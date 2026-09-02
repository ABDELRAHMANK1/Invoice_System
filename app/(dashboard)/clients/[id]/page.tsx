"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";
import { formatAliases, parseAliases } from "@/lib/aliases";
import { formatNL } from "@/lib/billing";
import { BTW_RATES, PRICING_MODELS } from "@/lib/types";
import type { CustomerExtras, PricingModel, Supplier } from "@/lib/types";
import { DEFAULT_DAYS_PER_WEEK, effectiveHourlyRate } from "@/lib/workforce/domain";
import type { Employee } from "@/lib/workforce/domain";

type Client = {
  id: string;
  name: string;
  phone_number: string | null;
  whatsapp_phone: string | null;
  email: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  country: string;
  btw_number: string | null;
  kvk_number: string | null;
  iban: string | null;
  aliases: string[] | null;
  relatie_code: string | null;
  notes: string | null;
  /** Default pay rate inherited by employees without their own override. */
  default_hourly_rate: number | null;
  created_at: string;
};

// Two columns are edited as text and stored as something else: `aliases` is a
// text[] (comma-separated in the input — see lib/aliases) and
// `default_hourly_rate` is a nullable numeric kept as a string so the box can
// be left empty.
type ClientForm = Omit<Client, "id" | "created_at" | "aliases" | "default_hourly_rate"> & {
  aliases: string;
  default_hourly_rate: string;
};

const emptyClientForm: ClientForm = {
  name: "", phone_number: "", whatsapp_phone: "", email: "", address: "",
  postcode: "", city: "", country: "NL", btw_number: "", kvk_number: "",
  iban: "", aliases: "", relatie_code: "", notes: "", default_hourly_rate: "",
};

// Suppliers (Leveranciers) and Customers (Klanten) share an identical record
// shape (the `customers` table mirrors `suppliers` — see migration 005), so a
// single "kind" parametrises the modal, import, and table for both.
type Kind = "supplier" | "customer";

// A counterparty record. Customers carry extra invoicing settings that
// suppliers don't have, so those are optional on the shared shape.
type Counterparty = Supplier & Partial<CustomerExtras>;

interface KindConfig {
  /** URL ?tab value */
  tab: "leveranciers" | "klanten";
  /** Dutch tab label */
  tabLabel: string;
  singular: string;          // "supplier"
  Singular: string;          // "Supplier"
  apiBase: (clientId: string) => string;
  addLabel: string;
  importTitle: string;
  emptyText: string;
}

const KINDS: Record<Kind, KindConfig> = {
  supplier: {
    tab: "leveranciers",
    tabLabel: "Leveranciers",
    singular: "supplier",
    Singular: "Supplier",
    apiBase: (clientId) => `/api/clients/${clientId}/suppliers`,
    addLabel: "Add supplier",
    importTitle: "Import suppliers from Excel",
    emptyText: "No suppliers yet. Add one to map their relatie_code to invoices.",
  },
  customer: {
    tab: "klanten",
    tabLabel: "Klanten",
    singular: "customer",
    Singular: "Customer",
    apiBase: (clientId) => `/api/clients/${clientId}/customers`,
    addLabel: "Add customer",
    importTitle: "Import customers from Excel",
    emptyText: "No customers yet. Add the parties this client sells to.",
  },
};

// Employees (workers the client PAYS) are not counterparties — they share the
// tab bar but nothing else, so the tab union is wider than Kind.
type Tab = Kind | "employee";

const EMPLOYEE_TAB = { tab: "employees", tabLabel: "Employees" } as const;
const TAB_ORDER: Tab[] = ["supplier", "customer", "employee"];

function tabConfig(tab: Tab): { tab: string; tabLabel: string } {
  return tab === "employee" ? EMPLOYEE_TAB : KINDS[tab];
}

function tabFromParam(param: string | null): Tab {
  if (param === "klanten") return "customer";
  if (param === EMPLOYEE_TAB.tab) return "employee";
  return "supplier";
}

// The form mirrors the record except for the two fields the DOM edits as text:
// `aliases` (a text[] column, comma-separated in the input) and `default_rate`
// (nullable numeric — kept as a string so the box can be left empty).
type CounterpartyForm = {
  name: string;
  relatie_code: string;
  address: string;
  postcode: string;
  city: string;
  kvk: string;
  btw_number: string;
  iban: string;
  email: string;
  phone: string;
  payment_days: number;
  active: boolean;
  // Customer-only (Invoicing settings) — ignored for suppliers.
  btw_verlegd: boolean;
  btw_rate: number;
  pricing_model: PricingModel;
  default_rate: string;
  aliases: string;
  message_pattern: string;
};

const PRICING_MODEL_LABELS: Record<PricingModel, string> = {
  hourly:   "Per hour",
  per_stop: "Per stop",
  lump_sum: "Lump sum",
};

const DEFAULT_RATE_LABELS: Record<PricingModel, string> = {
  hourly:   "Rate per hour",
  per_stop: "Rate per stop",
  lump_sum: "Default amount",
};

// Customers default to a 30-day payment term; suppliers keep the old 0.
function emptyCounterpartyForm(kind: Kind): CounterpartyForm {
  return {
    name: "", relatie_code: "", address: "", postcode: "", city: "",
    kvk: "", btw_number: "", iban: "", email: "", phone: "",
    payment_days: kind === "customer" ? 30 : 0, active: true,
    btw_verlegd: false, btw_rate: 21, pricing_model: "hourly",
    default_rate: "", aliases: "", message_pattern: "",
  };
}

const CLIENT_COLORS = ["#1d4ed8","#2563eb","#1f8a5b","#7a5af0","#b45309","#c0392b","#0e7490","#9333ea"];

function clientColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
  return CLIENT_COLORS[h % CLIENT_COLORS.length];
}

function clientInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `${res.status}`); }
  return res.json();
}

/* ── Counterparty (supplier / customer) modal ────────────────────── */

interface CounterpartyModalProps {
  clientId: string;
  kind: Kind;
  record: Counterparty | null;
  open: boolean;
  onClose: () => void;
  onSaved: (s: Counterparty, isNew: boolean) => void;
}

function CounterpartyModal({ clientId, kind, record, open, onClose, onSaved }: CounterpartyModalProps) {
  const cfg = KINDS[kind];
  const isCustomer = kind === "customer";
  const { toast } = useToast();
  const [form, setForm] = useState<CounterpartyForm>(() => emptyCounterpartyForm(kind));
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof CounterpartyForm, string>>>({});

  useEffect(() => {
    if (open) {
      setForm(record
        ? {
            name: record.name,
            relatie_code: record.relatie_code ?? "",
            address: record.address ?? "",
            postcode: record.postcode ?? "",
            city: record.city ?? "",
            kvk: record.kvk ?? "",
            btw_number: record.btw_number ?? "",
            iban: record.iban ?? "",
            email: record.email ?? "",
            phone: record.phone ?? "",
            payment_days: record.payment_days ?? 0,
            active: record.active,
            btw_verlegd: record.btw_verlegd ?? false,
            btw_rate: record.btw_rate ?? 21,
            pricing_model: record.pricing_model ?? "hourly",
            default_rate: record.default_rate == null ? "" : String(record.default_rate),
            aliases: formatAliases(record.aliases),
            message_pattern: record.message_pattern ?? "",
          }
        : emptyCounterpartyForm(kind));
      setErrors({});
    }
  }, [open, record, kind]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function validate(): boolean {
    const e: typeof errors = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (form.email && !/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) e.email = "Invalid email";
    // Reverse charge puts the recipient's VAT number on the invoice notice —
    // without it the notice is invalid, so the field becomes required.
    if (isCustomer && form.btw_verlegd && !form.btw_number.trim()) {
      e.btw_number = "BTW number is required when BTW verlegd is on";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setLoading(true);
    try {
      const payload = {
        name:         form.name,
        relatie_code: form.relatie_code || null,
        address:      form.address || null,
        postcode:     form.postcode || null,
        city:         form.city || null,
        kvk:          form.kvk || null,
        btw_number:   form.btw_number || null,
        iban:         form.iban || null,
        email:        form.email || null,
        phone:        form.phone || null,
        payment_days: Number(form.payment_days ?? 0),
        active:       form.active,
        // Invoicing settings only exist on customers.
        ...(isCustomer ? {
          btw_verlegd:     form.btw_verlegd,
          btw_rate:        form.btw_verlegd ? 0 : Number(form.btw_rate),
          pricing_model:   form.pricing_model,
          default_rate:    form.default_rate.trim() === "" ? null : Number(form.default_rate),
          aliases:         parseAliases(form.aliases),
          message_pattern: form.message_pattern.trim() || null,
        } : {}),
      };
      const saved = record
        ? await apiJson<Counterparty>(`${cfg.apiBase(clientId)}/${record.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiJson<Counterparty>(cfg.apiBase(clientId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      toast(record ? `${cfg.Singular} updated` : `${cfg.Singular} added`, "success");
      onSaved(saved, !record);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setLoading(false);
    }
  }

  function input(key: keyof CounterpartyForm, label: string, opts?: { placeholder?: string; type?: string; required?: boolean }) {
    const value = form[key];
    return (
      <div className="form-group">
        <label className="form-label" htmlFor={`sf-${key}`}>
          {label}{opts?.required && <span className="req"> *</span>}
        </label>
        <input
          id={`sf-${key}`}
          className={`form-input${errors[key] ? " error" : ""}`}
          type={opts?.type ?? "text"}
          value={value == null ? "" : String(value)}
          placeholder={opts?.placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            setForm((f) => ({ ...f, [key]: opts?.type === "number" ? (raw === "" ? 0 : Number(raw)) : raw }));
            setErrors((er) => { const n = { ...er }; delete n[key]; return n; });
          }}
        />
        {errors[key] && <div className="form-error">{errors[key]}</div>}
      </div>
    );
  }

  if (!open) return null;

  const editing = !!record;

  return (
    <>
      <div className="drawer-bg on" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer on"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? `Edit ${cfg.singular}` : `Add ${cfg.singular}`}
      >
        <div className="dr-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>{editing ? `Edit ${cfg.singular}` : `Add ${cfg.singular}`}</h3>
            {editing && <div className="dr-sub">{record!.name}</div>}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>

        <div className="dr-body">
          {input("name", "Name", { required: true, placeholder: "DE MOOIJ AMSTERDAM" })}
          {input("relatie_code", "Relatie Code (Snelstart)", { placeholder: "e.g. 20001" })}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {input("phone", "Phone", { placeholder: "+31 6 12 34 56 78" })}
            {input("email", "Email", { type: "email", placeholder: "info@example.nl" })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {input("kvk", "KvK")}
            {input("btw_number", "BTW number", { required: isCustomer && form.btw_verlegd })}
          </div>

          {input("iban", "IBAN", { placeholder: "NL00 BANK 0123 4567 89" })}
          {input("address", "Address")}

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12 }}>
            {input("postcode", "Postcode")}
            {input("city", "City")}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, alignItems: "end" }}>
            {input("payment_days", "Payment days", { type: "number" })}
            <label className="form-group" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              />
              <span>Active</span>
            </label>
          </div>

          {isCustomer && (
            <>
              <h4 style={{
                margin: 0, paddingTop: 4, borderTop: "1px solid var(--line)",
                fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", letterSpacing: ".02em",
              }}>
                Invoicing settings
              </h4>

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.btw_verlegd}
                    onChange={(e) => {
                      const on = e.target.checked;
                      // Reverse charge means no VAT is charged at all, so the
                      // rate is pinned to 0 (and back to the 21% default when off).
                      setForm((f) => ({ ...f, btw_verlegd: on, btw_rate: on ? 0 : 21 }));
                      setErrors((er) => { const n = { ...er }; delete n.btw_number; return n; });
                    }}
                  />
                  <span>BTW verlegd (reverse charge)</span>
                </label>
                <div className="form-hint">
                  No VAT is charged; the invoice states the reverse-charge notice with the recipient&apos;s VAT number.
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-btw_rate">BTW rate</label>
                  <select
                    id="sf-btw_rate"
                    className="form-input"
                    value={String(form.btw_rate)}
                    disabled={form.btw_verlegd}
                    onChange={(e) => setForm((f) => ({ ...f, btw_rate: Number(e.target.value) }))}
                  >
                    {BTW_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="sf-pricing_model">Pricing model</label>
                  <select
                    id="sf-pricing_model"
                    className="form-input"
                    value={form.pricing_model}
                    onChange={(e) => setForm((f) => ({ ...f, pricing_model: e.target.value as PricingModel }))}
                  >
                    {PRICING_MODELS.map((m) => (
                      <option key={m} value={m}>{PRICING_MODEL_LABELS[m]}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-default_rate">
                    {DEFAULT_RATE_LABELS[form.pricing_model]}
                  </label>
                  <input
                    id="sf-default_rate"
                    className="form-input"
                    type="number"
                    step="0.01"
                    value={form.default_rate}
                    placeholder="0.00"
                    onChange={(e) => setForm((f) => ({ ...f, default_rate: e.target.value }))}
                  />
                </div>
                {input("aliases", "Aliases", { placeholder: "buki, buki koeriers" })}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="sf-message_pattern">Message pattern</label>
                <textarea
                  id="sf-message_pattern"
                  className="form-input"
                  rows={3}
                  value={form.message_pattern}
                  placeholder="e.g. Sends RT TWB route codes with hours:minutes and price per hour, ends the message with the company name."
                  onChange={(e) => setForm((f) => ({ ...f, message_pattern: e.target.value }))}
                />
              </div>
            </>
          )}
        </div>

        <div className="dr-foot">
          <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={loading}>
            {loading ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} />{editing ? "Save changes" : cfg.addLabel}</>}
          </button>
        </div>
      </aside>
    </>
  );
}

/* ── Import counterparties from Excel modal ─────────────────────── */

interface ImportResult {
  inserted: number;
  skipped: number;
  total_rows: number;
  detected_columns?: string[];
  skipped_rows?: Array<{ row: number; reason: string }>;
  warnings?: Array<{ row: number; reason: string }>;
}

interface ImportModalProps {
  clientId: string;
  kind: Kind;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

function ImportCounterpartiesModal({ clientId, kind, open, onClose, onImported }: ImportModalProps) {
  const cfg = KINDS[kind];
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setError(null);
      setResult(null);
      setLoading(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open && !loading) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, loading]);

  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  async function handleImport() {
    if (!file) { setError("Pick a .xlsx file first"); return; }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${cfg.apiBase(clientId)}/bulk`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      setResult(data);
      if (data.inserted > 0) {
        toast(`Imported ${data.inserted} ${cfg.singular}${data.inserted === 1 ? "" : "s"}`, "success");
        onImported();
      } else if (data.skipped > 0) {
        toast(`No new ${cfg.singular}s — ${data.skipped} already existed`, "info");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={loading ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={cfg.importTitle}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={I.excel} size={16} />
            {cfg.importTitle}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close" disabled={loading}>
            <Icon d={I.x} size={14} />
          </button>
        </div>

        <p className="modal-sub">
          Upload a .xlsx file. The first row must contain column headers — at minimum a column called <strong>Name</strong> (or Naam) and a column called <strong>Relatie Code</strong> (or Code). Optional columns: Address, Postcode, City, KvK, BTW, IBAN, Email, Phone, Payment days. Duplicates (same name for this client) are skipped automatically.
        </p>

        <div className="form-group">
          <label className="form-label">File <span className="req">*</span></label>
          <div
            className={`file-drop${file ? " has-file" : ""}`}
            onClick={() => !loading && fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && !loading && fileInputRef.current?.click()}
            aria-label="Click to select Excel file"
            style={{ opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); setResult(null); }}
              style={{ display: "none" }}
              disabled={loading}
            />
            <Icon d={I.file} size={20} />
            {file ? (
              <span>{file.name} ({(file.size / 1024).toFixed(0)} KB)</span>
            ) : (
              <span>Click to select an .xlsx file</span>
            )}
          </div>
        </div>

        {result && (
          <div style={{
            background: "var(--surface-2, rgba(0,0,0,0.03))",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
            fontSize: 12.5,
          }}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              <span style={{ color: "#1f8a5b" }}>{result.inserted}</span> inserted
              {result.skipped > 0 && <> · <span style={{ color: "var(--muted)" }}>{result.skipped} skipped</span></>}
              {" · "}
              <span style={{ color: "var(--muted)" }}>{result.total_rows} total rows</span>
            </div>
            {result.detected_columns && result.detected_columns.length > 0 && (
              <div style={{ color: "var(--muted)", marginBottom: 6 }}>
                Detected columns: {result.detected_columns.join(", ")}
              </div>
            )}
            {result.skipped_rows && result.skipped_rows.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer", color: "var(--muted)" }}>
                  Show {result.skipped_rows.length} skipped row{result.skipped_rows.length === 1 ? "" : "s"}
                </summary>
                <ul style={{ margin: "6px 0 0 14px", padding: 0, color: "var(--muted)" }}>
                  {result.skipped_rows.slice(0, 50).map((r, i) => (
                    <li key={i}>Row {r.row}: {r.reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={loading}>
            {result && result.inserted > 0 ? "Close" : "Cancel"}
          </button>
          {(!result || result.inserted === 0) && (
            <button
              className="btn primary"
              onClick={handleImport}
              disabled={loading || !file}
            >
              {loading ? <><span className="spinner-sm" /> Importing…</> : <><Icon d={I.upload} size={13} /> Import</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Inline table-cell editor ───────────────────────────────────── */

interface InlineEditProps {
  value: string;
  /** Return false to reject the edit — the cell snaps back to `value`. */
  onCommit: (next: string) => boolean;
  ariaLabel: string;
  type?: string;
  step?: string;
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * One editable table cell. Keeps a local draft so typing doesn't fire a request
 * per keystroke, and commits on blur or Enter; Escape abandons the draft.
 *
 * `value` is the stored value: when the optimistic update lands (or is reverted)
 * the draft resyncs from it, which is also how a rejected edit snaps back.
 */
function InlineEdit({ value, onCommit, ariaLabel, type, step, min, max, placeholder, className, style }: InlineEditProps) {
  const [draft, setDraft] = useState(value);
  const abandon = useRef(false);

  useEffect(() => { setDraft(value); }, [value]);

  return (
    <input
      className={`cell-input${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      type={type ?? "text"}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      value={draft}
      style={style}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (abandon.current) { abandon.current = false; setDraft(value); return; }
        if (draft === value) return;
        if (!onCommit(draft)) setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") { abandon.current = true; e.currentTarget.blur(); }
      }}
    />
  );
}

/* ── Add-employee drawer ────────────────────────────────────────── */

// `hourly_rate` is a nullable numeric edited as a string so the box can be left
// empty — empty means "inherit the client's default rate", not zero.
type EmployeeForm = {
  name: string;
  phone: string;
  hourly_rate: string;
  default_days_per_week: number;
  active: boolean;
  notes: string;
};

function emptyEmployeeForm(): EmployeeForm {
  return {
    name: "", phone: "", hourly_rate: "",
    default_days_per_week: DEFAULT_DAYS_PER_WEEK, active: true, notes: "",
  };
}

interface EmployeeModalProps {
  clientId: string;
  clientDefaultRate: number | null;
  open: boolean;
  onClose: () => void;
  onSaved: (e: Employee) => void;
}

// Add only. Editing an existing employee happens inline in the table, so this
// drawer has no PATCH path.
function EmployeeModal({ clientId, clientDefaultRate, open, onClose, onSaved }: EmployeeModalProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<EmployeeForm>(() => emptyEmployeeForm());
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof EmployeeForm, string>>>({});

  useEffect(() => {
    if (open) {
      setForm(emptyEmployeeForm());
      setErrors({});
    }
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function validate(): boolean {
    const e: typeof errors = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (form.hourly_rate.trim() !== "" && !(Number(form.hourly_rate) >= 0)) {
      e.hourly_rate = "Rate must be a positive number";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setLoading(true);
    try {
      const payload = {
        name:  form.name,
        phone: form.phone || null,
        // Empty clears the override so the client's default applies again.
        hourly_rate: form.hourly_rate.trim() === "" ? null : Number(form.hourly_rate),
        default_days_per_week: Number(form.default_days_per_week ?? DEFAULT_DAYS_PER_WEEK),
        active: form.active,
        notes: form.notes || null,
      };
      const saved = await apiJson<Employee>(`/api/clients/${clientId}/employees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast("Employee added", "success");
      onSaved(saved);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const inheritedHint = clientDefaultRate == null
    ? "Leave empty to inherit the client's default rate (none set yet)"
    : `Leave empty to inherit the client's default of € ${formatNL(clientDefaultRate)}`;

  return (
    <>
      <div className="drawer-bg on" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer on"
        role="dialog"
        aria-modal="true"
        aria-label="Add employee"
      >
        <div className="dr-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>Add employee</h3>
            <div className="dr-sub">Rates, days and status can be edited inline afterwards</div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>

        <div className="dr-body">
          <div className="form-group">
            <label className="form-label" htmlFor="ef-name">Name<span className="req"> *</span></label>
            <input
              id="ef-name"
              className={`form-input${errors.name ? " error" : ""}`}
              value={form.name}
              placeholder="Jan de Vries"
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => ({ ...f, name: v }));
                setErrors((er) => { const n = { ...er }; delete n.name; return n; });
              }}
            />
            {errors.name && <div className="form-error">{errors.name}</div>}
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ef-phone">Phone</label>
            <input
              id="ef-phone"
              className="form-input"
              value={form.phone}
              placeholder="+31 6 12 34 56 78"
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label className="form-label" htmlFor="ef-hourly_rate">Hourly rate</label>
              <div className="form-hint">{inheritedHint}</div>
              <input
                id="ef-hourly_rate"
                className={`form-input${errors.hourly_rate ? " error" : ""}`}
                type="number"
                step="0.01"
                min="0"
                value={form.hourly_rate}
                placeholder="Inherited"
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, hourly_rate: v }));
                  setErrors((er) => { const n = { ...er }; delete n.hourly_rate; return n; });
                }}
              />
              {errors.hourly_rate && <div className="form-error">{errors.hourly_rate}</div>}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="ef-days">Days per week</label>
              <div className="form-hint">Default used when generating a schedule</div>
              <input
                id="ef-days"
                className="form-input"
                type="number"
                min="0"
                max="7"
                value={form.default_days_per_week}
                onChange={(e) => setForm((f) => ({
                  ...f,
                  default_days_per_week: e.target.value === "" ? 0 : Number(e.target.value),
                }))}
              />
            </div>
          </div>

          <label className="form-group" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
            />
            <span>Active</span>
          </label>

          <div className="form-group">
            <label className="form-label" htmlFor="ef-notes">Notes</label>
            <textarea
              id="ef-notes"
              className="form-input"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
        </div>

        <div className="dr-foot">
          <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={loading}>
            {loading ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} /> Add employee</>}
          </button>
        </div>
      </aside>
    </>
  );
}

/* ── Client detail page ──────────────────────────────────────────── */

function ClientDetailView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const clientId = params.id;

  // Active tab is driven by the ?tab query param so it deep-links and the
  // browser back button works. Anything unrecognised → Leveranciers.
  const activeTab: Tab = tabFromParam(searchParams.get("tab"));
  const isEmployeeTab = activeTab === "employee";
  // The counterparty section isn't rendered on the Employees tab, so `cpKind`
  // (and everything derived from it) is only read for the other two.
  const cpKind: Kind = isEmployeeTab ? "supplier" : activeTab;
  const cfg = KINDS[cpKind];

  const [client, setClient]     = useState<Client | null>(null);
  const [form, setForm]         = useState<ClientForm>(emptyClientForm);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [suppliers, setSuppliers] = useState<Counterparty[]>([]);
  const [customers, setCustomers] = useState<Counterparty[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [addEmployeeOpen, setAddEmployeeOpen] = useState(false);
  const [modal, setModal] = useState<{ open: boolean; kind: Kind; editing: Counterparty | null }>({ open: false, kind: "supplier", editing: null });
  const [importState, setImportState] = useState<{ open: boolean; kind: Kind }>({ open: false, kind: "supplier" });

  const list = cpKind === "customer" ? customers : suppliers;
  const setList = cpKind === "customer" ? setCustomers : setSuppliers;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both arrays come nested in the client GET — no extra round-trips.
      const c = await apiJson<Client & {
        suppliers?: Counterparty[];
        customers?: Counterparty[];
        employees?: Employee[];
      }>(`/api/clients/${clientId}`);
      setClient(c);
      setForm({
        name: c.name,
        phone_number: c.phone_number ?? "",
        whatsapp_phone: c.whatsapp_phone ?? "",
        email: c.email ?? "",
        address: c.address ?? "",
        postcode: c.postcode ?? "",
        city: c.city ?? "",
        country: c.country,
        btw_number: c.btw_number ?? "",
        kvk_number: c.kvk_number ?? "",
        iban: c.iban ?? "",
        aliases: formatAliases(c.aliases),
        relatie_code: c.relatie_code ?? "",
        notes: c.notes ?? "",
        default_hourly_rate: c.default_hourly_rate == null ? "" : String(c.default_hourly_rate),
      });
      setSuppliers(c.suppliers ?? []);
      setCustomers(c.customers ?? []);
      setEmployees(c.employees ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load client", "error");
    } finally {
      setLoading(false);
    }
  }, [clientId, toast]);

  useEffect(() => { load(); }, [load]);

  function selectTab(tab: Tab) {
    if (tab === activeTab) return;
    router.push(`${pathname}?tab=${tabConfig(tab).tab}`, { scroll: false });
  }

  async function saveClient() {
    if (!form.name.trim()) {
      toast("Name is required", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name:           form.name,
        phone_number:   form.phone_number || null,
        whatsapp_phone: form.whatsapp_phone || null,
        email:          form.email || null,
        address:        form.address || null,
        postcode:       form.postcode || null,
        city:           form.city || null,
        country:        form.country,
        btw_number:     form.btw_number || null,
        kvk_number:     form.kvk_number || null,
        iban:           form.iban || null,
        aliases:        parseAliases(form.aliases),
        relatie_code:   form.relatie_code || null,
        notes:          form.notes || null,
        // Empty box clears the rate; employees then have nothing to inherit.
        default_hourly_rate: form.default_hourly_rate.trim() === "" ? null : Number(form.default_hourly_rate),
      };
      const saved = await apiJson<Client>(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setClient(saved);
      toast("Client saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  // Only reachable from the counterparty tabs, so cpKind is the real kind.
  function openAdd() { setModal({ open: true, kind: cpKind, editing: null }); }
  function openEdit(s: Counterparty) { setModal({ open: true, kind: cpKind, editing: s }); }
  function closeModal() { setModal((m) => ({ ...m, open: false, editing: null })); }

  function onSaved(s: Counterparty, isNew: boolean) {
    const setter = modal.kind === "customer" ? setCustomers : setSuppliers;
    setter((prev) => {
      if (isNew) return [...prev, s].sort((a, b) => a.name.localeCompare(b.name));
      return prev.map((x) => x.id === s.id ? s : x);
    });
    closeModal();
  }

  async function deleteRecord(s: Counterparty) {
    if (!confirm(`Delete ${cfg.singular} "${s.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${cfg.apiBase(clientId)}/${s.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      setList((prev) => prev.filter((x) => x.id !== s.id));
      toast(`${s.name} deleted`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  function onEmployeeAdded(e: Employee) {
    setEmployees((prev) => [...prev, e].sort((a, b) => a.name.localeCompare(b.name)));
    setAddEmployeeOpen(false);
  }

  /**
   * Inline edits apply locally first and revert if the PATCH fails, so a row
   * never waits on a round-trip — the same optimistic pattern the Tasks page
   * uses. The response replaces the row, which also refreshes the server's
   * resolved `effective_hourly_rate`.
   */
  async function patchEmployee(target: Employee, patch: Partial<Employee>) {
    const before = target;
    setEmployees((prev) => prev.map((e) => (e.id === target.id ? { ...e, ...patch } : e)));
    try {
      const saved = await apiJson<Employee>(`/api/clients/${clientId}/employees/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setEmployees((prev) => prev.map((e) => (e.id === target.id ? saved : e)));
    } catch (err) {
      setEmployees((prev) => prev.map((e) => (e.id === target.id ? before : e)));
      toast(err instanceof Error ? err.message : "Update failed", "error");
    }
  }

  // Each commit validates before touching the network and returns false to make
  // the cell snap back, so an invalid draft never reaches the API.
  function commitName(e: Employee, raw: string): boolean {
    const name = raw.trim();
    if (!name) { toast("Name is required", "error"); return false; }
    patchEmployee(e, { name });
    return true;
  }

  function commitText(e: Employee, key: "phone" | "notes", raw: string): boolean {
    patchEmployee(e, { [key]: raw.trim() || null } as Partial<Employee>);
    return true;
  }

  function commitRate(e: Employee, raw: string): boolean {
    const text = raw.trim();
    // Empty clears the override — the client's default applies again.
    if (text === "") { patchEmployee(e, { hourly_rate: null }); return true; }
    const rate = Number(text);
    if (!Number.isFinite(rate) || rate < 0) { toast("Rate must be a positive number", "error"); return false; }
    patchEmployee(e, { hourly_rate: rate });
    return true;
  }

  function commitDays(e: Employee, raw: string): boolean {
    const days = Number(raw.trim());
    if (!Number.isInteger(days) || days < 0 || days > 7) {
      toast("Days per week must be a whole number from 0 to 7", "error");
      return false;
    }
    patchEmployee(e, { default_days_per_week: days });
    return true;
  }

  async function deleteEmployee(e: Employee) {
    if (!confirm(`Delete employee "${e.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/clients/${clientId}/employees/${e.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      setEmployees((prev) => prev.filter((x) => x.id !== e.id));
      toast(`${e.name} deleted`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    }
  }

  function field(key: keyof ClientForm, label: string, opts?: { placeholder?: string; type?: string; hint?: string; step?: string }) {
    return (
      <div className="form-group">
        <label className="form-label" htmlFor={`cf-${key}`}>{label}</label>
        {opts?.hint && <div className="form-hint">{opts.hint}</div>}
        <input
          id={`cf-${key}`}
          className="form-input"
          type={opts?.type ?? "text"}
          step={opts?.step}
          value={(form[key] as string) ?? ""}
          placeholder={opts?.placeholder}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        />
      </div>
    );
  }

  if (loading) {
    return <main className="main"><div className="t-empty">Loading client…</div></main>;
  }

  if (!client) {
    return (
      <main className="main">
        <div className="t-empty">
          Client not found.
          <div style={{ marginTop: 12 }}>
            <Link href="/clients" className="btn">Back to clients</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <div className="page-h">
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => router.push("/clients")}>
            <Icon d={I.chevL} size={14} />
          </button>
          <div className="client-av" style={{ width: 44, height: 44, borderRadius: 10, background: clientColor(client.name), flexShrink: 0 }}>
            {clientInitials(client.name)}
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{client.name}</h1>
            <div className="sub">
              {client.relatie_code ? <>Relatie Code: <span className="mono">{client.relatie_code}</span></> : "No Snelstart code set"}
            </div>
          </div>
        </div>
      </div>

      {/* Client info section */}
      <section className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Client info</h2>
          <button className="btn primary" onClick={saveClient} disabled={saving}>
            {saving ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} /> Save changes</>}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("name", "Name", { placeholder: "Client name" })}
          {field("relatie_code", "Relatie Code (Snelstart)", { placeholder: "e.g. 10001", hint: "Used as RelatieCode in exports" })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("phone_number", "Phone", { placeholder: "+31 6 12 34 56 78" })}
          {field("email", "Email", { type: "email", placeholder: "info@example.nl" })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("whatsapp_phone", "WhatsApp phone", {
            placeholder: "+31 6 12 34 56 78",
            hint: "Only if different from the phone above — this is the number the client sends invoices from on WhatsApp",
          })}
          {field("aliases", "Aliases", {
            placeholder: "akram, akram transport",
            hint: "Alternative names this client might be referred to by",
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("btw_number", "BTW number")}
          {field("kvk_number", "KvK number")}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("iban", "IBAN", { placeholder: "NL00 BANK 0123 4567 89" })}
          {field("default_hourly_rate", "Default hourly rate", {
            type: "number",
            step: "0.01",
            placeholder: "0.00",
            hint: "Inherited by every employee without their own rate",
          })}
        </div>

        {field("address", "Address")}

        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 12 }}>
          {field("postcode", "Postcode")}
          {field("city", "City")}
          <div className="form-group">
            <label className="form-label" htmlFor="cf-country">Country</label>
            <input
              id="cf-country"
              className="form-input"
              value={form.country}
              maxLength={2}
              placeholder="NL"
              onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
              style={{ width: 64, textAlign: "center", textTransform: "uppercase" }}
            />
          </div>
        </div>
      </section>

      {/* Counterparties section — tabbed: Leveranciers / Klanten */}
      <section className="card" style={{ padding: 20 }}>
        <div className="cp-tabs" role="tablist" aria-label="Counterparties" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)", marginBottom: 16 }}>
          {TAB_ORDER.map((k) => {
            const kc = tabConfig(k);
            const count = k === "employee" ? employees.length : k === "customer" ? customers.length : suppliers.length;
            const isActive = k === activeTab;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={isActive}
                className={`cp-tab${isActive ? " active" : ""}`}
                onClick={() => selectTab(k)}
                style={{
                  appearance: "none",
                  background: "none",
                  border: "none",
                  borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                  color: isActive ? "var(--ink)" : "var(--muted)",
                  fontWeight: isActive ? 600 : 500,
                  fontSize: 14,
                  padding: "8px 12px",
                  marginBottom: -1,
                  cursor: "pointer",
                }}
              >
                {kc.tabLabel} <span style={{ color: "var(--faint)", fontWeight: 500 }}>({count})</span>
              </button>
            );
          })}
        </div>

        {!isEmployeeTab && (<>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div className="sub" style={{ fontSize: 12 }}>
            {list.length} {cfg.singular}{list.length === 1 ? "" : "s"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => setImportState({ open: true, kind: cpKind })} title={cfg.importTitle}>
              <Icon d={I.excel} size={13} /> Import Excel
            </button>
            <button className="btn primary" onClick={openAdd}>
              <Icon d={I.users} size={13} /> {cfg.addLabel}
            </button>
          </div>
        </div>

        {list.length === 0 ? (
          <div className="t-empty" style={{ padding: 24 }}>
            {cfg.emptyText}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="t" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Code</th>
                  <th>Name</th>
                  <th style={{ width: 140 }}>KvK</th>
                  <th style={{ width: 180 }}>BTW</th>
                  <th style={{ width: 110, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.relatie_code || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{s.name}</div>
                      {s.city && <div style={{ color: "var(--muted)", fontSize: 12 }}>{s.city}</div>}
                    </td>
                    <td>{s.kvk || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>{s.btw_number || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="act" title="Edit" onClick={() => openEdit(s)}>
                        <Icon d={I.cog} size={14} />
                      </button>
                      <button className="act" title="Delete" onClick={() => deleteRecord(s)}>
                        <Icon d={I.trash} size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </>)}

        {isEmployeeTab && (<>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div className="sub" style={{ fontSize: 12 }}>
            {employees.length} employee{employees.length === 1 ? "" : "s"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {/* Phase 2. The generator itself is an interface with no
                implementation yet (lib/workforce/domain/schedule-generator.ts). */}
            <button className="btn" disabled title="Coming soon — schedule generation ships in a later phase">
              <Icon d={I.calendar} size={13} /> Generate monthly schedule
            </button>
            <button className="btn primary" onClick={() => setAddEmployeeOpen(true)}>
              <Icon d={I.users} size={13} /> Add employee
            </button>
          </div>
        </div>

        {employees.length === 0 ? (
          <div className="t-empty" style={{ padding: 24 }}>
            No employees yet. Add the workers this client pays.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="t" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 210 }}>Hourly rate</th>
                  <th style={{ width: 105 }}>Days/week</th>
                  <th style={{ width: 220 }}>Notes</th>
                  <th style={{ width: 125 }}>Status</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  // Resolved against the client's saved default, so the badge
                  // updates as soon as either side is edited.
                  const eff = effectiveHourlyRate(e, client.default_hourly_rate);
                  return (
                    <tr key={e.id}>
                      <td>
                        <InlineEdit
                          value={e.name}
                          onCommit={(v) => commitName(e, v)}
                          ariaLabel={`Name of ${e.name}`}
                          style={{ fontWeight: 500 }}
                        />
                        <InlineEdit
                          value={e.phone ?? ""}
                          onCommit={(v) => commitText(e, "phone", v)}
                          ariaLabel={`Phone of ${e.name}`}
                          placeholder="Add phone"
                          className="sub"
                        />
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <InlineEdit
                            value={e.hourly_rate == null ? "" : String(e.hourly_rate)}
                            onCommit={(v) => commitRate(e, v)}
                            ariaLabel={`Hourly rate of ${e.name}`}
                            type="number"
                            step="0.01"
                            min="0"
                            // Empty shows what it inherits, so the blank box reads
                            // as "using the client rate" rather than "no rate".
                            placeholder={client.default_hourly_rate == null ? "—" : formatNL(client.default_hourly_rate)}
                            style={{ width: 82, flexShrink: 0 }}
                          />
                          {eff.source === "employee" ? (
                            <span className="pill s-info"><span className="pill-dot" />override</span>
                          ) : eff.source === "client" ? (
                            <span className="pill s-good"><span className="pill-dot" />inherited</span>
                          ) : (
                            <span className="pill s-warn"><span className="pill-dot" />no rate</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <InlineEdit
                          value={String(e.default_days_per_week)}
                          onCommit={(v) => commitDays(e, v)}
                          ariaLabel={`Days per week of ${e.name}`}
                          type="number"
                          min="0"
                          max="7"
                          style={{ width: 56 }}
                        />
                      </td>
                      <td>
                        <InlineEdit
                          value={e.notes ?? ""}
                          onCommit={(v) => commitText(e, "notes", v)}
                          ariaLabel={`Notes for ${e.name}`}
                          placeholder="Add a note"
                          className="sub"
                        />
                      </td>
                      <td>
                        <span className={`pill-sel s-${e.active ? "good" : "danger"}`}>
                          <select
                            value={e.active ? "active" : "inactive"}
                            onChange={(ev) => patchEmployee(e, { active: ev.target.value === "active" })}
                            aria-label={`Status of ${e.name}`}
                          >
                            <option value="active">active</option>
                            <option value="inactive">inactive</option>
                          </select>
                          <span className="pill-chev"><Icon d={I.chev} size={11} stroke={2.2} /></span>
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button className="act" title="Delete" onClick={() => deleteEmployee(e)}>
                          <Icon d={I.trash} size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        </>)}
      </section>

      <CounterpartyModal
        clientId={clientId}
        kind={modal.kind}
        record={modal.editing}
        open={modal.open}
        onClose={closeModal}
        onSaved={onSaved}
      />

      <EmployeeModal
        clientId={clientId}
        clientDefaultRate={client.default_hourly_rate}
        open={addEmployeeOpen}
        onClose={() => setAddEmployeeOpen(false)}
        onSaved={onEmployeeAdded}
      />

      <ImportCounterpartiesModal
        clientId={clientId}
        kind={importState.kind}
        open={importState.open}
        onClose={() => setImportState((s) => ({ ...s, open: false }))}
        onImported={load}
      />
    </main>
  );
}

export default function ClientDetailPage() {
  // useSearchParams() needs a Suspense boundary to keep `next build` happy.
  return (
    <Suspense fallback={<main className="main"><div className="t-empty">Loading client…</div></main>}>
      <ClientDetailView />
    </Suspense>
  );
}
