import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

// The renderer is exercised by its own layout code, not by these route tests —
// the same stub the invoices route tests use for lib/invoice-pdf.
vi.mock("@/lib/timesheet-pdf", () => ({
  buildTimesheetPdf: vi.fn(async () => Buffer.from("%PDF-1.4 stub")),
}));

import { GET as listGet, POST as listPost } from "@/app/api/clients/[id]/employees/route";
import { PATCH, DELETE } from "@/app/api/clients/[id]/employees/[employeeId]/route";
import { GET as rulesGet, PUT as rulesPut } from "@/app/api/clients/[id]/schedule-rules/route";
import {
  GET as scheduleGet,
  POST as schedulePost,
} from "@/app/api/clients/[id]/employees/[employeeId]/schedule/route";
import { GET as schedulePdfGet } from "@/app/api/clients/[id]/employees/[employeeId]/schedule/pdf/route";

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
  function_title: "Sorteermedewerker",
  hourly_rate: null, default_working_days: 22, active: true, notes: null,
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

  it("POST rejects an out-of-range working-days default", async () => {
    // A MONTH total since migration 013, so 9 is fine and 40 is not.
    const res = await listPost(
      bodyReq("http://localhost/api/clients/c1/employees", "POST", { name: "Jan", default_working_days: 40 }),
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
      client_id: "c1", max_continuous_hours: 4, break_minutes: 30, max_hours_per_day: 8,
      work_start_time: "08:00", work_end_time: "17:00",
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

/* ── monthly schedule (Phase 2) ───────────────────────────────────── */

const SCHEDULE_ROW = {
  id: "s1", employee_id: "e1", client_id: "c1", year: 2026, month: 6,
  total_hours: 40, working_days: 20, status: "generated",
  schedule_data: {
    days: [{
      date: "2026-06-01", weekday: 1, day_name: "Maandag", kind: "worked",
      holiday_name: null, start: "08:00", end: "10:00", break_minutes: 0, hours: 2,
    }],
    totals: { hours: 40, overtime_hours: 0, km_allowance: 0, worked_days: 20 },
    warnings: [],
  },
  generated_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

describe("monthly schedule API", () => {
  function seedGenerationTables() {
    mockSupabase._table("employees")._setResult({ data: EMPLOYEE_ROW, error: null });
    mockSupabase._table("clients")._setResult({ data: { id: "c1", name: "Spik&Span", default_hourly_rate: 18 }, error: null });
    mockSupabase._table("client_schedule_rules")._setResult({ data: null, error: null }); // defaults
    mockSupabase._table("public_holidays")._setResult({ data: [], error: null });
    mockSupabase._table("employee_monthly_schedules")._setResult({ data: SCHEDULE_ROW, error: null });
  }

  it("POST generates the month and upserts it on (employee, year, month)", async () => {
    seedGenerationTables();
    const t = mockSupabase._table("employee_monthly_schedules");

    const res = await schedulePost(
      bodyReq("http://localhost/api/clients/c1/employees/e1/schedule", "POST",
              { year: 2026, month: 6, total_hours: 160, working_days: 20 }),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(201);

    const upsert = t._calls.find((c: Call) => c.method === "upsert")!;
    const written = upsert.args[0] as { client_id: string; status: string; schedule_data: { days: unknown[]; totals: { hours: number; worked_days: number } } };
    expect(written).toMatchObject({ client_id: "c1", employee_id: "e1", year: 2026, month: 6, status: "generated" });
    // June 2026 has 30 days, and the requested hours reconcile exactly.
    expect(written.schedule_data.days).toHaveLength(30);
    expect(written.schedule_data.totals.hours).toBe(160);
    // The requested 20 days land as 20 worked days in the totals.
    expect(written.schedule_data.totals.worked_days).toBe(20);
    expect((upsert.args[1] as { onConflict: string }).onConflict).toBe("employee_id,year,month");
  });

  it("POST falls back to the employee's default_working_days", async () => {
    seedGenerationTables();
    const t = mockSupabase._table("employee_monthly_schedules");

    await schedulePost(
      bodyReq("http://localhost/api/clients/c1/employees/e1/schedule", "POST",
              { year: 2026, month: 6, total_hours: 80 }),
      params2("c1", "e1"),
    );
    const upsert = t._calls.find((c: Call) => c.method === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ working_days: EMPLOYEE_ROW.default_working_days });
  });

  it("POST 404s for an employee of another client", async () => {
    mockSupabase._table("employees")._setResult({ data: null, error: null });
    const res = await schedulePost(
      bodyReq("http://localhost/api/clients/c1/employees/e1/schedule", "POST",
              { year: 2026, month: 6, total_hours: 160 }),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(404);
  });

  it("POST rejects an out-of-range month", async () => {
    const res = await schedulePost(
      bodyReq("http://localhost/api/clients/c1/employees/e1/schedule", "POST",
              { year: 2026, month: 13, total_hours: 160 }),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(400);
  });

  it("GET requires a year and a month", async () => {
    const res = await scheduleGet(
      getReq("http://localhost/api/clients/c1/employees/e1/schedule"),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(400);
  });

  it("GET returns the stored schedule, and 404s when the month has none", async () => {
    mockSupabase._table("employees")._setResult({ data: EMPLOYEE_ROW, error: null });
    mockSupabase._table("employee_monthly_schedules")._setResult({ data: SCHEDULE_ROW, error: null });
    const ok = await scheduleGet(
      getReq("http://localhost/api/clients/c1/employees/e1/schedule?year=2026&month=6"),
      params2("c1", "e1"),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ year: 2026, month: 6, status: "generated" });

    mockSupabase._table("employee_monthly_schedules")._setResult({ data: null, error: null });
    const missing = await scheduleGet(
      getReq("http://localhost/api/clients/c1/employees/e1/schedule?year=2027&month=1"),
      params2("c1", "e1"),
    );
    expect(missing.status).toBe(404);
  });

  it("PDF streams the rendered timesheet as an attachment", async () => {
    mockSupabase._table("employees")._setResult({ data: EMPLOYEE_ROW, error: null });
    mockSupabase._table("clients")._setResult({ data: { name: "Spik&Span" }, error: null });
    mockSupabase._table("employee_monthly_schedules")._setResult({ data: SCHEDULE_ROW, error: null });

    const res = await schedulePdfGet(
      getReq("http://localhost/api/clients/c1/employees/e1/schedule/pdf?year=2026&month=6"),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("Urenlijst Juni 2026");
  });

  it("PDF refuses a schedule that has no generated days", async () => {
    mockSupabase._table("employees")._setResult({ data: EMPLOYEE_ROW, error: null });
    mockSupabase._table("clients")._setResult({ data: { name: "Spik&Span" }, error: null });
    mockSupabase._table("employee_monthly_schedules")._setResult({
      data: { ...SCHEDULE_ROW, schedule_data: {} }, error: null,
    });

    const res = await schedulePdfGet(
      getReq("http://localhost/api/clients/c1/employees/e1/schedule/pdf?year=2026&month=6"),
      params2("c1", "e1"),
    );
    expect(res.status).toBe(409);
  });
});
