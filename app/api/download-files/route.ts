import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { uploadZipExport } from "@/lib/export-builders";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { applyCommonFilters, filtersFromRequest } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 180;

async function handle(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  let url = req.nextUrl;
  if (req.method === "POST") {
    const body = await req.json();
    const postUrl = new URL(req.url);
    if (body.phone) postUrl.searchParams.set("phone", body.phone);
    if (body.from) postUrl.searchParams.set("from", body.from);
    if (body.to) postUrl.searchParams.set("to", body.to);
    url = new NextRequest(postUrl.toString()).nextUrl;
  }

  const fakeReq = new NextRequest(url.toString());
  const filters = filtersFromRequest(fakeReq);
  let query = supabaseAdmin.from("files").select("file_key");
  query = applyCommonFilters(query, filters, "created_at");
  const { data, error } = await query.order("created_at", { ascending: true }).limit(500);

  if (error) return jsonError(error.message, 500);

  const result = await uploadZipExport({
    fileUrls: (data || []).map((row) => row.file_key),
    jobId: randomUUID(),
    baseUrl: req.nextUrl.origin
  });

  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
