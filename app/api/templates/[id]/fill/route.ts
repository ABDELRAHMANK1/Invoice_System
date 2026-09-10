import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { env } from "@/lib/env";
import { s3, uploadBuffer, signedReadUrl } from "@/lib/storage";
import { fillTemplate, templateExtension, TEMPLATE_FORMAT_MIME } from "@/lib/template-fill";
import { fillDocxTemplate } from "@/lib/docx-fill";

export const runtime = "nodejs";

const bodySchema = z.object({
  client_id: z.string().uuid("A client must be selected"),
});

// POST /api/templates/[id]/fill — fill a template with a client's data.
// Loads the template row (s3_key + kind + field_mapping) and the client row,
// downloads the blank template from S3, fills it through the path its `kind`
// selects, stores the result under `filled-templates/`, and returns a signed
// download URL. The filled file keeps the source's format — a .docx template
// yields a .docx.
//
// A `static` template has no fill path by definition; it is downloaded blank via
// GET /api/templates/[id]/download instead.
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request body", 400, parsed.error.flatten());

  const { data: template, error: tErr } = await supabaseAdmin
    .from("document_templates")
    .select("id, name, s3_key, kind, field_mapping")
    .eq("id", id)
    .maybeSingle();
  if (tErr) return jsonError(tErr.message, 500);
  if (!template) return jsonError("Template not found", 404);
  if (!template.s3_key) return jsonError("Template has no source file", 400);
  if (template.kind === "static") {
    return jsonError(
      "This template has no fillable fields — download it blank instead",
      400,
    );
  }

  const { data: client, error: cErr } = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("id", parsed.data.client_id)
    .maybeSingle();
  if (cErr) return jsonError(cErr.message, 500);
  if (!client) return jsonError("Client not found", 404);

  const bucket = env.s3Bucket || env.required("AWS_S3_BUCKET");

  // Download the blank template from S3.
  let templateBuffer: Buffer;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: template.s3_key }));
    const bytes = await obj.Body!.transformToByteArray();
    templateBuffer = Buffer.from(bytes);
  } catch (e) {
    console.error("[templates.fill] Failed to download template from S3:", e);
    return jsonError("Could not load the template file", 502);
  }

  // Fill it with the client's data, through the path this template's kind picks.
  let filled: Buffer;
  try {
    const mapping = (template.field_mapping ?? {}) as Record<string, string>;
    filled =
      template.kind === "docx_placeholder"
        ? await fillDocxTemplate(templateBuffer, mapping, client)
        : await fillTemplate(templateBuffer, mapping, client);
  } catch (e) {
    console.error("[templates.fill] Fill failed:", e);
    return jsonError("Could not fill the template", 500);
  }

  // Store the filled document and return a short-lived signed download URL. The
  // extension follows the SOURCE template, not a hardcoded .pdf.
  try {
    const ext = templateExtension(template.s3_key);
    const contentType =
      template.kind === "docx_placeholder" ? TEMPLATE_FORMAT_MIME.docx : TEMPLATE_FORMAT_MIME.pdf;
    const key = `filled-templates/${template.id}/${client.id}/${crypto.randomUUID()}.${ext}`;
    const fileUrl = await uploadBuffer({ key, body: filled, contentType });
    const safeName = `${template.name} - ${client.name}`.replace(/[^\w.\- ]/g, "_").slice(0, 120);
    const downloadUrl = await signedReadUrl(fileUrl, 60 * 10, { downloadName: `${safeName}.${ext}` });
    return NextResponse.json({ file_url: downloadUrl });
  } catch (e) {
    console.error("[templates.fill] Upload/sign failed:", e);
    return jsonError("Could not store the filled document", 500);
  }
}
