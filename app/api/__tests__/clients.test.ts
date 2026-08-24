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
import { GET as byWhatsapp } from "@/app/api/clients/by-whatsapp/route";

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

describe("GET /api/clients/by-whatsapp", () => {
  const url = (phone: string) => `http://localhost/api/clients/by-whatsapp?phone=${phone}`;

  // A full client row as the DB returns it, whatsapp_phone included.
  const clientRow = (over: Record<string, unknown> = {}) => ({
    id: "c1", name: "Akram", address: "Govert Flinckstraat 18", postcode: "3021 AB",
    city: "Rotterdam", phone_number: null, email: "info@akram.nl", iban: "NL00BANK",
    btw_number: "NL8123", kvk_number: "12345678", relatie_code: "40",
    whatsapp_phone: "+31 6-12 34 56 78", ...over,
  });

  it("matches whatsapp_phone despite formatting differences", async () => {
    mockSupabase._table("clients")._setResult({ data: [clientRow()], error: null });
    mockSupabase._table("customers")._setResult({ data: [], error: null });
    const res = await byWhatsapp(getReq(url("31612345678")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.client_id).toBe("c1");
  });

  it("returns the full client object without leaking whatsapp_phone", async () => {
    mockSupabase._table("clients")._setResult({ data: [clientRow()], error: null });
    mockSupabase._table("customers")._setResult({ data: [], error: null });
    const body = await (await byWhatsapp(getReq(url("31612345678")))).json();
    expect(Object.keys(body.client).sort()).toEqual([
      "address", "btw_number", "city", "email", "iban", "id", "kvk_number",
      "name", "phone_number", "postcode", "relatie_code",
    ]);
    expect(body.client.kvk_number).toBe("12345678");
    expect(body.client).not.toHaveProperty("whatsapp_phone");
  });

  it("keeps the top-level client_id / name / relatie_code the n8n node reads", async () => {
    mockSupabase._table("clients")._setResult({ data: [clientRow()], error: null });
    mockSupabase._table("customers")._setResult({ data: [], error: null });
    const body = await (await byWhatsapp(getReq(url("31612345678")))).json();
    expect(body.client_id).toBe("c1");
    expect(body.name).toBe("Akram");
    expect(body.relatie_code).toBe("40");
  });

  it("returns the client's active customers, ordered by name", async () => {
    mockSupabase._table("clients")._setResult({ data: [clientRow()], error: null });
    const cust = mockSupabase._table("customers");
    cust._setResult({
      data: [{
        id: "cu1", name: "Albert Heijn", address: "Hoofdweg 1", postcode: "1000 AA",
        city: "Amsterdam", btw_number: "NL5", kvk: "87654321", relatie_code: "7", btw_rate: 9,
        btw_verlegd: false, pricing_model: "per_uur", default_rate: 32.5,
        payment_days: 14, aliases: ["AH"], message_pattern: null,
      }],
      error: null,
    });
    const body = await (await byWhatsapp(getReq(url("31612345678")))).json();
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]).toMatchObject({ id: "cu1", kvk: "87654321", btw_rate: 9, payment_days: 14, aliases: ["AH"] });

    const calls = cust._calls as { method: string; args: unknown[] }[];
    expect(calls.find((c) => c.method === "eq" && c.args[0] === "client_id")!.args[1]).toBe("c1");
    expect(calls.find((c) => c.method === "eq" && c.args[0] === "active")!.args[1]).toBe(true);
    expect(calls.find((c) => c.method === "order")!.args).toEqual(["name", { ascending: true }]);
    // customers.kvk, NOT kvk_number — the two tables name this column differently.
    const select = calls.find((c) => c.method === "select")!.args[0] as string;
    expect(select).toContain("kvk,");
    expect(select).not.toContain("kvk_number");
    expect(select).toContain("btw_verlegd");
    expect(select).toContain("message_pattern");
  });

  it("500s when the customer lookup fails instead of reporting no customers", async () => {
    mockSupabase._table("clients")._setResult({ data: [clientRow()], error: null });
    mockSupabase._table("customers")._setResult({ data: null, error: { message: "boom" } });
    const res = await byWhatsapp(getReq(url("31612345678")));
    expect(res.status).toBe(500);
  });

  it("falls back to phone_number when whatsapp_phone is unset", async () => {
    mockSupabase._table("clients")._setResult({
      data: [clientRow({ id: "c2", name: "Buki", relatie_code: null, whatsapp_phone: null, phone_number: "+31612345678" })],
      error: null,
    });
    mockSupabase._table("customers")._setResult({ data: [], error: null });
    const body = await (await byWhatsapp(getReq(url("31612345678")))).json();
    expect(body.client_id).toBe("c2");
    expect(body.relatie_code).toBeNull();
  });

  it("prefers the whatsapp_phone match over a phone_number match", async () => {
    mockSupabase._table("clients")._setResult({
      data: [
        { id: "c1", name: "Phone only", relatie_code: "1", whatsapp_phone: null, phone_number: "0031612345678" },
        { id: "c2", name: "WhatsApp", relatie_code: "2", whatsapp_phone: "31612345678", phone_number: null },
      ],
      error: null,
    });
    const body = await (await byWhatsapp(getReq(url("31612345678")))).json();
    expect(body.client_id).toBe("c2");
  });

  it("returns found:false with HTTP 200 for an unknown sender", async () => {
    mockSupabase._table("clients")._setResult({ data: [], error: null });
    const res = await byWhatsapp(getReq(url("31699999999")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });
  });

  it("rejects a loose ilike candidate that is not a digits-only equal", async () => {
    // "0031612345678" contains the queried digits in order, so the ilike
    // pattern lets it through — digits-only equality must still reject it.
    mockSupabase._table("clients")._setResult({
      data: [{ id: "c9", name: "Other", relatie_code: "9", whatsapp_phone: "0031612345678", phone_number: null }],
      error: null,
    });
    expect(await (await byWhatsapp(getReq(url("31612345678")))).json()).toEqual({ found: false });
  });

  it("400s when phone is missing or has no digits", async () => {
    expect((await byWhatsapp(getReq("http://localhost/api/clients/by-whatsapp"))).status).toBe(400);
    expect((await byWhatsapp(getReq(url("%2B%2B")))).status).toBe(400);
  });

  it("queries both columns and never writes", async () => {
    const t = mockSupabase._table("clients");
    t._setResult({ data: [], error: null });
    await byWhatsapp(getReq(url("31612345678")));
    const or = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "or")!;
    expect(or.args[0]).toContain("whatsapp_phone.ilike.");
    expect(or.args[0]).toContain("phone_number.ilike.");
    const writes = t._calls.filter((c: { method: string }) =>
      ["insert", "update", "delete", "upsert"].includes(c.method));
    expect(writes).toHaveLength(0);
  });
});
