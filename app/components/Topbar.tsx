"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, I } from "./Icon";

const CRUMBS: Record<string, string> = {
  "/invoices": "Invoices",
  "/clients":  "Clients",
  "/files":    "Files",
};

interface TopbarProps {
  onSearch?: (q: string) => void;
}

export function Topbar({ onSearch }: TopbarProps) {
  const [q, setQ] = useState("");
  const pathname = usePathname();
  const page = CRUMBS[pathname] ?? "Dashboard";

  return (
    <header className="topbar">
      <div className="crumb">
        <span>Workspace</span>
        <span className="sep">/</span>
        <b>{page}</b>
      </div>

      <div className="gsearch">
        <Icon d={I.search} size={14} />
        <input
          value={q}
          placeholder="Search invoices, clients, files…"
          onChange={(e) => {
            setQ(e.target.value);
            onSearch?.(e.target.value);
          }}
          aria-label="Global search"
        />
        <span className="kbd">⌘K</span>
      </div>

      <Link href="/settings" className="iconbtn" aria-label="Settings" title="Settings">
        <Icon d={I.cog} size={16} />
      </Link>

      <div className="avatar" title="Your account">YS</div>
    </header>
  );
}
