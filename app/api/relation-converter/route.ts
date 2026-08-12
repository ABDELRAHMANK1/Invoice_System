// Snelstart relation-template converter — dashboard endpoint.
//
// Accepts an EXTERNAL supplier (Leveranciers) or customer (Klanten) spreadsheet
// (multipart upload) + a `kind`, reshapes it into Snelstart's exact accepted
// relation import template, and returns the conformed workbook (base64).
//
// Pure FILE→FILE: no Supabase, no client selection, writes NOTHING to the DB.
// Sibling of app/api/bulk-converter (which produces Boekingen rows and DOES need
// the DB for Relatiecode matching) — this one only conforms columns.

import { NextRequest, NextResponse } from "next/server";
import type ExcelJS from "exceljs";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { loadXlsxLenient } from "@/lib/xlsx-load";
import {
  convertRelationSheet,
  buildRelationTemplateBuffer,
  RelationConvertFormatError,
  RELATION_MAX_BYTES,
  RELATION_TEMPLATES,
  type RelationKind,
} from "@/lib/relation-template-convert";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseKind(raw: string): RelationKind | null {
  const k = raw.trim().toLowerCase();
  if (k === "leverancier" || k === "leveranciers") return "leverancier";
  if (k === "klant" || k === "klanten") return "klant";
  return null;
}

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
  const kind = parseKind(String(form.get("kind") || ""));
  const sheetName = String(form.get("sheet") || "").trim();

  if (!kind) return jsonError("Missing or invalid 'kind' (expected 'leverancier' or 'klant')", 400);
  if (!(file instanceof File)) return jsonError("No file uploaded (form field 'file')", 400);
  if (!/\.xlsx$/i.test(file.name)) return jsonError("File must be an .xlsx spreadsheet", 400);
  if (file.size === 0) return jsonError("The uploaded file is empty", 400);
  if (file.size > RELATION_MAX_BYTES) {
    return jsonError(`File too large — max ${Math.round(RELATION_MAX_BYTES / 1024 / 1024)} MB`, 400);
  }

  // Parse the uploaded workbook.
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    const wb = await loadXlsxLenient(Buffer.from(await file.arrayBuffer()));
    sheet = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  } catch {
    return jsonError("Could not read the file as a valid .xlsx workbook", 400);
  }
  if (!sheet) return jsonError(sheetName ? `Sheet "${sheetName}" not found` : "The workbook has no sheets", 400);

  // Conform to the Snelstart template (never writes to the DB). Wrong-shape → 400.
  let result;
  try {
    result = convertRelationSheet(sheet, kind);
  } catch (e) {
    if (e instanceof RelationConvertFormatError) return jsonError(e.message, 400);
    throw e;
  }

  const buffer = await buildRelationTemplateBuffer(result);
  const label = RELATION_TEMPLATES[kind].label.toLowerCase();
  const filename = `Snelstart_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return NextResponse.json({
    summary: result.summary,
    filename,
    file_base64: buffer.toString("base64"),
  });
}
