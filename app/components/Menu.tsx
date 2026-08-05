"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconPath } from "./Icon";

export type MenuEntry =
  | { kind: "sep" }
  | { kind: "label"; text: string }
  | { kind: "item"; label: string; icon: IconPath; onSelect: () => void; danger?: boolean };

interface MenuProps {
  /** Bounding rect of the button that opened the menu. */
  anchor: DOMRect;
  items: MenuEntry[];
  onClose: () => void;
  ariaLabel?: string;
}

/**
 * Dropdown menu rendered into document.body.
 *
 * Portalled on purpose: table rows live inside `.table-card`, which sets
 * `overflow: hidden` to clip its rounded corners — an absolutely positioned
 * menu inside a row would be cut off. Fixed coordinates are derived from the
 * trigger's rect and flipped upward when there isn't room below.
 */
export function Menu({ anchor, items, onClose, ariaLabel = "Actions" }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure first, then place — so the flip decision uses the real height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const gap = 6;
    const top =
      anchor.bottom + gap + height > window.innerHeight - 8
        ? Math.max(8, anchor.top - gap - height)
        : anchor.bottom + gap;
    const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8);
    setPos({ top, left });
  }, [anchor]);

  // Focus only once the menu is actually placed — a visibility:hidden element
  // cannot take focus, so focusing during the measure pass silently no-ops and
  // leaves the keyboard user stranded on the trigger.
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLButtonElement>("[data-mi]")?.focus();
  }, [pos]);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    // Escape is handled on the document, not the container: focus may still be
    // on the trigger (or anywhere else) and Escape must always dismiss.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    // Fixed coordinates go stale the moment the page scrolls or resizes.
    const close = () => onClose();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[data-mi]") ?? []);
    if (buttons.length === 0) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {items.map((it, i) => {
        if (it.kind === "sep") return <div key={i} className="menu-sep" role="separator" />;
        if (it.kind === "label") return <div key={i} className="menu-lbl">{it.text}</div>;
        return (
          <button
            key={i}
            data-mi
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}`}
            onClick={() => { onClose(); it.onSelect(); }}
          >
            <span className="menu-ico"><Icon d={it.icon} size={14} /></span>
            {it.label}
          </button>
        );
      })}
    </div>,
    document.body
  );
}
