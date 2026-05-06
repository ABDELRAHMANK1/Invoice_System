import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const schema = z.object({
  status: z.enum(["pending", "processing", "done", "error"]),
  download_url: z.string().optional().nullable(),
  file_count: z.number().int().optional().nullable(),
  error: z.string().optional().nullable()
});

export async function PATCH(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { jobId } = await context.params;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid export job update", 400, parsed.error.flatten());

  const patch = {
    ...parsed.data,
    completed_at: ["done", "error"].includes(parsed.data.status) ? new Date().toISOString() : null
  };

  const { data, error } = await supabaseAdmin
    .from("export_jobs")
    .update(patch)
    .eq("id", jobId)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}
