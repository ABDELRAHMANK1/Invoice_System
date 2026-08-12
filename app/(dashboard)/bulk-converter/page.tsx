"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, I } from "@/app/components/Icon";

type ClientOption = { id: string; name: string };

type InvoiceSummary = {
  sheetName: string;
  detectedColumns: string[];
  headerRow: number;
  totalDataRows: number;
  imported: number;
  concept: number;
  matched: number;
  blank: number;
  anomalous: number;
  rateCounts: { 0: number; 9: number; 21: number };
  customersLoaded: number;
  sumIncl: number;
  sumExcl: number;
  unmatchedNames: { name: string; count: number }[];
  anomalousInvoices: { invoice: string; rate: number }[];
};

type InvoiceResult = { summary: InvoiceSummary; filename: string; file_base64: string };

type RelationSummary = {
  kind: "leverancier" | "klant";
  label: string;
  sheetName: string;
  headerRow: number;
  templateColumns: number;
  totalDataRows: number;
  imported: number;
  mappedColumns: string[];
  filledColumns: string[];
  unmappedColumns: string[];
  unmatchedSourceColumns: string[];
};

type RelationResult = { summary: RelationSummary; filename: string; file_base64: string };

type Section = "invoices" | "leverancier" | "klant";

async function apiJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `${res.status}`); }
  return res.json();
}

function fmtEUR(n: number): string {
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n);
}

// base64 (the converted xlsx) → browser download.
function downloadBase64(filename: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--faint)", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ── Invoices → Snelstart Boekingen ─────────────────────────────────────────
function InvoicesConverter() {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientId, setClientId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiJson<{ data: ClientOption[] }>("/api/clients?limit=500")
      .then((r) => setClients(r.data || []))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load clients"));
  }, []);

  async function handleConvert() {
    if (!clientId) return setError("Select a client");
    if (!file) return setError("Choose an .xlsx file to convert");
    if (!/\.xlsx$/i.test(file.name)) return setError("File must be an .xlsx spreadsheet");

    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("client_id", clientId);
      const res = await fetch("/api/bulk-converter", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Conversion failed: ${res.status}`);
      setResult(body as InvoiceResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed");
    } finally {
      setBusy(false);
    }
  }

  const s = result?.summary;

  return (
    <>
      <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
            <label className="form-label" htmlFor="bc-client">Client <span className="req">*</span></label>
            <select id="bc-client" className="form-input" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={busy}>
              <option value="">— Select client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 4 }}>Relatiecodes are matched against this client’s customers (Klanten).</div>
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
            <label className="form-label" htmlFor="bc-file">Raw invoice file (.xlsx) <span className="req">*</span></label>
            <input
              id="bc-file"
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="form-input"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
            <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 4 }}>Needs at least: Factuurnummer · Datum · Client · Bedrag excl. BTW · Bedrag incl. BTW.</div>
          </div>
        </div>

        {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn primary" onClick={handleConvert} disabled={busy || !clientId || !file}>
            {busy ? <><span className="spinner-sm" /> Converting…</> : <><Icon d={I.excel} size={13} /> Convert</>}
          </button>
          <span style={{ fontSize: 12, color: "var(--faint)" }}>Read-only — nothing is saved to the database.</span>
        </div>
      </div>

      {s && result && (
        <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <Icon d={I.check} size={15} /> Converted — {s.imported} invoices
            </div>
            <button className="btn primary" onClick={() => downloadBase64(result.filename, result.file_base64)}>
              <Icon d={I.download} size={13} /> Download {result.filename}
            </button>
          </div>

          <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
            Sheet “{s.sheetName}” · header detected on row {s.headerRow} · columns: {s.detectedColumns.join(", ")}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            {[
              { label: "Imported", value: String(s.imported) },
              { label: "Concept (draft)", value: String(s.concept) },
              { label: "BTW 21% / 9% / 0%", value: `${s.rateCounts[21]} / ${s.rateCounts[9]} / ${s.rateCounts[0]}` },
              { label: "Anomalous VAT", value: String(s.anomalous) },
              { label: "Relatiecode matched", value: String(s.matched) },
              { label: "Relatiecode blank", value: String(s.blank) },
              { label: "Total incl. BTW", value: fmtEUR(s.sumIncl) },
              { label: "Total excl. BTW", value: fmtEUR(s.sumExcl) },
            ].map((stat) => <StatCard key={stat.label} label={stat.label} value={stat.value} />)}
          </div>

          {(s.blank > 0 || s.anomalous > 0) && (
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
              <Icon d={I.alert} size={12} /> Highlighted rows in the downloaded file need review (hover the RelatieCode cell for the reason).
            </div>
          )}

          {s.unmatchedNames.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 6, color: "var(--muted)" }}>
                <Icon d={I.alert} size={13} /> {s.unmatchedNames.length} customer name{s.unmatchedNames.length === 1 ? "" : "s"} had no match — Relatiecode left blank
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {s.unmatchedNames.map((u) => (
                  <span key={u.name} className="pill s-info" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {u.name}{u.count > 1 ? ` · ${u.count}` : ""}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 8 }}>
                Add or correct these in <strong>Clients → Customers (Klanten)</strong>, then re-convert — or fill them in manually.
              </div>
            </div>
          )}

          {s.anomalousInvoices.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 6, color: "var(--muted)" }}>
                <Icon d={I.alert} size={13} /> {s.anomalousInvoices.length} invoice{s.anomalousInvoices.length === 1 ? "" : "s"} had a VAT rate that isn’t 0% / 9% / 21%
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {s.anomalousInvoices.map((a) => (
                  <span key={a.invoice} className="pill s-warn" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {a.invoice} · {a.rate}%
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 8 }}>
                These keep their real excl/BTW amounts on the closest tarief and are highlighted for you to verify.
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── Leveranciers / Klanten → Snelstart relation import template ─────────────
function RelationConverter({ kind }: { kind: "leverancier" | "klant" }) {
  const label = kind === "leverancier" ? "Leveranciers" : "Klanten";
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RelationResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleConvert() {
    if (!file) return setError("Choose an .xlsx file to convert");
    if (!/\.xlsx$/i.test(file.name)) return setError("File must be an .xlsx spreadsheet");

    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const res = await fetch("/api/relation-converter", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Conversion failed: ${res.status}`);
      setResult(body as RelationResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed");
    } finally {
      setBusy(false);
    }
  }

  const s = result?.summary;

  return (
    <>
      <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16, marginBottom: 18 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor={`rc-file-${kind}`}>{label} file (.xlsx) <span className="req">*</span></label>
          <input
            id={`rc-file-${kind}`}
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="form-input"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 4 }}>
            Your columns are matched by name onto Snelstart’s {label.toLowerCase()} import template. Needs at least a <strong>Naam</strong> column.
          </div>
        </div>

        {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn primary" onClick={handleConvert} disabled={busy || !file}>
            {busy ? <><span className="spinner-sm" /> Converting…</> : <><Icon d={I.excel} size={13} /> Convert</>}
          </button>
          <span style={{ fontSize: 12, color: "var(--faint)" }}>Read-only — nothing is saved to the database.</span>
        </div>
      </div>

      {s && result && (
        <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <Icon d={I.check} size={15} /> Converted — {s.imported} {s.label.toLowerCase()}
            </div>
            <button className="btn primary" onClick={() => downloadBase64(result.filename, result.file_base64)}>
              <Icon d={I.download} size={13} /> Download {result.filename}
            </button>
          </div>

          <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
            Sheet “{s.sheetName}” · header detected on row {s.headerRow} · conformed to the {s.templateColumns}-column Snelstart {s.label} template.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <StatCard label="Rows converted" value={String(s.imported)} />
            <StatCard label="Columns filled" value={`${s.filledColumns.length} / ${s.templateColumns}`} />
            <StatCard label="Source cols mapped" value={String(s.mappedColumns.length)} />
            <StatCard label="Source cols ignored" value={String(s.unmatchedSourceColumns.length)} />
          </div>

          {s.unmatchedSourceColumns.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 6, color: "var(--muted)" }}>
                <Icon d={I.alert} size={13} /> {s.unmatchedSourceColumns.length} source column{s.unmatchedSourceColumns.length === 1 ? "" : "s"} didn’t map to the template — left out
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {s.unmatchedSourceColumns.map((c) => (
                  <span key={c} className="pill s-warn">{c}</span>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 8 }}>
                Snelstart’s template has no matching column for these. Rename them in your source to a template header if they’re needed.
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function BulkConverterPage() {
  const [section, setSection] = useState<Section>("invoices");

  const subtitle =
    section === "invoices"
      ? "Convert an external raw invoice spreadsheet into the accepted Snelstart verkoop Boekingen format. Relatiecodes are matched against the selected client’s customers."
      : section === "leverancier"
        ? "Reshape a suppliers (Leveranciers) list into Snelstart’s accepted relation import template — same data, exact template columns."
        : "Reshape a customers (Klanten) list into Snelstart’s accepted relation import template — same data, exact template columns.";

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Bulk Converter</h1>
          <div className="sub">{subtitle}</div>
        </div>
      </div>

      <div className="tabs-row" style={{ marginBottom: 18 }}>
        <button className={`tab${section === "invoices" ? " on" : ""}`} onClick={() => setSection("invoices")}>
          <Icon d={I.excel} size={14} /> Invoices
        </button>
        <button className={`tab${section === "leverancier" ? " on" : ""}`} onClick={() => setSection("leverancier")}>
          <Icon d={I.excel} size={14} /> Leveranciers
        </button>
        <button className={`tab${section === "klant" ? " on" : ""}`} onClick={() => setSection("klant")}>
          <Icon d={I.excel} size={14} /> Klanten
        </button>
      </div>

      {section === "invoices" && <InvoicesConverter />}
      {section === "leverancier" && <RelationConverter kind="leverancier" />}
      {section === "klant" && <RelationConverter kind="klant" />}
    </main>
  );
}
