import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { uploadBuffer } from "@/lib/storage";
import {
  detectTemplateFormat,
  inspectTemplate,
  sanitizeFieldMapping,
  TEMPLATE_FORMAT_MIME,
  TEMPLATE_MAX_BYTES,
} from "@/lib/template-fill";

export const runtime = "nodejs";

// List all document templates for the "Document Templates" page. `kind` tells
// the UI which actions a template supports (a `static` one can only be
// downloaded blank); field_mapping stays server-side.
export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { data, error } = await supabaseAdmin
    .from("document_templates")
    .select("id, name, description, kind, mime_type")
    .order("created_at", { ascending: false });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ data: data ?? [] });
}

// POST /api/templates — step 2 of the "upload a template" flow. Accepts a
// multipart PDF / .docx / .xlsx + name/description + the field_mapping (JSON)
// produced by /inspect, uploads the blank document to S3, and inserts the
// document_templates row.
//
// The KIND and the field list are both re-derived from the actual bytes here —
// the client's posted mapping is never trusted, and neither is a posted kind.
// A document with nothing to fill is stored as `static` (download-blank only)
// instead of being rejected.
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
  if (!(file instanceof File)) return jsonError("A file is required", 400);
  if (file.size === 0) return jsonError("The uploaded file is empty", 400);
  if (file.size > TEMPLATE_MAX_BYTES) return jsonError("File is too large (max 10 MB)", 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  const format = await detectTemplateFormat(buffer);
  if (!format) {
    return jsonError("Unsupported file type — upload a PDF, Word (.docx) or Excel (.xlsx) file", 400);
  }

  // Re-discover the fill mode + fields from the actual bytes, so the stored
  // mapping can only reference fields that really exist in THIS document.
  let inspected: { kind: string; fields: string[] };
  try {
    inspected = await inspectTemplate(buffer, format);
  } catch {
    return jsonError("Could not read this document — it may be corrupt or password-protected", 400);
  }

  let posted: Record<string, unknown>;
  try {
    posted = JSON.parse(mappingRaw);
    if (typeof posted !== "object" || posted === null || Array.isArray(posted)) throw new Error();
  } catch {
    return jsonError("Invalid field mapping", 400);
  }

  // Re-validate against the actual bytes + the clients-column allow-list.
  // Whatever the UI sent (auto-guess or human-edited), only real field → real
  // column pairs survive; tampered targets are dropped, never stored. A `static`
  // template has no fields, so this necessarily collapses to {}.
  const mapping = sanitizeFieldMapping(posted, inspected.fields);

  const contentType = TEMPLATE_FORMAT_MIME[format];
  const s3Key = `templates/${crypto.randomUUID()}.${format}`;
  try {
    await uploadBuffer({ key: s3Key, body: buffer, contentType });
  } catch (e) {
    console.error("[templates.create] S3 upload failed:", e);
    return jsonError("Could not store the template file", 502);
  }

  const { data, error } = await supabaseAdmin
    .from("document_templates")
    .insert({
      name,
      description: description || null,
      s3_key: s3Key,
      kind: inspected.kind,
      mime_type: contentType,
      field_mapping: mapping,
    })
    .select("id, name, description, kind, mime_type")
    .single();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ data }, { status: 201 });
}
