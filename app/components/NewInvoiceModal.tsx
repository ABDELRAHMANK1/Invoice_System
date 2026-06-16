"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, I } from "./Icon";

interface NewInvoiceModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

type Direction = "inkoop" | "verkoop";

interface FormState {
  invoice_number: string;
  client_name: string;
  phone_number: string;
  date: string;
  total_amount: string;
  currency: string;
  direction: Direction;
}

const empty: FormState = {
  invoice_number: "",
  client_name: "",
  phone_number: "",
  date: "",
  total_amount: "",
  currency: "EUR",
  direction: "inkoop",
};

// Clicking a native date input doesn't reliably open the picker (only the small
// calendar glyph does, and it's easy to miss). Trigger it explicitly.
function openPicker(e: React.MouseEvent<HTMLInputElement> | React.FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
  try { el.showPicker?.(); } catch { /* not user-activated — ignore */ }
}

export function NewInvoiceModal({ open, onClose, onSuccess }: NewInvoiceModalProps) {
  const [form, setForm] = useState<FormState>(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setForm(empty);
      setSaving(false);
      setError(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && open && !saving) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, saving]);

  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [open]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!form.invoice_number.trim()) {
      setError("Invoice number is required");
      return;
    }
    const amountStr = form.total_amount.trim().replace(",", ".");
    let total_amount: number | null = null;
    if (amountStr) {
      const n = Number(amountStr);
      if (!Number.isFinite(n) || n < 0) {
        setError("Total amount must be a non-negative number");
        return;
      }
      total_amount = n;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_number:    form.invoice_number.trim(),
          client_name:       form.client_name.trim() || null,
          phone_number:      form.phone_number.trim() || null,
          date:              form.date || null,
          total_amount,
          currency:          (form.currency.trim() || "EUR").toUpperCase(),
          invoice_direction: form.direction,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Create failed: ${res.status}`);
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create invoice");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New invoice"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={I.invoice} size={16} />
            New invoice
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon d={I.x} size={14} />
          </button>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="ni-number">
            Invoice number <span className="req">*</span>
          </label>
          <input
            id="ni-number"
            className="form-input"
            value={form.invoice_number}
            onChange={(e) => set("invoice_number", e.target.value)}
            placeholder="202603271"
            disabled={saving}
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="ni-client">Client name</label>
          <input
            id="ni-client"
            className="form-input"
            value={form.client_name}
            onChange={(e) => set("client_name", e.target.value)}
            placeholder="NemaFood B.V."
            disabled={saving}
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="ni-phone">Phone number</label>
          <input
            id="ni-phone"
            className="form-input"
            value={form.phone_number}
            onChange={(e) => set("phone_number", e.target.value)}
            placeholder="+31 6 12 34 56 78"
            disabled={saving}
          />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label" htmlFor="ni-date">Invoice date</label>
            <input
              id="ni-date"
              type="date"
              className="form-input"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              onClick={openPicker}
              onFocus={openPicker}
              disabled={saving}
            />
          </div>
          <div className="form-group" style={{ width: 130 }}>
            <label className="form-label" htmlFor="ni-amount">Total amount</label>
            <input
              id="ni-amount"
              className="form-input"
              inputMode="decimal"
              value={form.total_amount}
              onChange={(e) => set("total_amount", e.target.value)}
              placeholder="196.52"
              disabled={saving}
            />
          </div>
          <div className="form-group" style={{ width: 80 }}>
            <label className="form-label" htmlFor="ni-currency">Currency</label>
            <input
              id="ni-currency"
              className="form-input"
              value={form.currency}
              onChange={(e) => set("currency", e.target.value.toUpperCase().slice(0, 3))}
              placeholder="EUR"
              disabled={saving}
            />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Type</label>
          <div className="seg" role="group" aria-label="Invoice type">
            <button
              className={form.direction === "inkoop" ? "on" : ""}
              onClick={() => !saving && set("direction", "inkoop")}
              disabled={saving}
            >Inkoop</button>
            <button
              className={form.direction === "verkoop" ? "on" : ""}
              onClick={() => !saving && set("direction", "verkoop")}
              disabled={saving}
            >Verkoop</button>
          </div>
        </div>

        {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving
              ? <><span className="spinner-sm" /> Saving…</>
              : <><Icon d={I.invoice} size={13} /> Create invoice</>}
          </button>
        </div>
      </div>
    </div>
  );
}
