import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mutable navigation state the mocked next/navigation hooks read from.
const nav = vi.hoisted(() => ({ search: "", push: (..._args: unknown[]) => {} }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: (...args: unknown[]) => nav.push(...args) }),
  usePathname: () => "/clients/c1",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// One stable object: `useToast()` returning a fresh object per render would
// change the identity of the page's `load` useCallback on every render, so its
// mount effect would re-fire forever.
const toastMock = vi.hoisted(() => ({ toast: (..._args: unknown[]) => {} }));
vi.mock("@/app/components/Toast", () => ({ useToast: () => toastMock }));

import ClientDetailPage from "@/app/(dashboard)/clients/[id]/page";

const JAN = {
  id: "e1", client_id: "c1", name: "Jan de Vries", phone: null, hourly_rate: null,
  default_days_per_week: 5, active: true, notes: null, created_at: "", updated_at: "",
};
const ALI = {
  id: "e2", client_id: "c1", name: "Ali", phone: null, hourly_rate: 25,
  default_days_per_week: 4, active: true, notes: null, created_at: "", updated_at: "",
};

const clientPayload = () => ({
  id: "c1",
  name: "Akram",
  country: "NL",
  default_hourly_rate: 18,
  suppliers: [{ id: "s1", client_id: "c1", name: "Buki", active: true }],
  customers: [{ id: "cu1", client_id: "c1", name: "Klant A", active: true }],
  employees: [JAN, ALI],
});

/** Records every request; the initial client GET always succeeds. */
function mockFetch(onPatch?: (body: Record<string, unknown>) => { ok: boolean; body?: unknown }) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), method, body });
    if (method === "PATCH" && onPatch) {
      const res = onPatch(body);
      return { ok: res.ok, status: res.ok ? 200 : 400, json: async () => res.body ?? { error: "Update failed" } };
    }
    return { ok: true, status: 200, json: async () => clientPayload() };
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  nav.search = "";
  nav.push = vi.fn();
  // The page loads the client (with nested arrays) on mount.
  mockFetch();
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

  it("clicking the Employees tab pushes ?tab=employees to the URL", async () => {
    nav.search = "";
    render(<ClientDetailPage />);
    const employees = await screen.findByRole("tab", { name: /Employees \(2\)/ });
    fireEvent.click(employees);
    expect(nav.push).toHaveBeenCalledWith("/clients/c1?tab=employees", { scroll: false });
  });
});

describe("client detail — employees tab", () => {
  it("marks an own rate as an override and a missing one as inherited", async () => {
    nav.search = "tab=employees";
    render(<ClientDetailPage />);
    expect(await screen.findByRole("tab", { name: /Employees/ })).toHaveAttribute("aria-selected", "true");

    // Jan has no override → empty box, and the client's 18 shown as the
    // placeholder it inherits. Ali overrides with 25.
    const janRate = screen.getByLabelText("Hourly rate of Jan de Vries");
    expect(janRate).toHaveValue(null);
    expect(janRate).toHaveAttribute("placeholder", "18,00");
    expect(screen.getByText("inherited")).toBeInTheDocument();
    expect(screen.getByLabelText("Hourly rate of Ali")).toHaveValue(25);
    expect(screen.getByText("override")).toBeInTheDocument();
  });

  it("every column of a row is editable in place", async () => {
    nav.search = "tab=employees";
    render(<ClientDetailPage />);
    await screen.findByLabelText("Name of Ali");
    for (const label of [
      "Name of Ali", "Phone of Ali", "Hourly rate of Ali",
      "Days per week of Ali", "Notes for Ali", "Status of Ali",
    ]) {
      expect(screen.getByLabelText(label)).toBeEnabled();
    }
  });

  it("shows the schedule generator as disabled — Phase 2 is not built", async () => {
    nav.search = "tab=employees";
    render(<ClientDetailPage />);
    const btn = await screen.findByRole("button", { name: /Generate monthly schedule/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", expect.stringMatching(/coming soon/i));
  });
});

describe("client detail — inline employee editing", () => {
  beforeEach(() => { nav.search = "tab=employees"; });

  it("commits an edited rate on blur and PATCHes just that field", async () => {
    const calls = mockFetch((body) => ({ ok: true, body: { ...ALI, ...body } }));
    render(<ClientDetailPage />);

    const rate = await screen.findByLabelText("Hourly rate of Ali");
    fireEvent.change(rate, { target: { value: "30" } });
    fireEvent.blur(rate);

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/clients/c1/employees/e2");
    expect(patch.body).toEqual({ hourly_rate: 30 });
    await waitFor(() => expect(screen.getByLabelText("Hourly rate of Ali")).toHaveValue(30));
  });

  it("clearing the rate sends null and flips the badge back to inherited", async () => {
    const calls = mockFetch((body) => ({ ok: true, body: { ...ALI, ...body } }));
    render(<ClientDetailPage />);

    const rate = await screen.findByLabelText("Hourly rate of Ali");
    fireEvent.change(rate, { target: { value: "" } });
    fireEvent.blur(rate);

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ hourly_rate: null });
    // Both rows now inherit, so there are two badges and no override left.
    await waitFor(() => expect(screen.getAllByText("inherited")).toHaveLength(2));
    expect(screen.queryByText("override")).not.toBeInTheDocument();
  });

  it("reverts the row when the PATCH fails", async () => {
    const calls = mockFetch(() => ({ ok: false }));
    render(<ClientDetailPage />);

    const name = await screen.findByLabelText("Name of Ali");
    fireEvent.change(name, { target: { value: "Ali Yilmaz" } });
    fireEvent.blur(name);

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    // Optimistic value is rolled back to what the server still holds.
    await waitFor(() => expect(screen.getByLabelText("Name of Ali")).toHaveValue("Ali"));
  });

  it("rejects an invalid edit locally without calling the API", async () => {
    const calls = mockFetch(() => ({ ok: true, body: ALI }));
    render(<ClientDetailPage />);

    const days = await screen.findByLabelText("Days per week of Ali");
    fireEvent.change(days, { target: { value: "9" } });   // cap is 7
    fireEvent.blur(days);

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.getByLabelText("Days per week of Ali")).toHaveValue(4);

    const name = await screen.findByLabelText("Name of Ali");
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.blur(name);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.getByLabelText("Name of Ali")).toHaveValue("Ali");
  });

  it("Escape abandons the draft and blurring an unchanged cell sends nothing", async () => {
    const calls = mockFetch(() => ({ ok: true, body: ALI }));
    render(<ClientDetailPage />);

    const notes = await screen.findByLabelText("Notes for Ali");
    fireEvent.change(notes, { target: { value: "typed then abandoned" } });
    fireEvent.keyDown(notes, { key: "Escape" });
    fireEvent.blur(notes);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.getByLabelText("Notes for Ali")).toHaveValue("");

    fireEvent.blur(screen.getByLabelText("Phone of Ali"));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("the status dropdown PATCHes active straight away", async () => {
    const calls = mockFetch((body) => ({ ok: true, body: { ...ALI, ...body } }));
    render(<ClientDetailPage />);

    fireEvent.change(await screen.findByLabelText("Status of Ali"), { target: { value: "inactive" } });

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ active: false });
  });
});
