import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { sampleApiInvoiceRow } from "@/__tests__/fixtures/invoices";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

// PDF rendering + S3 upload are side effects; stub them so the create test
// exercises validation + server-side totals without touching pdfkit / AWS.
vi.mock("@/lib/invoice-pdf", () => ({ buildInvoicePdf: vi.fn(async () => Buffer.from("%PDF-1.4 stub")) }));
vi.mock("@/lib/storage", () => ({ uploadBuffer: vi.fn(async () => "s3://bucket/generated-invoices/x.pdf") }));

import { GET, POST } from "@/app/api/invoices/route";

const CID = "11111111-1111-1111-1111-111111111111";
const SID = "22222222-2222-2222-2222-222222222222";

// Seed clients + suppliers so a manual create can resolve them.
function seedClientAndSupplier() {
  mockSupabase._table("clients")._setResult({
    data: { id: CID, name: "Akram Transport B.V.", phone_number: "+31600000000", iban: "NL00", address: "Govert Flinckstraat 18" },
    error: null,
  });
  mockSupabase._table("suppliers")._setResult({
    data: { id: SID, client_id: CID, name: "Buki Koeriers B.V.", relatie_code: "4", iban: "NL91", btw_number: "NL8", kvk: "931" },
    error: null,
  });
}
const validBody = {
  invoice_number: "M-100",
  client_id: CID,
  supplier_id: SID,
  date: "2026-06-16",
  delivery_date: "2026-06-16",
  description: "Factuur M-100",
  btw_rate: 21,
  line_items: [
    { description: "RT TWB 1205", quantity: 22.5, unit_price: 30 },
    { description: "RT TWB 1316", quantity: 16.33, unit_price: 30 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
});

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { "sec-fetch-site": "same-origin", ...headers } });
}

function postReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/invoices", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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

describe("POST /api/invoices (manual create, inkoop)", () => {
  it("creates an invoice with server-computed totals + denormalised names, returns {id, invoice_number, file_url}", async () => {
    seedClientAndSupplier();
    const t = mockSupabase._table("invoices");
    t._setResult({ data: { id: "inv1", invoice_number: "M-100" }, error: null });

    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "inv1", invoice_number: "M-100", file_url: "s3://bucket/generated-invoices/x.pdf" });

    const insert = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "insert")!;
    const row = insert.args[0] as Record<string, unknown>;
    // Server-side totals (22.5*30 + 16.33*30 = 1164.90; 21% → 244.62; total 1409.52)
    expect(row.subtotal).toBe(1164.9);
    expect(row.btw_amount).toBe(244.62);
    expect(row.total_amount).toBe(1409.52);
    expect(row.btw_rate).toBe(21);
    expect(row.invoice_direction).toBe("inkoop");      // hardcoded
    expect(row.client_id).toBe(CID);
    expect(row.supplier_id).toBe(SID);
    expect(row.client_name).toBe("Akram Transport B.V.");   // denormalised
    expect(row.supplier_name).toBe("Buki Koeriers B.V.");
    expect(Array.isArray(row.line_items)).toBe(true);
    expect((row.line_items as unknown[]).length).toBe(2);
  });

  it("recomputes totals server-side and ignores any client-sent totals", async () => {
    seedClientAndSupplier();
    mockSupabase._table("invoices")._setResult({ data: { id: "inv2", invoice_number: "M-2" }, error: null });
    const res = await POST(postReq({
      ...validBody, invoice_number: "M-2",
      subtotal: 1, btw_amount: 1, total_amount: 1,        // attacker-supplied — must be ignored
    }));
    expect(res.status).toBe(201);
    const row = mockSupabase._table("invoices")._calls.find((c: { method: string; args: unknown[] }) => c.method === "insert")!.args[0] as Record<string, unknown>;
    expect(row.total_amount).toBe(1409.52);
  });

  it("rejects a missing client_id with 400", async () => {
    const { client_id, ...noClient } = validBody;     // eslint-disable-line @typescript-eslint/no-unused-vars
    const res = await POST(postReq(noClient));
    expect(res.status).toBe(400);
  });

  it("rejects when the supplier does not belong to the client (400)", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: CID, name: "Akram" }, error: null });
    mockSupabase._table("suppliers")._setResult({ data: { id: SID, client_id: "99999999-9999-9999-9999-999999999999", name: "X" }, error: null });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
  });

  it("404s when the client is not found", async () => {
    mockSupabase._table("clients")._setResult({ data: null, error: null });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
  });

  it("maps a duplicate invoice_number (23505) to 409", async () => {
    seedClientAndSupplier();
    mockSupabase._table("invoices")._setResult({ data: null, error: { code: "23505", message: "duplicate key" } });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(409);
  });
});
