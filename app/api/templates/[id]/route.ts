import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { env } from "@/lib/env";
import { s3 } from "@/lib/storage";

export const runtime = "nodejs";

// DELETE /api/templates/[id] — remove a template so a bad unsupervised upload can
// be undone without a developer. Deletes the S3 object (best-effort) then the
// row. If the row is already gone we still return ok (idempotent).
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;

  const { data: template, error: tErr } = await supabaseAdmin
    .from("document_templates")
    .select("id, s3_key")
    .eq("id", id)
    .maybeSingle();
  if (tErr) return jsonError(tErr.message, 500);
  if (!template) return NextResponse.json({ ok: true });

  if (template.s3_key) {
    try {
      const bucket = env.s3Bucket || env.required("AWS_S3_BUCKET");
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: template.s3_key }));
    } catch (e) {
      // Non-fatal: a leftover S3 object is preferable to a broken UI. The row is
      // still removed so the template disappears from the list.
      console.warn("[templates.delete] Failed to delete S3 object:", e);
    }
  }

  const { error: dErr } = await supabaseAdmin
    .from("document_templates")
    .delete()
    .eq("id", id);
  if (dErr) return jsonError(dErr.message, 500);

  return NextResponse.json({ ok: true });
}
