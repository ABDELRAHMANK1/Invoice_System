import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { signedReadUrl } from "@/lib/storage";
import { templateExtension } from "@/lib/template-fill";

export const runtime = "nodejs";

// GET /api/templates/[id]/download — download the BLANK template, exactly as it
// was uploaded: no client, no fill step. That is the only way to get a `static`
// template out (a contract to print and sign by hand), and a useful shortcut for
// the fillable ones too.
//
// 307s to a short-lived signed S3 URL rather than streaming the bytes — the
// blank template is a stored artifact, so this mirrors
// app/api/invoices/[id]/download/route.ts. `?inline=1` previews in-tab.
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;

  const { data: template, error } = await supabaseAdmin
    .from("document_templates")
    .select("id, name, s3_key")
    .eq("id", id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!template) return jsonError("Template not found", 404);
  if (!template.s3_key) return jsonError("This template has no source file", 404);

  const inline = req.nextUrl.searchParams.get("inline") === "1";
  const ext = templateExtension(template.s3_key);
  const downloadName = `${String(template.name || id)}.${ext}`;

  const url = await signedReadUrl(template.s3_key, 60 * 10, { downloadName, inline });
  return NextResponse.redirect(url);
}
