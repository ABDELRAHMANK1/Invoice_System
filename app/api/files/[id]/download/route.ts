import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { signedReadUrl } from "@/lib/storage";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;
  const { data, error } = await supabaseAdmin.from("files").select("file_key").eq("id", id).single();
  if (error) return jsonError(error.message, error.code === "PGRST116" ? 404 : 500);

  const downloadUrl = await signedReadUrl(data.file_key, 60 * 10);
  return NextResponse.redirect(downloadUrl);
}
