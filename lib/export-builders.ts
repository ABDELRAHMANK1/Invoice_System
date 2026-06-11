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

// ── Boekingen Excel template ──────────────────────────────────────────────────
//
//  Matches the column layout, widths, font (Aptos Narrow 11pt), and header
//  colours from the reference file Boekingen (1)-.xlsx.
//  Red header columns: B D G H I M N
//
const RED = "FFFF0000";

const BOEKINGEN_COLS: { header: string; key: string; width: number; red?: true }[] = [
  { header: "JournaalPostId",           key: "journaalPostId",           width: 37.21875 },
  { header: "BookingId",                key: "bookingId",                width: 11.77734375, red: true },
  { header: "Betalingstermijn",         key: "betalingstermijn",         width: 16.21875 },
  { header: "Datum",                    key: "datum",                    width: 13.21875, red: true },
  { header: "DagboekSoort",             key: "dagboekSoort",             width: 51.21875 },
  { header: "DagboekNaam",              key: "dagboekNaam",              width: 30.21875 },
  { header: "DagboekNummer",            key: "dagboekNummer",            width: 17.77734375, red: true },
  { header: "Omschrijving",             key: "omschrijving",             width: 58.77734375, red: true },
  { header: "Regel",                    key: "regel",                    width: 9, red: true },
  { header: "Debet",                    key: "debet",                    width: 9 },
  { header: "Credit",                   key: "credit",                   width: 12 },
  { header: "GrootboekNaam",            key: "grootboekNaam",            width: 31.21875 },
  { header: "GrootboekNummer",          key: "grootboekNummer",          width: 20.21875, red: true },
  { header: "BtwSoort",                 key: "btwSoort",                 width: 11.77734375, red: true },
  { header: "BtwPercentage",            key: "btwPercentage",            width: 17.77734375 },
  { header: "Boekstuk",                 key: "boekstuk",                 width: 10.5546875 },
  { header: "FactuurNummerId",          key: "factuurNummerId",          width: 40 },
  { header: "FactuurNummer",            key: "factuurNummer",            width: 19.5546875 },
  { header: "KostenplaatsOmschrijving", key: "kostenplaatsOmschrijving", width: 29 },
  { header: "KostenplaatsNummer",       key: "kostenplaatsNummer",       width: 22.21875 },
  { header: "RelatieNaam",              key: "relatieNaam",              width: 14.77734375 },
  { header: "RelatieCode",              key: "relatieCode",              width: 13.77734375 }
];

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

type OmschrijvingValue = string | null | { formula: string; result: string };

interface BookingRowParams {
  bookingId: number;
  datum: Date | null;
  omschrijving: OmschrijvingValue;
  regel: number;
  debet: number;
  credit: number;
  grootboekNaam: string | null;
  grootboekNummer: number | null;
  btwSoort: number | null;
  btwPercentage: number | null;
  factuurNummerId: string;
  factuurNummer: string;
  relatieNaam: string | null;
  relatieCode: number | string;
  dagboekSoort: string;
  dagboekNaam: string;
  dagboekNummer: number;
}

function addBookingRow(sheet: ExcelJS.Worksheet, params: BookingRowParams): ExcelJS.Row {
  const row = sheet.addRow({
    journaalPostId:           null,
    bookingId:                params.bookingId,
    betalingstermijn:         null,
    datum:                    params.datum,
    dagboekSoort:             params.dagboekSoort,
    dagboekNaam:              params.dagboekNaam,
    dagboekNummer:            params.dagboekNummer,
    omschrijving:             null,
    regel:                    params.regel,
    debet:                    params.debet,
    credit:                   params.credit,
    grootboekNaam:            params.grootboekNaam,
    grootboekNummer:          params.grootboekNummer,
    btwSoort:                 params.btwSoort,
    btwPercentage:            params.btwPercentage,
    boekstuk:                 null,
    factuurNummerId:          params.factuurNummerId,
    factuurNummer:            params.factuurNummer,
    kostenplaatsOmschrijving: null,
    kostenplaatsNummer:       null,
    relatieNaam:              params.relatieNaam,
    relatieCode:              params.relatieCode
  });

  // Column 8 = H = Omschrijving (may be a cell formula)
  row.getCell(8).value = params.omschrijving as ExcelJS.CellValue;

  if (params.datum) {
    row.getCell(4).numFmt = "mm-dd-yy";
  }

  row.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = BASE_FONT;
  });

  row.commit();
  return row;
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

// ── Verkoop sheet (existing Boekingen layout, untouched semantics) ──────────
//
// VERKOOP (dagboek 1300 / Debiteuren):
//   Regel 0: Debiteuren (1300)  Debet=total_incl   btwSoort=0
//   Regel 1: Omzet (8100/8110/8170)  Credit=excl_btw  btwSoort=2/1/0
//   Regel 2: BTW af te dragen (1671/1670)  Credit=btw_amount  (omitted when vat=0%)

function writeVerkoopSheet(workbook: ExcelJS.Workbook, invoices: InvoiceExportRow[]) {
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.columns = BOEKINGEN_COLS.map(({ header, key, width }) => ({ header, key, width }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNum) => {
    const col = BOEKINGEN_COLS[colNum - 1];
    cell.font = { ...BASE_FONT, bold: true, color: col?.red ? { argb: RED } : { theme: 1 } };
  });
  headerRow.commit();
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  let currentSheetRow = 2;

  invoices.forEach((inv, idx) => {
    const bookingId = idx + 1;
    const datum = inv.date ? new Date(`${inv.date}T00:00:00`) : null;

    const rawExt = (inv.raw_extraction as Record<string, unknown>) ?? {};
    const rawVat = Number(rawExt.vat_rate ?? rawExt.btw_percentage ?? 21);
    const vatPct = [0, 9, 21].includes(rawVat) ? rawVat : 21;

    const totalIncl = Number(inv.total_amount ?? 0);
    const btwBedrag = vatPct === 0 ? 0 : round2((totalIncl / (1 + vatPct / 100)) * (vatPct / 100));
    const exclBtw   = round2(totalIncl - btwBedrag);

    const common = {
      bookingId,
      datum,
      factuurNummerId: inv.id,
      factuurNummer:   inv.invoice_number,
      relatieNaam:     inv.client_name || null,
      relatieCode:     inv.relatie_code && inv.relatie_code.trim() !== "" ? inv.relatie_code : bookingId
    };

    const regel0Row = currentSheetRow;
    const regel1Row = currentSheetRow + 1;
    const dagboek = { dagboekSoort: "dagboek Verkoop", dagboekNaam: "Debiteuren", dagboekNummer: 1300 };

    addBookingRow(sheet, {
      ...common, ...dagboek,
      omschrijving:    inv.client_name || null,
      regel:           0,
      debet:           totalIncl,
      credit:          0,
      grootboekNaam:   "Debiteuren",
      grootboekNummer: 1300,
      btwSoort:        0,
      btwPercentage:   null
    });

    if (vatPct === 0) {
      addBookingRow(sheet, {
        ...common, ...dagboek,
        omschrijving:    { formula: `H${regel0Row}`, result: inv.client_name || "" },
        regel:           1,
        debet:           0,
        credit:          totalIncl,
        grootboekNaam:   "Omzet binnen EU handelsgoederen",
        grootboekNummer: 8170,
        btwSoort:        0,
        btwPercentage:   null
      });
      currentSheetRow += 2;
    } else {
      const btwSoort  = vatPct === 9 ? 1 : 2;
      const omzetNaam = vatPct === 9 ? "Omzet laag handelsgoederen"   : "Omzet hoog handelsgoederen";
      const omzetNr   = vatPct === 9 ? 8110                           : 8100;
      const btwNaam   = vatPct === 9 ? "BTW af te dragen laag"        : "BTW af te dragen hoog";
      const btwNr     = vatPct === 9 ? 1670                           : 1671;

      addBookingRow(sheet, {
        ...common, ...dagboek,
        omschrijving:    { formula: `H${regel0Row}`, result: inv.client_name || "" },
        regel:           1,
        debet:           0,
        credit:          exclBtw,
        grootboekNaam:   omzetNaam,
        grootboekNummer: omzetNr,
        btwSoort,
        btwPercentage:   vatPct
      });

      addBookingRow(sheet, {
        ...common, ...dagboek,
        omschrijving:    { formula: `H${regel1Row}`, result: inv.client_name || "" },
        regel:           2,
        debet:           0,
        credit:          btwBedrag,
        grootboekNaam:   btwNaam,
        grootboekNummer: btwNr,
        btwSoort,
        btwPercentage:   vatPct
      });
      currentSheetRow += 3;
    }
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
