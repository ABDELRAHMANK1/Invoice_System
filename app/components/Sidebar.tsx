"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, I } from "./Icon";

const NAV_ITEMS: Array<{
  href: string;
  d: string | string[];
  label: string;
  match?: (pathname: string) => boolean;
  count?: number | null;
}> = [
  // Dashboard temporarily points at /invoices until a dedicated dashboard page exists.
  // Marked active only on the exact root.
  { href: "/",          d: I.home,    label: "Dashboard", match: (p) => p === "/" },
  { href: "/invoices",  d: I.invoice, label: "Invoices" },
  { href: "/files",     d: I.folder,  label: "Files" },
  { href: "/clients",   d: I.users,   label: "Clients" },
  { href: "/snelstart-import", d: I.excel, label: "Snelstart Import" },
  { href: "/reports",   d: I.chart,   label: "Reports" },
  { href: "/settings",  d: I.cog,     label: "Settings" },
];

interface SidebarProps {
  invoiceCount?: number;
  clientCount?: number;
}

export function Sidebar({ invoiceCount, clientCount }: SidebarProps) {
  const pathname = usePathname();

  function isActive(item: (typeof NAV_ITEMS)[number]) {
    if (item.match) return item.match(pathname);
    return pathname.startsWith(item.href);
  }

  return (
    <aside className="side">
      <div className="brand">
        <div className="brand-mark" style={{ padding: 4 }} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" fill="rgba(255,255,255,0.15)" stroke="white" strokeWidth="2" />
            <path d="M9 9h6" stroke="white" strokeWidth="2" />
            <path d="M9 13h6" stroke="white" strokeWidth="2" />
            <path d="M9 17h4" stroke="white" strokeWidth="2" />
          </svg>
        </div>
        <div>
          <div className="brand-name">Oranje</div>
          <div className="brand-sub">Invoice workspace</div>
        </div>
      </div>

      <nav className="nav-sec" aria-label="Workspace">
        {NAV_ITEMS.map((item) => {
          const count =
            item.href === "/invoices" ? invoiceCount :
            item.href === "/clients"  ? clientCount  :
            item.count;
          const active = isActive(item);
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
    </aside>
  );
}
