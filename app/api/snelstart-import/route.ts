// Snelstart import — dashboard self-serve conversion endpoint.
//
// Accepts a raw Snelstart "Alle-facturen" export (multipart upload) + a
// client_id, fuzzy-matches the counterparty names against that client's
// `customers` to resolve Relatiecodes, and returns the converted native verkoop
// Boekingen workbook (base64) alongside the summary the page renders.
//
// READ-ONLY against Supabase (customers, for matching). It writes NOTHING to the
// invoices table — this is a pure file-to-file conversion, exactly like the CLI
// (scripts/convert-snelstart-import.ts); both share lib/snelstart-convert.ts.

import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildInvoiceExcelBuffer } from "@/lib/export-builders";
import {
  convertSnelstartSheet,
  SnelstartFormatError,
  SNELSTART_MAX_BYTES,
  type SnelstartCustomer,
} from "@/lib/snelstart-convert";

export const runtime = "nodejs";

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
  if (file.size > SNELSTART_MAX_BYTES) {
    return jsonError(`File too large — max ${Math.round(SNELSTART_MAX_BYTES / 1024 / 1024)} MB`, 400);
  }
  if (!UUID_RE.test(clientId)) return jsonError("A client must be selected", 400);

  // This client's customers drive the fuzzy Relatiecode match (read-only).
  const { data: customerRows, error: custErr } = await supabaseAdmin
    .from("customers")
    .select("id,client_id,name,relatie_code")
    .eq("client_id", clientId)
    .limit(10000);
  if (custErr) return jsonError(custErr.message, 500);
  const customers = (customerRows ?? []) as SnelstartCustomer[];

  // Parse the uploaded workbook.
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as unknown as ArrayBuffer);
    sheet = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  } catch {
    return jsonError("Could not read the file as a valid .xlsx workbook", 400);
  }
  if (!sheet) return jsonError(sheetName ? `Sheet "${sheetName}" not found` : "The workbook has no sheets", 400);

  // Convert (never writes to the DB). A wrong-shape sheet → 400 with a clear message.
  let rows, summary;
  try {
    ({ rows, summary } = convertSnelstartSheet(sheet, customers));
  } catch (e) {
    if (e instanceof SnelstartFormatError) return jsonError(e.message, 400);
    throw e;
  }

  // Unmatched rows keep a BLANK Relatiecode (no boekstuk fallback) for manual fill-in.
  const buffer = await buildInvoiceExcelBuffer(rows, { blankUnmatchedRelatiecode: true });
  const filename = `Boekingen_verkoop_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return NextResponse.json({
    summary,
    filename,
    file_base64: buffer.toString("base64"),
  });
}
