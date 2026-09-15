"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Menu, type MenuEntry } from "./Menu";
import { I } from "./Icon";
import { type AuthProfile, canManageUsers } from "@/lib/auth/permissions";
import { createBrowserSupabase } from "@/lib/supabase/session-client";

const ROLE_LABELS: Record<AuthProfile["role"], string> = {
  owner: "Owner",
  developer: "Developer",
  employee: "Employee",
};

/** Avatar initials — real name first, the email local-part as the fallback. */
function initials(profile: AuthProfile): string {
  const source = profile.full_name?.trim() || profile.email?.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * The topbar account control: who am I, and how do I get out.
 *
 * Reuses the portalled <Menu> rather than a bespoke dropdown so it inherits the
 * outside-click / Escape / scroll-close behaviour the rest of the dashboard
 * already has.
 */
export function UserMenu({ profile }: { profile: AuthProfile }) {
  const router = useRouter();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  async function signOut() {
    try {
      await createBrowserSupabase().auth.signOut();
    } finally {
      // refresh() so middleware re-runs against the cleared cookie — without it
      // the client would re-render the cached signed-in tree.
      router.replace("/login");
      router.refresh();
    }
  }

  const items: MenuEntry[] = [
    { kind: "label", text: `${profile.full_name || profile.email || "Signed in"} · ${ROLE_LABELS[profile.role]}` },
    { kind: "sep" },
    ...(canManageUsers(profile)
      ? ([{ kind: "item", label: "Users", icon: I.users, onSelect: () => router.push("/settings/users") }] as MenuEntry[])
      : []),
    { kind: "item", label: "Settings", icon: I.cog, onSelect: () => router.push("/settings") },
    { kind: "sep" },
    { kind: "item", label: "Log out", icon: I.ban, danger: true, onSelect: signOut },
  ];

  return (
    <>
      <button
        className="avatar"
        style={{ border: 0, cursor: "pointer" }}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`Account: ${profile.full_name ?? profile.email ?? "signed in"}`}
      >
        {initials(profile)}
      </button>

      {anchor && <Menu anchor={anchor} items={items} onClose={() => setAnchor(null)} ariaLabel="Account" />}
    </>
  );
}
