import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthProfile } from "@/lib/auth/session";
import { canManageUsers } from "@/lib/auth/permissions";
import { UsersClient } from "./UsersClient";

export const metadata: Metadata = { title: "Users — Oranje" };

/**
 * Settings > Users. Owner/developer only — a ROLE test, not a permission one,
 * so granting an employee `manage_users` still does not get them in here (the
 * API agrees: lib/auth/guard.ts `requireUserAdmin`).
 */
export default async function UsersPage() {
  const profile = await getAuthProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending");
  if (!canManageUsers(profile)) redirect("/?denied=1");

  return <UsersClient currentUserId={profile.id} />;
}
