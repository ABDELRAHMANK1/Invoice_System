"use client";

import { useEffect, useRef } from "react";
import { Icon, I } from "./Icon";

/**
 * The single confirmation gate for destructive actions.
 *
 * Every delete button in the dashboard routes through this — deliberately NOT
 * the native `confirm()`. A browser lets the user tick "prevent this page from
 * creating additional dialogs", after which `confirm()` stops prompting and the
 * `if (!confirm(...)) return` guard silently evaporates, so the next click
 * deletes with no question asked. A rendered dialog can't be suppressed.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
  busy = false,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** Blocks a double-submit while the request is in flight. */
  busy?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const escRef = useRef(onCancel);
  escRef.current = onCancel;

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") escRef.current(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  // Focus Cancel, not Confirm: a stray Enter from the click that opened the
  // dialog must never land on the destructive button.
  useEffect(() => { cancelRef.current?.focus(); }, []);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 420 }}
      >
        <div className="modal-head">
          <div className="modal-title"><Icon d={I.alert} size={16} /> {title}</div>
          <button className="iconbtn" onClick={onCancel} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>
        <div style={{ padding: "16px 18px", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>{body}</div>
        <div className="modal-foot">
          <button ref={cancelRef} className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            onClick={onConfirm}
            disabled={busy}
            style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }}
          >
            <Icon d={I.trash} size={13} /> {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
