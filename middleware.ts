import { NextRequest, NextResponse } from "next/server";

const VALID_USER = process.env.DASHBOARD_USER ?? "admin";
const VALID_PASS = process.env.DASHBOARD_PASS ?? "Oranje19052026@";

const DENY = new NextResponse("Authentication required", {
  status: 401,
  headers: { "WWW-Authenticate": 'Basic realm="Oranji Dashboard", charset="UTF-8"' },
});

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) {
    // Still iterate to avoid length-based timing leak
    let diff = 0;
    for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ (bb[i % bb.length] ?? 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function middleware(req: NextRequest) {
  // API routes use x-api-key — skip Basic Auth entirely
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const authHeader = req.headers.get("authorization") ?? "";

  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      const colon = decoded.indexOf(":");
      if (colon > 0) {
        const user = decoded.slice(0, colon);
        const pass = decoded.slice(colon + 1);
        if (timingSafeEqual(user, VALID_USER) && timingSafeEqual(pass, VALID_PASS)) {
          return NextResponse.next();
        }
      }
    } catch {
      // malformed base64 — fall through to 401
    }
  }

  return DENY;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf)).*)",
  ],
};
