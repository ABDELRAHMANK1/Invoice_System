import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { GET as listGet, POST as listPost } from "@/app/api/clients/route";
import { GET as getOne, PATCH, DELETE } from "@/app/api/clients/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
});

const SO = { "sec-fetch-site": "same-origin" };
function getReq(url: string) {
  return new NextRequest(url, { headers: SO });
}
function bodyReq(url: string, method: string, body: unknown) {
  return new NextRequest(url, { method, headers: { ...SO, "content-type": "application/json" }, body: JSON.stringify(body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("clients API", () => {
  it("GET list returns paginated data", async () => {
    mockSupabase._table("clients")._setResult({ data: [{ id: "c1", name: "Akram" }], error: null, count: 1 });
    const res = await listGet(getReq("http://localhost/api/clients"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.data[0].name).toBe("Akram");
  });

  it("POST create accepts iban and inserts it", async () => {
    const t = mockSupabase._table("clients");
    t._setResult({ data: { id: "c9", name: "New BV", iban: "NL00 BANK 0000" }, error: null });
    const res = await listPost(bodyReq("http://localhost/api/clients", "POST", {
      name: "New BV", iban: "NL00 BANK 0000", kvk_number: "12345678",
    }));
    expect(res.status).toBe(201);
    const insert = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "insert")!;
    expect((insert.args[0] as Record<string, unknown>).iban).toBe("NL00 BANK 0000");
  });

  it("GET :id nests both the client's suppliers and customers", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: "c1", name: "Akram", iban: "NL00" }, error: null });
    mockSupabase._table("suppliers")._setResult({
      data: [{ id: "s1", client_id: "c1", name: "Buki", active: true }],
      error: null,
    });
    mockSupabase._table("customers")._setResult({
      data: [{ id: "cu1", client_id: "c1", name: "Klant A", active: true }],
      error: null,
    });
    const res = await getOne(getReq("http://localhost/api/clients/c1"), params("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("c1");
    expect(Array.isArray(body.suppliers)).toBe(true);
    expect(body.suppliers[0].name).toBe("Buki");
    expect(Array.isArray(body.customers)).toBe(true);
    expect(body.customers[0].name).toBe("Klant A");
  });

  it("PATCH updates iban", async () => {
    const t = mockSupabase._table("clients");
    t._setResult({ data: { id: "c1", name: "Akram", iban: "NL22" }, error: null });
    const res = await PATCH(bodyReq("http://localhost/api/clients/c1", "PATCH", { iban: "NL22" }), params("c1"));
    expect(res.status).toBe(200);
    const update = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "update")!;
    expect((update.args[0] as Record<string, unknown>).iban).toBe("NL22");
  });

  it("DELETE returns 204", async () => {
    mockSupabase._table("clients")._setResult({ data: null, error: null });
    const res = await DELETE(getReq("http://localhost/api/clients/c1"), params("c1"));
    expect(res.status).toBe(204);
  });
});
