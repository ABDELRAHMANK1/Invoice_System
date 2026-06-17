import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { signedReadUrl } from "@/lib/storage";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;
  const { data, error } = await supabaseAdmin.from("invoices").select("file_url, invoice_number").eq("id", id).single();
  if (error) return jsonError(error.message, error.code === "PGRST116" ? 404 : 500);
  if (!data.file_url) return jsonError("This invoice has no file", 404);

  // ?inline=1 → view in the browser; otherwise download with a friendly name.
  const inline = req.nextUrl.searchParams.get("inline") === "1";
  const ext = (data.file_url.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] || "pdf").toLowerCase();
  const safeNumber = String(data.invoice_number || id).replace(/[^\w.\-]/g, "_");
  const downloadName = `Invoice ${safeNumber}.${ext}`;

  const downloadUrl = data.file_url.startsWith("s3://")
    ? await signedReadUrl(data.file_url, 60 * 10, { downloadName, inline })
    : data.file_url;
  return NextResponse.redirect(downloadUrl);
}
