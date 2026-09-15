import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireUserAdmin } from "@/lib/auth/guard";
import { grantedKeys, isRole, isUserStatus, type Role, type UserStatus } from "@/lib/auth/permissions";

export const runtime = "nodejs";

export interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role;
  status: UserStatus;
  created_at: string | null;
  last_sign_in_at: string | null;
  permissions: string[];
}

/** Pending accounts first — the list exists to get them approved. */
const STATUS_ORDER: Record<UserStatus, number> = { pending: 0, active: 1, disabled: 2 };

/**
 * GET /api/users — every account with its role, status and grants.
 *
 * Emails live in `auth.users`, which PostgREST does not expose, so they come
 * from the Admin API and are joined in memory. The workspace is a back office
 * with a handful of accounts; paginating two sources against each other would
 * cost more than it buys. `perPage` is capped at 1000 — if this workspace ever
 * outgrows that, the join needs real pagination.
 */
export async function GET() {
  const guard = await requireUserAdmin();
  if (!guard.ok) return guard.response;

  const { data: profiles, error } = await supabaseAdmin
    .from("user_profiles")
    .select("id, full_name, role, status, created_at, user_permissions(permission_key, granted)")
    .order("created_at", { ascending: true });

  if (error) return jsonError(error.message, 500);

  const { data: authList, error: authError } = await supabaseAdmin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (authError) return jsonError(authError.message, 500);

  const authById = new Map(authList.users.map((u) => [u.id, u]));

  const rows: UserRow[] = (profiles ?? []).map((p) => {
    const authUser = authById.get(p.id as string);
    return {
      id: p.id as string,
      email: authUser?.email ?? null,
      full_name: (p.full_name as string | null) ?? null,
      role: isRole(p.role) ? p.role : "employee",
      status: isUserStatus(p.status) ? p.status : "pending",
      created_at: (p.created_at as string | null) ?? null,
      last_sign_in_at: authUser?.last_sign_in_at ?? null,
      permissions: grantedKeys(
        p.user_permissions as Array<{ permission_key: string; granted: boolean }> | null
      ),
    };
  });

  rows.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return (a.full_name || a.email || "").localeCompare(b.full_name || b.email || "");
  });

  return NextResponse.json({ data: rows, total: rows.length });
}
