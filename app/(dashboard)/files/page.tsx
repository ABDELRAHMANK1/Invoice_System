"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, I } from "@/app/components/Icon";
import { Pill, statusTone, statusLabel } from "@/app/components/Pill";
import { UploadModal } from "@/app/components/UploadModal";
import { useToast } from "@/app/components/Toast";

type FileRow = {
  id: string;
  phone_number: string;
  file_key: string;
  file_type: "image" | "pdf" | "document";
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  status: "pending" | "processing" | "done" | "error";
  error_message: string | null;
  invoice_direction: "inkoop" | "verkoop" | null;
  created_at: string;
};

type Paged<T> = { data: T[]; total: number; page: number; limit: number; totalPages: number };

const emptyPage: Paged<FileRow> = { data: [], total: 0, page: 1, limit: 50, totalPages: 0 };

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `${res.status}`); }
  return res.json();
}

export default function FilesPage() {
  const { toast } = useToast();
  const [files, setFiles]         = useState<Paged<FileRow>>(emptyPage);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: "50" });
      const result = await apiJson<Paged<FileRow>>(`/api/files?${qs}`);
      setFiles(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load files");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  async function deleteFile(file: FileRow) {
    const label = file.file_name || file.file_key.split("/").pop() || file.id.slice(0, 8);
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed: ${res.status}`);
      }
      toast("File deleted", "success");
      setFiles((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        data: prev.data.filter((f) => f.id !== file.id),
      }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  async function retry(fileId: string) {
    try {
      await apiJson(`/api/files/${fileId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
      });
      toast("File re-queued for processing", "success");
      load();
    } catch {
      toast("Could not reset file status", "error");
    }
  }

  function fmtSize(bytes: number | null) {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  const pageNums = Array.from({ length: Math.min(files.totalPages, 5) }, (_, i) => {
    if (files.totalPages <= 5) return i + 1;
    if (page <= 3) return i + 1;
    if (page >= files.totalPages - 2) return files.totalPages - 4 + i;
    return page - 2 + i;
  });

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Files</h1>
          <div className="sub">Raw uploaded files and their processing status.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setUploadOpen(true)}>
            <Icon d={I.upload} size={13} /> Upload file
          </button>
        </div>
      </div>

      {error && (
        <div className="notice-error">
          <Icon d={I.alert} size={14} />
          {error}
          <button className="btn sm" onClick={load} style={{ marginLeft: "auto" }}>Retry</button>
        </div>
      )}

      <div className="table-card" style={{ borderTop: "1px solid var(--line)", borderRadius: "var(--r-lg)" }}>
        <div className="t-head" style={{ gridTemplateColumns: "1.5fr 1fr 80px 100px 120px 90px 60px" }}>
          <div>File</div>
          <div>Phone</div>
          <div>Type</div>
          <div>Size</div>
          <div>Direction</div>
          <div>Status</div>
          <div />
        </div>

        {loading ? (
          <div className="t-empty">Loading files…</div>
        ) : files.data.length === 0 ? (
          <div className="t-empty">No files found.</div>
        ) : (
          files.data.map((file) => (
            <div
              key={file.id}
              className="t-row"
              style={{ gridTemplateColumns: "1.5fr 1fr 80px 100px 120px 90px 60px", cursor: "default" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span className="client-name">{file.file_name || file.file_key.split("/").pop()}</span>
                {file.error_message && (
                  <span style={{ fontSize: 11, color: "var(--danger)" }}>{file.error_message}</span>
                )}
              </div>
              <div className="cell-phone">{file.phone_number}</div>
              <div style={{ textTransform: "uppercase", fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>
                {file.file_type}
              </div>
              <div className="cell-date">{fmtSize(file.file_size)}</div>
              <div>
                <span className={`pill ${file.invoice_direction === "verkoop" ? "t-verkoop" : "t-inkoop"}`}>
                  {file.invoice_direction === "verkoop" ? "Verkoop" : "Inkoop"}
                </span>
              </div>
              <div>
                <Pill tone={statusTone(file.status)}>{statusLabel(file.status)}</Pill>
              </div>
              <div className="row-actions" style={{ opacity: 1 }}>
                <a
                  href={`/api/files/${file.id}/download`}
                  target="_blank"
                  rel="noopener"
                  className="act"
                  title="Open file"
                >
                  <Icon d={I.open} size={14} />
                </a>
                {file.status === "error" && (
                  <button className="act" title="Retry" onClick={() => retry(file.id)}>
                    <Icon d={I.refresh} size={14} />
                  </button>
                )}
                <button
                  className="act"
                  title="Delete"
                  onClick={() => deleteFile(file)}
                  aria-label="Delete file"
                >
                  <Icon d={I.trash} size={14} />
                </button>
              </div>
            </div>
          ))
        )}

        <div className="t-foot">
          <div>
            Showing <strong style={{ color: "var(--ink)" }}>{files.data.length}</strong> of{" "}
            <strong style={{ color: "var(--ink)" }}>{files.total}</strong> files
          </div>
          <nav className="pgr" aria-label="Pagination">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <Icon d={I.chevL} size={13} />
            </button>
            {pageNums.map((n) => (
              <button key={n} className={n === page ? "on" : ""} onClick={() => setPage(n)}>{n}</button>
            ))}
            <button disabled={page >= files.totalPages} onClick={() => setPage((p) => p + 1)}>
              <Icon d={I.chevR} size={13} />
            </button>
          </nav>
        </div>
      </div>

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={() => { toast("File uploaded", "success"); load(); }}
      />
    </main>
  );
}
