import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import {
  discoverTemplateFields,
  guessFieldMapping,
  TEMPLATE_MAX_BYTES,
} from "@/lib/template-fill";

export const runtime = "nodejs";

// POST /api/templates/inspect — step 1 of the "upload a template" flow.
// Accepts a multipart PDF, discovers its AcroForm fields, and returns them plus
// an auto-generated field → clients-column mapping. Writes NOTHING (no S3, no
// DB) — this is a pure preview so Ammar can confirm before saving.
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
  if (!(file instanceof File)) return jsonError("A PDF file is required", 400);
  if (file.size === 0) return jsonError("The uploaded file is empty", 400);
  if (file.size > TEMPLATE_MAX_BYTES) return jsonError("File is too large (max 10 MB)", 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    return jsonError("Only PDF files are supported", 400);
  }

  let fields: string[];
  try {
    fields = await discoverTemplateFields(buffer);
  } catch {
    return jsonError("Could not read this PDF — it may be corrupt or password-protected", 400);
  }

  if (fields.length === 0) {
    return jsonError("This PDF has no fillable form fields, so it can't be used as a template", 400);
  }

  const mapping = guessFieldMapping(fields);
  return NextResponse.json({ fields, mapping });
}
