import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { GET as listGet, POST as listPost } from "@/app/api/clients/[id]/employees/route";
import { PATCH, DELETE } from "@/app/api/clients/[id]/employees/[employeeId]/route";
import { GET as rulesGet, PUT as rulesPut } from "@/app/api/clients/[id]/schedule-rules/route";

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
const params2 = (id: string, employeeId: string) => ({ params: Promise.resolve({ id, employeeId }) });
type Call = { method: string; args: unknown[] };

const EMPLOYEE_ROW = {
  id: "e1", client_id: "c1", name: "Jan de Vries", phone: null,
  hourly_rate: null, default_days_per_week: 5, active: true, notes: null,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

describe("employees API", () => {
  it("GET list scopes to the client and resolves the inherited rate", async () => {
    mockSupabase._table("employees")._setResult({ data: [EMPLOYEE_ROW], error: null });
    mockSupabase._table("clients")._setResult({ data: { default_hourly_rate: 18.5 }, error: null });

    const res = await listGet(getReq("http://localhost/api/clients/c1/employees"), params("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].effective_hourly_rate).toEqual({ rate: 18.5, source: "client" });

    const t = mockSupabase._table("employees");
    expect(t._calls.some((c: Call) => c.method === "eq" && c.args[0] === "client_id" && c.args[1] === "c1")).toBe(true);
  });

  it("GET list?active=1 filters on active", async () => {
    mockSupabase._table("employees")._setResult({ data: [], error: null });
    mockSupabase._table("clients")._setResult({ data: { default_hourly_rate: null }, error: null });

    await listGet(getReq("http://localhost/api/clients/c1/employees?active=1"), params("c1"));
    const t = mockSupabase._table("employees");
    expect(t._calls.some((c: Call) => c.method === "eq" && c.args[0] === "active" && c.args[1] === true)).toBe(true);
  });

  it("POST create inserts with client_id and reports the override as the source", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: "c1", default_hourly_rate: 18 }, error: null });
    const t = mockSupabase._table("employees");
    t._setResult({ data: { ...EMPLOYEE_ROW, id: "e9", hourly_rate: 25 }, error: null });

    const res = await listPost(
      bodyReq("http://localhost/api/clients/c1/employees", "POST", { name: "Jan de Vries", hourly_rate: 25 }),
      params("c1"),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.effective_hourly_rate).toEqual({ rate: 25, source: "employee" });

    const insert = t._calls.find((c: Call) => c.method === "insert")!;
    expect(insert.args[0]).toMatchObject({ client_id: "c1", name: "Jan de Vries", hourly_rate: 25 });
  });

  it("POST returns 404 when the client does not exist", async () => {
    mockSupabase._table("clients")._setResult({ data: null, error: null });
    const res = await listPost(
      bodyReq("http://localhost/api/clients/cX/employees", "POST", { name: "Jan" }),
      params("cX"),
    );
    expect(res.status).toBe(404);
  });

  it("POST rejects an out-of-range days-per-week", async () => {
    const res = await listPost(
      bodyReq("http://localhost/api/clients/c1/employees", "POST", { name: "Jan", default_days_per_week: 9 }),
      params("c1"),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH clears the override with an explicit null", async () => {
    const t = mockSupabase._table("employees");
    t._setResult({ data: { ...EMPLOYEE_ROW, hourly_rate: null }, error: null });
    mockSupabase._table("clients")._setResult({ data: { default_hourly_rate: 18 }, error: null });

    const res = await PATCH(
      bodyReq("http://localhost/api/clients/c1/employees/e1", "PATCH", { hourly_rate: null }),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(200);
    const update = t._calls.find((c: Call) => c.method === "update")!;
    expect(update.args[0]).toMatchObject({ hourly_rate: null });
    expect(await res.json().then((b) => b.effective_hourly_rate)).toEqual({ rate: 18, source: "client" });
  });

  it("PATCH 404s when the employee belongs to another client", async () => {
    mockSupabase._table("employees")._setResult({ data: null, error: null });
    const res = await PATCH(
      bodyReq("http://localhost/api/clients/c1/employees/e1", "PATCH", { name: "X" }),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(404);
  });

  it("DELETE is scoped to both ids and returns 204", async () => {
    const t = mockSupabase._table("employees");
    t._setResult({ data: EMPLOYEE_ROW, error: null });
    const res = await DELETE(getReq("http://localhost/api/clients/c1/employees/e1"), params2("c1", "e1"));
    expect(res.status).toBe(204);
    expect(t._calls.some((c: Call) => c.method === "delete")).toBe(true);
    expect(t._calls.some((c: Call) => c.method === "eq" && c.args[0] === "client_id" && c.args[1] === "c1")).toBe(true);
  });
});

describe("schedule rules API", () => {
  it("GET returns the defaults when the client has saved none", async () => {
    mockSupabase._table("client_schedule_rules")._setResult({ data: null, error: null });
    const res = await rulesGet(getReq("http://localhost/api/clients/c1/schedule-rules"), params("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      client_id: "c1", max_continuous_hours: 4, break_minutes: 30, max_hours_per_day: 10,
    });
  });

  it("PUT upserts the rules for the client", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: "c1" }, error: null });
    const t = mockSupabase._table("client_schedule_rules");
    t._setResult({ data: { client_id: "c1", max_continuous_hours: 5, break_minutes: 45, max_hours_per_day: 9 }, error: null });

    const res = await rulesPut(
      bodyReq("http://localhost/api/clients/c1/schedule-rules", "PUT",
              { max_continuous_hours: 5, break_minutes: 45, max_hours_per_day: 9 }),
      params("c1"),
    );
    expect(res.status).toBe(200);
    const upsert = t._calls.find((c: Call) => c.method === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ client_id: "c1", break_minutes: 45 });
  });

  it("PUT rejects a break threshold longer than the daily cap", async () => {
    const res = await rulesPut(
      bodyReq("http://localhost/api/clients/c1/schedule-rules", "PUT",
              { max_continuous_hours: 12, break_minutes: 30, max_hours_per_day: 10 }),
      params("c1"),
    );
    expect(res.status).toBe(400);
  });
});
