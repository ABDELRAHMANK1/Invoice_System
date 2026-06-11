"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, I } from "./Icon";

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

type ItemStatus = "pending" | "uploading" | "done" | "error";

interface UploadItem {
  id: string;
  file: File;
  status: ItemStatus;
  error?: string;
}

const CONCURRENCY = 5;

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function detectFileType(f: File): "pdf" | "image" {
  return f.type.includes("pdf") || f.name.toLowerCase().endsWith(".pdf") ? "pdf" : "image";
}

async function uploadOne(item: UploadItem, phone: string, direction: "inkoop" | "verkoop"): Promise<void> {
  const fileType = detectFileType(item.file);

  const formData = new FormData();
  formData.append("file", item.file);
  formData.append("phone_number", phone);
  formData.append("file_type", fileType);

  const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(uploadData.error || "Upload failed");

  const filesRes = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone_number:      phone,
      file_key:          uploadData.file_key,
      file_type:         fileType,
      file_name:         uploadData.file_name,
      mime_type:         item.file.type || null,
      invoice_direction: direction,
    }),
  });
  const filesData = await filesRes.json();
  if (!filesRes.ok) throw new Error(filesData.error || "Failed to register file");
}

export function UploadModal({ open, onClose, onSuccess }: UploadModalProps) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [phone, setPhone] = useState("");
  const [direction, setDirection] = useState<"inkoop" | "verkoop">("inkoop");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setItems([]);
      setPhone("");
      setDirection("inkoop");
      setError(null);
      setRunning(false);
      setDragOver(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open && !running) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, running]);

  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [open]);

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...incoming.map<UploadItem>((file) => ({ id: newId(), file, status: "pending" })),
    ]);
    setError(null);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    // Reset so the same file can be re-selected later if removed.
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (running) return;
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  function clearAll() {
    setItems([]);
  }

  function updateItem(id: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function handleUpload() {
    if (items.length === 0) return;
    if (!phone.trim()) { setError("Phone number is required"); return; }

    setRunning(true);
    setError(null);

    // Reset statuses for any prior errors before retry.
    setItems((prev) => prev.map((it) => (it.status === "error" ? { ...it, status: "pending", error: undefined } : it)));

    const queue: UploadItem[] = items.filter((it) => it.status !== "done");
    let index = 0;

    async function worker() {
      while (true) {
        const next = queue[index];
        index += 1;
        if (!next) return;
        updateItem(next.id, { status: "uploading", error: undefined });
        try {
          await uploadOne(next, phone.trim(), direction);
          updateItem(next.id, { status: "done" });
        } catch (e) {
          updateItem(next.id, { status: "error", error: e instanceof Error ? e.message : "Upload failed" });
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker());
    await Promise.all(workers);

    setRunning(false);
    onSuccess?.();
  }

  const counts = useMemo(() => {
    const total  = items.length;
    const done   = items.filter((it) => it.status === "done").length;
    const error  = items.filter((it) => it.status === "error").length;
    const upload = items.filter((it) => it.status === "uploading").length;
    const pending = total - done - error - upload;
    return { total, done, error, upload, pending };
  }, [items]);

  const allDoneOrError = items.length > 0 && counts.pending === 0 && counts.upload === 0;
  const totalBytes = items.reduce((s, it) => s + it.file.size, 0);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Upload invoice files"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
      >
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={I.upload} size={16} />
            Upload invoices
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close" disabled={running}>
            <Icon d={I.x} size={14} />
          </button>
        </div>

        {/* File picker / drop zone */}
        <div className="form-group">
          <label className="form-label">
            Files {items.length > 0 && <span style={{ color: "var(--muted)", fontWeight: 400 }}>({items.length} selected · {(totalBytes / 1024 / 1024).toFixed(1)} MB)</span>}
            <span className="req"> *</span>
          </label>
          <div
            className={`file-drop${items.length > 0 ? " has-file" : ""}${dragOver ? " drag-over" : ""}`}
            onClick={() => !running && fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); if (!running) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && !running && fileInputRef.current?.click()}
            aria-label="Click or drop files here"
            style={{ opacity: running ? 0.6 : 1, cursor: running ? "not-allowed" : "pointer" }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,image/*"
              multiple
              onChange={onFileChange}
              style={{ display: "none" }}
              disabled={running}
            />
            <Icon d={I.file} size={20} />
            <span>
              {items.length === 0
                ? "Click or drop PDFs/images — pick as many as you need"
                : "Click or drop to add more"}
            </span>
          </div>
        </div>

        {/* Selected files list */}
        {items.length > 0 && (
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 14 }}>
            {items.map((it) => (
              <div key={it.id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 12px", fontSize: 12.5,
                borderBottom: "1px solid var(--line)",
              }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {it.file.name}
                </span>
                <span style={{ color: "var(--muted)", flexShrink: 0 }}>
                  {(it.file.size / 1024).toFixed(0)} KB
                </span>
                <span style={{ flexShrink: 0, width: 90, textAlign: "right" }}>
                  {it.status === "pending"   && <span style={{ color: "var(--muted)" }}>queued</span>}
                  {it.status === "uploading" && <span style={{ color: "#1d4ed8" }}><span className="spinner-sm" /> uploading</span>}
                  {it.status === "done"      && <span style={{ color: "#1f8a5b" }}>✓ done</span>}
                  {it.status === "error"     && <span style={{ color: "#c0392b" }} title={it.error || ""}>✗ failed</span>}
                </span>
                {!running && it.status !== "done" && (
                  <button
                    className="iconbtn"
                    onClick={() => removeItem(it.id)}
                    aria-label={`Remove ${it.file.name}`}
                    style={{ flexShrink: 0 }}
                  >
                    <Icon d={I.x} size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Phone */}
        <div className="form-group">
          <label className="form-label" htmlFor="upload-phone">
            Phone number <span className="req">*</span>
          </label>
          <input
            id="upload-phone"
            className="form-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+31 6 12 34 56 78"
            disabled={running}
          />
        </div>

        {/* Direction */}
        <div className="form-group">
          <label className="form-label">Type</label>
          <div className="seg" role="group" aria-label="Invoice type">
            <button
              className={direction === "inkoop" ? "on" : ""}
              onClick={() => !running && setDirection("inkoop")}
              disabled={running}
            >Inkoop</button>
            <button
              className={direction === "verkoop" ? "on" : ""}
              onClick={() => !running && setDirection("verkoop")}
              disabled={running}
            >Verkoop</button>
          </div>
        </div>

        {/* Progress / summary */}
        {items.length > 0 && (counts.upload > 0 || counts.done > 0 || counts.error > 0) && (
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>
            {counts.done} of {counts.total} uploaded
            {counts.error > 0 && <> · <span style={{ color: "#c0392b" }}>{counts.error} failed</span></>}
            {counts.upload > 0 && <> · {counts.upload} in flight</>}
          </div>
        )}

        {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

        <div className="modal-foot">
          {items.length > 0 && !running && (
            <button className="btn" onClick={clearAll}>Clear all</button>
          )}
          <button className="btn" onClick={onClose} disabled={running}>
            {allDoneOrError ? "Close" : "Cancel"}
          </button>
          {!allDoneOrError && (
            <button
              className="btn primary"
              onClick={handleUpload}
              disabled={running || items.length === 0}
            >
              {running ? (
                <><span className="spinner-sm" /> Uploading {counts.done + counts.upload}/{counts.total}…</>
              ) : counts.error > 0 ? (
                <><Icon d={I.upload} size={13} /> Retry failed</>
              ) : (
                <><Icon d={I.upload} size={13} /> Upload {items.length > 1 ? `${items.length} files` : "file"}</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
