import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireUserAdmin } from "@/lib/auth/guard";
import { PERMISSION_KEYS, ROLES, USER_STATUSES, grantedKeys } from "@/lib/auth/permissions";

export const runtime = "nodejs";

/**
 * One endpoint for approve / edit-permissions / disable, because approving IS
 * "set status = active and grant these permissions" — two round trips would
 * leave an approved account with no permissions if the second one failed.
 *
 * `permissions` is the COMPLETE checkbox state, not a delta: every key is
 * written with its boolean, so unchecking one is a real update rather than a
 * missing row that happens to read as denied.
 */
const patchSchema = z
  .object({
    full_name: z.string().trim().max(200).nullable().optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    permissions: z.record(z.enum(PERMISSION_KEYS), z.boolean()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireUserAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  if (!id) return jsonError("Missing user id", 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError("Invalid request", 400, parsed.error.flatten());
  const patch = parsed.data;

  const { data: target, error: targetError } = await supabaseAdmin
    .from("user_profiles")
    .select("id, role, status")
    .eq("id", id)
    .maybeSingle();

  if (targetError) return jsonError(targetError.message, 500);
  if (!target) return jsonError("User not found", 404);

  // An admin editing their OWN row can still rename themselves, but not change
  // their own role or status: the only way that ends is a workspace whose last
  // owner demoted themselves and can no longer reach this page to undo it.
  if (id === guard.profile.id && (patch.role !== undefined || patch.status !== undefined)) {
    return jsonError("You can't change your own role or status", 400);
  }

  // Same reasoning one step out: the last ACTIVE owner must stay one. Checked
  // on the way out (role and status can both move in a single PATCH), so the
  // question is always "what would the workspace look like after this write?".
  const losesOwnerAccess =
    target.role === "owner" &&
    target.status === "active" &&
    ((patch.role !== undefined && patch.role !== "owner") ||
      (patch.status !== undefined && patch.status !== "active"));

  if (losesOwnerAccess) {
    const { count, error: countError } = await supabaseAdmin
      .from("user_profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "owner")
      .eq("status", "active");

    if (countError) return jsonError(countError.message, 500);
    if ((count ?? 0) <= 1) {
      return jsonError("This is the last active owner — promote someone else first", 400);
    }
  }

  const profilePatch: Record<string, unknown> = {};
  if (patch.full_name !== undefined) profilePatch.full_name = patch.full_name || null;
  if (patch.role !== undefined) profilePatch.role = patch.role;
  if (patch.status !== undefined) profilePatch.status = patch.status;

  if (Object.keys(profilePatch).length > 0) {
    const { error } = await supabaseAdmin.from("user_profiles").update(profilePatch).eq("id", id);
    if (error) return jsonError(error.message, 500);
  }

  if (patch.permissions) {
    const rows = Object.entries(patch.permissions).map(([permission_key, granted]) => ({
      user_id: id,
      permission_key,
      granted,
    }));
    if (rows.length > 0) {
      const { error } = await supabaseAdmin
        .from("user_permissions")
        .upsert(rows, { onConflict: "user_id,permission_key" });
      if (error) return jsonError(error.message, 500);
    }
  }

  const { data: updated, error: readError } = await supabaseAdmin
    .from("user_profiles")
    .select("id, full_name, role, status, created_at, user_permissions(permission_key, granted)")
    .eq("id", id)
    .maybeSingle();

  if (readError) return jsonError(readError.message, 500);

  return NextResponse.json({
    data: {
      ...updated,
      permissions: grantedKeys(
        updated?.user_permissions as Array<{ permission_key: string; granted: boolean }> | null
      ),
    },
  });
}
