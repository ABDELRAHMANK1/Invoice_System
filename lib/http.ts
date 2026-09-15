import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

export function jsonError(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status });
}

export function requireInternalApiKey(req: NextRequest) {
  if (!env.apiInternalKey) return null;

  // Browser requests from the dashboard run on the same origin and cannot attach
  // the private n8n API key to normal links (an <a download> sends no headers).
  // Those requests are NOT unauthenticated: middleware.ts has already resolved
  // the Supabase session and checked the route's permission before the handler
  // runs, so this only decides whether an EXTRA machine key is also required.
  if (req.headers.get("sec-fetch-site") === "same-origin") return null;

  const provided = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== env.apiInternalKey) {
    return jsonError("Unauthorized", 401);
  }

  return null;
}

export function pagination(req: NextRequest, defaultLimit = 20, maxLimit = 1000) {
  const page = Math.max(Number(req.nextUrl.searchParams.get("page") || 1), 1);
  const rawLimit = Number(req.nextUrl.searchParams.get("limit") || defaultLimit);
  const limit = Math.min(Math.max(rawLimit, 1), maxLimit);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  return { page, limit, from, to };
}

export function normalizePhone(phone?: string | null) {
  if (!phone) return undefined;
  return phone.trim().replace(/[^\d+]/g, "");
}
