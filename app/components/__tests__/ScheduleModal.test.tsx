import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const toastMock = vi.hoisted(() => ({ toast: (..._args: unknown[]) => {} }));
vi.mock("@/app/components/Toast", () => ({ useToast: () => toastMock }));

import ScheduleModal from "@/app/components/ScheduleModal";
import type {
  Employee,
  GeneratedSchedule,
  ScheduleDay,
  ScheduleWarning,
} from "@/lib/workforce/domain";
import { DEFAULT_SCHEDULE_RULES, applyOvertimeAssignments, generateMonthlyScheduleData } from "@/lib/workforce/domain";

/**
 * Two things this view has to get right: telling an "act on this" warning apart
 * from a "the month is full" one, and actually letting the user place leftover
 * overtime without leaving the modal.
 *
 * The fixtures come from the real generator rather than hand-written literals,
 * so the component is always tested against the shape it will really receive.
 */

const EMPLOYEE: Employee = {
  id: "e1", client_id: "c1", name: "J. Alshawakh", phone: null,
  function_title: "Sorteermedewerker", hourly_rate: null, default_working_days: 22,
  active: true, notes: null, created_at: "", updated_at: "",
};

const RULES = { client_id: "c1", ...DEFAULT_SCHEDULE_RULES };

/** The reported case: 20 hours over 2 days → 8 + 8, with 4 left over. */
function generated(total_hours = 20, working_days = 2): GeneratedSchedule {
  return generateMonthlyScheduleData({
    rules: RULES,
    request: { employee_id: "e1", client_id: "c1", year: 2026, month: 6, total_hours, working_days },
    holidays: [],
  });
}

function row(schedule: GeneratedSchedule) {
  return {
    id: "s1", employee_id: "e1", client_id: "c1", year: 2026, month: 6,
    total_hours: schedule.requested_hours, working_days: 2, status: "generated",
    schedule_data: schedule,
    generated_at: "", created_at: "", updated_at: "",
  };
}

/** Records every request; GET returns `body`, PUT returns whatever it is given. */
function mockFetch(body: unknown, putResponse?: unknown) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url), method,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return {
      ok: true, status: 200,
      json: async () => (method === "PUT" ? (putResponse ?? body) : body),
    };
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => { vi.clearAllMocks(); });

/**
 * Render, then point the form at June 2026 — the month the fixtures describe.
 * The modal otherwise defaults to today, and the stored schedule it loads is
 * keyed on the selected period.
 */
function open() {
  const view = render(
    <ScheduleModal clientId="c1" employees={[EMPLOYEE]} initialEmployeeId="e1" open onClose={() => {}} />,
  );
  fireEvent.change(screen.getByLabelText("Month"), { target: { value: "6" } });
  fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2026" } });
  return view;
}

describe("ScheduleModal warnings", () => {
  it("flags leftover overtime as something the user must act on", async () => {
    mockFetch(row(generated()));
    open();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Needs your input")).toBeInTheDocument();
    expect(within(alert).getByText(/4 hours of overtime could not be scheduled/)).toBeInTheDocument();
  });

  it("separates a capacity warning from an action one", async () => {
    // 300 hours over 30 days in a 22-weekday month: the month is genuinely full
    // AND there is leftover to assign, so both blocks appear.
    mockFetch(row(generated(300, 30)));
    open();

    await screen.findByText("Needs your input");
    expect(screen.getByText("Month is full")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(within(alert).queryByText(/eligible weekdays/)).toBeNull();
  });

  it("still renders schedules stored before warnings were classified", async () => {
    const legacy = row(generated());
    legacy.schedule_data = {
      ...legacy.schedule_data,
      warnings: ["Public holidays skipped: Eerste Kerstdag (2026-12-25)."],
      warning_details: undefined as unknown as ScheduleWarning[],
    };
    mockFetch(legacy);
    open();

    await waitFor(() =>
      expect(screen.getByText(/Public holidays skipped/)).toBeInTheDocument());
  });
});

describe("ScheduleModal overtime assignment", () => {
  it("pre-fills the leftover on a date and PUTs it as a full replace", async () => {
    const schedule = generated();
    const lastWorked = schedule.days.filter((d) => d.hours > 0).at(-1)!.date;
    const assigned = applyOvertimeAssignments(schedule, [{ date: lastWorked, hours: 4 }], RULES);
    const calls = mockFetch(row(schedule), row(assigned));
    open();

    // Pre-filled with the whole outstanding amount, on the last worked day.
    const hours = await screen.findByLabelText("Overtime hours");
    expect(hours).toHaveValue(4);
    expect(screen.getByLabelText("Date")).toHaveValue(lastWorked);

    fireEvent.click(screen.getByRole("button", { name: /Save overtime/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/clients/c1/employees/e1/schedule/overtime");
    expect(put.body).toEqual({
      year: 2026, month: 6, assignments: [{ date: lastWorked, hours: 4 }],
    });
  });

  it("lets the user edit the hours before saving", async () => {
    const calls = mockFetch(row(generated()));
    open();

    const hours = await screen.findByLabelText("Overtime hours");
    fireEvent.change(hours, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Save overtime/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body.assignments)
      .toEqual([{ date: expect.any(String), hours: 2.5 }]);
  });

  it("splits the leftover across two dates", async () => {
    const schedule = generated();
    const [first, second] = schedule.days.filter((d) => d.hours > 0).map((d) => d.date);
    const calls = mockFetch(row(schedule));
    open();

    await screen.findByLabelText("Overtime hours");
    fireEvent.change(screen.getByLabelText("Overtime hours"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Add date/i }));

    const dates = screen.getAllByLabelText("Date");
    const allHours = screen.getAllByLabelText("Overtime hours");
    expect(dates).toHaveLength(2);
    fireEvent.change(dates[0], { target: { value: first } });
    fireEvent.change(dates[1], { target: { value: second } });
    fireEvent.change(allHours[1], { target: { value: "2.5" } });

    fireEvent.click(screen.getByRole("button", { name: /Save overtime/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body.assignments).toEqual([
      { date: first, hours: 1.5 },
      { date: second, hours: 2.5 },
    ]);
  });

  it("shows what is still unassigned as the user types", async () => {
    mockFetch(row(generated()));
    open();

    const hours = await screen.findByLabelText("Overtime hours");
    fireEvent.change(hours, { target: { value: "1" } });
    expect(screen.getByText(/3 h still unassigned/)).toBeInTheDocument();

    fireEvent.change(hours, { target: { value: "6" } });
    expect(screen.getByText(/2 h over/)).toBeInTheDocument();
  });

  it("renders an assigned day's Overuren in the table and the totals", async () => {
    const schedule = generated();
    const target = schedule.days.filter((d) => d.hours > 0)[0].date;
    const assigned = applyOvertimeAssignments(schedule, [{ date: target, hours: 4 }], RULES);
    mockFetch(row(assigned));
    open();

    // The assigned day's row now carries 8 regular + 4 overtime, and the day
    // stretches to 21:00 with two breaks.
    const dateCell = await screen.findByText("01-06-2026");
    const tr = dateCell.closest("tr")!;
    expect(within(tr).getByText("8")).toBeInTheDocument();
    expect(within(tr).getByText("4")).toBeInTheDocument();
    expect(within(tr).getByText("21:00")).toBeInTheDocument();
    expect(within(tr).getByText("60")).toBeInTheDocument();

    // …and the footer's Overuren total is no longer a static 0.
    expect(screen.getByText("4 overuren")).toBeInTheDocument();
  });

  it("keeps the form available after assigning, so it can be edited or cleared", async () => {
    const schedule = generated();
    const target = schedule.days.filter((d) => d.hours > 0)[0].date;
    const assigned = applyOvertimeAssignments(schedule, [{ date: target, hours: 4 }], RULES);
    mockFetch(row(assigned));
    open();

    await screen.findByText("Assign overtime");
    expect(screen.getByLabelText("Overtime hours")).toHaveValue(4);
    // Nothing outstanding any more, so no action alert.
    expect(screen.queryByText("Needs your input")).toBeNull();
  });

  it("is absent entirely when the hours fit", async () => {
    mockFetch(row(generated(16, 2)));
    open();

    await screen.findByText("01-06-2026");
    expect(screen.queryByText("Assign overtime")).toBeNull();
  });
});
