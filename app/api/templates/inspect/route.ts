import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import {
  detectTemplateFormat,
  guessFieldMapping,
  inspectTemplate,
  TEMPLATE_MAX_BYTES,
} from "@/lib/template-fill";

export const runtime = "nodejs";

// POST /api/templates/inspect — step 1 of the "upload a template" flow.
// Accepts a multipart PDF / .docx / .xlsx, works out how (or whether) it can be
// filled, and returns its fillable fields plus an auto-generated field →
// clients-column mapping. Writes NOTHING (no S3, no DB) — this is a pure preview
// so Ammar can confirm before saving.
//
// A document with nothing to fill is NOT an error: it comes back as
// `kind: "static"` with no fields, and the UI offers to save it as a
// download-blank-only template. Rejecting it was the old PDF-form-only rule.
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
  if (!(file instanceof File)) return jsonError("A file is required", 400);
  if (file.size === 0) return jsonError("The uploaded file is empty", 400);
  if (file.size > TEMPLATE_MAX_BYTES) return jsonError("File is too large (max 10 MB)", 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  const format = await detectTemplateFormat(buffer);
  if (!format) {
    return jsonError("Unsupported file type — upload a PDF, Word (.docx) or Excel (.xlsx) file", 400);
  }

  let inspected: { kind: string; fields: string[] };
  try {
    inspected = await inspectTemplate(buffer, format);
  } catch {
    return jsonError(
      format === "pdf"
        ? "Could not read this PDF — it may be corrupt or password-protected"
        : "Could not read this document — it may be corrupt or password-protected",
      400,
    );
  }

  // Placeholder names in a .docx were authored by hand, so they can be trusted
  // in a way a government form's field names can't (see guessFieldMapping).
  const mapping = guessFieldMapping(inspected.fields, {
    authoredNames: inspected.kind === "docx_placeholder",
  });
  return NextResponse.json({ format, kind: inspected.kind, fields: inspected.fields, mapping });
}
