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
  relatieCode: number;
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

// ── Boekingen Excel builder — 2 or 3 rows per invoice ────────────────────────
//
// INKOOP (dagboek 1600 / Crediteuren):
//   Regel 0: Crediteuren (1600)  Credit=total_incl   btwSoort=0
//   Regel 1: Inkopen (7002/7001/7003)  Debet=excl_btw  btwSoort=2/1/0
//   Regel 2: BTW te vorderen (1582/1681)  Debet=btw_amount  (omitted when vat=0%)
//
// VERKOOP (dagboek 1300 / Debiteuren):
//   Regel 0: Debiteuren (1300)  Debet=total_incl   btwSoort=0
//   Regel 1: Omzet (8100/8110/8170)  Credit=excl_btw  btwSoort=2/1/0
//   Regel 2: BTW af te dragen (1671/1670)  Credit=btw_amount  (omitted when vat=0%)

export async function buildInvoiceExcelBuffer(invoices: InvoiceExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Oranji";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Sheet1");
  sheet.columns = BOEKINGEN_COLS.map(({ header, key, width }) => ({ header, key, width }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNum) => {
    const col = BOEKINGEN_COLS[colNum - 1];
    cell.font = { ...BASE_FONT, bold: true, color: col?.red ? { argb: RED } : { theme: 1 } };
  });
  headerRow.commit();
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  let currentSheetRow = 2; // row 1 is the header

  invoices.forEach((inv, idx) => {
    const bookingId = idx + 1;
    const datum = inv.date ? new Date(`${inv.date}T00:00:00`) : null;
    const direction = inv.invoice_direction ?? "inkoop";

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
      relatieCode:     bookingId
    };

    const regel0Row = currentSheetRow;
    const regel1Row = currentSheetRow + 1;

    if (direction === "verkoop") {
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
    } else {
      // inkoop (default)
      const dagboek = { dagboekSoort: "dagboek Inkoop", dagboekNaam: "Crediteuren", dagboekNummer: 1600 };
      const inkoopParty   = inv.supplier_name || inv.client_name || null;
      const inkoopCommon  = { ...common, relatieNaam: inkoopParty };

      addBookingRow(sheet, {
        ...inkoopCommon, ...dagboek,
        omschrijving:    inkoopParty,
        regel:           0,
        debet:           0,
        credit:          totalIncl,
        grootboekNaam:   "Debiteuren",
        grootboekNummer: 1300,
        btwSoort:        0,
        btwPercentage:   null
      });

      if (vatPct === 0) {
        addBookingRow(sheet, {
          ...inkoopCommon, ...dagboek,
          omschrijving:    { formula: `H${regel0Row}`, result: inkoopParty || "" },
          regel:           1,
          debet:           totalIncl,
          credit:          0,
          grootboekNaam:   "Inkopen vrij",
          grootboekNummer: 7003,
          btwSoort:        0,
          btwPercentage:   null
        });
        currentSheetRow += 2;
      } else {
        const btwSoort    = vatPct === 9 ? 1 : 2;
        const inkoopNaam  = vatPct === 9 ? "Inkoop laag tarief"             : "Inkoop hoog tarief";
        const inkoopNr    = vatPct === 9 ? 7001                              : 7002;
        const btwNaam     = vatPct === 9 ? "BTW te vorderen laag (inkopen)" : "BTW te vorderen hoog (inkopen)";
        const btwNr       = vatPct === 9 ? 1681                              : 1680;

        addBookingRow(sheet, {
          ...inkoopCommon, ...dagboek,
          omschrijving:    { formula: `H${regel0Row}`, result: inkoopParty || "" },
          regel:           1,
          debet:           exclBtw,
          credit:          0,
          grootboekNaam:   inkoopNaam,
          grootboekNummer: inkoopNr,
          btwSoort,
          btwPercentage:   vatPct
        });

        addBookingRow(sheet, {
          ...inkoopCommon, ...dagboek,
          omschrijving:    { formula: `H${regel1Row}`, result: inkoopParty || "" },
          regel:           2,
          debet:           btwBedrag,
          credit:          0,
          grootboekNaam:   btwNaam,
          grootboekNummer: btwNr,
          btwSoort,
          btwPercentage:   vatPct
        });
        currentSheetRow += 3;
      }
    }
  });

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
