import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uploadZipExport } from "@/lib/export-builders";
import { jsonError, requireInternalApiKey } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 180;

const schema = z.object({
  file_urls: z.array(z.string().min(8)).max(500),
  job_id: z.string().uuid()
});

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid ZIP payload", 400, parsed.error.flatten());

  const result = await uploadZipExport({
    fileUrls: parsed.data.file_urls,
    jobId: parsed.data.job_id,
    baseUrl: req.nextUrl.origin
  });

  return NextResponse.json(result);
}
