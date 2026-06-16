"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";

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
  iban: string | null;
  notes: string | null;
  created_at: string;
};

type Paged<T> = { data: T[]; total: number; page: number; limit: number; totalPages: number };
const emptyPage: Paged<Client> = { data: [], total: 0, page: 1, limit: 50, totalPages: 0 };

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

/* ── Client form (used in drawer) ────────────────────────────────── */

type ClientFormData = Omit<Client, "id" | "created_at">;

const emptyForm: ClientFormData = {
  name: "", phone_number: "", email: "", address: "",
  city: "", country: "NL", btw_number: "", kvk_number: "", iban: "", notes: "",
};

interface ClientDrawerProps {
  client: Client | null;
  open: boolean;
  onClose: () => void;
  onSaved: (c: Client) => void;
}

function ClientDrawer({ client, open, onClose, onSaved }: ClientDrawerProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<ClientFormData>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof ClientFormData, string>>>({});
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) {
      setForm(client
        ? { name: client.name, phone_number: client.phone_number ?? "", email: client.email ?? "",
            address: client.address ?? "", city: client.city ?? "", country: client.country,
            btw_number: client.btw_number ?? "", kvk_number: client.kvk_number ?? "", iban: client.iban ?? "", notes: client.notes ?? "" }
        : emptyForm);
      setErrors({});
    }
  }, [open, client]);

  useEffect(() => {
    if (open) drawerRef.current?.querySelector<HTMLElement>("input")?.focus();
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
        ...form,
        phone_number: form.phone_number || null,
        email:        form.email || null,
        address:      form.address || null,
        city:         form.city || null,
        btw_number:   form.btw_number || null,
        kvk_number:   form.kvk_number || null,
        iban:         form.iban || null,
        notes:        form.notes || null,
      };
      const saved = client
        ? await apiJson<Client>(`/api/clients/${client.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiJson<Client>("/api/clients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      toast(client ? "Client updated" : "Client added", "success");
      onSaved(saved);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setLoading(false);
    }
  }

  function field(key: keyof ClientFormData, label: string, opts?: { placeholder?: string; type?: string; required?: boolean; hint?: string }) {
    return (
      <div className="form-group">
        <label className="form-label" htmlFor={`cf-${key}`}>
          {label}{opts?.required && <span className="req"> *</span>}
        </label>
        {opts?.hint && <div className="form-hint">{opts.hint}</div>}
        <input
          id={`cf-${key}`}
          className={`form-input${errors[key] ? " error" : ""}`}
          type={opts?.type ?? "text"}
          value={(form[key] as string) ?? ""}
          placeholder={opts?.placeholder}
          onChange={(e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setErrors((er) => { const n = { ...er }; delete n[key]; return n; }); }}
        />
        {errors[key] && <div className="form-error">{errors[key]}</div>}
      </div>
    );
  }

  return (
    <>
      <div className={`drawer-bg${open ? " on" : ""}`} onClick={onClose} aria-hidden="true" />
      <aside
        ref={drawerRef}
        className={`drawer${open ? " on" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={client ? "Edit client" : "Add client"}
      >
        <div className="dr-head">
          {client && (
            <div className="client-av" style={{ width: 36, height: 36, borderRadius: 9, background: clientColor(client.name), flexShrink: 0 }}>
              {clientInitials(client.name)}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>{client ? "Edit client" : "Add client"}</h3>
            {client && <div className="dr-sub">{client.name}</div>}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>

        <div className="dr-body">
          {field("name", "Name", { required: true, placeholder: "NemaFood B.V." })}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {field("phone_number", "Phone", { placeholder: "+31 6 12 34 56 78" })}
            {field("email", "Email", { type: "email", placeholder: "info@example.nl" })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {field("btw_number", "BTW number", { placeholder: "NL000000000B01", hint: "Dutch VAT number" })}
            {field("kvk_number", "KvK number", { placeholder: "12345678", hint: "Chamber of Commerce" })}
          </div>

          {field("iban", "IBAN", { placeholder: "NL00 BANK 0000 0000 00", hint: "Used on generated invoice PDFs" })}

          {field("address", "Address", { placeholder: "Keizersgracht 1" })}

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12 }}>
            {field("city", "City", { placeholder: "Amsterdam" })}
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

          <div className="form-group">
            <label className="form-label" htmlFor="cf-notes">Notes</label>
            <textarea
              id="cf-notes"
              className="form-input"
              value={form.notes ?? ""}
              placeholder="Internal notes…"
              rows={3}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              style={{ resize: "vertical" }}
            />
          </div>
        </div>

        <div className="dr-foot">
          <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={loading}>
            {loading ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} />{client ? "Save changes" : "Add client"}</>}
          </button>
        </div>
      </aside>
    </>
  );
}

/* ── Clients page ────────────────────────────────────────────────── */

export default function ClientsPage() {
  const { toast } = useToast();
  const [clients, setClients]       = useState<Paged<Client>>(emptyPage);
  const [page, setPage]             = useState(1);
  const [search, setSearch]         = useState("");
  const [committed, setCommitted]   = useState("");
  const [loading, setLoading]       = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing]       = useState<Client | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: "50" });
      if (committed) qs.set("q", committed);
      const result = await apiJson<Paged<Client>>(`/api/clients?${qs}`);
      setClients(result);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load clients", "error");
    } finally {
      setLoading(false);
    }
  }, [page, committed, toast]);

  useEffect(() => { load(); }, [load]);

  function openAdd() { setEditing(null); setDrawerOpen(true); }
  function openEdit(c: Client) { setEditing(c); setDrawerOpen(true); }

  function onSaved(c: Client) {
    setDrawerOpen(false);
    setClients((prev) => {
      if (editing) {
        return { ...prev, data: prev.data.map((x) => x.id === c.id ? c : x) };
      }
      return { ...prev, total: prev.total + 1, data: [c, ...prev.data] };
    });
  }

  async function deleteClient(c: Client) {
    if (!confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/clients/${c.id}`, { method: "DELETE" });
      toast(`${c.name} deleted`, "success");
      setClients((prev) => ({ ...prev, total: prev.total - 1, data: prev.data.filter((x) => x.id !== c.id) }));
    } catch {
      toast("Delete failed", "error");
    }
  }

  const pageNums = Array.from({ length: Math.min(clients.totalPages, 5) }, (_, i) => {
    if (clients.totalPages <= 5) return i + 1;
    if (page <= 3) return i + 1;
    if (page >= clients.totalPages - 2) return clients.totalPages - 4 + i;
    return page - 2 + i;
  });

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Clients</h1>
          <div className="sub">Manage clients and their contact details.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={openAdd}>
            <Icon d={I.users} size={13} /> Add client
          </button>
        </div>
      </div>

      {/* Inline search */}
      <div className="filters" style={{ marginBottom: 14 }}>
        <div className="quick" style={{ gap: 8 }}>
          <div className="field" style={{ flex: 1, maxWidth: 400 }}>
            <Icon d={I.search} size={14} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { setCommitted(search); setPage(1); } }}
              placeholder="Search by name, phone, or city…"
              aria-label="Search clients"
            />
          </div>
          <button className="btn sm primary" onClick={() => { setCommitted(search); setPage(1); }}>
            <Icon d={I.search} size={12} /> Search
          </button>
          {committed && (
            <button className="btn sm" onClick={() => { setSearch(""); setCommitted(""); setPage(1); }}>
              <Icon d={I.refresh} size={12} /> Clear
            </button>
          )}
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
            {clients.total} client{clients.total !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Clients grid */}
      {loading ? (
        <div className="t-empty">Loading clients…</div>
      ) : clients.data.length === 0 ? (
        <div className="clients-empty">
          <Icon d={I.users} size={32} />
          <div>No clients yet</div>
          <button className="btn primary" onClick={openAdd}>
            <Icon d={I.users} size={13} /> Add your first client
          </button>
        </div>
      ) : (
        <div className="clients-grid">
          {clients.data.map((c) => (
            <div key={c.id} className="client-card">
              <div className="client-card-av" style={{ background: clientColor(c.name) }}>
                {clientInitials(c.name)}
              </div>
              <div className="client-card-body">
                <div className="client-card-name">{c.name}</div>
                {c.phone_number && <div className="client-card-meta mono">{c.phone_number}</div>}
                {c.email        && <div className="client-card-meta">{c.email}</div>}
                {c.city         && <div className="client-card-meta">{c.city}{c.country ? `, ${c.country}` : ""}</div>}
                {c.btw_number   && <div className="client-card-tag">BTW {c.btw_number}</div>}
                {c.kvk_number   && <div className="client-card-tag">KvK {c.kvk_number}</div>}
              </div>
              <div className="client-card-actions">
                <Link href={`/clients/${c.id}`} className="act" title="Open details">
                  <Icon d={I.chevR} size={14} />
                </Link>
                <button className="act" title="Edit" onClick={() => openEdit(c)}>
                  <Icon d={I.cog} size={14} />
                </button>
                <button className="act" title="Delete" onClick={() => deleteClient(c)}>
                  <Icon d={I.trash} size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {clients.totalPages > 1 && (
        <div className="t-foot" style={{ background: "none", border: "none", paddingLeft: 0, marginTop: 12 }}>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            Page {clients.page} of {clients.totalPages}
          </div>
          <nav className="pgr" aria-label="Pagination">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <Icon d={I.chevL} size={13} />
            </button>
            {pageNums.map((n) => (
              <button key={n} className={n === page ? "on" : ""} onClick={() => setPage(n)}>{n}</button>
            ))}
            <button disabled={page >= clients.totalPages} onClick={() => setPage((p) => p + 1)}>
              <Icon d={I.chevR} size={13} />
            </button>
          </nav>
        </div>
      )}

      <ClientDrawer
        open={drawerOpen}
        client={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={onSaved}
      />
    </main>
  );
}
