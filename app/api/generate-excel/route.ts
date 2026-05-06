import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uploadExcelExport } from "@/lib/export-builders";
import { jsonError, requireInternalApiKey } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  rows: z.array(z.record(z.unknown())).max(20000),
  summary: z.record(z.unknown()).optional(),
  job_id: z.string().uuid()
});

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid Excel payload", 400, parsed.error.flatten());

  const result = await uploadExcelExport({
    rows: parsed.data.rows,
    summary: parsed.data.summary,
    jobId: parsed.data.job_id,
    baseUrl: req.nextUrl.origin
  });

  return NextResponse.json(result);
}
