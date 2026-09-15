/**
 * The permission model, as pure data + pure functions.
 *
 * No Supabase, no Next.js, no IO — middleware (Edge), server components and
 * route handlers all import from here so "can this person do that?" has exactly
 * one answer in the codebase. Mirrors the checks in
 * db/migrations/016_auth_user_profiles_and_permissions.sql.
 */

export const ROLES = ["owner", "developer", "employee"] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ["pending", "active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PERMISSION_KEYS = [
  "view_invoices",
  "edit_invoices",
  "export_excel",
  "manage_clients",
  "manage_users",
  "delete_data",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Labels for the Users page. `view_invoices` is the workspace-wide READ
 * permission — it also gates reading clients, files, tasks and templates, not
 * just the invoice list. The description says so rather than the key being
 * renamed, because the key is what the DB check constraint stores.
 */
export const PERMISSION_LABELS: Record<PermissionKey, { label: string; description: string }> = {
  view_invoices:  { label: "View data",      description: "Read invoices, clients, files, tasks and templates." },
  edit_invoices:  { label: "Edit invoices",  description: "Create, upload and edit invoices and tasks." },
  export_excel:   { label: "Export Excel",   description: "Run Snelstart exports and the bulk converter." },
  manage_clients: { label: "Manage clients", description: "Add or change clients, suppliers, customers and employees." },
  manage_users:   { label: "Manage users",   description: "Approve accounts and change permissions." },
  delete_data:    { label: "Delete data",    description: "Delete invoices, files and records." },
};

/** Roles that bypass `user_permissions` completely — full access by role. */
const FULL_ACCESS_ROLES: readonly Role[] = ["owner", "developer"];

export interface AuthProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role;
  status: UserStatus;
  /** Only the keys with `granted = true`. Empty for owner/developer. */
  permissions: PermissionKey[];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === "string" && (USER_STATUSES as readonly string[]).includes(value);
}

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && (PERMISSION_KEYS as readonly string[]).includes(value);
}

/** Owner and developer manage users; an employee needs the explicit grant. */
export function hasFullAccess(role: Role): boolean {
  return FULL_ACCESS_ROLES.includes(role);
}

/**
 * The single access question.
 *
 * A disabled or still-pending account is denied everything, whatever its role —
 * the status gate runs BEFORE the role bypass, so demoting an owner to
 * `disabled` actually locks them out.
 */
export function can(profile: AuthProfile | null, permission: PermissionKey | null): boolean {
  if (!profile) return false;
  if (profile.status !== "active") return false;
  if (permission === null) return true;
  if (hasFullAccess(profile.role)) return true;
  return profile.permissions.includes(permission);
}

/** Convenience for the pages that are owner/developer-only (Settings > Users). */
export function canManageUsers(profile: AuthProfile | null): boolean {
  return !!profile && profile.status === "active" && hasFullAccess(profile.role);
}

/**
 * Narrow an arbitrary `user_permissions` result to the granted keys.
 * A missing row and `granted = false` both mean denied (see migration 016).
 */
export function grantedKeys(rows: Array<{ permission_key: string; granted: boolean }> | null | undefined): PermissionKey[] {
  if (!rows) return [];
  return rows
    .filter((r) => r.granted && isPermissionKey(r.permission_key))
    .map((r) => r.permission_key as PermissionKey);
}
