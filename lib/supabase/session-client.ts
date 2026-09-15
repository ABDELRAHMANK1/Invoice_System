/**
 * Cookie-backed Supabase clients for the signed-in USER.
 *
 * Deliberately separate from lib/supabase-admin.ts: that one holds the service
 * role key, bypasses RLS and must never see a request's cookies. These use the
 * ANON key and act strictly as the person holding the session, so RLS applies
 * (see the policies in migration 016).
 *
 * Edge-safe — middleware.ts imports `createMiddlewareSupabase` from here.
 */
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

/**
 * Read at call time, not at module load. lib/env.ts throws on a missing var,
 * which would take down every route that transitively imports it; auth has a
 * narrower blast radius if it fails only where it is actually used.
 */
function authEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase Auth is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }
  return { url, anonKey };
}

/** Browser client — the only one the login/signup forms touch. */
export function createBrowserSupabase() {
  const { url, anonKey } = authEnv();
  return createBrowserClient(url, anonKey);
}

type CookieStore = {
  getAll: () => Array<{ name: string; value: string }>;
  set: (name: string, value: string, options?: Record<string, unknown>) => void;
};

/**
 * Server-component / route-handler client.
 *
 * Pass the `cookies()` store from next/headers. In a Server Component the store
 * is read-only and `set` throws — that is expected and swallowed, because
 * middleware already refreshed the session cookie for this request.
 */
export function createServerSupabase(cookieStore: CookieStore) {
  const { url, anonKey } = authEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookies) => {
        try {
          for (const { name, value, options } of cookies) {
            cookieStore.set(name, value, options as Record<string, unknown>);
          }
        } catch {
          // Read-only cookie store (Server Component). Safe to ignore.
        }
      },
    },
  });
}

/**
 * Middleware client. Writes refreshed tokens onto BOTH the request (so the rest
 * of this request sees them) and the response (so the browser keeps them).
 */
export function createMiddlewareSupabase(req: NextRequest, res: NextResponse) {
  const { url, anonKey } = authEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          req.cookies.set(name, value);
        }
        for (const { name, value, options } of cookies) {
          res.cookies.set(name, value, options);
        }
      },
    },
  });
}
