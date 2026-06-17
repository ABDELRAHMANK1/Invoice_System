import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mutable navigation state the mocked next/navigation hooks read from.
const nav = vi.hoisted(() => ({ search: "", push: (..._args: unknown[]) => {} }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: (...args: unknown[]) => nav.push(...args) }),
  usePathname: () => "/clients/c1",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/app/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ClientDetailPage from "@/app/(dashboard)/clients/[id]/page";

beforeEach(() => {
  nav.search = "";
  nav.push = vi.fn();
  // The page loads the client (with nested arrays) on mount.
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      id: "c1",
      name: "Akram",
      country: "NL",
      suppliers: [{ id: "s1", client_id: "c1", name: "Buki", active: true }],
      customers: [{ id: "cu1", client_id: "c1", name: "Klant A", active: true }],
    }),
  })) as unknown as typeof fetch;
});

describe("client detail — tab routing", () => {
  it("defaults to the Leveranciers tab when no ?tab is present", async () => {
    nav.search = "";
    render(<ClientDetailPage />);
    const lev = await screen.findByRole("tab", { name: /Leveranciers/ });
    expect(lev).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Klanten/ })).toHaveAttribute("aria-selected", "false");
    // The active tab's primary action is "Add supplier".
    expect(screen.getByRole("button", { name: /Add supplier/i })).toBeInTheDocument();
  });

  it("?tab=klanten activates the Klanten tab", async () => {
    nav.search = "tab=klanten";
    render(<ClientDetailPage />);
    const klanten = await screen.findByRole("tab", { name: /Klanten/ });
    expect(klanten).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Leveranciers/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: /Add customer/i })).toBeInTheDocument();
  });

  it("shows per-tab counts in the labels", async () => {
    nav.search = "";
    render(<ClientDetailPage />);
    expect(await screen.findByRole("tab", { name: /Leveranciers \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Klanten \(1\)/ })).toBeInTheDocument();
  });

  it("clicking the Klanten tab pushes ?tab=klanten to the URL", async () => {
    nav.search = "";
    render(<ClientDetailPage />);
    const klanten = await screen.findByRole("tab", { name: /Klanten/ });
    fireEvent.click(klanten);
    expect(nav.push).toHaveBeenCalledWith("/clients/c1?tab=klanten", { scroll: false });
  });
});
