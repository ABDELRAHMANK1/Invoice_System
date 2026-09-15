import { NextResponse } from "next/server";
import { getAuthProfile } from "@/lib/auth/session";
import { type AuthProfile, type PermissionKey, can, canManageUsers } from "@/lib/auth/permissions";

/**
 * Route-handler guards.
 *
 * middleware.ts already gates /api by path+method, so most routes need nothing
 * here. These exist for the cases where the middleware answer is not enough:
 *
 *  • The internal API key (n8n) bypasses the session check in middleware. A
 *    route that must never be reachable by a machine caller — the Users API —
 *    has to say so itself.
 *  • "owner or developer" is a ROLE test, and middleware only knows about
 *    permission keys.
 */

export type GuardResult =
  | { ok: true; profile: AuthProfile }
  | { ok: false; response: NextResponse };

function deny(message: string, status: number): GuardResult {
  return { ok: false, response: NextResponse.json({ error: message }, { status }) };
}

/** A signed-in, approved account holding `permission` (null = any active one). */
export async function requireAccess(permission: PermissionKey | null = null): Promise<GuardResult> {
  const profile = await getAuthProfile();
  if (!profile) return deny("Authentication required", 401);
  if (profile.status !== "active") {
    return deny(
      profile.status === "disabled" ? "This account has been disabled" : "This account is awaiting approval",
      403
    );
  }
  if (!can(profile, permission)) return deny("You do not have permission to do that", 403);
  return { ok: true, profile };
}

/** Owner or developer only — user administration is never permission-granted. */
export async function requireUserAdmin(): Promise<GuardResult> {
  const profile = await getAuthProfile();
  if (!profile) return deny("Authentication required", 401);
  if (!canManageUsers(profile)) return deny("Only an owner or developer can manage users", 403);
  return { ok: true, profile };
}
