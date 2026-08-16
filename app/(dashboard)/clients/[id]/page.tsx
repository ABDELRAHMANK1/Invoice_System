"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";
import { formatAliases, parseAliases } from "@/lib/aliases";
import { BTW_RATES, PRICING_MODELS } from "@/lib/types";
import type { CustomerExtras, PricingModel, Supplier } from "@/lib/types";

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
  created_at: string;
};

// `aliases` is a text[] on the client record but a comma-separated string in
// the form — see lib/aliases.
type ClientForm = Omit<Client, "id" | "created_at" | "aliases"> & { aliases: string };

const emptyClientForm: ClientForm = {
  name: "", phone_number: "", whatsapp_phone: "", email: "", address: "",
  postcode: "", city: "", country: "NL", btw_number: "", kvk_number: "",
  iban: "", aliases: "", relatie_code: "", notes: "",
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

function kindFromTab(tab: string | null): Kind {
  return tab === "klanten" ? "customer" : "supplier";
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

/* ── Client detail page ──────────────────────────────────────────── */

function ClientDetailView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const clientId = params.id;

  // Active tab is driven by the ?tab query param so it deep-links and the
  // browser back button works. Anything other than "klanten" → Leveranciers.
  const activeTab: Kind = kindFromTab(searchParams.get("tab"));
  const cfg = KINDS[activeTab];

  const [client, setClient]     = useState<Client | null>(null);
  const [form, setForm]         = useState<ClientForm>(emptyClientForm);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [suppliers, setSuppliers] = useState<Counterparty[]>([]);
  const [customers, setCustomers] = useState<Counterparty[]>([]);
  const [modal, setModal] = useState<{ open: boolean; kind: Kind; editing: Counterparty | null }>({ open: false, kind: "supplier", editing: null });
  const [importState, setImportState] = useState<{ open: boolean; kind: Kind }>({ open: false, kind: "supplier" });

  const list = activeTab === "customer" ? customers : suppliers;
  const setList = activeTab === "customer" ? setCustomers : setSuppliers;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both arrays come nested in the client GET — no extra round-trips.
      const c = await apiJson<Client & { suppliers?: Counterparty[]; customers?: Counterparty[] }>(`/api/clients/${clientId}`);
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
      });
      setSuppliers(c.suppliers ?? []);
      setCustomers(c.customers ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load client", "error");
    } finally {
      setLoading(false);
    }
  }, [clientId, toast]);

  useEffect(() => { load(); }, [load]);

  function selectTab(kind: Kind) {
    if (kind === activeTab) return;
    router.push(`${pathname}?tab=${KINDS[kind].tab}`, { scroll: false });
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

  function openAdd() { setModal({ open: true, kind: activeTab, editing: null }); }
  function openEdit(s: Counterparty) { setModal({ open: true, kind: activeTab, editing: s }); }
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

  function field(key: keyof ClientForm, label: string, opts?: { placeholder?: string; type?: string; hint?: string }) {
    return (
      <div className="form-group">
        <label className="form-label" htmlFor={`cf-${key}`}>{label}</label>
        {opts?.hint && <div className="form-hint">{opts.hint}</div>}
        <input
          id={`cf-${key}`}
          className="form-input"
          type={opts?.type ?? "text"}
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

        {field("iban", "IBAN", { placeholder: "NL00 BANK 0123 4567 89" })}

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
          {(["supplier", "customer"] as Kind[]).map((k) => {
            const kc = KINDS[k];
            const count = k === "customer" ? customers.length : suppliers.length;
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

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div className="sub" style={{ fontSize: 12 }}>
            {list.length} {cfg.singular}{list.length === 1 ? "" : "s"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => setImportState({ open: true, kind: activeTab })} title={cfg.importTitle}>
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
      </section>

      <CounterpartyModal
        clientId={clientId}
        kind={modal.kind}
        record={modal.editing}
        open={modal.open}
        onClose={closeModal}
        onSaved={onSaved}
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
