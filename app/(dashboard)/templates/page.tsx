"use client";

import { useEffect, useState } from "react";
import { Icon, I } from "@/app/components/Icon";

type Template = { id: string; name: string; description: string | null };
type ClientOption = { id: string; name: string };

async function apiJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `${res.status}`); }
  return res.json();
}

// Programmatic <a download> click — a plain window.open() after an await gets
// popup-blocked (same lesson as NewInvoiceModal.tsx).
function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Client-picker modal state.
  const [active, setActive] = useState<Template | null>(null);
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    apiJson<{ data: Template[] }>("/api/templates")
      .then((r) => setTemplates(r.data || []))
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load templates"));
    apiJson<{ data: ClientOption[] }>("/api/clients?limit=500")
      .then((r) => setClients(r.data || []))
      .catch(() => { /* client load failure surfaces when the picker opens */ });
  }, []);

  function openPicker(t: Template) {
    setActive(t);
    setSearch("");
    setClientId("");
    setModalError(null);
  }

  function closePicker() {
    if (busy) return;
    setActive(null);
  }

  const filtered = search.trim()
    ? clients.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
    : clients;

  async function handleFill() {
    if (!active) return;
    if (!clientId) return setModalError("Select a client");

    setBusy(true);
    setModalError(null);
    try {
      const res = await fetch(`/api/templates/${active.id}/fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Fill failed: ${res.status}`);
      if (!body.file_url) throw new Error("No download URL returned");
      triggerDownload(body.file_url);
      setActive(null);
    } catch (e) {
      setModalError(e instanceof Error ? e.message : "Fill failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Document Templates</h1>
          <div className="sub">Pick a template and a client — the form is auto-filled with that client’s data and downloaded.</div>
        </div>
      </div>

      {loadError && <div className="modal-error"><Icon d={I.alert} size={13} />{loadError}</div>}

      {templates.length === 0 && !loadError ? (
        <div className="table-card" style={{ padding: "40px 24px", textAlign: "center", color: "var(--faint)" }}>
          No templates yet.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
          {templates.map((t) => (
            <button
              key={t.id}
              className="table-card"
              onClick={() => openPicker(t)}
              style={{
                padding: "18px 20px", textAlign: "left", cursor: "pointer",
                display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start",
                background: "var(--card, #fff)", border: "1px solid var(--line)",
              }}
            >
              <span className="nav-icon" style={{ display: "inline-flex" }}><Icon d={I.copy} size={18} /></span>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</span>
              {t.description && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{t.description}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Client-picker modal */}
      {active && (
        <div className="modal-overlay" onClick={closePicker} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div className="table-card" onClick={(e) => e.stopPropagation()} style={{ width: "min(440px, 92vw)", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{active.name}</div>
              <button className="btn ghost" onClick={closePicker} disabled={busy} aria-label="Close"><Icon d={I.x} size={14} /></button>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Choose the client whose data should fill this template.</div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="tpl-search">Client <span className="req">*</span></label>
              <input
                id="tpl-search"
                className="form-input"
                placeholder="Search clients…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={busy}
                autoFocus
              />
              <select
                className="form-input"
                size={6}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={busy}
                style={{ marginTop: 8, height: "auto" }}
              >
                {filtered.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {filtered.length === 0 && <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 4 }}>No matching clients.</div>}
            </div>

            {modalError && <div className="modal-error"><Icon d={I.alert} size={13} />{modalError}</div>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={closePicker} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={handleFill} disabled={busy || !clientId}>
                {busy ? <><span className="spinner-sm" /> Generating…</> : <><Icon d={I.download} size={13} /> Fill &amp; download</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
