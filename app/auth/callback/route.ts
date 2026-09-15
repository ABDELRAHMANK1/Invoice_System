import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabase } from "@/lib/supabase/session-client";

export const runtime = "nodejs";

/**
 * Where Supabase sends the user back after an email link — confirmation or
 * password recovery. The link carries a one-time `code` that has to be
 * exchanged for a session ON THE SERVER so the resulting tokens are written as
 * httpOnly cookies rather than living in the URL.
 *
 * Listed in PUBLIC_PATHS: the visitor has no session yet, which is the whole
 * point of the exchange.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const nextParam = req.nextUrl.searchParams.get("next");
  // Only same-site paths — an open redirect here would let a crafted email
  // bounce a freshly authenticated user to an attacker's page.
  const next = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", req.url));
  }

  const cookieStore = await cookies();
  const supabase = createServerSupabase(cookieStore);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

  return NextResponse.redirect(new URL(next, req.url));
}
