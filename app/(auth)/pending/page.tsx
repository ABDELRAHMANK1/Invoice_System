import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Icon, I } from "@/app/components/Icon";
import { SignOutButton } from "@/app/components/SignOutButton";
import { getAuthProfile } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Awaiting approval — Oranje" };

/**
 * Where middleware parks a signed-in account that is not `active` yet.
 *
 * It renders the REASON — pending vs. disabled are different situations and a
 * single "no access" wall would leave a disabled user waiting forever for an
 * approval that is never coming.
 */
export default async function PendingPage() {
  const profile = await getAuthProfile();
  if (!profile) redirect("/login");
  if (profile.status === "active") redirect("/");

  const disabled = profile.status === "disabled";

  return (
    <div className="auth-page">
      <div className="auth-state">
        <div
          className="auth-state-icon"
          style={disabled ? { background: "var(--danger-soft)", color: "var(--danger)" } : undefined}
        >
          <Icon d={disabled ? I.ban : I.clock} size={20} />
        </div>

        <h2>{disabled ? "Account disabled" : "Waiting for approval"}</h2>
        <p>
          {disabled
            ? "Your access to this workspace has been turned off. Contact an owner if you think that's a mistake."
            : "Your account was created. An owner needs to approve it and grant permissions before the dashboard opens."}
        </p>

        <div className="who">{profile.email ?? profile.full_name ?? profile.id}</div>
        <SignOutButton />
      </div>
    </div>
  );
}
