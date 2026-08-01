import JSZip from "jszip";
import ExcelJS from "exceljs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { buildExportObjectKey, signedReadUrl, uploadBuffer } from "@/lib/storage";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InvoiceExportRow {
  id: string;
  invoice_number: string;
  client_name: string | null;
  supplier_name?: string | null;
  /** Verkoop counterparty (the customer sold to) — denormalised name + FK. */
  customer_name?: string | null;
  customer_id?: string | null;
  phone_number: string;
  date: string | null;
  total_amount: number | null;
  currency: string;
  file_url: string;
  status: string;
  created_at: string;
  raw_extraction?: Record<string, unknown> | null;
  invoice_direction?: "inkoop" | "verkoop" | null;
  /** RelatieCode resolved from the matching supplier (inkoop) or client (verkoop). Falls back to bookingId when null. */
  relatie_code?: string | null;
  /** Explicit verkoop split — used by the raw-file converter to feed real
   *  excl (net) + btw amounts straight through, so anomalous rates that don't
   *  snap to 0/9/21 keep their real numbers instead of being recomputed from a
   *  bucketed rate. When absent, the verkoop sheet derives net/btw from
   *  vat_rate + total_amount as before. `draft` = a single zero-amount
   *  Debiteuren line (Concept invoices). */
  verkoop_amounts?: { net: number; btw: number; variant: VerkoopVariant } | null;
  /** When set AND the builder is called with `flagReviewRows`, this invoice's
   *  rows are highlighted and the note is attached as a cell comment (used to
   *  flag unmatched Relatiecodes / anomalous VAT for manual review). */
  review_note?: string | null;
}

/** Verkoop booking shape: which omzet/BTW accounts a row set uses. */
export type VerkoopVariant = "hoog" | "laag" | "vrij" | "draft";

// ── Dev helpers ───────────────────────────────────────────────────────────────

function isPlaceholder(value?: string) {
  return !value || value.startsWith("your-") || value.includes("change-me");
}

function shouldUseLocalExportStorage() {
  return (
    process.env.NODE_ENV !== "production" &&
    [env.s3Bucket, env.awsRegion, env.awsAccessKeyId, env.awsSecretAccessKey].some(isPlaceholder)
  );
}

async function saveLocalExport(params: { body: Buffer; jobId: string; type: "excel" | "zip"; baseUrl?: string }) {
  const ext = params.type === "excel" ? "xlsx" : "zip";
  const fileName = `${params.jobId}.${ext}`;
  const exportDir = path.join(process.cwd(), "public", "exports", params.type);
  await mkdir(exportDir, { recursive: true });
  await writeFile(path.join(exportDir, fileName), params.body);
  const downloadUrl = `${(params.baseUrl || env.appUrl).replace(/\/$/, "")}/exports/${params.type}/${fileName}`;
  return {
    file_url: `local://exports/${params.type}/${fileName}`,
    download_url: downloadUrl
  };
}

// ── Snelstart Boekingen base font ─────────────────────────────────────────────

const BASE_FONT: Partial<ExcelJS.Font> = {
  size: 11,
  name: "Aptos Narrow",
  family: 2,
  scheme: "minor",
  color: { theme: 1 }
};

// ── Snelstart VAT helpers ─────────────────────────────────────────────────────

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// ── Snelstart "Boekingen" import schema — the ONE accepted 22-column layout ──
//
// These are the exact column names (case-sensitive, no spaces/hyphens) that
// Snelstart's "Bestand uploaden" importer requires — verified against the real
// accepted template (`Boekingen (1)-.xlsx`, sheet with 22 cols). BOTH the
// verkoop and inkoop sheets use this identical schema; the importer rejected
// earlier files for missing `bookingid`/`dagboeknummer`/`btwsoort` because the
// old headers were hyphenated / renamed.
//
// Columns intentionally left blank for a fresh import (matching the template's
// own example rows): JournaalPostId, BtwPercentage (the rate is carried by
// BtwSoort), FactuurNummerId, KostenplaatsOmschrijving, KostenplaatsNummer.
// Betalingstermijn is 0 on verkoop rows, blank on inkoop (per the template).
//
// INKOOP booking — 6 rows per invoice (Regel 5 → 0):
//   Regel 5: 1679 Btw te vorderen laag (inkopen)  Debet=vat_9
//   Regel 4: 1680 Btw te vorderen hoog (inkopen)  Debet=vat_21
//   Regel 3: 7001 Inkopen laag tarief             Debet=net_9
//   Regel 2: 3090 Emballage                       Debet=emballage
//   Regel 1: 7002 Inkopen hoog tarief             Debet=net_21
//   Regel 0: 1300 Crediteuren (GrootboekNummer)   Credit=total_amount
//            (DagboekNummer stays 1600 — the Crediteuren dagboek.)

const SNELSTART_COLS: { header: string; key: string; width: number }[] = [
  { header: "JournaalPostId",           key: "journaalPostId",           width: 14 },
  { header: "BookingId",                key: "bookingId",                width: 11 },
  { header: "Betalingstermijn",         key: "betalingstermijn",         width: 16 },
  { header: "Datum",                    key: "datum",                    width: 12 },
  { header: "DagboekSoort",             key: "dagboeksoort",             width: 18 },
  { header: "DagboekNaam",              key: "dagboeknaam",              width: 14 },
  { header: "DagboekNummer",            key: "dagboeknummer",            width: 14 },
  { header: "Omschrijving",             key: "omschrijving",             width: 32 },
  { header: "Regel",                    key: "regel",                    width: 7 },
  { header: "Debet",                    key: "debet",                    width: 11 },
  { header: "Credit",                   key: "credit",                   width: 11 },
  { header: "GrootboekNaam",            key: "grootboeknaam",            width: 32 },
  { header: "GrootboekNummer",          key: "grootboeknummer",          width: 14 },
  { header: "BtwSoort",                 key: "btwSoort",                 width: 10 },
  { header: "BtwPercentage",            key: "btwPercentage",            width: 14 },
  { header: "Boekstuk",                 key: "boekstuk",                 width: 10 },
  { header: "FactuurNummerId",          key: "factuurNummerId",          width: 16 },
  { header: "FactuurNummer",            key: "factuurnummer",            width: 18 },
  { header: "KostenplaatsOmschrijving", key: "kostenplaatsOmschrijving", width: 22 },
  { header: "KostenplaatsNummer",       key: "kostenplaatsNummer",       width: 18 },
  { header: "RelatieNaam",              key: "relatienaam",              width: 28 },
  { header: "RelatieCode",              key: "relatiecode",              width: 12 },
];

// Both sheets share the single accepted schema. Kept as named aliases so the
// two write functions read intention-clearly and future divergence is a
// one-line change, not a re-thread.
const INKOOP_COLS = SNELSTART_COLS;
const VERKOOP_COLS = SNELSTART_COLS;

// 1-based column indices used for number/date formatting (see SNELSTART_COLS).
const COL_DATUM = 4;
const COL_DEBET = 10;
const COL_CREDIT = 11;
const COL_RELATIECODE = 22;

// Light amber highlight for rows that need manual review (blank Relatiecode /
// anomalous VAT). Opt-in via BuildInvoiceExcelOptions.flagReviewRows.
const REVIEW_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };

/** Highlight an invoice's rows and pin a review note as a comment on its
 *  RelatieCode cell. Fills all 22 columns so the whole band reads as flagged. */
function applyReviewFlag(rows: ExcelJS.Row[], note: string) {
  for (const row of rows) {
    for (let c = 1; c <= SNELSTART_COLS.length; c += 1) row.getCell(c).fill = REVIEW_FILL;
  }
  if (rows[0]) rows[0].getCell(COL_RELATIECODE).note = note;
}

interface VatBreakdownLike {
  net_21: number;
  vat_21: number;
  net_9: number;
  vat_9: number;
  net_0: number;
  emballage: number;
}

function readVatBreakdown(inv: InvoiceExportRow): VatBreakdownLike {
  const rawExt = (inv.raw_extraction as Record<string, unknown>) ?? {};
  const bd = rawExt.vat_breakdown as Record<string, unknown> | undefined;
  if (bd && typeof bd === "object") {
    return {
      net_21:    Number(bd.net_21)    || 0,
      vat_21:    Number(bd.vat_21)    || 0,
      net_9:     Number(bd.net_9)     || 0,
      vat_9:     Number(bd.vat_9)     || 0,
      net_0:     Number(bd.net_0)     || 0,
      emballage: Number(bd.emballage) || 0,
    };
  }
  // Fallback when no breakdown was extracted: synthesise from vat_rate + total.
  const rawVat = Number(rawExt.vat_rate ?? rawExt.btw_percentage ?? 21);
  const vatPct = [0, 9, 21].includes(rawVat) ? rawVat : 21;
  const total  = Number(inv.total_amount ?? 0);
  const btw    = vatPct === 0 ? 0 : round2((total / (1 + vatPct / 100)) * (vatPct / 100));
  const net    = round2(total - btw);
  return {
    net_21:    vatPct === 21 ? net : 0,
    vat_21:    vatPct === 21 ? btw : 0,
    net_9:     vatPct === 9  ? net : 0,
    vat_9:     vatPct === 9  ? btw : 0,
    net_0:     vatPct === 0  ? total : 0,
    emballage: 0,
  };
}

interface InkoopRowSpec {
  regel: number;
  grootboek: number;
  grootboeknaam: string;
  debet: number;
  credit: number;
  /** Snelstart BtwSoort code: 0 = Geen, 1 = Laag, 2 = Hoog */
  btwSoort: 0 | 1 | 2;
  grootboekrekeningType: "Balans" | "Verlies & Winst";
  grootboekFunctie: string;
}

function inkoopRowSpecs(bd: VatBreakdownLike, totalIncl: number): InkoopRowSpec[] {
  return [
    { regel: 5, grootboek: 1679, grootboeknaam: "Btw te vorderen laag (inkopen)", debet: round2(bd.vat_9),    credit: 0,                  btwSoort: 1, grootboekrekeningType: "Balans",          grootboekFunctie: "BtwTeVorderenLaag" },
    { regel: 4, grootboek: 1680, grootboeknaam: "Btw te vorderen hoog (inkopen)", debet: round2(bd.vat_21),   credit: 0,                  btwSoort: 2, grootboekrekeningType: "Balans",          grootboekFunctie: "BtwTeVorderenHoog" },
    { regel: 3, grootboek: 7001, grootboeknaam: "Inkopen laag tarief",            debet: round2(bd.net_9),    credit: 0,                  btwSoort: 1, grootboekrekeningType: "Verlies & Winst", grootboekFunctie: "InkopenKostenLaag" },
    { regel: 2, grootboek: 3090, grootboeknaam: "Emballage",                      debet: round2(bd.emballage),credit: 0,                  btwSoort: 0, grootboekrekeningType: "Balans",          grootboekFunctie: "Diversen" },
    { regel: 1, grootboek: 7002, grootboeknaam: "Inkopen hoog tarief",            debet: round2(bd.net_21),   credit: 0,                  btwSoort: 2, grootboekrekeningType: "Verlies & Winst", grootboekFunctie: "InkopenKostenHoog" },
    { regel: 0, grootboek: 1300, grootboeknaam: "Crediteuren",                    debet: 0,                   credit: round2(totalIncl),  btwSoort: 0, grootboekrekeningType: "Balans",          grootboekFunctie: "DagboekInkoop" },
  ];
}

function writeInkoopSheet(workbook: ExcelJS.Workbook, invoices: InvoiceExportRow[], blankUnmatched = false) {
  const sheet = workbook.addWorksheet("Inkoop");
  sheet.columns = INKOOP_COLS.map(({ header, key, width }) => ({ header, key, width }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { ...BASE_FONT, bold: true };
  });
  headerRow.commit();
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  invoices.forEach((inv, idx) => {
    const boekstuk  = idx + 1;
    const datum     = inv.date ? new Date(`${inv.date}T00:00:00`) : null;
    const totalIncl = Number(inv.total_amount ?? 0);
    const party     = inv.supplier_name || inv.client_name || null;
    // Coerce to string so a numeric DB value can't crash .trim(); fall back to
    // the per-invoice boekstuk when no supplier was matched in attachRelatieCodes
    // (unless the caller asked to keep unmatched Relatiecodes blank).
    const codeStr     = inv.relatie_code == null ? "" : String(inv.relatie_code).trim();
    const relatieCode = codeStr !== "" ? codeStr : (blankUnmatched ? null : boekstuk);
    const bd        = readVatBreakdown(inv);

    inkoopRowSpecs(bd, totalIncl).forEach((spec) => {
      const row = sheet.addRow({
        journaalPostId:           null,   // blank for a fresh import
        bookingId:                boekstuk,
        betalingstermijn:         null,   // inkoop: blank (template leaves it empty)
        datum:                    datum,
        dagboeksoort:             "dagboek Inkoop",
        dagboeknaam:              "Crediteuren",
        dagboeknummer:            1600,
        omschrijving:             party,
        regel:                    spec.regel,
        debet:                    spec.debet,
        credit:                   spec.credit,
        grootboeknaam:            spec.grootboeknaam,
        grootboeknummer:          spec.grootboek,
        btwSoort:                 spec.btwSoort,
        btwPercentage:            null,   // rate carried by BtwSoort; blank per template
        boekstuk:                 boekstuk,
        factuurNummerId:          null,
        factuurnummer:            inv.invoice_number,
        kostenplaatsOmschrijving: null,
        kostenplaatsNummer:       null,
        relatienaam:              party,
        relatiecode:              relatieCode,
      });

      if (datum) row.getCell(COL_DATUM).numFmt = "dd-mm-yyyy";
      for (const numCol of [COL_DEBET, COL_CREDIT]) row.getCell(numCol).numFmt = "#,##0.00";

      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = BASE_FONT;
      });
      row.commit();
    });
  });
}

// ── Native Snelstart VERKOOP booking — 2 or 3 rows per invoice ──────────────
//
//   Regel 2: BTW af te dragen (1671 hoog / 1670 laag)  Credit=btw    (omitted at 0%)
//   Regel 1: Omzet (8200 hoog / 8210 laag / 8170 verlegd)  Credit=net
//   Regel 0: 1300 Debiteuren                              Debet=total_incl
// Emitted into the shared SNELSTART_COLS schema (see above).

interface VerkoopRowSpec {
  regel: number;
  grootboek: number;
  grootboeknaam: string;
  debet: number;
  credit: number;
  /** Snelstart BtwSoort code: 0 = Geen, 1 = Laag, 2 = Hoog (numeric on BOTH
   *  sheets — Ammar confirmed Snelstart's verkoop import accepts the codes). */
  btwSoort: 0 | 1 | 2;
  grootboekrekeningType: "Balans" | "Verlies & Winst";
  grootboekFunctie: string;
}

export function verkoopVariantForRate(vatPct: 0 | 9 | 21): VerkoopVariant {
  return vatPct === 21 ? "hoog" : vatPct === 9 ? "laag" : "vrij";
}

/**
 * Build the 2–3 verkoop rows from EXPLICIT net + btw amounts and a variant.
 * Shared by the DB-backed export (amounts derived from vat_rate, via
 * `verkoopRowSpecsFromRate`) and the raw-file converter (amounts passed
 * verbatim so anomalous rates keep their real numbers). `draft` emits a single
 * zero-amount Debiteuren line (Concept invoices — no VAT split).
 */
export function verkoopRowSpecs(
  totalIncl: number,
  net: number,
  btw: number,
  variant: VerkoopVariant,
): VerkoopRowSpec[] {
  const regel0: VerkoopRowSpec = {
    regel: 0,
    grootboek: 1300,
    grootboeknaam: "Debiteuren",
    debet: round2(totalIncl),
    credit: 0,
    btwSoort: 0,
    grootboekrekeningType: "Balans",
    grootboekFunctie: "DagboekVerkoop",
  };

  // draft (Concept): a single zero-amount booking line, no omzet/BTW split.
  if (variant === "draft") return [regel0];

  // 0% / verlegd: 2 rows only (no BTW row).
  if (variant === "vrij") {
    return [
      {
        regel: 1,
        grootboek: 8170,
        grootboeknaam: "Omzet binnen EU diensten",
        debet: 0,
        credit: round2(net),
        btwSoort: 0,
        grootboekrekeningType: "Verlies & Winst",
        grootboekFunctie: "VerkopenOmzetVrijgesteld",
      },
      regel0,
    ];
  }

  if (variant === "laag") {
    return [
      {
        regel: 2,
        grootboek: 1670,
        grootboeknaam: "Btw af te dragen laag (verkopen)",
        debet: 0,
        credit: round2(btw),
        btwSoort: 1,
        grootboekrekeningType: "Balans",
        grootboekFunctie: "BtwAfTeDragenLaag",
      },
      {
        regel: 1,
        grootboek: 8210,
        grootboeknaam: "Omzet laag (diensten)",
        debet: 0,
        credit: round2(net),
        btwSoort: 1,
        grootboekrekeningType: "Verlies & Winst",
        grootboekFunctie: "VerkopenOmzetLaag",
      },
      regel0,
    ];
  }

  // hoog (21%) — and the fallback bucket for a flagged anomalous rate.
  return [
    {
      regel: 2,
      grootboek: 1671,
      grootboeknaam: "Btw af te dragen hoog (verkopen)",
      debet: 0,
      credit: round2(btw),
      btwSoort: 2,
      grootboekrekeningType: "Balans",
      grootboekFunctie: "BtwAfTeDragenHoog",
    },
    {
      regel: 1,
      grootboek: 8200,
      grootboeknaam: "Omzet hoog (diensten)",
      debet: 0,
      credit: round2(net),
      btwSoort: 2,
      grootboekrekeningType: "Verlies & Winst",
      grootboekFunctie: "VerkopenOmzetHoog",
    },
    regel0,
  ];
}

/** DB-backed export path: derive net/btw from a snapped rate, then delegate. */
function verkoopRowSpecsFromRate(totalIncl: number, vatPct: 0 | 9 | 21): VerkoopRowSpec[] {
  if (vatPct === 0) return verkoopRowSpecs(totalIncl, totalIncl, 0, "vrij");
  const btw = round2((totalIncl / (1 + vatPct / 100)) * (vatPct / 100));
  const net = round2(totalIncl - btw);
  return verkoopRowSpecs(totalIncl, net, btw, verkoopVariantForRate(vatPct));
}

function writeVerkoopSheet(
  workbook: ExcelJS.Workbook,
  invoices: InvoiceExportRow[],
  blankUnmatched = false,
  flagReview = false,
) {
  const sheet = workbook.addWorksheet("Verkoop");
  sheet.columns = VERKOOP_COLS.map(({ header, key, width }) => ({ header, key, width }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { ...BASE_FONT, bold: true };
  });
  headerRow.commit();
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  invoices.forEach((inv, idx) => {
    const boekstuk  = idx + 1;
    const datum     = inv.date ? new Date(`${inv.date}T00:00:00`) : null;
    const totalIncl = Number(inv.total_amount ?? 0);
    // Verkoop counterparty = the customer sold to (mirror of inkoop's
    // supplier_name || client_name). Manual invoices set customer_name; the
    // legacy free-text path only had client_name.
    const party     = inv.customer_name || inv.client_name || null;
    // Coerce to string so a numeric DB value can't crash .trim(); fall back to
    // the per-invoice boekstuk when no customer was matched — unless the caller
    // asked to keep unmatched Relatiecodes blank (one-off converter).
    const codeStr     = inv.relatie_code == null ? "" : String(inv.relatie_code).trim();
    const relatieCode = codeStr !== "" ? codeStr : (blankUnmatched ? null : boekstuk);

    // Prefer explicit converter amounts (real excl/btw, incl. anomalous rates);
    // otherwise derive net/btw from the snapped vat_rate as the DB path does.
    let specs: VerkoopRowSpec[];
    if (inv.verkoop_amounts) {
      const { net, btw, variant } = inv.verkoop_amounts;
      specs = verkoopRowSpecs(totalIncl, net, btw, variant);
    } else {
      const rawExt = (inv.raw_extraction as Record<string, unknown>) ?? {};
      const rawVat = Number(rawExt.vat_rate ?? rawExt.btw_percentage ?? 21);
      const vatPct = ([0, 9, 21] as const).includes(rawVat as 0 | 9 | 21) ? (rawVat as 0 | 9 | 21) : 21;
      specs = verkoopRowSpecsFromRate(totalIncl, vatPct);
    }

    const invRows: ExcelJS.Row[] = [];
    specs.forEach((spec) => {
      const row = sheet.addRow({
        journaalPostId:           null,   // blank for a fresh import
        bookingId:                boekstuk,
        betalingstermijn:         0,      // verkoop rows: 0 (per accepted template)
        datum:                    datum,
        dagboeksoort:             "dagboek Verkoop",
        dagboeknaam:              "Debiteuren",
        dagboeknummer:            1300,
        omschrijving:             party,
        regel:                    spec.regel,
        debet:                    spec.debet,
        credit:                   spec.credit,
        grootboeknaam:            spec.grootboeknaam,
        grootboeknummer:          spec.grootboek,
        btwSoort:                 spec.btwSoort,
        btwPercentage:            null,   // rate carried by BtwSoort; blank per template
        boekstuk:                 boekstuk,
        factuurNummerId:          null,
        factuurnummer:            inv.invoice_number,
        kostenplaatsOmschrijving: null,
        kostenplaatsNummer:       null,
        relatienaam:              party,
        relatiecode:              relatieCode,
      });

      if (datum) row.getCell(COL_DATUM).numFmt = "dd-mm-yyyy";
      for (const numCol of [COL_DEBET, COL_CREDIT]) row.getCell(numCol).numFmt = "#,##0.00";

      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = BASE_FONT;
      });
      invRows.push(row);
    });

    if (flagReview && inv.review_note) applyReviewFlag(invRows, inv.review_note);
    invRows.forEach((row) => row.commit());
  });
}

export interface BuildInvoiceExcelOptions {
  /** When a row has no resolved relatie_code, the Relatiecode cell normally
   *  falls back to the per-invoice boekstuk. Set true to leave it BLANK instead
   *  (used by the one-off Snelstart converter so unmatched customers stay empty
   *  for manual fill-in). Default false → existing boekstuk fallback. */
  blankUnmatchedRelatiecode?: boolean;
  /** When true, any invoice carrying a `review_note` has its rows highlighted
   *  and the note attached as a cell comment (blank Relatiecode / anomalous VAT
   *  in the raw-file converter). Default false. */
  flagReviewRows?: boolean;
}

export async function buildInvoiceExcelBuffer(
  invoices: InvoiceExportRow[],
  options: BuildInvoiceExcelOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Oranji";
  workbook.created = new Date();
  const blankUnmatched = options.blankUnmatchedRelatiecode ?? false;
  const flagReview = options.flagReviewRows ?? false;

  const verkoopInvoices = invoices.filter((inv) => (inv.invoice_direction ?? "inkoop") === "verkoop");
  const inkoopInvoices  = invoices.filter((inv) => (inv.invoice_direction ?? "inkoop") !== "verkoop");

  if (verkoopInvoices.length > 0) writeVerkoopSheet(workbook, verkoopInvoices, blankUnmatched, flagReview);
  if (inkoopInvoices.length  > 0) writeInkoopSheet(workbook,  inkoopInvoices,  blankUnmatched);

  // Workbook must have at least one sheet.
  if (workbook.worksheets.length === 0) writeInkoopSheet(workbook, []);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function uploadInvoiceExcelExport(params: {
  invoices: InvoiceExportRow[];
  jobId: string;
  baseUrl?: string;
}) {
  const body = await buildInvoiceExcelBuffer(params.invoices);
  const key = buildExportObjectKey("excel", params.jobId);

  if (shouldUseLocalExportStorage()) {
    const local = await saveLocalExport({ body, jobId: params.jobId, type: "excel", baseUrl: params.baseUrl });
    return { ...local, file_count: params.invoices.length };
  }

  const fileUrl = await uploadBuffer({
    key,
    body,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });

  return {
    file_url: fileUrl,
    download_url: await signedReadUrl(fileUrl, 60 * 60 * 24),
    file_count: params.invoices.length
  };
}

// ── Generic Excel builder (kept for n8n /api/generate-excel calls) ────────────

export async function buildExcelBuffer(rows: Record<string, unknown>[], summary?: Record<string, unknown>) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "WhatsApp Invoice SaaS";
  workbook.created = new Date();

  const invoiceSheet = workbook.addWorksheet("Invoices");
  const columns = rows.length > 0 ? Object.keys(rows[0]) : ["Invoice #", "Client", "Phone", "Date", "Amount", "Currency", "File URL"];
  invoiceSheet.columns = columns.map((key) => ({
    header: key,
    key,
    width: Math.min(Math.max(key.length + 8, 14), 38)
  }));
  invoiceSheet.addRows(rows);
  invoiceSheet.getRow(1).font = { bold: true };
  invoiceSheet.views = [{ state: "frozen", ySplit: 1 }];

  if (summary) {
    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.columns = Object.keys(summary).map((key) => ({ header: key, key, width: Math.max(key.length + 8, 18) }));
    summarySheet.addRow(summary);
    summarySheet.getRow(1).font = { bold: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function uploadExcelExport(params: {
  rows: Record<string, unknown>[];
  summary?: Record<string, unknown>;
  jobId: string;
  baseUrl?: string;
}) {
  const body = await buildExcelBuffer(params.rows, params.summary);
  const key = buildExportObjectKey("excel", params.jobId);

  if (shouldUseLocalExportStorage()) {
    const local = await saveLocalExport({ body, jobId: params.jobId, type: "excel", baseUrl: params.baseUrl });
    return { ...local, file_count: params.rows.length };
  }

  const fileUrl = await uploadBuffer({
    key,
    body,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });

  return {
    file_url: fileUrl,
    download_url: await signedReadUrl(fileUrl, 60 * 60 * 24),
    file_count: params.rows.length
  };
}

// ── ZIP builder ───────────────────────────────────────────────────────────────

export async function uploadZipExport(params: { fileUrls: string[]; jobId: string; baseUrl?: string }) {
  const zip = new JSZip();

  await Promise.all(
    params.fileUrls.map(async (fileUrl, index) => {
      const readUrl = fileUrl.startsWith("s3://") ? await signedReadUrl(fileUrl, 60 * 20) : fileUrl;
      const response = await fetch(readUrl);
      if (!response.ok) throw new Error(`Could not fetch file ${index + 1}: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const ext = fileUrl.toLowerCase().includes(".pdf") ? "pdf" : "jpg";
      zip.file(`invoice-file-${String(index + 1).padStart(4, "0")}.${ext}`, bytes);
    })
  );

  const body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const key = buildExportObjectKey("zip", params.jobId);

  if (shouldUseLocalExportStorage()) {
    const local = await saveLocalExport({ body, jobId: params.jobId, type: "zip", baseUrl: params.baseUrl });
    return { ...local, file_count: params.fileUrls.length };
  }

  const fileUrl = await uploadBuffer({ key, body, contentType: "application/zip" });

  return {
    file_url: fileUrl,
    download_url: await signedReadUrl(fileUrl, 60 * 60 * 24),
    file_count: params.fileUrls.length
  };
}
