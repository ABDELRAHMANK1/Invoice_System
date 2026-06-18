"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, I } from "./Icon";
import { computeTotals, formatNL } from "@/lib/billing";

interface NewInvoiceModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

type ClientOption = { id: string; name: string };
// Suppliers (inkoop) and customers (verkoop) share the same shape.
type CounterpartyOption = { id: string; name: string; relatie_code: string | null; active: boolean };
type Direction = "inkoop" | "verkoop";

interface ItemRow {
  id: string;
  description: string;
  quantity: string;   // kept as strings for free typing; parsed for math
  unit_price: string;
}

function todayISO(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function emptyRow(): ItemRow {
  return { id: newId(), description: "", quantity: "", unit_price: "" };
}

// Accept both "1.234,56" and "1234.56" while typing.
function num(s: string): number {
  const cleaned = s.trim().replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number(s) || 0;
}

async function apiJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Open the native date picker when the field is clicked (the glyph is easy to miss).
function openPicker(e: React.MouseEvent<HTMLInputElement> | React.FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
  try { el.showPicker?.(); } catch { /* not user-activated */ }
}

export function NewInvoiceModal({ open, onClose, onSuccess }: NewInvoiceModalProps) {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientId, setClientId] = useState("");
  const [direction, setDirection] = useState<Direction>("inkoop");
  // Both lists come from the single nested GET /api/clients/:id fetch; which one
  // the second dropdown shows depends on the chosen direction.
  const [suppliers, setSuppliers] = useState<CounterpartyOption[]>([]);
  const [customers, setCustomers] = useState<CounterpartyOption[]>([]);
  const [counterpartyId, setCounterpartyId] = useState("");
  const [loadingCounterparties, setLoadingCounterparties] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [deliveryDate, setDeliveryDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [btwRate, setBtwRate] = useState("21");
  const [items, setItems] = useState<ItemRow[]>([emptyRow()]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset + load clients each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setClientId(""); setDirection("inkoop");
    setSuppliers([]); setCustomers([]); setCounterpartyId("");
    setInvoiceNumber(""); setInvoiceDate(todayISO()); setDeliveryDate(todayISO());
    setDescription(""); setBtwRate("21"); setItems([emptyRow()]);
    setSaving(false); setError(null);
    apiJson<{ data: ClientOption[] }>("/api/clients?limit=500")
      .then((r) => setClients(r.data || []))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load clients"));
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open && !saving) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, saving]);

  // When the client changes, load that client's suppliers AND customers (both
  // nested in GET :id) in one round-trip, and reset the counterparty selection.
  useEffect(() => {
    if (!clientId) { setSuppliers([]); setCustomers([]); setCounterpartyId(""); return; }
    setLoadingCounterparties(true); setCounterpartyId("");
    apiJson<{ suppliers?: CounterpartyOption[]; customers?: CounterpartyOption[] }>(`/api/clients/${clientId}`)
      .then((c) => { setSuppliers(c.suppliers || []); setCustomers(c.customers || []); })
      .catch(() => { setSuppliers([]); setCustomers([]); })
      .finally(() => setLoadingCounterparties(false));
  }, [clientId]);

  // Switching direction invalidates the selected counterparty (a supplier under
  // inkoop is not a valid customer under verkoop), so reset the second dropdown.
  useEffect(() => { setCounterpartyId(""); }, [direction]);

  // The second dropdown's data + labels follow the direction.
  const counterparties = direction === "inkoop" ? suppliers : customers;
  const counterpartyNoun = direction === "inkoop" ? "supplier" : "customer";
  const counterpartyLabel = direction === "inkoop" ? "Supplier" : "Customer";

  function setItem(id: string, patch: Partial<ItemRow>) {
    setItems((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addRow() { setItems((prev) => [...prev, emptyRow()]); }
  function removeRow(id: string) {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
  }

  // Live preview using the exact same math as the server (truncated to 2dp).
  const parsedItems = items.map((r) => ({ description: r.description, quantity: num(r.quantity), unit_price: num(r.unit_price) }));
  const totals = computeTotals(parsedItems, num(btwRate));

  async function handleSave() {
    if (!clientId) return setError("Select a client");
    if (!counterpartyId) return setError(`Select a ${counterpartyNoun}`);
    if (!invoiceNumber.trim()) return setError("Invoice number is required");
    const usable = parsedItems.filter((it) => it.quantity > 0 || it.unit_price > 0);
    if (usable.length === 0) return setError("Add at least one line item");

    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_number: invoiceNumber.trim(),
          client_id: clientId,
          invoice_direction: direction,
          supplier_id: direction === "inkoop" ? counterpartyId : null,
          customer_id: direction === "verkoop" ? counterpartyId : null,
          date: invoiceDate || null,
          delivery_date: deliveryDate || null,
          description: description.trim() || null,
          btw_rate: num(btwRate),
          line_items: usable,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Create failed: ${res.status}`);

      // Download the generated PDF. A programmatic <a> click is reliable here —
      // unlike window.open(), it isn't blocked as a popup after the await.
      if (body.id && body.file_url) {
        const a = document.createElement("a");
        a.href = `/api/invoices/${body.id}/download`;
        a.download = "";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (body.warning) {
        // Invoice saved, but the PDF didn't render — tell the user instead of failing silently.
        alert(body.warning);
      }
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create invoice");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const numberInput: React.CSSProperties = { textAlign: "right" };

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New invoice"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 720 }}
      >
        <div className="modal-head">
          <div className="modal-title"><Icon d={I.invoice} size={16} /> New invoice</div>
          <button className="iconbtn" onClick={onClose} aria-label="Close" disabled={saving}><Icon d={I.x} size={14} /></button>
        </div>

        {/* Direction — chosen explicitly, never inferred. Drives the second
            dropdown's source, the PDF issuer/bill-to roles, and which FK is written. */}
        <div className="form-group">
          <label className="form-label">Direction <span className="req">*</span></label>
          <div role="radiogroup" aria-label="Invoice direction" style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {([
              { v: "inkoop", label: "Inkoop" },
              { v: "verkoop", label: "Verkoop" },
            ] as Array<{ v: Direction; label: string }>).map(({ v, label }, i) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={direction === v}
                onClick={() => setDirection(v)}
                disabled={saving}
                style={{
                  padding: "7px 18px", fontSize: 13, fontWeight: 600, cursor: saving ? "default" : "pointer",
                  border: "none", borderLeft: i === 0 ? "none" : "1px solid var(--line)",
                  background: direction === v ? "var(--accent)" : "transparent",
                  color: direction === v ? "#fff" : "var(--muted)",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Client + counterparty (supplier for inkoop, customer for verkoop) */}
        <div style={{ display: "flex", gap: 12 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label" htmlFor="ni-client">Client <span className="req">*</span></label>
            <select id="ni-client" className="form-input" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={saving}>
              <option value="">— Select client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label" htmlFor="ni-counterparty">{counterpartyLabel} <span className="req">*</span></label>
            <select id="ni-counterparty" className="form-input" value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)} disabled={saving || !clientId || loadingCounterparties}>
              <option value="">{!clientId ? "— Select a client first —" : loadingCounterparties ? "Loading…" : counterparties.length === 0 ? `— No ${counterpartyNoun}s —` : `— Select ${counterpartyNoun} —`}</option>
              {counterparties.map((s) => <option key={s.id} value={s.id}>{s.name}{s.relatie_code ? ` (${s.relatie_code})` : ""}</option>)}
            </select>
          </div>
        </div>

        {/* Invoice meta */}
        <div style={{ display: "flex", gap: 12 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label" htmlFor="ni-number">Invoice number <span className="req">*</span></label>
            <input id="ni-number" className="form-input" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="2026052" disabled={saving} />
          </div>
          <div className="form-group" style={{ width: 150 }}>
            <label className="form-label" htmlFor="ni-date">Invoice date</label>
            <input id="ni-date" type="date" className="form-input" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} onClick={openPicker} onFocus={openPicker} disabled={saving} />
          </div>
          <div className="form-group" style={{ width: 150 }}>
            <label className="form-label" htmlFor="ni-delivery">Delivery date</label>
            <input id="ni-delivery" type="date" className="form-input" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} onClick={openPicker} onFocus={openPicker} disabled={saving} />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="ni-desc">Description</label>
          <input id="ni-desc" className="form-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`Invoice ${invoiceNumber || "…"}`} disabled={saving} />
        </div>

        {/* Line items */}
        <div className="form-group">
          <label className="form-label">Line items</label>
          <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 8, padding: "6px 10px", background: "var(--surface)", fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--faint)" }}>
              <span style={{ flex: 1 }}>Description</span>
              <span style={{ width: 70, textAlign: "right" }}>Qty</span>
              <span style={{ width: 70, textAlign: "right" }}>Price</span>
              <span style={{ width: 80, textAlign: "right" }}>Total</span>
              <span style={{ width: 24 }} />
            </div>
            {items.map((r) => {
              const lineTotal = computeTotals([{ description: r.description, quantity: num(r.quantity), unit_price: num(r.unit_price) }], 0).subtotal;
              return (
                <div key={r.id} style={{ display: "flex", gap: 8, padding: "6px 10px", alignItems: "center", borderTop: "1px solid var(--line)" }}>
                  <input className="form-input" style={{ flex: 1 }} value={r.description} onChange={(e) => setItem(r.id, { description: e.target.value })} placeholder="RT TWB 1205" disabled={saving} />
                  <input className="form-input" style={{ width: 70, ...numberInput }} inputMode="decimal" value={r.quantity} onChange={(e) => setItem(r.id, { quantity: e.target.value })} placeholder="0" disabled={saving} />
                  <input className="form-input" style={{ width: 70, ...numberInput }} inputMode="decimal" value={r.unit_price} onChange={(e) => setItem(r.id, { unit_price: e.target.value })} placeholder="0.00" disabled={saving} />
                  <span style={{ width: 80, textAlign: "right", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>{formatNL(lineTotal)}</span>
                  <button className="iconbtn" style={{ width: 24 }} onClick={() => removeRow(r.id)} aria-label="Remove line" disabled={saving || items.length <= 1}><Icon d={I.x} size={11} /></button>
                </div>
              );
            })}
          </div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={addRow} disabled={saving}><span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1 }}>+</span> Add line</button>
        </div>

        {/* VAT + totals */}
        <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
          <div className="form-group" style={{ width: 110, marginBottom: 0 }}>
            <label className="form-label" htmlFor="ni-btw">VAT %</label>
            <input id="ni-btw" className="form-input" style={numberInput} inputMode="decimal" value={btwRate} onChange={(e) => setBtwRate(e.target.value)} placeholder="21" disabled={saving} />
          </div>
          <div style={{ marginLeft: "auto", fontSize: 13, minWidth: 240 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", padding: "2px 0" }}><span>Subtotal (excl. VAT)</span><span style={{ fontVariantNumeric: "tabular-nums" }}>€ {formatNL(totals.subtotal)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", padding: "2px 0" }}><span>VAT ({formatNL(totals.btw_rate)}%)</span><span style={{ fontVariantNumeric: "tabular-nums" }}>€ {formatNL(totals.btw_amount)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 6 }}><span>Total</span><span style={{ fontVariantNumeric: "tabular-nums" }}>€ {formatNL(totals.total)}</span></div>
          </div>
        </div>

        {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.invoice} size={13} /> Create &amp; PDF</>}
          </button>
        </div>
      </div>
    </div>
  );
}
