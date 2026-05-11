"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, I } from "./Icon";

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function UploadModal({ open, onClose, onSuccess }: UploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [phone, setPhone] = useState("");
  const [direction, setDirection] = useState<"inkoop" | "verkoop">("inkoop");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setPhone("");
      setDirection("inkoop");
      setError(null);
      setSuccess(false);
      setLoading(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [open]);

  async function handleUpload() {
    if (!file) return;
    if (!phone.trim()) { setError("Phone number is required"); return; }

    setLoading(true);
    setError(null);

    try {
      const fileType = file.type.includes("pdf") ? "pdf" : "image";

      // 1. Upload binary to S3
      const formData = new FormData();
      formData.append("file", file);
      formData.append("phone_number", phone.trim());
      formData.append("file_type", fileType);

      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || "Upload failed");

      // 2. Save file metadata to DB (triggers n8n processing)
      const filesRes = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number:      phone.trim(),
          file_key:          uploadData.file_key,
          file_type:         fileType,
          file_name:         uploadData.file_name,
          mime_type:         file.type || null,
          invoice_direction: direction,
        }),
      });
      const filesData = await filesRes.json();
      if (!filesRes.ok) throw new Error(filesData.error || "Failed to register file");

      setSuccess(true);
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError(null);
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Upload invoice file"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={I.upload} size={16} />
            Upload invoice
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon d={I.x} size={14} />
          </button>
        </div>

        {success ? (
          <div className="modal-success">
            <Icon d={I.check} size={24} stroke={2} />
            <div>File uploaded — extraction queued</div>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label className="form-label">File <span className="req">*</span></label>
              <div
                className={`file-drop${file ? " has-file" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                aria-label="Click to select file"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,image/*"
                  onChange={onFileChange}
                  style={{ display: "none" }}
                />
                <Icon d={I.file} size={20} />
                {file ? (
                  <span>{file.name} ({(file.size / 1024).toFixed(0)} KB)</span>
                ) : (
                  <span>Click to select PDF or image</span>
                )}
              </div>
            </div>

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
              />
            </div>

            <div className="form-group">
              <label className="form-label">Type</label>
              <div className="seg" role="group" aria-label="Invoice type">
                <button
                  className={direction === "inkoop" ? "on" : ""}
                  onClick={() => setDirection("inkoop")}
                >Inkoop</button>
                <button
                  className={direction === "verkoop" ? "on" : ""}
                  onClick={() => setDirection("verkoop")}
                >Verkoop</button>
              </div>
            </div>

            {error && <div className="modal-error"><Icon d={I.alert} size={13} />{error}</div>}

            <div className="modal-foot">
              <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
              <button
                className="btn primary"
                onClick={handleUpload}
                disabled={loading || !file}
              >
                {loading ? <><span className="spinner-sm" /> Uploading…</> : <><Icon d={I.upload} size={13} /> Upload</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
