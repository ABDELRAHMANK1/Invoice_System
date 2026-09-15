import { NextRequest, NextResponse } from "next/server";
import { createMiddlewareSupabase } from "@/lib/supabase/session-client";
import { can, grantedKeys, isRole, isUserStatus, type AuthProfile } from "@/lib/auth/permissions";
import { isPublicPath, isSessionOnlyPath, requiredPermission } from "@/lib/auth/route-permissions";

/**
 * The single auth gate for the dashboard.
 *
 * Replaces the old HTTP Basic Auth popup. Two audiences share this file:
 *
 *  • n8n and other machine callers — still authenticate with `x-api-key` and
 *    never touch a session. Checked FIRST so the invoice pipeline is unaffected
 *    by anything below it.
 *  • People — carry a Supabase Auth session cookie. Pages redirect; /api
 *    answers JSON, because a fetch() from the dashboard cannot follow a
 *    redirect to an HTML login page in any useful way.
 *
 * Why permissions are enforced HERE for /api rather than in each route: there
 * are ~45 route files, and a check that must be remembered in every one of them
 * is a check that will eventually be forgotten. lib/auth/route-permissions.ts
 * maps path+method → permission, and fails closed on an unknown path.
 */

// Edge runtime: no Node built-ins are used here.
const LOGIN_PATH = "/login";

/**
 * ── Rollback switch for the Basic Auth cutover ───────────────────────────
 * Set LEGACY_BASIC_AUTH=1 to put the old HTTP Basic Auth popup back and skip
 * session auth entirely. It exists so the new auth can ship to production and
 * be reverted with one environment variable instead of a redeploy, and so
 * deleting Basic Auth is a deliberate, separate step.
 *
 * The two CANNOT run side by side: a 401 + WWW-Authenticate makes the browser
 * show the popup before it ever reaches /login, so this picks one or the other.
 *
 * Remove this block, `basicAuthGate` and DASHBOARD_USER / DASHBOARD_PASS once
 * session auth is confirmed working in production.
 */
function legacyBasicAuthEnabled(): boolean {
  const flag = process.env.LEGACY_BASIC_AUTH;
  return flag === "1" || flag?.toLowerCase() === "true";
}

function basicAuthGate(req: NextRequest): NextResponse {
  const validUser = process.env.DASHBOARD_USER ?? "admin";
  const validPass = process.env.DASHBOARD_PASS ?? "";

  // API routes authenticate with x-api-key, never with Basic.
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const colon = decoded.indexOf(":");
      if (colon > 0) {
        const user = decoded.slice(0, colon);
        const pass = decoded.slice(colon + 1);
        if (validPass && safeEqual(user, validUser) && safeEqual(pass, validPass)) {
          return NextResponse.next();
        }
      }
    } catch {
      // malformed base64 — fall through to the challenge
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Oranji Dashboard", charset="UTF-8"' },
  });
}

function apiError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function redirectTo(req: NextRequest, pathname: string, next?: string) {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

/** Constant-time-ish compare so a wrong key cannot be probed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hasInternalApiKey(req: NextRequest): boolean {
  const expected = process.env.API_INTERNAL_KEY;
  if (!expected) return false;
  const provided =
    req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  return !!provided && safeEqual(provided, expected);
}

export async function middleware(req: NextRequest) {
  if (legacyBasicAuthEnabled()) return basicAuthGate(req);

  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // 1. Machine callers (n8n). Keep this before everything else.
  if (isApi && hasInternalApiKey(req)) return NextResponse.next();

  // `res` is created up front so the Supabase client can write refreshed auth
  // cookies onto it; every early return below must return THIS response (or a
  // redirect), or a refreshed token is silently dropped and the user is logged
  // out the moment the old access token expires.
  const res = NextResponse.next({ request: { headers: req.headers } });
  const supabase = createMiddlewareSupabase(req, res);
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  // 2. Public pages — but bounce a signed-in user away from the login form.
  if (isPublicPath(pathname)) {
    if (user && (pathname === LOGIN_PATH || pathname === "/signup")) {
      return redirectTo(req, "/");
    }
    return res;
  }

  // 3. No session at all.
  if (!user) {
    if (isApi) return apiError("Authentication required", 401);
    return redirectTo(req, LOGIN_PATH, pathname);
  }

  // 4. The /pending screen needs a session but NOT an approved profile — check
  // before the query below, so the one page a pending user can open does not
  // pay for a profile lookup it then throws away.
  if (isSessionOnlyPath(pathname)) return res;

  // 5. Is the account approved? One query — PostgREST embeds the grants
  // through the FK.
  const { data: row } = await supabase
    .from("user_profiles")
    .select("id, full_name, role, status, user_permissions(permission_key, granted)")
    .eq("id", user.id)
    .maybeSingle();

  const profile: AuthProfile | null = row
    ? {
        id: row.id as string,
        email: user.email ?? null,
        full_name: (row.full_name as string | null) ?? null,
        role: isRole(row.role) ? row.role : "employee",
        status: isUserStatus(row.status) ? row.status : "pending",
        permissions: grantedKeys(
          row.user_permissions as Array<{ permission_key: string; granted: boolean }> | null
        ),
      }
    : null;

  if (!profile || profile.status !== "active") {
    if (isApi) {
      return apiError(
        profile?.status === "disabled" ? "This account has been disabled" : "This account is awaiting approval",
        403
      );
    }
    return redirectTo(req, "/pending");
  }

  // 6. Approved — now the per-permission check. Owner/developer bypass the
  // permissions table entirely (see lib/auth/permissions.ts).
  const permission = requiredPermission(pathname, req.method);
  if (!can(profile, permission)) {
    if (isApi) return apiError("You do not have permission to do that", 403);
    return redirectTo(req, "/?denied=1");
  }

  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf)).*)",
  ],
};
