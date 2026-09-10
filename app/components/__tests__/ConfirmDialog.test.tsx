import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";

describe("ConfirmDialog", () => {
  function renderDialog(overrides: Partial<{ onCancel: () => void; onConfirm: () => void; busy: boolean }> = {}) {
    const onCancel = overrides.onCancel ?? vi.fn();
    const onConfirm = overrides.onConfirm ?? vi.fn();
    render(
      <ConfirmDialog
        title="Delete client"
        body="Delete Acme? This cannot be undone."
        confirmLabel="Delete"
        busy={overrides.busy ?? false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    return { onCancel, onConfirm };
  }

  it("does not fire the destructive action until Delete is clicked", () => {
    const { onConfirm } = renderDialog();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels on Cancel, on Escape, and on a backdrop click", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(
      <ConfirmDialog
        title="Delete client" body="body" confirmLabel="Delete"
        onCancel={onCancel} onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(container.querySelector(".modal-backdrop")!);

    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("focuses Cancel so a stray Enter cannot confirm the delete", () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("disables both buttons while the delete is in flight", () => {
    renderDialog({ busy: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deleting/i })).toBeDisabled();
  });
});

/**
 * Guard rail, not a unit test: a delete button must never reach production
 * behind `window.confirm()`. The browser lets a user tick "prevent this page
 * from creating additional dialogs", after which `confirm()` stops prompting
 * and an `if (!confirm(...)) return` guard silently stops guarding — the next
 * click deletes with no question asked. Every destructive action therefore
 * routes through the rendered <ConfirmDialog />.
 */
describe("delete confirmation coverage", () => {
  const appDir = join(process.cwd(), "app");

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : tsxFiles(p);
      return e.name.endsWith(".tsx") ? [p] : [];
    });
  }

  // Comments discuss window.confirm() on purpose (this file and ConfirmDialog
  // itself explain why it is banned), so the sweep reads code only.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const sources = tsxFiles(appDir).map((path) => ({
    path: path.slice(process.cwd().length + 1),
    text: readFileSync(path, "utf8"),
  }));

  it("finds the pages that issue DELETE requests", () => {
    const deleters = sources.filter((f) => /method:\s*"DELETE"/.test(f.text));
    // Clients, client detail (counterparties + employees), invoices, files,
    // templates, tasks. If this drops, the sweep below has stopped sweeping.
    expect(deleters.length).toBeGreaterThanOrEqual(6);
  });

  it("uses no window.confirm() anywhere in the app", () => {
    const offenders = sources
      .filter((f) => /(^|[^.\w])confirm\s*\(/.test(stripComments(f.text)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("gates every DELETE-issuing page on <ConfirmDialog />", () => {
    const ungated = sources
      .filter((f) => /method:\s*"DELETE"/.test(f.text))
      .filter((f) => !f.text.includes("ConfirmDialog"))
      .map((f) => f.path);
    expect(ungated).toEqual([]);
  });
});
