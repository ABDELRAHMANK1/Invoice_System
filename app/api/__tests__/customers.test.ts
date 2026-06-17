import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { GET as listGet, POST as listPost } from "@/app/api/clients/[id]/customers/route";
import { PATCH, DELETE } from "@/app/api/clients/[id]/customers/[customerId]/route";

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
const params2 = (id: string, customerId: string) => ({ params: Promise.resolve({ id, customerId }) });

describe("customers API", () => {
  it("GET list returns the client's customers ordered by name", async () => {
    mockSupabase._table("customers")._setResult({
      data: [{ id: "cu1", client_id: "c1", name: "Klant A", active: true }],
      error: null,
    });
    const res = await listGet(getReq("http://localhost/api/clients/c1/customers"), params("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].name).toBe("Klant A");
    // scoped to the client
    const t = mockSupabase._table("customers");
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "client_id" && c.args[1] === "c1")).toBe(true);
  });

  it("POST create inserts with client_id and normalises empty email to null", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: "c1" }, error: null });
    const t = mockSupabase._table("customers");
    t._setResult({ data: { id: "cu9", client_id: "c1", name: "Klant Nieuw" }, error: null });

    const res = await listPost(
      bodyReq("http://localhost/api/clients/c1/customers", "POST", { name: "Klant Nieuw", relatie_code: "20001" }),
      params("c1"),
    );
    expect(res.status).toBe(201);
    const insert = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "insert")!;
    const payload = insert.args[0] as Record<string, unknown>;
    expect(payload.client_id).toBe("c1");
    expect(payload.email).toBeNull();
    expect(payload.name).toBe("Klant Nieuw");
  });

  it("POST returns 404 when the client does not exist", async () => {
    mockSupabase._table("clients")._setResult({ data: null, error: null });
    const res = await listPost(
      bodyReq("http://localhost/api/clients/cX/customers", "POST", { name: "Klant Nieuw" }),
      params("cX"),
    );
    expect(res.status).toBe(404);
  });

  it("POST rejects an invalid payload with 400", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: "c1" }, error: null });
    const res = await listPost(
      bodyReq("http://localhost/api/clients/c1/customers", "POST", { name: "" }),
      params("c1"),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH updates the customer scoped to the client", async () => {
    const t = mockSupabase._table("customers");
    t._setResult({ data: { id: "cu1", client_id: "c1", name: "Klant A", city: "Rotterdam" }, error: null });
    const res = await PATCH(
      bodyReq("http://localhost/api/clients/c1/customers/cu1", "PATCH", { city: "Rotterdam" }),
      params2("c1", "cu1"),
    );
    expect(res.status).toBe(200);
    const update = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "update")!;
    expect((update.args[0] as Record<string, unknown>).city).toBe("Rotterdam");
    // scoped by both id and client_id
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "id" && c.args[1] === "cu1")).toBe(true);
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "client_id" && c.args[1] === "c1")).toBe(true);
  });

  it("DELETE returns 204", async () => {
    mockSupabase._table("customers")._setResult({ data: null, error: null });
    const res = await DELETE(getReq("http://localhost/api/clients/c1/customers/cu1"), params2("c1", "cu1"));
    expect(res.status).toBe(204);
  });
});
