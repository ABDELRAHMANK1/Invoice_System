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
}

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

// ── Native Snelstart INKOOP sheet — 24 columns, 6 rows per invoice ──────────
//
//   Regel 5: 1679 Btw te vorderen laag (inkopen)  Debet=vat_9
//   Regel 4: 1680 Btw te vorderen hoog (inkopen)  Debet=vat_21
//   Regel 3: 7001 Inkopen laag tarief             Debet=net_9
//   Regel 2: 3090 Emballage                       Debet=emballage   (TODO: net_0 unmapped — Ammar to specify a 0% grootboek)
//   Regel 1: 7002 Inkopen hoog tarief             Debet=net_21
//   Regel 0: 1600 Crediteuren                     Credit=total_amount

const INKOOP_COLS: { header: string; key: string; width: number }[] = [
  { header: "BookingId",                 key: "bookingId",                 width: 11 },
  { header: "Dagboeknaam",               key: "dagboeknaam",               width: 14 },
  { header: "Datum",                     key: "datum",                     width: 12 },
  { header: "Regel",                     key: "regel",                     width: 7 },
  { header: "Omschrijving",              key: "omschrijving",              width: 32 },
  { header: "GrootboekNummer",           key: "grootboek",                 width: 14 },
  { header: "Grootboeknaam",             key: "grootboeknaam",             width: 32 },
  { header: "Debet",                     key: "debet",                     width: 11 },
  { header: "Credit",                    key: "credit",                    width: 11 },
  { header: "Saldo",                     key: "saldo",                     width: 11 },
  { header: "BtwSoort",                  key: "btwSoort",                  width: 10 },
  { header: "Factuurnummer",             key: "factuurnummer",             width: 18 },
  { header: "DagboekNummer",             key: "dagboek",                   width: 10 },
  { header: "Dagboeksoort",              key: "dagboeksoort",              width: 18 },
  { header: "Boekstuk",                  key: "boekstuk",                  width: 10 },
  { header: "Gewijzigd door accountant", key: "gewijzigdDoorAccountant",   width: 26 },
  { header: "Relatiecode",               key: "relatiecode",               width: 12 },
  { header: "Relatienaam",               key: "relatienaam",               width: 28 },
  { header: "Grootboekrekening type",    key: "grootboekrekeningType",     width: 22 },
  { header: "Grootboek functie",         key: "grootboekFunctie",          width: 22 },
  { header: "Gemarkeerd",                key: "gemarkeerd",                width: 12 },
  { header: "Bijlagen",                  key: "bijlagen",                  width: 10 },
  { header: "Kostenplaats",              key: "kostenplaats",              width: 12 },
  { header: "Kostenplaatsnaam",          key: "kostenplaatsnaam",          width: 20 },
  { header: "Bankomschrijving",          key: "bankomschrijving",          width: 22 },
];

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
    { regel: 0, grootboek: 1600, grootboeknaam: "Crediteuren",                    debet: 0,                   credit: round2(totalIncl),  btwSoort: 0, grootboekrekeningType: "Balans",          grootboekFunctie: "DagboekInkoop" },
  ];
}

function writeInkoopSheet(workbook: ExcelJS.Workbook, invoices: InvoiceExportRow[]) {
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
    const relatieCode = inv.relatie_code && inv.relatie_code.trim() !== "" ? inv.relatie_code : boekstuk;
    const bd        = readVatBreakdown(inv);

    inkoopRowSpecs(bd, totalIncl).forEach((spec) => {
      const row = sheet.addRow({
        bookingId:               boekstuk,
        dagboeknaam:             "Crediteuren",
        datum:                   datum,
        regel:                   spec.regel,
        omschrijving:            party,
        grootboek:               spec.grootboek,
        grootboeknaam:           spec.grootboeknaam,
        debet:                   spec.debet,
        credit:                  spec.credit,
        saldo:                   round2(spec.debet - spec.credit),
        btwSoort:                spec.btwSoort,
        factuurnummer:           inv.invoice_number,
        dagboek:                 1600,
        dagboeksoort:            "dagboek Inkoop",
        boekstuk:                boekstuk,
        gewijzigdDoorAccountant: false,
        relatiecode:             relatieCode,
        relatienaam:             party,
        grootboekrekeningType:   spec.grootboekrekeningType,
        grootboekFunctie:        spec.grootboekFunctie,
        gemarkeerd:              false,
        bijlagen:                true,
        kostenplaats:            0,
        kostenplaatsnaam:        null,
        bankomschrijving:        null,
      });

      if (datum) row.getCell(3).numFmt = "dd-mm-yyyy";
      for (const numCol of [8, 9, 10]) row.getCell(numCol).numFmt = "#,##0.00";

      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = BASE_FONT;
      });
      row.commit();
    });
  });
}

// ── Native Snelstart VERKOOP sheet — 25 columns, 2 or 3 rows per invoice ────
//
//   Regel 2: BTW af te dragen (1671 hoog / 1670 laag)  Credit=btw    (omitted at 0%)
//   Regel 1: Omzet (8200 hoog / 8210 laag / 8170 verlegd)  Credit=net
//   Regel 0: 1300 Debiteuren                              Debet=total_incl

const VERKOOP_COLS: { header: string; key: string; width: number }[] = [
  { header: "BookingId",                 key: "bookingId",                 width: 11 },
  { header: "Dagboeknaam",               key: "dagboeknaam",               width: 14 },
  { header: "Datum",                     key: "datum",                     width: 12 },
  { header: "Regel",                     key: "regel",                     width: 7 },
  { header: "Omschrijving",              key: "omschrijving",              width: 32 },
  { header: "Grootboek",                 key: "grootboek",                 width: 10 },
  { header: "Grootboeknaam",             key: "grootboeknaam",             width: 32 },
  { header: "Debet",                     key: "debet",                     width: 11 },
  { header: "Credit",                    key: "credit",                    width: 11 },
  { header: "Saldo",                     key: "saldo",                     width: 11 },
  { header: "Btw-soort",                 key: "btwSoort",                  width: 10 },
  { header: "Factuurnummer",             key: "factuurnummer",             width: 18 },
  { header: "Dagboek",                   key: "dagboek",                   width: 10 },
  { header: "Dagboeksoort",              key: "dagboeksoort",              width: 18 },
  { header: "Boekstuk",                  key: "boekstuk",                  width: 10 },
  { header: "Gewijzigd door accountant", key: "gewijzigdDoorAccountant",   width: 26 },
  { header: "Relatiecode",               key: "relatiecode",               width: 12 },
  { header: "Relatienaam",               key: "relatienaam",               width: 28 },
  { header: "Grootboekrekening type",    key: "grootboekrekeningType",     width: 22 },
  { header: "Grootboek functie",         key: "grootboekFunctie",          width: 22 },
  { header: "Gemarkeerd",                key: "gemarkeerd",                width: 12 },
  { header: "Bijlagen",                  key: "bijlagen",                  width: 10 },
  { header: "Bankomschrijving",          key: "bankomschrijving",          width: 22 },
  { header: "Kostenplaats",              key: "kostenplaats",              width: 12 },
  { header: "Kostenplaatsnaam",          key: "kostenplaatsnaam",          width: 20 },
];

interface VerkoopRowSpec {
  regel: number;
  grootboek: number;
  grootboeknaam: string;
  debet: number;
  credit: number;
  /** Native Snelstart label — text, not numeric (verkoop convention). */
  btwSoort: "Hoog" | "Laag" | "Geen";
  grootboekrekeningType: "Balans" | "Verlies & Winst";
  grootboekFunctie: string;
}

function verkoopRowSpecs(totalIncl: number, vatPct: 0 | 9 | 21): VerkoopRowSpec[] {
  const regel0: VerkoopRowSpec = {
    regel: 0,
    grootboek: 1300,
    grootboeknaam: "Debiteuren",
    debet: round2(totalIncl),
    credit: 0,
    btwSoort: "Geen",
    grootboekrekeningType: "Balans",
    grootboekFunctie: "DagboekVerkoop",
  };

  // 0% / verlegd: 2 rows only (no BTW row).
  if (vatPct === 0) {
    return [
      {
        regel: 1,
        grootboek: 8170,
        grootboeknaam: "Omzet binnen EU diensten",
        debet: 0,
        credit: round2(totalIncl),
        btwSoort: "Geen",
        grootboekrekeningType: "Verlies & Winst",
        grootboekFunctie: "VerkopenOmzetVrijgesteld",
      },
      regel0,
    ];
  }

  const btw = round2((totalIncl / (1 + vatPct / 100)) * (vatPct / 100));
  const net = round2(totalIncl - btw);

  if (vatPct === 9) {
    return [
      {
        regel: 2,
        grootboek: 1670,
        grootboeknaam: "Btw af te dragen laag (verkopen)",
        debet: 0,
        credit: btw,
        btwSoort: "Laag",
        grootboekrekeningType: "Balans",
        grootboekFunctie: "BtwAfTeDragenLaag",
      },
      {
        regel: 1,
        grootboek: 8210,
        grootboeknaam: "Omzet laag (diensten)",
        debet: 0,
        credit: net,
        btwSoort: "Laag",
        grootboekrekeningType: "Verlies & Winst",
        grootboekFunctie: "VerkopenOmzetLaag",
      },
      regel0,
    ];
  }

  // 21% — default
  return [
    {
      regel: 2,
      grootboek: 1671,
      grootboeknaam: "Btw af te dragen hoog (verkopen)",
      debet: 0,
      credit: btw,
      btwSoort: "Hoog",
      grootboekrekeningType: "Balans",
      grootboekFunctie: "BtwAfTeDragenHoog",
    },
    {
      regel: 1,
      grootboek: 8200,
      grootboeknaam: "Omzet hoog (diensten)",
      debet: 0,
      credit: net,
      btwSoort: "Hoog",
      grootboekrekeningType: "Verlies & Winst",
      grootboekFunctie: "VerkopenOmzetHoog",
    },
    regel0,
  ];
}

function writeVerkoopSheet(workbook: ExcelJS.Workbook, invoices: InvoiceExportRow[]) {
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
    const party     = inv.client_name || null;
    const relatieCode = inv.relatie_code && inv.relatie_code.trim() !== "" ? inv.relatie_code : boekstuk;

    const rawExt = (inv.raw_extraction as Record<string, unknown>) ?? {};
    const rawVat = Number(rawExt.vat_rate ?? rawExt.btw_percentage ?? 21);
    const vatPct = ([0, 9, 21] as const).includes(rawVat as 0 | 9 | 21) ? (rawVat as 0 | 9 | 21) : 21;

    verkoopRowSpecs(totalIncl, vatPct).forEach((spec) => {
      const row = sheet.addRow({
        bookingId:               boekstuk,
        dagboeknaam:             "Debiteuren",
        datum:                   datum,
        regel:                   spec.regel,
        omschrijving:            party,
        grootboek:               spec.grootboek,
        grootboeknaam:           spec.grootboeknaam,
        debet:                   spec.debet,
        credit:                  spec.credit,
        saldo:                   round2(spec.debet - spec.credit),
        btwSoort:                spec.btwSoort,
        factuurnummer:           inv.invoice_number,
        dagboek:                 1300,
        dagboeksoort:            "dagboek Verkoop",
        boekstuk:                boekstuk,
        gewijzigdDoorAccountant: false,
        relatiecode:             relatieCode,
        relatienaam:             party,
        grootboekrekeningType:   spec.grootboekrekeningType,
        grootboekFunctie:        spec.grootboekFunctie,
        gemarkeerd:              false,
        bijlagen:                true,
        bankomschrijving:        null,
        kostenplaats:            0,
        kostenplaatsnaam:        null,
      });

      if (datum) row.getCell(3).numFmt = "dd-mm-yyyy";
      for (const numCol of [8, 9, 10]) row.getCell(numCol).numFmt = "#,##0.00";

      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = BASE_FONT;
      });
      row.commit();
    });
  });
}

export async function buildInvoiceExcelBuffer(invoices: InvoiceExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Oranji";
  workbook.created = new Date();

  const verkoopInvoices = invoices.filter((inv) => (inv.invoice_direction ?? "inkoop") === "verkoop");
  const inkoopInvoices  = invoices.filter((inv) => (inv.invoice_direction ?? "inkoop") !== "verkoop");

  if (verkoopInvoices.length > 0) writeVerkoopSheet(workbook, verkoopInvoices);
  if (inkoopInvoices.length  > 0) writeInkoopSheet(workbook,  inkoopInvoices);

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
