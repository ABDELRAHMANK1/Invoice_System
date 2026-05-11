"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, I } from "@/app/components/Icon";
import { StatsRow } from "@/app/components/StatsRow";
import { FilterBar, type FilterQuery, type AppliedChip } from "@/app/components/FilterBar";
import { InvoiceTable, type InvoiceRow, type Sort } from "@/app/components/InvoiceTable";
import { BulkBar } from "@/app/components/BulkBar";
import { InvoiceDrawer } from "@/app/components/InvoiceDrawer";
import { ExportModal } from "@/app/components/ExportModal";
import { UploadModal } from "@/app/components/UploadModal";
import { useToast } from "@/app/components/Toast";

type Paged<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type InvoicePage = Paged<InvoiceRow> & { total_amount: number };

const emptyPage: InvoicePage = {
  data: [], total: 0, total_amount: 0, page: 1, limit: 20, totalPages: 0,
};

const emptyQ: FilterQuery = {
  phone: "", client: "", invoice: "", from: "", to: "", type: "Alle",
};

type TabId = "invoices" | "files" | "review";

async function apiJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function buildQuery(q: FilterQuery, sort: Sort, page: number) {
  const qs = new URLSearchParams();
  if (q.phone)   qs.set("phone",   q.phone);
  if (q.client)  qs.set("client",  q.client);
  if (q.invoice) qs.set("invoice", q.invoice);
  if (q.from)    qs.set("from",    q.from);
  if (q.to)      qs.set("to",      q.to);
  if (q.type !== "Alle") qs.set("direction", q.type.toLowerCase());
  qs.set("sort_by",  sort.k);
  qs.set("sort_dir", sort.dir);
  qs.set("page",     String(page));
  qs.set("limit",    "20");
  return qs.toString();
}

function filtersForExport(q: FilterQuery) {
  return {
    phone:   q.phone   || undefined,
    client:  q.client  || undefined,
    invoice: q.invoice || undefined,
    from:    q.from    || undefined,
    to:      q.to      || undefined,
  };
}

export default function InvoicesPage() {
  const { toast } = useToast();

  const [tab, setTab]                 = useState<TabId>("invoices");
  const [q, setQ]                     = useState<FilterQuery>(emptyQ);
  const [committed, setCommitted]     = useState<FilterQuery>(emptyQ);
  const [quickOn, setQuickOn]         = useState("");
  const [applied, setApplied]         = useState<AppliedChip[]>([]);
  const [sort, setSort]               = useState<Sort>({ k: "date", dir: "desc" });
  const [page, setPage]               = useState(1);
  const [invoices, setInvoices]       = useState<InvoicePage>(emptyPage);
  const [loading, setLoading]         = useState(false);
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [drawer, setDrawer]           = useState<InvoiceRow | null>(null);
  const [exportType, setExportType]   = useState<"excel" | "zip">("excel");
  const [exportOpen, setExportOpen]   = useState(false);
  const [exportIds, setExportIds]     = useState<string[] | undefined>(undefined);
  const [uploadOpen, setUploadOpen]   = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiJson<InvoicePage>(
        `/api/invoices?${buildQuery(committed, sort, page)}`
      );
      setInvoices(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load invoices");
    } finally {
      setLoading(false);
    }
  }, [committed, sort, page]);

  useEffect(() => { load(); }, [load]);

  function applySearch() {
    setCommitted(q);
    setPage(1);
    const chips: AppliedChip[] = [];
    if (q.client)  chips.push({ k: "client",  v: q.client });
    if (q.phone)   chips.push({ k: "phone",   v: q.phone });
    if (q.invoice) chips.push({ k: "invoice", v: q.invoice });
    if (q.from)    chips.push({ k: "from",    v: q.from });
    if (q.to)      chips.push({ k: "to",      v: q.to });
    setApplied(chips);
  }

  function clearAll() {
    setQ(emptyQ);
    setCommitted(emptyQ);
    setApplied([]);
    setQuickOn("");
    setPage(1);
  }

  function removeApplied(k: string) {
    setApplied((prev) => prev.filter((a) => a.k !== k));
    const next = { ...committed } as FilterQuery;
    if (k === "type") { next.type = "Alle"; }
    else { (next as Record<string, string>)[k] = ""; }
    setCommitted(next);
    setQ(next);
    setPage(1);
  }

  function handleSort(s: Sort) {
    setSort(s);
    setPage(1);
  }

  function openExport(type: "excel" | "zip", ids?: string[]) {
    setExportType(type);
    setExportIds(ids);
    setExportOpen(true);
  }

  const pendingCount = invoices.data.filter(
    (r) => r.status !== "extracted" && r.status !== "done"
  ).length;

  const reviewCount = pendingCount;

  const avgConf = invoices.data.length > 0
    ? Math.round(
        invoices.data.reduce((s, r) => s + (r.confidence != null ? r.confidence * 100 : 0), 0)
        / invoices.data.length
      )
    : 0;

  return (
    <main className="main">
      {/* Page header */}
      <div className="page-h">
        <div>
          <h1>Invoices</h1>
          <div className="sub">All extracted invoices and source files for your workspace.</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setUploadOpen(true)}>
            <Icon d={I.upload} size={13} /> Upload
          </button>
          <button className="btn" onClick={() => openExport("excel")}>
            <Icon d={I.excel} size={13} /> Export Excel
          </button>
          <button className="btn" onClick={() => openExport("zip")}>
            <Icon d={I.download} size={13} /> Download files
          </button>
          <button
            className="btn primary"
            onClick={() => toast("New invoice form — coming soon", "info")}
          >
            <Icon d={I.invoice} size={13} /> New invoice
          </button>
        </div>
      </div>

      {error && (
        <div className="notice-error">
          <Icon d={I.alert} size={14} />
          {error}
          <button className="btn sm" onClick={load} style={{ marginLeft: "auto" }}>Retry</button>
        </div>
      )}

      {/* Stats */}
      <StatsRow
        total={invoices.total}
        totalAmount={invoices.total_amount}
        pending={pendingCount}
        avgConfidence={avgConf}
      />

      {/* Filters */}
      <FilterBar
        q={q}
        setQ={setQ}
        quickOn={quickOn}
        setQuickOn={setQuickOn}
        applied={applied}
        removeApplied={removeApplied}
        onSearch={applySearch}
        onClear={clearAll}
      />

      {/* Tabs */}
      <div className="tabs-row" role="tablist" aria-label="Invoice views">
        <button
          className={`tab${tab === "invoices" ? " on" : ""}`}
          role="tab"
          aria-selected={tab === "invoices"}
          onClick={() => setTab("invoices")}
        >
          <Icon d={I.invoice} size={14} />
          Invoices
          <span className="tab-ct">{invoices.total}</span>
        </button>
        <button
          className={`tab${tab === "review" ? " on" : ""}`}
          role="tab"
          aria-selected={tab === "review"}
          onClick={() => setTab("review")}
        >
          <Icon d={I.alert} size={14} />
          Needs review
          <span className="tab-ct">{reviewCount}</span>
        </button>
        <div className="tabs-right">
          <button className="btn sm">
            <Icon d={I.filter} size={12} /> Columns
          </button>
          <button className="btn sm" onClick={() => openExport("excel")}>
            <Icon d={I.download} size={12} /> Export view
          </button>
        </div>
      </div>

      <InvoiceTable
        rows={invoices.data}
        total={invoices.total}
        page={invoices.page}
        totalPages={invoices.totalPages}
        selected={selected}
        setSelected={setSelected}
        sort={sort}
        setSort={handleSort}
        onOpen={(row) => setDrawer(row)}
        onPage={(p) => setPage(p)}
        loading={loading}
      />

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          onDownload={() => openExport("zip", [...selected])}
          onExport={() => openExport("excel", [...selected])}
          onMarkReviewed={() => toast(`Marked ${selected.size} as reviewed`, "success")}
          onArchive={() => toast("Archive — coming soon", "info")}
          onClear={() => setSelected(new Set())}
        />
      )}

      <InvoiceDrawer
        row={drawer}
        onClose={() => setDrawer(null)}
      />

      <ExportModal
        open={exportOpen}
        type={exportType}
        filters={filtersForExport(committed)}
        ids={exportIds}
        onClose={() => { setExportOpen(false); setExportIds(undefined); }}
      />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={() => {
          toast("File uploaded — extraction queued", "success");
          load();
        }}
      />
    </main>
  );
}
