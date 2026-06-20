"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Icon, I } from "@/app/components/Icon";
import { StatsRow, type StatCardProps } from "@/app/components/StatsRow";
import type { InvoiceRow } from "@/app/components/InvoiceTable";

type Paged = {
  data: InvoiceRow[];
  total: number;
  total_amount: number;
};

function fmtEUR(n: number) {
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n);
}

// Local-date ISO (YYYY-MM-DD); avoid toISOString() which shifts to UTC.
function toISODate(d: Date): string {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

async function apiJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export default function DashboardPage() {
  const [all, setAll]         = useState<Paged | null>(null);
  const [month, setMonth]     = useState<Paged | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const monthStart = (() => {
    const now = new Date();
    return toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  })();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allRes, monthRes] = await Promise.all([
        apiJson<Paged>("/api/invoices?sort_by=date&sort_dir=desc&page=1&limit=6"),
        apiJson<Paged>(`/api/invoices?from=${monthStart}&page=1&limit=1`),
      ]);
      setAll(allRes);
      setMonth(monthRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load overview");
    } finally {
      setLoading(false);
    }
  }, [monthStart]);

  useEffect(() => { load(); }, [load]);

  const cards: StatCardProps[] = [
    {
      label: "Total invoices",
      value: all ? String(all.total) : "—",
      sub: "across your workspace",
      accent: "#0ea5e9",
    },
    {
      label: "Total value",
      value: all ? fmtEUR(all.total_amount) : "—",
      sub: "sum of invoice totals",
      accent: "#10b981",
    },
    {
      label: "Invoices this month",
      value: month ? String(month.total) : "—",
      sub: "since the 1st",
      accent: "#6366f1",
    },
    {
      label: "Value this month",
      value: month ? fmtEUR(month.total_amount) : "—",
      sub: "billed this month",
      accent: "#f59e0b",
    },
  ];

  const recent = all?.data ?? [];

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">Overview of your invoice workspace.</div>
        </div>
        <div className="actions">
          <Link href="/invoices" className="btn primary">
            <Icon d={I.invoice} size={13} /> Go to invoices
          </Link>
        </div>
      </div>

      {error && (
        <div className="notice-error">
          <Icon d={I.alert} size={14} />
          {error}
          <button className="btn sm" onClick={load} style={{ marginLeft: "auto" }}>Retry</button>
        </div>
      )}

      <StatsRow cards={cards} />

      <section className="report-card">
        <div className="dash-panel-h">
          <h3>Recent invoices</h3>
          <Link href="/invoices" className="btn sm">
            View all <Icon d={I.chevR} size={12} />
          </Link>
        </div>

        {loading ? (
          <div className="dash-empty">Loading…</div>
        ) : recent.length === 0 ? (
          <div className="dash-empty">No invoices yet.</div>
        ) : (
          <ul className="dash-list">
            {recent.map((r) => {
              const who = r.sender_name || r.client_name || r.phone_number || "—";
              return (
                <li key={r.id} className="dash-row">
                  <div className="dash-row-main">
                    <span className="dash-inv">{r.invoice_number || r.id.slice(0, 8)}</span>
                    <span className="dash-cli">{who}</span>
                  </div>
                  <span className="dash-date">{r.date ?? "—"}</span>
                  <span className="dash-amt mono">
                    {r.total_amount != null ? fmtEUR(r.total_amount) : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
