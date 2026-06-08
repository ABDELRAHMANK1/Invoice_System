"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";
import type { Supplier } from "@/lib/types";

type Client = {
  id: string;
  name: string;
  phone_number: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string;
  btw_number: string | null;
  kvk_number: string | null;
  relatie_code: string | null;
  notes: string | null;
  created_at: string;
};

type ClientForm = Omit<Client, "id" | "created_at">;

const emptyClientForm: ClientForm = {
  name: "", phone_number: "", email: "", address: "", city: "", country: "NL",
  btw_number: "", kvk_number: "", relatie_code: "", notes: "",
};

type SupplierForm = Omit<Supplier, "id" | "client_id" | "created_at" | "updated_at">;

const emptySupplierForm: SupplierForm = {
  name: "", relatie_code: "", address: "", postcode: "", city: "",
  kvk: "", btw_number: "", iban: "", email: "", phone: "",
  payment_days: 0, active: true,
};

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

/* ── Supplier modal ──────────────────────────────────────────────── */

interface SupplierModalProps {
  clientId: string;
  supplier: Supplier | null;
  open: boolean;
  onClose: () => void;
  onSaved: (s: Supplier, isNew: boolean) => void;
}

function SupplierModal({ clientId, supplier, open, onClose, onSaved }: SupplierModalProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<SupplierForm>(emptySupplierForm);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof SupplierForm, string>>>({});

  useEffect(() => {
    if (open) {
      setForm(supplier
        ? {
            name: supplier.name,
            relatie_code: supplier.relatie_code ?? "",
            address: supplier.address ?? "",
            postcode: supplier.postcode ?? "",
            city: supplier.city ?? "",
            kvk: supplier.kvk ?? "",
            btw_number: supplier.btw_number ?? "",
            iban: supplier.iban ?? "",
            email: supplier.email ?? "",
            phone: supplier.phone ?? "",
            payment_days: supplier.payment_days ?? 0,
            active: supplier.active,
          }
        : emptySupplierForm);
      setErrors({});
    }
  }, [open, supplier]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function validate(): boolean {
    const e: typeof errors = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (form.email && !/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) e.email = "Invalid email";
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
      };
      const saved = supplier
        ? await apiJson<Supplier>(`/api/clients/${clientId}/suppliers/${supplier.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiJson<Supplier>(`/api/clients/${clientId}/suppliers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      toast(supplier ? "Supplier updated" : "Supplier added", "success");
      onSaved(saved, !supplier);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setLoading(false);
    }
  }

  function input(key: keyof SupplierForm, label: string, opts?: { placeholder?: string; type?: string; required?: boolean }) {
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

  return (
    <>
      <div className="drawer-bg on" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer on"
        role="dialog"
        aria-modal="true"
        aria-label={supplier ? "Edit supplier" : "Add supplier"}
      >
        <div className="dr-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>{supplier ? "Edit supplier" : "Add supplier"}</h3>
            {supplier && <div className="dr-sub">{supplier.name}</div>}
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
            {input("btw_number", "BTW number")}
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
        </div>

        <div className="dr-foot">
          <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={loading}>
            {loading ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} />{supplier ? "Save changes" : "Add supplier"}</>}
          </button>
        </div>
      </aside>
    </>
  );
}

/* ── Client detail page ──────────────────────────────────────────── */

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const clientId = params.id;

  const [client, setClient]     = useState<Client | null>(null);
  const [form, setForm]         = useState<ClientForm>(emptyClientForm);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierModal, setSupplierModal] = useState<{ open: boolean; editing: Supplier | null }>({ open: false, editing: null });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        apiJson<Client>(`/api/clients/${clientId}`),
        apiJson<Supplier[]>(`/api/clients/${clientId}/suppliers`),
      ]);
      setClient(c);
      setForm({
        name: c.name,
        phone_number: c.phone_number ?? "",
        email: c.email ?? "",
        address: c.address ?? "",
        city: c.city ?? "",
        country: c.country,
        btw_number: c.btw_number ?? "",
        kvk_number: c.kvk_number ?? "",
        relatie_code: c.relatie_code ?? "",
        notes: c.notes ?? "",
      });
      setSuppliers(s);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load client", "error");
    } finally {
      setLoading(false);
    }
  }, [clientId, toast]);

  useEffect(() => { load(); }, [load]);

  async function saveClient() {
    if (!form.name.trim()) {
      toast("Name is required", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name:         form.name,
        phone_number: form.phone_number || null,
        email:        form.email || null,
        address:      form.address || null,
        city:         form.city || null,
        country:      form.country,
        btw_number:   form.btw_number || null,
        kvk_number:   form.kvk_number || null,
        relatie_code: form.relatie_code || null,
        notes:        form.notes || null,
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

  function openAddSupplier() { setSupplierModal({ open: true, editing: null }); }
  function openEditSupplier(s: Supplier) { setSupplierModal({ open: true, editing: s }); }
  function closeSupplierModal() { setSupplierModal({ open: false, editing: null }); }

  function onSupplierSaved(s: Supplier, isNew: boolean) {
    setSuppliers((prev) => {
      if (isNew) return [...prev, s].sort((a, b) => a.name.localeCompare(b.name));
      return prev.map((x) => x.id === s.id ? s : x);
    });
    closeSupplierModal();
  }

  async function deleteSupplier(s: Supplier) {
    if (!confirm(`Delete supplier "${s.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/clients/${clientId}/suppliers/${s.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      setSuppliers((prev) => prev.filter((x) => x.id !== s.id));
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
          {field("btw_number", "BTW number")}
          {field("kvk_number", "KvK number")}
        </div>

        {field("address", "Address")}

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12 }}>
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

      {/* Suppliers section */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 16, margin: 0 }}>Suppliers (Leveranciers)</h2>
            <div className="sub" style={{ fontSize: 12 }}>
              {suppliers.length} supplier{suppliers.length === 1 ? "" : "s"}
            </div>
          </div>
          <button className="btn primary" onClick={openAddSupplier}>
            <Icon d={I.users} size={13} /> Add supplier
          </button>
        </div>

        {suppliers.length === 0 ? (
          <div className="t-empty" style={{ padding: 24 }}>
            No suppliers yet. Add one to map their relatie_code to invoices.
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
                {suppliers.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.relatie_code || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{s.name}</div>
                      {s.city && <div style={{ color: "var(--muted)", fontSize: 12 }}>{s.city}</div>}
                    </td>
                    <td>{s.kvk || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>{s.btw_number || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="act" title="Edit" onClick={() => openEditSupplier(s)}>
                        <Icon d={I.cog} size={14} />
                      </button>
                      <button className="act" title="Delete" onClick={() => deleteSupplier(s)}>
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

      <SupplierModal
        clientId={clientId}
        supplier={supplierModal.editing}
        open={supplierModal.open}
        onClose={closeSupplierModal}
        onSaved={onSupplierSaved}
      />
    </main>
  );
}
