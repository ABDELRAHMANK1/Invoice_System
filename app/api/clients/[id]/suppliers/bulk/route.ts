import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 1000;

/**
 * Header names this importer recognises for each target field. Match is
 * normalised (lowercased, punctuation/whitespace stripped) so "Relatie Code",
 * "RelatieCode", "Relatie_code", "Code" all hit the same field.
 */
const COLUMN_ALIASES = {
  name:         ["name", "naam", "supplier", "leverancier", "suppliername", "leveranciersnaam"],
  relatie_code: ["relatiecode", "relatie", "code", "snelstartcode", "klantcode", "leverancierscode"],
  address:      ["address", "adres", "straat"],
  postcode:     ["postcode", "zip", "zipcode", "postalcode"],
  city:         ["city", "plaats", "stad"],
  kvk:          ["kvk", "kvknumber", "kvknr"],
  btw_number:   ["btw", "btwnumber", "btwnr", "vatnumber", "vat"],
  iban:         ["iban", "bankaccount", "bank"],
  email:        ["email", "emailaddress", "mail"],
  phone:        ["phone", "telefoon", "tel", "mobile"],
  payment_days: ["paymentdays", "betalingstermijn", "termijn", "days"],
} as const;

type Field = keyof typeof COLUMN_ALIASES;

function normaliseHeader(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[\s_.\-/]/g, "");
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  // Rich text / formula / hyperlink shapes
  if (typeof value === "object") {
    if ("text" in value && typeof (value as { text: unknown }).text === "string") return ((value as { text: string }).text).trim();
    if ("result" in value) return cellToString((value as { result: ExcelJS.CellValue }).result);
    if ("richText" in value && Array.isArray((value as { richText: { text: string }[] }).richText)) {
      return (value as { richText: { text: string }[] }).richText.map((r) => r.text).join("").trim();
    }
  }
  return String(value).trim();
}

interface ParsedRow {
  rowNum: number;
  name: string | null;
  relatie_code: string | null;
  address?: string | null;
  postcode?: string | null;
  city?: string | null;
  kvk?: string | null;
  btw_number?: string | null;
  iban?: string | null;
  email?: string | null;
  phone?: string | null;
  payment_days?: number | null;
}

interface RowError { row: number; reason: string }

function parseWorkbook(workbook: ExcelJS.Workbook): { rows: ParsedRow[]; errors: RowError[]; headerMap: Partial<Record<Field, number>> } {
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], errors: [{ row: 0, reason: "Workbook has no sheets" }], headerMap: {} };

  // Build header → column-index map from row 1
  const headerMap: Partial<Record<Field, number>> = {};
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const norm = normaliseHeader(cellToString(cell.value));
    if (!norm) return;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [Field, readonly string[]][]) {
      if (headerMap[field] != null) continue;
      if (aliases.includes(norm)) {
        headerMap[field] = colNumber;
        return;
      }
    }
  });

  const errors: RowError[] = [];
  if (headerMap.name == null) {
    errors.push({ row: 1, reason: "No 'Name' / 'Naam' column found in the first row" });
    return { rows: [], errors, headerMap };
  }

  const rows: ParsedRow[] = [];
  const lastRow = Math.min(sheet.rowCount, MAX_ROWS + 1); // +1 for header
  for (let r = 2; r <= lastRow; r += 1) {
    const xr = sheet.getRow(r);
    const name = cellToString(xr.getCell(headerMap.name!).value);
    if (!name) continue; // skip blank rows entirely

    const parsed: ParsedRow = { rowNum: r, name, relatie_code: null };
    for (const [field, col] of Object.entries(headerMap) as [Field, number][]) {
      if (field === "name" || col == null) continue;
      const v = cellToString(xr.getCell(col).value);
      if (field === "payment_days") {
        const n = Number(v);
        parsed.payment_days = Number.isFinite(n) ? Math.max(0, Math.min(365, Math.round(n))) : null;
      } else {
        (parsed as unknown as Record<string, unknown>)[field] = v || null;
      }
    }
    rows.push(parsed);
  }

  if (sheet.rowCount > MAX_ROWS + 1) {
    errors.push({ row: MAX_ROWS + 2, reason: `File has more than ${MAX_ROWS} rows; only the first ${MAX_ROWS} were imported.` });
  }
  return { rows, errors, headerMap };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;

  // Pre-check the client exists so a stale dashboard fails clearly.
  const { data: clientRow, error: clientErr } = await supabaseAdmin
    .from("clients").select("id").eq("id", id).maybeSingle();
  if (clientErr) {
    console.error(`[suppliers.bulk] client lookup failed for client_id=${id}:`, clientErr);
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

  const { rows: parsedRows, errors: parseErrors, headerMap } = parseWorkbook(workbook);
  if (parseErrors.some((e) => e.row === 1)) {
    return NextResponse.json({ error: "Invalid Excel header", details: parseErrors }, { status: 400 });
  }

  // Dedupe against existing suppliers for this client (case-insensitive on name).
  const { data: existing, error: existErr } = await supabaseAdmin
    .from("suppliers").select("name").eq("client_id", id);
  if (existErr) {
    console.error(`[suppliers.bulk] existing-supplier query failed:`, existErr);
    return jsonError(existErr.message, 500);
  }
  const existingNames = new Set<string>((existing ?? []).map((s) => (s.name ?? "").toLowerCase().trim()));

  const seenInBatch = new Set<string>();
  const toInsert: Omit<ParsedRow, "rowNum">[] = [];
  const skipped: RowError[] = [];
  for (const row of parsedRows) {
    const key = row.name!.toLowerCase().trim();
    if (existingNames.has(key)) { skipped.push({ row: row.rowNum, reason: `"${row.name}" already exists for this client` }); continue; }
    if (seenInBatch.has(key))   { skipped.push({ row: row.rowNum, reason: `"${row.name}" appears more than once in the file` }); continue; }
    seenInBatch.add(key);
    const { rowNum: _ignored, ...rest } = row;
    void _ignored;
    toInsert.push({ ...rest, client_id: id } as Omit<ParsedRow, "rowNum"> & { client_id: string });
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const { data: ins, error: insErr } = await supabaseAdmin
      .from("suppliers")
      .insert(toInsert)
      .select("id");
    if (insErr) {
      console.error(`[suppliers.bulk] bulk insert failed for client_id=${id}:`, insErr);
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
  console.log(`[suppliers.bulk] client_id=${id} inserted=${inserted} skipped=${skipped.length} total=${parsedRows.length}`);
  return NextResponse.json(result, { status: 200 });
}
