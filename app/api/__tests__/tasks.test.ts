import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { GET as listTasks, POST as createTask } from "@/app/api/tasks/route";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { GET as dueReminders } from "@/app/api/tasks/reminders/due/route";
import { isReminderPending } from "@/lib/task-reminders";
import { POST as markReminded } from "@/app/api/tasks/[id]/reminded/route";
import { GET as taskStats } from "@/app/api/tasks/stats/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
});

const SO = { "sec-fetch-site": "same-origin" };

function getReq(url: string) {
  return new NextRequest(url, { headers: SO });
}

function bodyReq(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { ...SO, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("tasks API", () => {
  it("POST creates a dashboard task with reminder metadata", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({
      data: { id: "task-1", title: "Call Ammar", status: "new", priority: "high" },
      error: null,
    });

    const res = await createTask(bodyReq("http://localhost/api/tasks", "POST", {
      title: "Call Ammar",
      priority: "high",
      source: "telegram",
      telegram_chat_id: "123",
      remind_at: "2026-08-05T09:00:00+02:00",
    }));

    expect(res.status).toBe(201);
    const insert = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "insert");
    expect(insert?.args[0]).toMatchObject({
      title: "Call Ammar",
      priority: "high",
      source: "telegram",
      telegram_chat_id: "123",
      status: "new",
    });
    expect((insert?.args[0] as Record<string, unknown>).remind_at).toBe("2026-08-05T07:00:00.000Z");
  });

  it("GET lists tasks with filters", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({ data: [{ id: "task-1", title: "Review export" }], error: null, count: 1 });

    const res = await listTasks(getReq("http://localhost/api/tasks?status=new&priority=urgent&q=export"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.data[0].title).toBe("Review export");

    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "status" && c.args[1] === "new")).toBe(true);
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "priority" && c.args[1] === "urgent")).toBe(true);
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "or" && String(c.args[0]).includes("title.ilike.%export%"))).toBe(true);
  });

  it("PATCH marks done and sets completed_at", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({ data: { id: "task-1", status: "done" }, error: null });

    const res = await patchTask(
      bodyReq("http://localhost/api/tasks/task-1", "PATCH", { status: "done" }),
      params("task-1")
    );
    expect(res.status).toBe(200);
    const update = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "update");
    expect((update?.args[0] as Record<string, unknown>).status).toBe("done");
    expect((update?.args[0] as Record<string, unknown>).completed_at).toEqual(expect.any(String));
  });

  it("GET due reminders returns open reminder tasks", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({
      data: [{ id: "task-1", title: "Call client", telegram_chat_id: "123", remind_at: "2026-08-05T07:00:00Z", reminded_at: null, snoozed_until: null }],
      error: null,
    });

    const res = await dueReminders(getReq("http://localhost/api/tasks/reminders/due?limit=5&now=2026-08-05T08:00:00Z"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "lte" && c.args[0] === "remind_at")).toBe(true);
    // Over-fetches so the pending filter has headroom before trimming to limit.
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "limit" && c.args[0] === 15)).toBe(true);
  });

  it("GET due reminders skips snoozed and already-delivered tasks", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({
      data: [
        // pending: due, never reminded
        { id: "pending", remind_at: "2026-08-05T07:00:00Z", reminded_at: null, snoozed_until: null },
        // already delivered for this remind_at
        { id: "sent", remind_at: "2026-08-05T07:00:00Z", reminded_at: "2026-08-05T07:00:05Z", snoozed_until: null },
        // snoozed into the future
        { id: "snoozed", remind_at: "2026-08-05T07:00:00Z", reminded_at: null, snoozed_until: "2026-08-05T10:00:00Z" },
        // rescheduled after the last reminder went out
        { id: "rescheduled", remind_at: "2026-08-05T07:30:00Z", reminded_at: "2026-08-05T06:00:00Z", snoozed_until: null },
      ],
      error: null,
    });

    const res = await dueReminders(getReq("http://localhost/api/tasks/reminders/due?now=2026-08-05T08:00:00Z"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: { id: string }) => r.id)).toEqual(["pending", "rescheduled"]);
  });

  it("isReminderPending ignores tasks whose reminder is still in the future", () => {
    const now = Date.parse("2026-08-05T08:00:00Z");
    expect(isReminderPending({ remind_at: "2026-08-05T09:00:00Z", reminded_at: null, snoozed_until: null }, now)).toBe(false);
    expect(isReminderPending({ remind_at: null, reminded_at: null, snoozed_until: null }, now)).toBe(false);
    expect(isReminderPending({ remind_at: "2026-08-05T07:59:00Z", reminded_at: null, snoozed_until: null }, now)).toBe(true);
  });

  it("POST reminded records delivery, clears the snooze and stores the message id", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({ data: { id: "task-1", reminder_count: 2, remind_at: "2026-08-05T07:00:00Z" }, error: null });

    const res = await markReminded(
      bodyReq("http://localhost/api/tasks/task-1/reminded", "POST", {
        reminded_at: "2026-08-05T08:00:00Z",
        message_id: 4821,
      }),
      params("task-1")
    );
    expect(res.status).toBe(200);

    const update = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "update");
    expect(update?.args[0]).toMatchObject({
      reminded_at: "2026-08-05T08:00:00.000Z",
      reminder_count: 3,
      remind_at: null,
      snoozed_until: null,
      last_reminder_message_id: "4821",
    });
  });

  it("POST reminded keeps the reminder pending when Telegram delivery failed", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({ data: { id: "task-1", reminder_count: 2, remind_at: "2026-08-05T07:00:00Z" }, error: null });

    const res = await markReminded(
      bodyReq("http://localhost/api/tasks/task-1/reminded", "POST", { error: "chat not found" }),
      params("task-1")
    );
    expect(res.status).toBe(200);

    const update = t._calls.find((c: { method: string; args: unknown[] }) => c.method === "update") as
      | { args: Record<string, unknown>[] }
      | undefined;
    // remind_at must survive so the next poll retries it.
    expect(update?.args[0]).toMatchObject({ remind_at: "2026-08-05T07:00:00Z", last_reminder_error: "chat not found" });
    expect(update?.args[0]).not.toHaveProperty("reminded_at");
    expect(update?.args[0]).not.toHaveProperty("reminder_count");
  });

  it("GET stats returns table-wide counts, not page counts", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({ data: null, error: null, count: 7 });

    const res = await taskStats(getReq("http://localhost/api/tasks/stats?now=2026-08-05T08:00:00Z"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: 7, due: 7, urgent: 7, done: 7 });

    // Counts must not transfer rows.
    expect(t._calls.some((c: { method: string; args: unknown[] }) =>
      c.method === "select" && (c.args[1] as { head?: boolean })?.head === true)).toBe(true);
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "status" && c.args[1] === "done")).toBe(true);
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "priority" && c.args[1] === "urgent")).toBe(true);
  });

  it("GET filters by the reminder message id so a Telegram reply resolves to its task", async () => {
    const t = mockSupabase._table("tasks");
    t._setResult({ data: [{ id: "task-1" }], error: null, count: 1 });

    await listTasks(getReq("http://localhost/api/tasks?telegram_chat_id=123&reminder_message_id=4821"));
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "telegram_chat_id" && c.args[1] === "123")).toBe(true);
    expect(t._calls.some((c: { method: string; args: unknown[] }) => c.method === "eq" && c.args[0] === "last_reminder_message_id" && c.args[1] === "4821")).toBe(true);
  });
});
