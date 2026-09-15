/**
 * Which permission a request needs, derived from its path + method.
 *
 * This map is what lets middleware.ts guard all ~45 API routes without editing
 * any of them. Putting the check in one place means a route added later is
 * protected by DEFAULT — `requiredPermission` falls back to the most
 * restrictive answer for anything it does not recognise, so forgetting to add
 * an entry locks a route down rather than leaving it open.
 *
 * Pure: no Supabase, no Next.js. See lib/__tests__/route-permissions.test.ts.
 */
import type { PermissionKey } from "@/lib/auth/permissions";

/** Pages and API paths reachable with no session at all. */
export const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/auth/callback",
  "/api/auth",
] as const;

/**
 * Reachable with a session but WITHOUT an active profile — i.e. the screens a
 * pending or disabled user is allowed to see. Everything else bounces them to
 * /pending.
 */
export const SESSION_ONLY_PATHS = ["/pending", "/api/auth"] as const;

function matches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function isPublicPath(pathname: string): boolean {
  return matches(pathname, PUBLIC_PATHS);
}

export function isSessionOnlyPath(pathname: string): boolean {
  return matches(pathname, SESSION_ONLY_PATHS);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface Rule {
  /** Matched as an exact path or as a `prefix/...` segment boundary. */
  prefix: string;
  read: PermissionKey;
  write: PermissionKey;
  /** Defaults to `write` when a route has no separate delete permission. */
  remove?: PermissionKey;
}

/**
 * Longest prefix wins, so `/api/clients/x/employees` can differ from
 * `/api/clients`. Order in this array is irrelevant — `requiredPermission`
 * sorts by specificity.
 */
const API_RULES: Rule[] = [
  // Users management is role-gated on top of this (owner/developer only); the
  // permission key exists so the middleware answer is never "no rule".
  { prefix: "/api/users",              read: "manage_users",   write: "manage_users",   remove: "manage_users" },

  { prefix: "/api/invoices",           read: "view_invoices",  write: "edit_invoices",  remove: "delete_data" },
  { prefix: "/api/files",              read: "view_invoices",  write: "edit_invoices",  remove: "delete_data" },
  { prefix: "/api/tasks",              read: "view_invoices",  write: "edit_invoices",  remove: "delete_data" },
  { prefix: "/api/templates",          read: "view_invoices",  write: "manage_clients", remove: "delete_data" },

  { prefix: "/api/clients",            read: "view_invoices",  write: "manage_clients", remove: "delete_data" },

  // Everything that produces a downloadable Excel / ZIP.
  { prefix: "/api/export",             read: "export_excel",   write: "export_excel" },
  { prefix: "/api/generate-excel",     read: "export_excel",   write: "export_excel" },
  { prefix: "/api/generate-zip",       read: "export_excel",   write: "export_excel" },
  { prefix: "/api/download-files",     read: "export_excel",   write: "export_excel" },
  { prefix: "/api/bulk-converter",     read: "export_excel",   write: "export_excel" },
  { prefix: "/api/relation-converter", read: "export_excel",   write: "export_excel" },

  // Ingest: uploading a file and running AI extraction both write invoice data.
  { prefix: "/api/upload",             read: "edit_invoices",  write: "edit_invoices" },
  { prefix: "/api/extract",            read: "edit_invoices",  write: "edit_invoices" },
];

const PAGE_RULES: Array<{ prefix: string; permission: PermissionKey }> = [
  { prefix: "/settings/users", permission: "manage_users" },
  { prefix: "/bulk-converter", permission: "export_excel" },
  { prefix: "/invoices",       permission: "view_invoices" },
  { prefix: "/files",          permission: "view_invoices" },
  { prefix: "/tasks",          permission: "view_invoices" },
  { prefix: "/templates",      permission: "view_invoices" },
  { prefix: "/clients",        permission: "view_invoices" },
];

function matchPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function bestRule<T extends { prefix: string }>(pathname: string, rules: T[]): T | undefined {
  return rules
    .filter((r) => matchPrefix(pathname, r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

/**
 * The permission a request needs, or `null` when the path needs only an active
 * account (the dashboard root and Settings, say).
 *
 * An UNKNOWN /api path returns `delete_data` on purpose — the narrowest key any
 * employee is likely to hold. A new route is therefore owner/developer-only
 * until someone adds it to API_RULES, which fails closed instead of open.
 */
export function requiredPermission(pathname: string, method: string): PermissionKey | null {
  if (pathname.startsWith("/api/")) {
    const rule = bestRule(pathname, API_RULES);
    if (!rule) return "delete_data";
    if (READ_METHODS.has(method.toUpperCase())) return rule.read;
    if (method.toUpperCase() === "DELETE") return rule.remove ?? rule.write;
    return rule.write;
  }

  return bestRule(pathname, PAGE_RULES)?.permission ?? null;
}
