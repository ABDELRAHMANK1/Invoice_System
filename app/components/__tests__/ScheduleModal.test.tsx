import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const toastMock = vi.hoisted(() => ({ toast: (..._args: unknown[]) => {} }));
vi.mock("@/app/components/Toast", () => ({ useToast: () => toastMock }));

import ScheduleModal from "@/app/components/ScheduleModal";
import type { Employee, ScheduleDay, ScheduleWarning } from "@/lib/workforce/domain";

/**
 * The generated-schedule view has to let the reader tell two things apart at a
 * glance: "the numbers you typed look wrong" and "the month is genuinely full".
 * These render the modal against a stored schedule carrying both.
 */

const EMPLOYEE: Employee = {
  id: "e1", client_id: "c1", name: "J. Alshawakh", phone: null,
  function_title: "Sorteermedewerker", hourly_rate: null, default_working_days: 22,
  active: true, notes: null, created_at: "", updated_at: "",
};

const DAY: ScheduleDay = {
  date: "2026-06-01", weekday: 1, day_name: "Maandag", kind: "worked",
  holiday_name: null, start: "08:00", end: "15:00", break_minutes: 30, hours: 6.67,
};

const INPUT_WARNING: ScheduleWarning = {
  code: "input_exceeds_daily_cap",
  kind: "input",
  message: "20 hours over 2 working days averages 10 hours/day, above the 8 h/day maximum — please confirm these numbers are correct.",
};
const CAPACITY_WARNING: ScheduleWarning = {
  code: "hours_unplaced",
  kind: "capacity",
  message: "24.00 hours could not be scheduled: the month has only 22 eligible working days at 8 h/day.",
};
const INFO_WARNING: ScheduleWarning = {
  code: "days_expanded",
  kind: "info",
  message: "1 extra working day added beyond the 2 requested.",
};

function scheduleWith(warning_details: ScheduleWarning[]) {
  return {
    id: "s1", employee_id: "e1", client_id: "c1", year: 2026, month: 6,
    total_hours: 20, working_days: 2, status: "generated",
    schedule_data: {
      days: [DAY],
      totals: { hours: 20, overtime_hours: 0, km_allowance: 0, worked_days: 3 },
      warnings: warning_details.map((w) => w.message),
      warning_details,
    },
    generated_at: "", created_at: "", updated_at: "",
  };
}

/** The modal loads any existing schedule for the period on open. */
function mockFetch(body: unknown) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

beforeEach(() => { vi.clearAllMocks(); });

function open() {
  return render(
    <ScheduleModal clientId="c1" employees={[EMPLOYEE]} initialEmployeeId="e1" open onClose={() => {}} />,
  );
}

describe("ScheduleModal warnings", () => {
  it("separates an input warning from a capacity warning under distinct headings", async () => {
    mockFetch(scheduleWith([INPUT_WARNING, CAPACITY_WARNING]));
    open();

    const inputBlock = await screen.findByRole("alert");
    expect(within(inputBlock).getByText("Check the input")).toBeInTheDocument();
    expect(within(inputBlock).getByText(/averages 10 hours\/day/)).toBeInTheDocument();
    // The capacity note is a different block, not inside the input alert.
    expect(within(inputBlock).queryByText(/could not be scheduled/)).toBeNull();

    expect(screen.getByText("Month is full")).toBeInTheDocument();
    expect(screen.getByText(/24.00 hours could not be scheduled/)).toBeInTheDocument();
  });

  it("marks only the input warning as an alert, so it is the one that stands out", async () => {
    mockFetch(scheduleWith([INPUT_WARNING, CAPACITY_WARNING, INFO_WARNING]));
    open();

    await screen.findByText("Check the input");
    // One alert region, and it is the input one.
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(within(alerts[0]).getByText(/please confirm these numbers are correct/)).toBeInTheDocument();
  });

  it("shows a capacity warning on its own without implying a bad input", async () => {
    mockFetch(scheduleWith([CAPACITY_WARNING]));
    open();

    await screen.findByText("Month is full");
    expect(screen.queryByText("Check the input")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still renders schedules stored before warnings were classified", async () => {
    // Older rows have `warnings` only; they must not vanish from the view.
    const legacy = scheduleWith([]);
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
