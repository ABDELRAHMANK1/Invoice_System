import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { uploadBuffer } from "@/lib/storage";
import {
  discoverTemplateFields,
  sanitizeFieldMapping,
  TEMPLATE_MAX_BYTES,
} from "@/lib/template-fill";

export const runtime = "nodejs";

// List all document templates for the "Document Templates" page. Only the
// display fields are returned — s3_key and field_mapping stay server-side.
export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { data, error } = await supabaseAdmin
    .from("document_templates")
    .select("id, name, description")
    .order("created_at", { ascending: false });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ data: data ?? [] });
}

// POST /api/templates — step 2 of the "upload a template" flow. Accepts a
// multipart PDF + name/description + the field_mapping (JSON) produced by
// /inspect, uploads the blank PDF to S3, and inserts the document_templates row.
// The mapping is re-validated server-side (fields must exist in the PDF; targets
// must be real clients columns) — never trust the client's posted mapping.
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
  const name = String(form.get("name") || "").trim();
  const description = String(form.get("description") || "").trim();
  const mappingRaw = String(form.get("mapping") || "{}");

  if (!name) return jsonError("A template name is required", 400);
  if (!(file instanceof File)) return jsonError("A PDF file is required", 400);
  if (file.size === 0) return jsonError("The uploaded file is empty", 400);
  if (file.size > TEMPLATE_MAX_BYTES) return jsonError("File is too large (max 10 MB)", 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    return jsonError("Only PDF files are supported", 400);
  }

  // Re-discover the fields from the actual bytes so the stored mapping can only
  // reference fields that really exist in this PDF.
  let fields: string[];
  try {
    fields = await discoverTemplateFields(buffer);
  } catch {
    return jsonError("Could not read this PDF — it may be corrupt or password-protected", 400);
  }
  if (fields.length === 0) {
    return jsonError("This PDF has no fillable form fields, so it can't be used as a template", 400);
  }
  let posted: Record<string, unknown>;
  try {
    posted = JSON.parse(mappingRaw);
    if (typeof posted !== "object" || posted === null || Array.isArray(posted)) throw new Error();
  } catch {
    return jsonError("Invalid field mapping", 400);
  }

  // Re-validate against the actual PDF bytes + the clients-column allow-list.
  // Whatever the UI sent (auto-guess or human-edited), only real field → real
  // column pairs survive; tampered targets are dropped, never stored.
  const mapping = sanitizeFieldMapping(posted, fields);

  const s3Key = `templates/${crypto.randomUUID()}.pdf`;
  try {
    await uploadBuffer({ key: s3Key, body: buffer, contentType: "application/pdf" });
  } catch (e) {
    console.error("[templates.create] S3 upload failed:", e);
    return jsonError("Could not store the template PDF", 502);
  }

  const { data, error } = await supabaseAdmin
    .from("document_templates")
    .insert({ name, description: description || null, s3_key: s3Key, field_mapping: mapping })
    .select("id, name, description")
    .single();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ data }, { status: 201 });
}
