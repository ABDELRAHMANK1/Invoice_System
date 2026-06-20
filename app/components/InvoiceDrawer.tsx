"use client";

import { useEffect, useRef } from "react";
import { Icon, I } from "./Icon";
import { Pill, TypePill, statusTone, statusLabel } from "./Pill";
import type { InvoiceRow } from "./InvoiceTable";

const CLIENT_COLORS = [
  "#1d4ed8","#2563eb","#1f8a5b","#7a5af0",
  "#b45309","#c0392b","#0e7490","#9333ea",
];

function clientColor(name: string | null): string {
  if (!name) return CLIENT_COLORS[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
  return CLIENT_COLORS[h % CLIENT_COLORS.length];
}

function clientInitials(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function fmtEUR(n: number | null): string {
  if (n == null) return "-";
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n);
}

interface InvoiceDrawerProps {
  row: InvoiceRow | null;
  onClose: () => void;
}

export function InvoiceDrawer({ row, onClose }: InvoiceDrawerProps) {
  const open = !!row;
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && open) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open && drawerRef.current) {
      const first = drawerRef.current.querySelector<HTMLElement>("button, a, [tabindex]");
      first?.focus();
    }
  }, [open]);

  const color = clientColor(row?.client_name ?? null);
  const initials = clientInitials(row?.client_name ?? null);
  const type = row?.invoice_direction === "verkoop" ? "Verkoop" : "Inkoop";
  const exportCount = row?.export_count ?? 0;

  return (
    <>
      <div
        className={`drawer-bg${open ? " on" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        className={`drawer${open ? " on" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={row ? `Invoice ${row.invoice_number}` : "Invoice detail"}
      >
        {row && (
          <>
            <div className="dr-head">
              <div
                className="client-av"
                style={{
                  width: 36, height: 36, borderRadius: 9,
                  background: color, flexShrink: 0,
                }}
              >
                {initials}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3>{row.client_name || "Unknown client"}</h3>
                <div className="dr-sub">
                  {row.invoice_number ? `INV-${row.invoice_number}` : row.id.slice(0, 12)} · {row.date ?? "—"}
                </div>
              </div>
              <button className="iconbtn" onClick={onClose} aria-label="Close drawer">
                <Icon d={I.x} size={14} />
              </button>
            </div>

            <div className="dr-body">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <TypePill type={type} />
                <Pill tone={statusTone(row.status)}>{statusLabel(row.status)}</Pill>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>
                  {fmtEUR(row.total_amount)}
                </span>
              </div>

              <div>
                <div className="section-label">Details</div>
                <dl className="kv">
                  <dt>Invoice #</dt>
                  <dd>{row.invoice_number || "—"}</dd>
                  <dt>Date</dt>
                  <dd>{row.date ?? "—"}</dd>
                  <dt>Sender</dt>
                  <dd>{row.sender_name || "—"}</dd>
                  <dt>Company</dt>
                  <dd>{row.client_name || "—"}</dd>
                  <dt>Phone</dt>
                  <dd>{row.phone_number || "—"}</dd>
                  <dt>Type</dt>
                  <dd>{type}</dd>
                  <dt>Currency</dt>
                  <dd>{row.currency}</dd>
                  <dt>Exported</dt>
                  <dd>{exportCount > 0 ? `${exportCount}×` : "Not yet"}</dd>
                </dl>
              </div>

              <div>
                <div className="section-label">Line items</div>
                <div className="dr-empty">No line items extracted for this invoice.</div>
              </div>
            </div>

            <div className="dr-foot">
              <button
                className="btn"
                onClick={() => navigator.clipboard.writeText(row.id)}
                aria-label="Copy invoice ID"
              >
                <Icon d={I.copy} size={13} /> Copy ID
              </button>
              <a
                href={`/api/invoices/${row.id}/download`}
                download
                className="btn"
              >
                <Icon d={I.download} size={13} /> Download
              </a>
              <a
                href={`/api/invoices/${row.id}/download?inline=1`}
                target="_blank"
                rel="noopener"
                className="btn primary"
              >
                <Icon d={I.open} size={13} /> Open file
              </a>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
