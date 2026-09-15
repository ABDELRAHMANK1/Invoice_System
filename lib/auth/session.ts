/**
 * Server-only. Imports next/headers, which throws in a Client Component — the
 * repo has no `server-only` package and this comment is the marker instead.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/session-client";
import {
  type AuthProfile,
  type PermissionKey,
  type Role,
  type UserStatus,
  can,
  grantedKeys,
  isRole,
  isUserStatus,
} from "@/lib/auth/permissions";

/**
 * Server-side "who is asking?" for Server Components and route handlers.
 *
 * One round trip for the profile and its grants: PostgREST embeds
 * user_permissions through the FK, so this never becomes two queries.
 */
export async function getAuthProfile(): Promise<AuthProfile | null> {
  const cookieStore = await cookies();
  const supabase = createServerSupabase(cookieStore);

  // getUser() validates the JWT with the auth server. getSession() only decodes
  // the cookie, so it must not be used for an access decision.
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;

  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, full_name, role, status, user_permissions(permission_key, granted)")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id as string,
    email: userData.user.email ?? null,
    full_name: (data.full_name as string | null) ?? null,
    role: (isRole(data.role) ? data.role : "employee") as Role,
    status: (isUserStatus(data.status) ? data.status : "pending") as UserStatus,
    permissions: grantedKeys(
      data.user_permissions as Array<{ permission_key: string; granted: boolean }> | null
    ),
  };
}

/**
 * Gate for a dashboard Server Component.
 *
 * Redirects rather than throwing so a signed-out visitor lands on /login and a
 * not-yet-approved one on /pending, which is the difference the "waiting for
 * approval" screen exists to show.
 */
export async function requireActiveProfile(permission: PermissionKey | null = null): Promise<AuthProfile> {
  const profile = await getAuthProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending");
  if (!can(profile, permission)) redirect("/?denied=1");
  return profile;
}
