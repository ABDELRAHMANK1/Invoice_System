"use client";

import { useEffect, useState } from "react";
import { Icon, I } from "@/app/components/Icon";

type Template = { id: string; name: string; description: string | null };
type ClientOption = { id: string; name: string };

// Client columns an uploaded template can auto-fill, with labels. Mirrors
// FILLABLE_CLIENT_COLUMNS in lib/template-fill.ts — kept local (not imported) so
// pdf-lib stays out of the client bundle. The order here is the dropdown order;
// the server re-validates every target against its own allow-list on save.
const FILLABLE_COLUMNS: Array<{ value: string; label: string }> = [
  { value: "name", label: "Company name" },
  { value: "iban", label: "IBAN" },
  { value: "address", label: "Address" },
  { value: "city", label: "City" },
  { value: "phone_number", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "btw_number", label: "BTW number" },
  { value: "kvk_number", label: "KVK number" },
];

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

  // Upload-template modal state.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [upStep, setUpStep] = useState<"pick" | "review">("pick");
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upFields, setUpFields] = useState<string[]>([]);
  const [upMapping, setUpMapping] = useState<Record<string, string>>({});
  const [upName, setUpName] = useState("");
  const [upDesc, setUpDesc] = useState("");
  const [upBusy, setUpBusy] = useState(false);
  const [upError, setUpError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function openUpload() {
    setUploadOpen(true);
    setUpStep("pick");
    setUpFile(null);
    setUpFields([]);
    setUpMapping({});
    setUpName("");
    setUpDesc("");
    setUpError(null);
  }

  function closeUpload() {
    if (upBusy) return;
    setUploadOpen(false);
  }

  // Step 1: user picked a PDF → discover its fields + auto-mapping, advance to review.
  async function handleInspect(file: File) {
    setUpFile(file);
    setUpBusy(true);
    setUpError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/templates/inspect", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Inspect failed: ${res.status}`);
      setUpFields(body.fields || []);
      setUpMapping(body.mapping || {});
      setUpName(file.name.replace(/\.pdf$/i, ""));
      setUpStep("review");
    } catch (e) {
      setUpError(e instanceof Error ? e.message : "Could not read this PDF");
      setUpFile(null);
    } finally {
      setUpBusy(false);
    }
  }

  // Step 2: save the template (upload PDF + insert row).
  async function handleSaveTemplate() {
    if (!upFile) return;
    if (!upName.trim()) return setUpError("Enter a template name");
    setUpBusy(true);
    setUpError(null);
    try {
      const fd = new FormData();
      fd.append("file", upFile);
      fd.append("name", upName.trim());
      fd.append("description", upDesc.trim());
      fd.append("mapping", JSON.stringify(upMapping));
      const res = await fetch("/api/templates", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Save failed: ${res.status}`);
      if (body.data) setTemplates((prev) => [body.data, ...prev]);
      setUploadOpen(false);
    } catch (e) {
      setUpError(e instanceof Error ? e.message : "Could not save the template");
    } finally {
      setUpBusy(false);
    }
  }

  async function handleDelete(t: Template) {
    if (!confirm(`Delete the template “${t.name}”? This can't be undone.`)) return;
    setDeletingId(t.id);
    try {
      const res = await fetch(`/api/templates/${t.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed: ${res.status}`);
      }
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not delete the template");
    } finally {
      setDeletingId(null);
    }
  }

  // Edit one field's target in the review step. "" (None) removes the mapping so
  // the field stays blank on fill — this is how a wrong auto-match is corrected.
  function setFieldMapping(field: string, col: string) {
    setUpMapping((prev) => {
      const next = { ...prev };
      if (col) next[field] = col;
      else delete next[field];
      return next;
    });
  }

  const mappedCount = upFields.filter((f) => upMapping[f]).length;

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
        <button className="btn primary" onClick={openUpload}>
          <Icon d={I.plus} size={14} /> Upload template
        </button>
      </div>

      {loadError && <div className="modal-error"><Icon d={I.alert} size={13} />{loadError}</div>}

      {templates.length === 0 && !loadError ? (
        <div className="table-card" style={{ padding: "40px 24px", textAlign: "center", color: "var(--faint)" }}>
          No templates yet.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
          {templates.map((t) => (
            // Relative wrapper so the delete button is a SIBLING of the card
            // button (a <button> inside a <button> is invalid HTML).
            <div key={t.id} style={{ position: "relative" }}>
              <button
                className="table-card"
                onClick={() => openPicker(t)}
                style={{
                  width: "100%", padding: "18px 20px", textAlign: "left", cursor: "pointer",
                  display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start",
                  // Use theme tokens so the card follows light/dark like every other
                  // surface. A native <button> does NOT inherit `color` from body and
                  // falls back to the UA `ButtonText` system colour, which flips to
                  // near-white under `color-scheme: dark` — pin `--ink` so the title +
                  // icon stay visible. (.table-card already supplies background + border.)
                  background: "var(--surface)", color: "var(--ink)",
                }}
              >
                <span className="nav-icon" style={{ display: "inline-flex" }}><Icon d={I.copy} size={18} /></span>
                <span style={{ fontWeight: 700, fontSize: 14, paddingRight: 22 }}>{t.name}</span>
                {t.description && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{t.description}</span>}
              </button>
              <button
                className="act"
                onClick={() => handleDelete(t)}
                disabled={deletingId === t.id}
                aria-label={`Delete ${t.name}`}
                title="Delete template"
                style={{ position: "absolute", top: 12, right: 12 }}
              >
                <Icon d={I.trash} size={14} />
              </button>
            </div>
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

      {/* Upload-template modal */}
      {uploadOpen && (
        <div className="modal-overlay" onClick={closeUpload} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div className="table-card" onClick={(e) => e.stopPropagation()} style={{ width: "min(520px, 94vw)", maxHeight: "88vh", overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Upload a new template</div>
              <button className="btn ghost" onClick={closeUpload} disabled={upBusy} aria-label="Close"><Icon d={I.x} size={14} /></button>
            </div>

            {upStep === "pick" && (
              <>
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  Upload a fillable PDF form. We’ll detect its fields automatically and match them to client data.
                </div>
                <label className="file-drop" style={{ cursor: upBusy ? "wait" : "pointer" }}>
                  <Icon d={I.upload} size={18} />
                  <span>{upBusy ? "Reading PDF…" : "Choose a PDF file"}</span>
                  <input
                    type="file"
                    accept="application/pdf"
                    style={{ display: "none" }}
                    disabled={upBusy}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleInspect(f); e.target.value = ""; }}
                  />
                </label>
                {upError && <div className="modal-error"><Icon d={I.alert} size={13} />{upError}</div>}
              </>
            )}

            {upStep === "review" && (
              <>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="tpl-name">Name <span className="req">*</span></label>
                  <input id="tpl-name" className="form-input" value={upName} onChange={(e) => setUpName(e.target.value)} disabled={upBusy} autoFocus />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="tpl-desc">Description</label>
                  <input id="tpl-desc" className="form-input" placeholder="Optional" value={upDesc} onChange={(e) => setUpDesc(e.target.value)} disabled={upBusy} />
                </div>

                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 6 }}>
                    Detected fields — {mappedCount} of {upFields.length} auto-filled
                  </div>
                  <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", maxHeight: 240, overflowY: "auto" }}>
                    {upFields.map((f) => {
                      const col = upMapping[f];
                      return (
                        <div key={f} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "7px 12px", borderBottom: "1px solid var(--line-2)", fontSize: 12.5 }}>
                          <span style={{ fontFamily: "var(--mono)", color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }} title={f}>{f}</span>
                          <select
                            className="form-input"
                            value={col ?? ""}
                            onChange={(e) => setFieldMapping(f, e.target.value)}
                            disabled={upBusy}
                            aria-label={`Fill "${f}" with`}
                            style={{ flexShrink: 0, width: 160, padding: "5px 8px", fontSize: 12.5, color: col ? "var(--ink)" : "var(--faint)" }}
                          >
                            <option value="">— not filled —</option>
                            {FILLABLE_COLUMNS.map((c) => (
                              <option key={c.value} value={c.value}>{c.label}</option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>
                    Auto-matched by field name — check each one and correct it if wrong. Set a field to “— not filled —” to leave it blank on the generated document.
                  </div>
                </div>

                {upError && <div className="modal-error"><Icon d={I.alert} size={13} />{upError}</div>}

                <div style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
                  <button className="btn ghost" onClick={() => setUpStep("pick")} disabled={upBusy}>Back</button>
                  <button className="btn primary" onClick={handleSaveTemplate} disabled={upBusy || !upName.trim()}>
                    {upBusy ? <><span className="spinner-sm" /> Saving…</> : <>Save template</>}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
