import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const username = process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASS;

  // Auth not configured — allow everything through
  if (!username || !password) return NextResponse.next();

  // API routes authenticate with x-api-key — skip Basic Auth
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      const colon = decoded.indexOf(":");
      if (
        colon > 0 &&
        decoded.slice(0, colon) === username &&
        decoded.slice(colon + 1) === password
      ) {
        return NextResponse.next();
      }
    } catch {
      // malformed base64 — fall through to 401
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="WhatsApp Invoice Dashboard"' }
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"]
};
