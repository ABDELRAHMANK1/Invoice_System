import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const schema = z.object({
  status: z.enum(["pending", "processing", "done", "error"]),
  error_message: z.string().optional().nullable()
});

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid status payload", 400, parsed.error.flatten());

  const { data, error } = await supabaseAdmin
    .from("files")
    .update(parsed.data)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}
