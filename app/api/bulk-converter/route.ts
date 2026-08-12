// Bulk Snelstart Converter — dashboard endpoint.
//
// Accepts an EXTERNAL raw invoice spreadsheet (multipart upload) + a client_id,
// fuzzy-matches each row's Client name against that client's `customers` to
// resolve Relatiecodes, computes VAT from incl − excl, and returns the converted
// verkoop Boekingen workbook (base64) with the 22-column accepted Snelstart
// schema. Rows with a blank Relatiecode or an anomalous VAT rate are highlighted
// + carry a cell comment for manual review.
//
// READ-ONLY against Supabase (customers, for matching). Writes NOTHING to the
// invoices table — a pure file-to-file conversion, like lib/snelstart-convert's
// sibling route.

import { NextRequest, NextResponse } from "next/server";
import type ExcelJS from "exceljs";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { loadXlsxLenient } from "@/lib/xlsx-load";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildInvoiceExcelBuffer } from "@/lib/export-builders";
import {
  convertRawInvoiceSheet,
  RawConvertFormatError,
  RAW_MAX_BYTES,
  type RawConvertCustomer,
} from "@/lib/raw-invoice-convert";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("Expected a multipart/form-data upload", 400);
  }

  const file = form.get("file");
  const clientId = String(form.get("client_id") || "").trim();
  const sheetName = String(form.get("sheet") || "").trim();

  if (!(file instanceof File)) return jsonError("No file uploaded (form field 'file')", 400);
  if (!/\.xlsx$/i.test(file.name)) return jsonError("File must be an .xlsx spreadsheet", 400);
  if (file.size === 0) return jsonError("The uploaded file is empty", 400);
  if (file.size > RAW_MAX_BYTES) {
    return jsonError(`File too large — max ${Math.round(RAW_MAX_BYTES / 1024 / 1024)} MB`, 400);
  }
  if (!UUID_RE.test(clientId)) return jsonError("A client must be selected", 400);

  // Confirm the client exists (a stale dashboard fails clearly).
  const { data: clientRow, error: clientErr } = await supabaseAdmin
    .from("clients").select("id,name").eq("id", clientId).maybeSingle();
  if (clientErr) return jsonError(clientErr.message, 500);
  if (!clientRow) return jsonError("Client not found", 404);

  // This client's customers drive the fuzzy Relatiecode match (read-only).
  const { data: customerRows, error: custErr } = await supabaseAdmin
    .from("customers")
    .select("id,name,relatie_code")
    .eq("client_id", clientId)
    .limit(10000);
  if (custErr) return jsonError(custErr.message, 500);
  const customers = (customerRows ?? []) as RawConvertCustomer[];

  // Parse the uploaded workbook.
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    const wb = await loadXlsxLenient(Buffer.from(await file.arrayBuffer()));
    sheet = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  } catch {
    return jsonError("Could not read the file as a valid .xlsx workbook", 400);
  }
  if (!sheet) return jsonError(sheetName ? `Sheet "${sheetName}" not found` : "The workbook has no sheets", 400);

  // Convert (never writes to the DB). A headerless/wrong-shape sheet → 400.
  let rows, summary;
  try {
    ({ rows, summary } = convertRawInvoiceSheet(sheet, customers));
  } catch (e) {
    if (e instanceof RawConvertFormatError) return jsonError(e.message, 400);
    throw e;
  }

  // Unmatched Relatiecodes stay BLANK; unmatched/anomalous rows are flagged.
  const buffer = await buildInvoiceExcelBuffer(rows, {
    blankUnmatchedRelatiecode: true,
    flagReviewRows: true,
  });
  const filename = `Boekingen_verkoop_${clientRow.name.replace(/[^\w.-]+/g, "_")}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return NextResponse.json({
    summary,
    filename,
    file_base64: buffer.toString("base64"),
  });
}
