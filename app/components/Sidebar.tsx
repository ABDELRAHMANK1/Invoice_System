"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, I } from "./Icon";

const NAV_ITEMS: Array<{
  href: string;
  d: string | string[];
  label: string;
  count?: number | null;
}> = [
  { href: "/",        d: I.home,    label: "Home" },
  { href: "/invoices",d: I.invoice, label: "Invoices" },
  { href: "/files",   d: I.folder,  label: "Files" },
  { href: "/clients", d: I.users,   label: "Clients" },
];


interface SidebarProps {
  invoiceCount?: number;
  clientCount?: number;
}

export function Sidebar({ invoiceCount, clientCount }: SidebarProps) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <aside className="side">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">O</div>
        <div>
          <div className="brand-name">Oranji</div>
          <div className="brand-sub">workspace · NL</div>
        </div>
      </div>

      <nav className="nav-sec" aria-label="Workspace">
        <h6>Workspace</h6>
        {NAV_ITEMS.map((item) => {
          const count = item.href === "/invoices" ? invoiceCount : item.href === "/clients" ? clientCount : item.count;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <span className="nav-icon"><Icon d={item.d} size={16} /></span>
              <span>{item.label}</span>
              {count != null && <span className="ct">{count}</span>}
            </Link>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <nav className="nav-sec" aria-label="Settings">
        <Link href="/settings" className={`nav-item${pathname.startsWith("/settings") ? " active" : ""}`}>
          <span className="nav-icon"><Icon d={I.cog} size={16} /></span>
          <span>Settings</span>
        </Link>
      </nav>
    </aside>
  );
}
