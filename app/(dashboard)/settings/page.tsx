import { requireActiveProfile } from "@/lib/auth/session";
import { canManageUsers } from "@/lib/auth/permissions";
import { SettingsClient } from "./SettingsClient";

export default async function SettingsPage() {
  const profile = await requireActiveProfile();
  return <SettingsClient canManageUsers={canManageUsers(profile)} />;
}
