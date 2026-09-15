"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, I } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import type { AuthProfile } from "@/lib/auth/permissions";

const PAGE_TITLES: Record<string, string> = {
  "/":         "Dashboard",
  "/invoices": "Invoices",
  "/tasks":    "Tasks",
  "/files":    "Files",
  "/clients":  "Clients",
  "/reports":  "Reports",
  "/settings": "Settings",
  "/settings/users": "Users",
};

export function Topbar({ profile }: { profile?: AuthProfile }) {
  const pathname = usePathname();
  const title = PAGE_TITLES[pathname] ?? "Dashboard";

  return (
    <header className="topbar">
      <div className="crumb">
        <span>Workspace</span>
        <span className="sep">/</span>
        <b>{title}</b>
      </div>

      <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        <ThemeToggle />
        <Link href="/settings" className="iconbtn" aria-label="Settings" title="Settings">
          <Icon d={I.cog} size={16} />
        </Link>
        {profile && <UserMenu profile={profile} />}
      </div>
    </header>
  );
}
