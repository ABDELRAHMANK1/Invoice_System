import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { extractInvoicesFromUrls } from "@/lib/ai-extraction";
import { jsonError, requireInternalApiKey } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  file_urls: z.array(z.string().min(8)).min(1).max(10)
});

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid extraction payload", 400, parsed.error.flatten());

  try {
    const data = await extractInvoicesFromUrls(parsed.data.file_urls);
    return NextResponse.json(data);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "AI extraction failed", 502);
  }
}
