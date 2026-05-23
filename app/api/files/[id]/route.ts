import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  if (!id) return jsonError("Missing id", 400);

  const { error } = await supabaseAdmin.from("files").delete().eq("id", id);
  if (error) {
    console.error("[DELETE /api/files/[id]] Supabase error:", error);
    return jsonError(error.message, 500);
  }

  return new NextResponse(null, { status: 204 });
}
