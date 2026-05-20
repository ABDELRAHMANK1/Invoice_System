"use client";

import { Icon, I } from "./Icon";
import { Pill, TypePill, statusTone, statusLabel } from "./Pill";
import { ConfidenceBar } from "./ConfidenceBar";

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

export type SortKey = "id" | "client" | "amount" | "date";
export type SortDir = "asc" | "desc";

export interface Sort {
  k: SortKey;
  dir: SortDir;
}

export interface InvoiceRow {
  id: string;
  phone_number: string;
  invoice_number: string;
  client_name: string | null;
  date: string | null;
  total_amount: number | null;
  currency: string;
  file_url: string;
  status: string;
  confidence: number | null;
  created_at: string;
  invoice_direction: "inkoop" | "verkoop" | null;
}

function SortHead({
  children,
  k,
  sort,
  setSort,
  align = "left",
}: {
  children: React.ReactNode;
  k: SortKey;
  sort: Sort;
  setSort: (s: Sort) => void;
  align?: "left" | "right";
}) {
  const active = sort.k === k;
  const icon = active ? (sort.dir === "asc" ? I.arrowUp : I.arrowDown) : I.chev;
  return (
    <button
      className="sort-head"
      style={{ justifyContent: align === "right" ? "flex-end" : "flex-start", width: "100%" }}
      onClick={() => setSort({ k, dir: active && sort.dir === "asc" ? "desc" : "asc" })}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {children}
      <Icon d={icon} size={10} stroke={2.4} />
    </button>
  );
}

interface InvoiceTableProps {
  rows: InvoiceRow[];
  total: number;
  page: number;
  totalPages: number;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  sort: Sort;
  setSort: (s: Sort) => void;
  onOpen: (row: InvoiceRow) => void;
  onPage: (p: number) => void;
  loading?: boolean;
}

export function InvoiceTable({
  rows, total, page, totalPages, selected, setSelected,
  sort, setSort, onOpen, onPage, loading,
}: InvoiceTableProps) {
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleAll() {
    const ns = new Set(selected);
    if (allOn) rows.forEach((r) => ns.delete(r.id));
    else rows.forEach((r) => ns.add(r.id));
    setSelected(ns);
  }

  function toggleRow(id: string) {
    const ns = new Set(selected);
    ns.has(id) ? ns.delete(id) : ns.add(id);
    setSelected(ns);
  }

  const pageNums = Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
    if (totalPages <= 5) return i + 1;
    if (page <= 3) return i + 1;
    if (page >= totalPages - 2) return totalPages - 4 + i;
    return page - 2 + i;
  });

  return (
    <div className="table-card">
      <div className="t-head" role="row">
        <div>
          <div
            className={`cb${allOn ? " on" : ""}`}
            role="checkbox"
            aria-checked={allOn}
            aria-label="Select all"
            onClick={toggleAll}
            tabIndex={0}
            onKeyDown={(e) => e.key === " " && toggleAll()}
          >
            {allOn && <Icon d={I.check} size={11} stroke={3} />}
          </div>
        </div>
        <div>
          <SortHead k="id" sort={sort} setSort={setSort}>Invoice #</SortHead>
        </div>
        <div>
          <SortHead k="client" sort={sort} setSort={setSort}>Client</SortHead>
        </div>
        <div>Phone</div>
        <div>
          <SortHead k="date" sort={sort} setSort={setSort}>Date</SortHead>
        </div>
        <div style={{ textAlign: "right" }}>
          <SortHead k="amount" sort={sort} setSort={setSort} align="right">Amount</SortHead>
        </div>
        <div>Confidence</div>
        <div>Type</div>
        <div>Status</div>
        <div />
      </div>

      {loading ? (
        <div className="t-empty">Loading invoices…</div>
      ) : rows.length === 0 ? (
        <div className="t-empty">No invoices match these filters.</div>
      ) : (
        rows.map((row) => {
          const sel = selected.has(row.id);
          const pct = row.confidence != null ? Math.min(100, Math.round(row.confidence * 100)) : 0;
          const type = row.invoice_direction === "verkoop" ? "Verkoop" : "Inkoop";
          const color = clientColor(row.client_name);
          const initials = clientInitials(row.client_name);

          return (
            <div
              key={row.id}
              className={`t-row${sel ? " sel" : ""}`}
              role="row"
              onClick={() => onOpen(row)}
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onOpen(row)}
            >
              <div
                className={`cb${sel ? " on" : ""}`}
                role="checkbox"
                aria-checked={sel}
                aria-label={`Select invoice ${row.invoice_number}`}
                onClick={(e) => { e.stopPropagation(); toggleRow(row.id); }}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === " ") { e.stopPropagation(); toggleRow(row.id); } }}
              >
                {sel && <Icon d={I.check} size={11} stroke={3} />}
              </div>

              <div className="cell-id">{row.invoice_number || row.id.slice(0, 8)}</div>

              <div className="cell-client">
                <div className="client-av" style={{ background: color }}>{initials}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="client-name">{row.client_name || "—"}</div>
                  <div className="client-phone">{row.phone_number}</div>
                </div>
              </div>

              <div className="cell-phone">{row.phone_number}</div>
              <div className="cell-date">{row.date ?? "—"}</div>
              <div className="cell-amount">{fmtEUR(row.total_amount)}</div>
              <div><ConfidenceBar pct={pct} /></div>
              <div><TypePill type={type} /></div>
              <div><Pill tone={statusTone(row.status)}>{statusLabel(row.status)}</Pill></div>

              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <a
                  href={`/api/invoices/${row.id}/download`}
                  target="_blank"
                  rel="noopener"
                  className="act"
                  title="Open file"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon d={I.open} size={14} />
                </a>
                <a
                  href={`/api/invoices/${row.id}/download`}
                  download
                  className="act"
                  title="Download"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon d={I.download} size={14} />
                </a>
                <button className="act" title="More" onClick={(e) => e.stopPropagation()}>
                  <Icon d={I.more} size={14} stroke={2.6} />
                </button>
              </div>
            </div>
          );
        })
      )}

      <div className="t-foot">
        <div>
          Showing <strong style={{ color: "var(--ink)" }}>{rows.length}</strong> of{" "}
          <strong style={{ color: "var(--ink)" }}>{total}</strong> invoices
        </div>
        <nav className="pgr" aria-label="Pagination">
          <button
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            aria-label="Previous page"
          >
            <Icon d={I.chevL} size={13} />
          </button>

          {pageNums.map((n) => (
            <button
              key={n}
              className={n === page ? "on" : ""}
              onClick={() => onPage(n)}
              aria-label={`Page ${n}`}
              aria-current={n === page ? "page" : undefined}
            >
              {n}
            </button>
          ))}

          <button
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
            aria-label="Next page"
          >
            <Icon d={I.chevR} size={13} />
          </button>
        </nav>
      </div>
    </div>
  );
}
