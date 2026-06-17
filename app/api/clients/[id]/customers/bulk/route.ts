import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  CUSTOMER_COLUMN_ALIASES,
  parseCounterpartyWorkbook,
  type ParsedRow,
  type RowError,
} from "@/lib/counterparty-import";

export const runtime = "nodejs";
export const maxDuration = 60;

// Excel (.xlsx) import for customers (Klanten). Mirrors the suppliers bulk
// import, but the workbook parser is factored into lib/counterparty-import.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;

  // Pre-check the client exists so a stale dashboard fails clearly.
  const { data: clientRow, error: clientErr } = await supabaseAdmin
    .from("clients").select("id").eq("id", id).maybeSingle();
  if (clientErr) {
    console.error(`[customers.bulk] client lookup failed for client_id=${id}:`, clientErr);
    return jsonError(clientErr.message, 500);
  }
  if (!clientRow) return jsonError("Client not found", 404);

  // Read the multipart upload
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return jsonError(`Invalid multipart body: ${e instanceof Error ? e.message : "parse failed"}`, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError("Missing 'file' field", 400);
  if (file.size === 0)         return jsonError("Uploaded file is empty", 400);
  if (file.size > 8 * 1024 * 1024) return jsonError("File too large (max 8 MB)", 413);

  // Parse the workbook
  const workbook = new ExcelJS.Workbook();
  try {
    const arrayBuffer = await file.arrayBuffer();
    await workbook.xlsx.load(arrayBuffer);
  } catch (e) {
    return jsonError(`Could not read .xlsx: ${e instanceof Error ? e.message : "parse failed"}`, 400);
  }

  const { rows: parsedRows, errors: parseErrors, headerMap } = parseCounterpartyWorkbook(workbook, CUSTOMER_COLUMN_ALIASES);
  if (parseErrors.some((e) => e.row === 1)) {
    return NextResponse.json({ error: "Invalid Excel header", details: parseErrors }, { status: 400 });
  }

  // Dedupe against existing customers for this client (case-insensitive on name).
  const { data: existing, error: existErr } = await supabaseAdmin
    .from("customers").select("name").eq("client_id", id);
  if (existErr) {
    console.error(`[customers.bulk] existing-customer query failed:`, existErr);
    return jsonError(existErr.message, 500);
  }
  const existingNames = new Set<string>((existing ?? []).map((s) => (s.name ?? "").toLowerCase().trim()));

  const seenInBatch = new Set<string>();
  const toInsert: (Omit<ParsedRow, "rowNum"> & { client_id: string })[] = [];
  const skipped: RowError[] = [];
  for (const row of parsedRows) {
    const key = row.name!.toLowerCase().trim();
    if (existingNames.has(key)) { skipped.push({ row: row.rowNum, reason: `"${row.name}" already exists for this client` }); continue; }
    if (seenInBatch.has(key))   { skipped.push({ row: row.rowNum, reason: `"${row.name}" appears more than once in the file` }); continue; }
    seenInBatch.add(key);
    const { rowNum: _ignored, ...rest } = row;
    void _ignored;
    toInsert.push({ ...rest, client_id: id });
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const { data: ins, error: insErr } = await supabaseAdmin
      .from("customers")
      .insert(toInsert)
      .select("id");
    if (insErr) {
      console.error(`[customers.bulk] bulk insert failed for client_id=${id}:`, insErr);
      return jsonError(`Insert failed: ${insErr.message}`, 500);
    }
    inserted = ins?.length ?? 0;
  }

  const result = {
    inserted,
    skipped: skipped.length,
    total_rows: parsedRows.length,
    detected_columns: Object.keys(headerMap),
    skipped_rows: skipped,
    warnings: parseErrors,
  };
  console.log(`[customers.bulk] client_id=${id} inserted=${inserted} skipped=${skipped.length} total=${parsedRows.length}`);
  return NextResponse.json(result, { status: 200 });
}
