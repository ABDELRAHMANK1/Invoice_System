import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { sampleApiInvoiceRow } from "@/__tests__/fixtures/invoices";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { GET } from "@/app/api/invoices/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
});

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { "sec-fetch-site": "same-origin", ...headers } });
}

describe("GET /api/invoices", () => {
  it("returns rows + computed total + pagination metadata", async () => {
    const invoicesTable = mockSupabase._table("invoices");
    invoicesTable._setResult({
      data: [sampleApiInvoiceRow],
      error: null,
      count: 1,
    });

    const res = await GET(req("http://localhost/api/invoices?page=1&limit=20"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.totalPages).toBe(1);
    // total_amount sums the rows from the aggregate query
    expect(typeof body.total_amount).toBe("number");
  });

  it("applies direction filter when ?direction=inkoop", async () => {
    const t = mockSupabase._table("invoices");
    t._setResult({ data: [], error: null, count: 0 });

    await GET(req("http://localhost/api/invoices?direction=inkoop"));

    const eqCalls = t._calls.filter((c: { method: string; args: unknown[] }) =>c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["invoice_direction", "inkoop"] });
  });

  it("applies invoice ilike + client OR-search (company name OR sender phone)", async () => {
    const invoicesT = mockSupabase._table("invoices");
    invoicesT._setResult({ data: [], error: null, count: 0 });
    const clientsT = mockSupabase._table("clients");
    clientsT._setResult({ data: [], error: null });

    await GET(req("http://localhost/api/invoices?client=Nema&invoice=INV-1"));

    // Invoice filter still goes through .ilike directly
    const ilikeCalls = invoicesT._calls.filter((c: { method: string; args: unknown[] }) => c.method === "ilike");
    expect(ilikeCalls).toContainEqual({ method: "ilike", args: ["invoice_number", "%INV-1%"] });

    // Client filter goes through .or() with at minimum a client_name ilike condition
    const orCalls = invoicesT._calls.filter((c: { method: string; args: unknown[] }) => c.method === "or");
    expect(orCalls.length).toBeGreaterThan(0);
    expect(String(orCalls[0]?.args[0])).toContain("client_name.ilike.%Nema%");

    // And the clients table was searched for matching senders
    const clientsIlike = clientsT._calls.filter((c: { method: string; args: unknown[] }) => c.method === "ilike");
    expect(clientsIlike).toContainEqual({ method: "ilike", args: ["name", "%Nema%"] });
  });

  it("uses sort_by and sort_dir from query string", async () => {
    const t = mockSupabase._table("invoices");
    t._setResult({ data: [], error: null, count: 0 });

    await GET(req("http://localhost/api/invoices?sort_by=amount&sort_dir=asc"));

    const orderCalls = t._calls.filter((c: { method: string; args: unknown[] }) =>c.method === "order");
    expect(orderCalls[0]?.args).toEqual(["total_amount", { ascending: true }]);
  });

  it("returns 500 when supabase reports an error", async () => {
    const t = mockSupabase._table("invoices");
    t._setResult({ data: null, error: { message: "boom" }, count: null });

    const res = await GET(req("http://localhost/api/invoices"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("boom");
  });

  it("rejects external requests without an API key (401)", async () => {
    const r = new NextRequest("http://localhost/api/invoices");
    // No sec-fetch-site, no x-api-key
    const res = await GET(r);
    expect(res.status).toBe(401);
  });
});
