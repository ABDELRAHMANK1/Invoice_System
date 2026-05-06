import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { buildInvoiceObjectKey, uploadBuffer } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  // ── 2. Parse multipart form ────────────────────────────────────────────────
  const form = await req.formData();
  const file        = form.get("file");
  const phoneNumber = String(form.get("phone_number") || "").trim();
  const fileType    = String(form.get("file_type")    || "").trim();

  // ── 3. Validate ────────────────────────────────────────────────────────────
  if (!(file instanceof File))
    return jsonError("Missing multipart file field", 400);

  if (!phoneNumber)
    return jsonError("Missing phone_number", 400);

  if (!["image", "pdf"].includes(fileType))
    return jsonError("file_type must be 'image' or 'pdf'", 400);

  // ── 4. Upload binary to S3 ─────────────────────────────────────────────────
  const buffer = Buffer.from(await file.arrayBuffer());

  const key = buildInvoiceObjectKey({
    phoneNumber,
    fileType,
    mimeType:     file.type,
    originalName: file.name,
  });

  await uploadBuffer({
    key,
    body:        buffer,
    contentType: file.type || "application/octet-stream",
    metadata: {
      phone_number: phoneNumber,
      source:       "whatsapp",
    },
  });

  // ── 5. Return key + stable s3:// URL ──────────────────────────────────────
  //
  //  IMPORTANT: We return the S3 key and an s3:// URI — NOT a signed URL.
  //
  //  Reasons:
  //   • Signed URLs expire (300 s – 24 h).  Storing them in the DB means they
  //     become dead links the moment they expire.
  //   • The DB schema (files table) stores `file_key`, not `file_url`.
  //   • Signed URLs are generated on-demand by GET /api/files/url?key=...
  //     whenever a real download is needed (dashboard, AI extraction, exports).
  //
  //  The s3:// URI is a stable, internal reference that never expires.
  //  It is stored in invoices.file_url so exports do not need an extra join.
  //
  const bucket  = process.env.AWS_S3_BUCKET!;
  const s3Uri   = `s3://${bucket}/${key}`;

  return NextResponse.json({
    file_key:  key,          // → saved in files.file_key
    file_url:  s3Uri,        // → saved in invoices.file_url  (s3:// format)
    file_name: file.name || key.split("/").pop() || key,
    file_size: buffer.byteLength,
    mime_type: file.type || null,
  });
}