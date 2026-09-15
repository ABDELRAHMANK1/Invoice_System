"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";

export function SettingsClient({ canManageUsers }: { canManageUsers: boolean }) {
  const { toast } = useToast();
  const [apiKey, setApiKey] = useState("");
  const [n8nUrl, setN8nUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 600));
    setSaving(false);
    toast("Settings saved", "success");
  }

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Settings</h1>
          <div className="sub">Workspace configuration and API credentials.</div>
        </div>
      </div>

      <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 24 }}>

        {/* Workspace */}
        <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>Workspace</div>

          <div className="form-group">
            <label className="form-label" htmlFor="ws-name">Workspace name</label>
            <input id="ws-name" className="form-input" defaultValue="Oranji NL" />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ws-country">Default country</label>
            <input id="ws-country" className="form-input" defaultValue="NL" maxLength={2}
              style={{ width: 72, textTransform: "uppercase" }} />
          </div>
        </div>

        {/* Team — owner/developer only. The page itself re-checks the role, so
            hiding the card is presentation, not the access control. */}
        {canManageUsers && (
          <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>Team</div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>
              Approve new accounts, change roles and edit what each person can do.
            </div>
            <Link href="/settings/users" className="btn" style={{ alignSelf: "flex-start" }}>
              <Icon d={I.users} size={13} /> Manage users
            </Link>
          </div>
        )}

        {/* Integrations */}
        <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>Integrations</div>

          <div className="form-group">
            <label className="form-label" htmlFor="api-key">Internal API key</label>
            <div className="form-hint">Used to authenticate requests from n8n and external services.</div>
            <input
              id="api-key"
              className="form-input"
              type="password"
              value={apiKey}
              placeholder="sk-••••••••••••••••"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="n8n-url">n8n webhook base URL</label>
            <input
              id="n8n-url"
              className="form-input"
              type="url"
              value={n8nUrl}
              placeholder="https://your-n8n-instance.com/webhook"
              onChange={(e) => setN8nUrl(e.target.value)}
            />
          </div>
        </div>

        {/* Danger zone */}
        <div className="table-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 12, borderColor: "var(--danger)" }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--danger)" }}>Danger zone</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            Permanently delete all invoices, files, and client data. This cannot be undone.
          </div>
          <button
            className="btn"
            style={{ alignSelf: "flex-start", borderColor: "var(--danger)", color: "var(--danger)" }}
            onClick={() => toast("Contact support to delete workspace data", "info")}
          >
            <Icon d={I.trash} size={13} /> Delete workspace data
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} /> Save settings</>}
          </button>
        </div>
      </div>
    </main>
  );
}
