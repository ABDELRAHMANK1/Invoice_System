"use client";

import { useCallback, useEffect, useState } from "react";

type InvoiceDirection = "inkoop" | "verkoop";

type Invoice = {
  id: string;
  phone_number: string;
  invoice_number: string;
  client_name: string | null;
  date: string | null;
  total_amount: number | null;
  currency: string;
  file_url: string;
  status: "extracted" | "pending" | "error";
  confidence: number | null;
  created_at: string;
  invoice_direction: InvoiceDirection | null;
};

type FileRow = {
  id: string;
  phone_number: string;
  file_key: string;
  file_type: "image" | "pdf";
  file_name: string | null;
  status: "pending" | "processing" | "done" | "error";
  error_message: string | null;
  created_at: string;
  invoice_direction: InvoiceDirection | null;
};

type Paged<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type InvoicePage = Paged<Invoice> & { total_amount: number };

type Filters = {
  phone: string;
  from: string;
  to: string;
  client: string;
  invoice: string;
  direction: "" | InvoiceDirection;
};

const emptyFilters: Filters = { phone: "", from: "", to: "", client: "", invoice: "", direction: "" };

function money(value: number | null, currency = "EUR") {
  if (value == null) return "-";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

function statusClass(status: string) {
  if (["done", "extracted"].includes(status)) return "badge ok";
  if (["pending", "processing"].includes(status)) return "badge warn";
  return "badge danger";
}

function buildInvoiceQuery(filters: Filters, page: number, limit = 12) {
  const qs = new URLSearchParams();
  if (filters.phone)     qs.set("phone", filters.phone);
  if (filters.from)      qs.set("from", filters.from);
  if (filters.to)        qs.set("to", filters.to);
  if (filters.client)    qs.set("client", filters.client);
  if (filters.invoice)   qs.set("invoice", filters.invoice);
  if (filters.direction) qs.set("direction", filters.direction);
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  return qs.toString();
}

function buildFileQuery(filters: Filters, page: number, limit = 12) {
  const qs = new URLSearchParams();
  if (filters.phone)     qs.set("phone", filters.phone);
  if (filters.from)      qs.set("from", filters.from);
  if (filters.to)        qs.set("to", filters.to);
  if (filters.direction) qs.set("direction", filters.direction);
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  return qs.toString();
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with ${res.status}`);
  }
  return res.json();
}

const emptyInvoicePage: InvoicePage = { data: [], total: 0, total_amount: 0, page: 1, limit: 12, totalPages: 0 };
const emptyFilePage: Paged<FileRow> = { data: [], total: 0, page: 1, limit: 12, totalPages: 0 };

export default function DashboardPage() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [tab, setTab] = useState<"invoices" | "files">("invoices");
  const [invoicePage, setInvoicePage] = useState(1);
  const [filePage, setFilePage] = useState(1);
  const [invoices, setInvoices] = useState<InvoicePage>(emptyInvoicePage);
  const [files, setFiles] = useState<Paged<FileRow>>(emptyFilePage);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportModal, setExportModal] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invoiceResult, fileResult] = await Promise.all([
        apiJson<InvoicePage>(`/api/invoices?${buildInvoiceQuery(filters, invoicePage)}`),
        apiJson<Paged<FileRow>>(`/api/files?${buildFileQuery(filters, filePage)}`)
      ]);
      setInvoices(invoiceResult);
      setFiles(fileResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load dashboard data");
    } finally {
      setLoading(false);
    }
  }, [filters, invoicePage, filePage]);

  useEffect(() => {
    load();
  }, [load]);

  function applyFilters() {
    setFilters(draft);
    setInvoicePage(1);
    setFilePage(1);
    setMessage(null);
    setExportMsg(null);
    setExportUrl(null);
  }

  function clearFilters() {
    setDraft(emptyFilters);
    setFilters(emptyFilters);
    setExportMsg(null);
    setExportUrl(null);
  }

  async function startExport(type: "excel" | "zip", direction?: InvoiceDirection) {
    setExporting(true);
    setExportMsg(type === "excel" ? "Generating Excel file…" : "Preparing ZIP archive…");
    setExportUrl(null);
    setError(null);

    try {
      const result = await apiJson<{ jobId: string; status: string; download_url?: string; file_count?: number }>(
        "/api/export",
        {
          method: "POST",
          body: JSON.stringify({ ...filters, type, async_job: false, direction: direction ?? (filters.direction || undefined) })
        }
      );

      if (result.download_url) {
        const label = type === "excel" ? "Excel" : "ZIP";
        setExportMsg(`${label} ready — ${result.file_count ?? 0} ${type === "excel" ? "invoices" : "files"}.`);
        setExportUrl(result.download_url);
        // Trigger download automatically
        const a = document.createElement("a");
        a.href = result.download_url;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        // Async job — poll until done
        setExportMsg("Export job queued, checking status…");
        await pollExportJob(result.jobId, type);
      }
    } catch (err) {
      setExportMsg(null);
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function pollExportJob(jobId: string, type: "excel" | "zip") {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const job = await apiJson<{ status: string; download_url?: string; file_count?: number }>(
        `/api/export?jobId=${jobId}`
      );
      if (job.status === "done" && job.download_url) {
        const label = type === "excel" ? "Excel" : "ZIP";
        setExportMsg(`${label} ready — ${job.file_count ?? 0} items.`);
        setExportUrl(job.download_url);
        return;
      }
      if (job.status === "error") throw new Error("Export job failed on server");
    }
    throw new Error("Export timed out — try a smaller date range");
  }

  async function retryFile(fileId: string) {
    try {
      await apiJson(`/api/files/${fileId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "pending" })
      });
      load();
    } catch {
      setError("Could not reset file status — try again");
    }
  }

  const pendingCount = files.data.filter((f) => ["pending", "processing"].includes(f.status)).length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a href="/" className="nav-logo">Oranji</a>
          <nav className="nav-links" aria-label="Main navigation">
            <a href="/" className="nav-link">Home</a>
            <button
              className={`nav-link nav-tab-btn${tab === "invoices" ? " nav-link--active" : ""}`}
              onClick={() => setTab("invoices")}
            >
              Invoices
            </button>
            <button
              className={`nav-link nav-tab-btn${tab === "files" ? " nav-link--active" : ""}`}
              onClick={() => setTab("files")}
            >
              Files
            </button>
          </nav>
        </div>
      </header>

      <section className="workspace">
        <div className="summary" aria-label="Result summary">
          <div className="summary-item">
            <div className="summary-label">Total invoices</div>
            <div className="summary-value">{invoices.total.toLocaleString()}</div>
          </div>
          <div className="summary-item">
            <div className="summary-label">Total files</div>
            <div className="summary-value">{files.total.toLocaleString()}</div>
          </div>
          <div className="summary-item">
            <div className="summary-label">Pending (page)</div>
            <div className="summary-value">{pendingCount.toLocaleString()}</div>
          </div>
          <div className="summary-item">
            <div className="summary-label">Total amount (all results)</div>
            <div className="summary-value">{money(invoices.total_amount, "EUR")}</div>
          </div>
        </div>

        <div className="filters">
          <div className="field">
            <label htmlFor="phone">Phone number</label>
            <input
              id="phone"
              value={draft.phone}
              placeholder="+201012345678"
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="client">Client name</label>
            <input
              id="client"
              value={draft.client}
              placeholder="Acme LLC"
              onChange={(e) => setDraft((d) => ({ ...d, client: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="invoice">Invoice number</label>
            <input
              id="invoice"
              value={draft.invoice}
              placeholder="INV-1005"
              onChange={(e) => setDraft((d) => ({ ...d, invoice: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="from">From</label>
            <input
              id="from"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="to">To</label>
            <input
              id="to"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Type</label>
            <div className="seg-ctrl" role="group" aria-label="Invoice direction">
              {(["", "inkoop", "verkoop"] as const).map((d) => (
                <button
                  key={d || "alle"}
                  className={draft.direction === d ? "seg-btn seg-active" : "seg-btn"}
                  onClick={() => setDraft((prev) => ({ ...prev, direction: d }))}
                >
                  {d === "" ? "Alle" : d.charAt(0).toUpperCase() + d.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="actions">
            <button className="primary" onClick={applyFilters} disabled={loading}>Search</button>
            <button onClick={clearFilters} disabled={loading}>Clear</button>
            <button onClick={() => setExportModal(true)} disabled={exporting || loading}>
              {exporting ? "Exporting…" : "Export Excel"}
            </button>
            <button onClick={() => startExport("zip")} disabled={exporting || loading}>
              {exporting ? "Exporting…" : "Download Files"}
            </button>
          </div>
        </div>

        {exportModal && (
          <div className="modal-backdrop" onClick={() => setExportModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">Excel exporteren</div>
              <p className="modal-sub">Kies het type boekingen voor dit exportbestand:</p>
              <div className="modal-choices">
                <button
                  className="modal-choice"
                  onClick={() => { setExportModal(false); startExport("excel", "inkoop"); }}
                >
                  <span className="badge dir-inkoop">Inkoop</span>
                  <span className="modal-choice-desc">Crediteuren · dagboek 1600</span>
                </button>
                <button
                  className="modal-choice"
                  onClick={() => { setExportModal(false); startExport("excel", "verkoop"); }}
                >
                  <span className="badge dir-verkoop">Verkoop</span>
                  <span className="modal-choice-desc">Debiteuren · dagboek 1300</span>
                </button>
              </div>
              <button className="modal-cancel" onClick={() => setExportModal(false)}>Annuleren</button>
            </div>
          </div>
        )}

        {exportMsg ? (
          <div className="notice export-notice">
            <span>{exportMsg}</span>
            {exportUrl ? (
              <a href={exportUrl} className="download-link">Download again</a>
            ) : (
              <span className="spinner" />
            )}
          </div>
        ) : null}

        {message ? <div className="notice">{message}</div> : null}
        {error   ? <div className="notice error">{error}</div> : null}

        <div className="tabs" role="tablist" aria-label="Data tables">
          <button aria-pressed={tab === "invoices"} onClick={() => setTab("invoices")}>
            Invoices {invoices.total > 0 ? `(${invoices.total.toLocaleString()})` : ""}
          </button>
          <button aria-pressed={tab === "files"} onClick={() => setTab("files")}>
            Raw files {files.total > 0 ? `(${files.total.toLocaleString()})` : ""}
          </button>
        </div>

        {tab === "invoices" ? (
          <InvoiceTable paged={invoices} loading={loading} onPage={setInvoicePage} />
        ) : (
          <FileTable paged={files} loading={loading} onPage={setFilePage} onRetry={retryFile} />
        )}
      </section>
    </main>
  );
}

function InvoiceTable({
  paged,
  loading,
  onPage
}: {
  paged: InvoicePage;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <section className="table-wrap">
      <div className="table-header">
        <div className="table-title">Invoices</div>
        <div className="muted">{paged.total.toLocaleString()} results</div>
      </div>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Client</th>
              <th>Phone</th>
              <th>Date</th>
              <th className="right">Amount</th>
              <th className="center">Confidence</th>
              <th className="center">Type</th>
              <th className="center">Status</th>
              <th className="center">File</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="loading">Loading invoices…</td></tr>
            ) : paged.data.length === 0 ? (
              <tr><td colSpan={9} className="empty">No invoices match these filters.</td></tr>
            ) : (
              paged.data.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="mono">{invoice.invoice_number}</td>
                  <td>{invoice.client_name || "-"}</td>
                  <td className="mono">{invoice.phone_number}</td>
                  <td>{invoice.date || "-"}</td>
                  <td className="right">{money(invoice.total_amount, invoice.currency)}</td>
                  <td className="center">
                    {invoice.confidence != null
                      ? `${Math.round(invoice.confidence * 100)}%`
                      : "-"}
                  </td>
                  <td className="center">
                    <span className={`badge ${invoice.invoice_direction === "verkoop" ? "dir-verkoop" : "dir-inkoop"}`}>
                      {invoice.invoice_direction === "verkoop" ? "Verkoop" : "Inkoop"}
                    </span>
                  </td>
                  <td className="center">
                    <span className={statusClass(invoice.status)}>{invoice.status}</span>
                  </td>
                  <td className="center">
                    <a href={`/api/invoices/${invoice.id}/download`} target="_blank">Open</a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager paged={paged} onPage={onPage} />
    </section>
  );
}

function FileTable({
  paged,
  loading,
  onPage,
  onRetry
}: {
  paged: Paged<FileRow>;
  loading: boolean;
  onPage: (page: number) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <section className="table-wrap">
      <div className="table-header">
        <div className="table-title">Raw files</div>
        <div className="muted">{paged.total.toLocaleString()} results</div>
      </div>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Phone</th>
              <th>Type</th>
              <th>Received</th>
              <th className="center">Direction</th>
              <th className="center">Status</th>
              <th>Error</th>
              <th className="center">File</th>
              <th className="center">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="loading">Loading files…</td></tr>
            ) : paged.data.length === 0 ? (
              <tr><td colSpan={8} className="empty">No files match these filters.</td></tr>
            ) : (
              paged.data.map((file) => (
                <tr key={file.id}>
                  <td className="mono">{file.phone_number}</td>
                  <td>{file.file_type.toUpperCase()}</td>
                  <td>{new Date(file.created_at).toLocaleString()}</td>
                  <td className="center">
                    <span className={`badge ${file.invoice_direction === "verkoop" ? "dir-verkoop" : "dir-inkoop"}`}>
                      {file.invoice_direction === "verkoop" ? "Verkoop" : "Inkoop"}
                    </span>
                  </td>
                  <td className="center">
                    <span className={statusClass(file.status)}>{file.status}</span>
                  </td>
                  <td>{file.error_message || "-"}</td>
                  <td className="center">
                    <a href={`/api/files/${file.id}/download`} target="_blank">Open</a>
                  </td>
                  <td className="center">
                    {file.status === "error" ? (
                      <button className="btn-retry" onClick={() => onRetry(file.id)}>Retry</button>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager paged={paged} onPage={onPage} />
    </section>
  );
}

function Pager<T>({ paged, onPage }: { paged: Paged<T>; onPage: (page: number) => void }) {
  return (
    <div className="pager">
      <button onClick={() => onPage(Math.max(1, paged.page - 1))} disabled={paged.page <= 1}>
        Previous
      </button>
      <span className="muted">Page {paged.page} of {Math.max(paged.totalPages, 1)}</span>
      <button onClick={() => onPage(Math.min(paged.totalPages, paged.page + 1))} disabled={paged.page >= paged.totalPages}>
        Next
      </button>
    </div>
  );
}
