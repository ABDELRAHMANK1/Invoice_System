"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, I } from "./Icon";

type ExportType = "excel" | "zip";
type Direction = "inkoop" | "verkoop" | "";

interface Filters {
  phone?: string;
  client?: string;
  invoice?: string;
  from?: string;
  to?: string;
}

interface ExportModalProps {
  open: boolean;
  type: ExportType;
  filters: Filters;
  ids?: string[];
  onClose: () => void;
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function pollJob(jobId: string, maxWait = 120_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(`/api/export/${jobId}`);
    const job = await res.json();
    if (job.status === "done" && job.download_url) return job.download_url;
    if (job.status === "error") throw new Error(job.error || "Export failed on server");
  }
  throw new Error("Export timed out — try a smaller date range");
}

export function ExportModal({ open, type, filters, ids, onClose }: ExportModalProps) {
  const [direction, setDirection] = useState<Direction>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) { setError(null); setLoading(false); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  async function handleExport() {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        type,
        async_job: false,
      };
      if (ids && ids.length > 0) {
        body.ids = ids;
      } else {
        Object.assign(body, filters);
      }
      if (direction) body.direction = direction;

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Export failed");

      let downloadUrl: string | undefined = data.download_url;

      // Async fallback
      if (!downloadUrl && data.jobId) {
        downloadUrl = await pollJob(data.jobId);
      }

      if (downloadUrl) {
        const ext = type === "excel" ? "xlsx" : "zip";
        const filename = `oranji-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
        triggerDownload(downloadUrl, filename);
        onClose();
      } else {
        throw new Error("Export completed but no download URL returned");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={type === "excel" ? "Export Excel" : "Download files"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={type === "excel" ? I.excel : I.download} size={16} />
            {type === "excel" ? "Export Excel" : "Download files (ZIP)"}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon d={I.x} size={14} />
          </button>
        </div>

        {type === "excel" ? (
          <>
            <p className="modal-sub">Choose which invoices to include in the Boekingen export:</p>
            <div className="modal-choices">
              {(["", "inkoop", "verkoop"] as Direction[]).map((d) => (
                <button
                  key={d || "all"}
                  className={`modal-choice${direction === d ? " selected" : ""}`}
                  onClick={() => setDirection(d)}
                >
                  <span className={`pill ${d === "inkoop" ? "t-inkoop" : d === "verkoop" ? "t-verkoop" : "s-info"}`}>
                    {d === "" ? "Alle" : d === "inkoop" ? "Inkoop" : "Verkoop"}
                  </span>
                  <span className="modal-choice-desc">
                    {d === "" ? "All invoices" : d === "inkoop" ? "Crediteuren · dagboek 1600" : "Debiteuren · dagboek 1300"}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="modal-sub">
            Download all matching invoice files as a ZIP archive. Large exports may take a moment.
          </p>
        )}

        {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn primary" onClick={handleExport} disabled={loading}>
            {loading ? (
              <><span className="spinner-sm" /> Preparing…</>
            ) : (
              <><Icon d={type === "excel" ? I.excel : I.download} size={13} />
              {type === "excel" ? "Export Excel" : "Download ZIP"}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
