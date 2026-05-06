import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  status: z.enum(["pending", "processing", "done", "error"]),
  error_message: z.string().optional().nullable()
});

export async function PATCH(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid batch status payload", 400, parsed.error.flatten());

  const { ids, status, error_message } = parsed.data;
  const { data, error } = await supabaseAdmin
    .from("files")
    .update({ status, error_message: error_message ?? null })
    .in("id", ids)
    .select("id,status,error_message");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ updated: data?.length ?? 0, data });
}
