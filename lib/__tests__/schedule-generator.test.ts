import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCHEDULE_RULES,
  breakCountForDay,
  distributeHours,
  dutchPublicHolidays,
  formatHoursNL,
  generateMonthlyScheduleData,
  applyOvertimeAssignments,
  monthDays,
  monthlyScheduleGenerator,
  normaliseOvertimeAssignments,
  selectEvenlySpreadDays,
} from "@/lib/workforce/domain";
import type {
  GeneratedSchedule,
  MonthlyScheduleRequest,
  OvertimeAssignment,
  PublicHoliday,
  ScheduleRules,
  ScheduleRulesInput,
} from "@/lib/workforce/domain";

/* ── helpers ──────────────────────────────────────────────────────── */

const rules = (over: Partial<ScheduleRulesInput> = {}): ScheduleRules => ({
  client_id: "c1",
  ...DEFAULT_SCHEDULE_RULES,
  ...over,
});

const holiday = (date: string, name: string): PublicHoliday => ({
  id: date, country: "NL", date, year: Number(date.slice(0, 4)), name,
  created_at: "", updated_at: "",
});

/** Only the NL holidays that actually fall inside the requested month. */
function holidaysIn(year: number, month: number): PublicHoliday[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  return dutchPublicHolidays(year)
    .filter((h) => h.date.startsWith(prefix))
    .map((h) => holiday(h.date, h.name));
}

function generate(over: {
  year?: number; month?: number; total_hours?: number; working_days?: number;
  rules?: ScheduleRules; holidays?: PublicHoliday[];
  existing_overtime?: OvertimeAssignment[];
} = {}): GeneratedSchedule {
  const request: MonthlyScheduleRequest = {
    employee_id: "e1",
    client_id: "c1",
    year: over.year ?? 2026,
    month: over.month ?? 6,
    total_hours: over.total_hours ?? 160,
    // A MONTH total: June 2026 has 22 eligible weekdays.
    working_days: over.working_days ?? 22,
  };
  return generateMonthlyScheduleData({
    rules: over.rules ?? rules(),
    request,
    holidays: over.holidays ?? [],
    existing_overtime: over.existing_overtime,
  });
}

/** The classified warnings a generated schedule carries, by code. */
function codes(schedule: GeneratedSchedule): string[] {
  return schedule.warning_details.map((w) => w.code);
}

/** Sum of the printed rows, in cents — what "totals reconcile" means. */
function sumWorkedCents(schedule: GeneratedSchedule): number {
  return schedule.days.reduce((sum, d) => sum + Math.round(d.hours * 100), 0);
}

/* ── weekday selection ────────────────────────────────────────────── */

describe("selectEvenlySpreadDays", () => {
  const days = Array.from({ length: 10 }, (_, i) => i);

  it("anchors both ends and keeps the gaps as equal as possible", () => {
    expect(selectEvenlySpreadDays(days, 2)).toEqual([0, 9]);
    expect(selectEvenlySpreadDays(days, 3)).toEqual([0, 5, 9]);
    expect(selectEvenlySpreadDays(days, 4)).toEqual([0, 3, 6, 9]);
    expect(selectEvenlySpreadDays(days, 5)).toEqual([0, 2, 5, 7, 9]);
  });

  it("puts a single day in the middle, not at the start", () => {
    expect(selectEvenlySpreadDays(days, 1)).toEqual([4]);
  });

  it("never picks more days than there are, and keeps them in order", () => {
    expect(selectEvenlySpreadDays(days, 10)).toEqual(days);
    expect(selectEvenlySpreadDays(days, 25)).toEqual(days);
    expect(selectEvenlySpreadDays(days, 0)).toEqual([]);
    expect(selectEvenlySpreadDays([], 5)).toEqual([]);
    const picked = selectEvenlySpreadDays(days, 6);
    expect(new Set(picked).size).toBe(6);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });
});

/* ── even distribution ────────────────────────────────────────────── */

describe("distributeHours", () => {
  it("splits evenly and reconciles to the cent", () => {
    const { hours, unplacedCents } = distributeHours(160, 22, 10);
    expect(unplacedCents).toBe(0);
    expect(hours).toHaveLength(22);
    expect(Math.round(hours.reduce((a, b) => a + b, 0) * 100)).toBe(16000);
  });

  it("puts the indivisible remainder on the LAST days", () => {
    const { hours } = distributeHours(10, 3, 10);
    // 10 h over 3 days = 3.33 / 3.33 / 3.34, summing back to exactly 10.
    expect(hours).toEqual([3.33, 3.33, 3.34]);
    expect(Math.round(hours.reduce((a, b) => a + b, 0) * 100)).toBe(1000);
  });

  it("never exceeds the daily cap, and reports what would not fit", () => {
    const { hours, unplacedCents } = distributeHours(50, 5, 10);
    expect(hours).toEqual([10, 10, 10, 10, 10]);
    expect(unplacedCents).toBe(0);

    // 5 days can hold 50 h at most, so 70 of the 120 have nowhere to go.
    const over = distributeHours(120, 5, 10);
    expect(over.hours).toEqual([10, 10, 10, 10, 10]);
    expect(over.unplacedCents).toBe(7000);
  });

  it("handles the degenerate inputs", () => {
    expect(distributeHours(0, 5, 10)).toEqual({ hours: [0, 0, 0, 0, 0], unplacedCents: 0 });
    expect(distributeHours(8, 0, 10)).toEqual({ hours: [], unplacedCents: 800 });
  });
});

describe("breakCountForDay", () => {
  it("adds a break between every pair of continuous blocks", () => {
    expect(breakCountForDay(3, 4)).toBe(0);           // one block, no break
    expect(breakCountForDay(4, 4)).toBe(0);           // exactly the limit
    expect(breakCountForDay(4.5, 4)).toBe(1);
    expect(breakCountForDay(8, 4)).toBe(1);           // 8 / 4 = 2 blocks, not 3
    expect(breakCountForDay(9, 4)).toBe(2);
    expect(breakCountForDay(0, 4)).toBe(0);
  });
});

/* ── the month as a whole ─────────────────────────────────────────── */

describe("monthly schedule generation", () => {
  it("emits one row per calendar day, in order, with Dutch weekday names", () => {
    const schedule = generate({ year: 2026, month: 6 });
    expect(schedule.days).toHaveLength(30);
    expect(schedule.days[0]).toMatchObject({ date: "2026-06-01", day_name: "Maandag", weekday: 1 });
    expect(schedule.days.at(-1)).toMatchObject({ date: "2026-06-30", day_name: "Dinsdag" });
    expect(schedule.days.map((d) => d.date)).toEqual(monthDays(2026, 6).map((d) => d.date));
  });

  it("never schedules a weekend and flags those rows", () => {
    const schedule = generate();
    const weekends = schedule.days.filter((d) => d.weekday > 5);
    expect(weekends.length).toBeGreaterThan(0);
    expect(weekends.every((d) => d.kind === "weekend" && d.hours === 0 && d.start === null)).toBe(true);
  });

  it("reconciles exactly: the day rows sum to the requested hours", () => {
    for (const total of [160, 137.5, 7, 0.75, 1]) {
      const schedule = generate({ total_hours: total });
      expect(schedule.total_hours).toBe(total);
      expect(sumWorkedCents(schedule)).toBe(Math.round(total * 100));
      expect(schedule.totals.hours).toBe(total);
    }
  });

  it("keeps Overuren and Km vergoeding structurally zero", () => {
    const schedule = generate();
    expect(schedule.totals.overtime_hours).toBe(0);
    expect(schedule.totals.km_allowance).toBe(0);
  });

  it("counts the worked days in the totals", () => {
    const schedule = generate({ working_days: 18, total_hours: 144 });
    expect(schedule.totals.worked_days).toBe(18);
    expect(schedule.totals.worked_days)
      .toBe(schedule.days.filter((d) => d.hours > 0).length);
    expect(schedule.totals.worked_days).toBe(schedule.shifts.length);
  });

  it("works exactly the number of days asked for, across the whole month", () => {
    const schedule = generate({ working_days: 12, total_hours: 60 });
    const worked = schedule.days.filter((d) => d.kind === "worked");
    expect(worked).toHaveLength(12);
    expect(schedule.totals.worked_days).toBe(12);
    expect(schedule.total_hours).toBe(60);

    // Spread end to end, not clustered at the start: the first and last eligible
    // weekdays of June 2026 (Mon 1 and Tue 30) are both worked. Evenness is
    // measured over the ELIGIBLE days — that is the list the spread indexes, and
    // a calendar gap across a weekend is longer by definition.
    expect(worked[0].date).toBe("2026-06-01");
    expect(worked.at(-1)!.date).toBe("2026-06-30");
    const eligible = schedule.days.filter((d) => d.weekday <= 5 && d.kind !== "holiday");
    const indexes = worked.map((d) => eligible.findIndex((x) => x.date === d.date));
    const gaps = indexes.slice(1).map((v, i) => v - indexes[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("treats the days input as a month total, not a per-week count", () => {
    // 5 would once have meant "5 a week" (≈22 days). It now means 5 days, full stop.
    const schedule = generate({ working_days: 5, total_hours: 40 });
    expect(schedule.days.filter((d) => d.kind === "worked")).toHaveLength(5);
  });

  it("is deterministic — the same request twice gives the same plan", async () => {
    const a = generate({ total_hours: 112, working_days: 16 });
    const b = await monthlyScheduleGenerator.generate({
      employee: {
        id: "e1", client_id: "c1", name: "Jan", phone: null, function_title: null,
        hourly_rate: null, default_working_days: 16, active: true, notes: null,
        created_at: "", updated_at: "",
      },
      hourly_rate: null,       // present on the Phase 1 interface, never read
      rules: rules(),
      request: { employee_id: "e1", client_id: "c1", year: 2026, month: 6, total_hours: 112, working_days: 16 },
      holidays: [],
    });
    expect(b.days).toEqual(a.days);
    expect(b.total_hours).toBe(112);
  });
});

/* ── edge case: partial first/last week ───────────────────────────── */

describe("partial weeks", () => {
  // October 2026 starts on a Thursday and ends on a Saturday, so both the first
  // and the last week are stumps. With a month-wide spread that is a non-event:
  // the stub days are simply the first and last entries of the eligible list.
  it("still covers the month end to end when it opens and closes mid-week", () => {
    const schedule = generate({ year: 2026, month: 10, working_days: 12, total_hours: 90 });
    const worked = schedule.days.filter((d) => d.kind === "worked").map((d) => d.date);

    expect(worked).toHaveLength(12);
    expect(worked[0]).toBe("2026-10-01");    // Thursday, the month's first weekday
    expect(worked.at(-1)).toBe("2026-10-30"); // Friday, its last
    expect(schedule.total_hours).toBe(90);
    // Nothing to warn about: a stub week no longer costs the request any days.
    expect(schedule.warnings).toEqual([]);
  });

  it("warns and works every eligible day when more days are asked for than exist", () => {
    const schedule = generate({ working_days: 31, total_hours: 100 });
    expect(schedule.days.filter((d) => d.kind === "worked")).toHaveLength(22);
    expect(schedule.warnings.some((w) => /only 22 eligible weekdays/.test(w))).toBe(true);
    expect(schedule.total_hours).toBe(100);
  });
});

/* ── edge case: a holiday on a would-be work day ──────────────────── */

describe("public holidays", () => {
  it("never schedules a holiday and marks the row instead", () => {
    // April 2026 holidays: Goede Vrijdag (3rd), Tweede Paasdag (6th), Koningsdag
    // (27th) — 22 weekdays, so 19 remain eligible.
    const schedule = generate({ year: 2026, month: 4, working_days: 19, total_hours: 80, holidays: holidaysIn(2026, 4) });
    const easterMonday = schedule.days.find((d) => d.date === "2026-04-06")!;

    expect(easterMonday.kind).toBe("holiday");
    expect(easterMonday.holiday_name).toBe("Tweede Paasdag");
    expect(easterMonday.hours).toBe(0);
    expect(easterMonday.start).toBeNull();
    expect(schedule.shifts.some((s) => s.date === "2026-04-06")).toBe(false);
    expect(schedule.warnings.some((w) => w.includes("Tweede Paasdag"))).toBe(true);
    // The hours it would have carried are redistributed, not lost.
    expect(schedule.total_hours).toBe(80);
  });

  it("a holiday costs the month a slot, not a day — the requested count still lands", () => {
    // The spread indexes the ELIGIBLE list, so Tweede Paasdag simply is not a
    // position that can be chosen and the other 12 days still get scheduled.
    const schedule = generate({ year: 2026, month: 4, working_days: 12, total_hours: 60, holidays: holidaysIn(2026, 4) });
    const worked = schedule.days.filter((d) => d.kind === "worked").map((d) => d.date);

    expect(worked).toHaveLength(12);
    expect(worked).not.toContain("2026-04-06");   // Tweede Paasdag
    expect(worked).not.toContain("2026-04-03");   // Goede Vrijdag
    expect(worked).not.toContain("2026-04-27");   // Koningsdag
    expect(schedule.total_hours).toBe(60);
  });
});

/* ── edge case: a day that would exceed max_hours_per_day ─────────── */

describe("the daily cap", () => {
  it("caps every day and leaves the rest as overtime — it never adds days", () => {
    // 130 hours over the 14 days asked for would be ~9.3 h/day. The cap is 8, so
    // all 14 days sit at 8 (112 h) and the remaining 18 h become leftover.
    const schedule = generate({ working_days: 14, total_hours: 130, rules: rules({ max_hours_per_day: 8 }) });
    const worked = schedule.days.filter((d) => d.hours > 0);

    expect(worked).toHaveLength(14);                 // exactly what was requested
    expect(worked.every((d) => d.hours === 8)).toBe(true);
    expect(schedule.total_hours).toBe(112);
    expect(schedule.overtime.leftover_hours).toBe(18);
    expect(schedule.overtime.unassigned_hours).toBe(18);
    expect(codes(schedule)).toContain("overtime_unassigned");
    expect(codes(schedule)).not.toContain("days_expanded");
    // Still anchored to both ends of the month.
    expect(worked[0].date).toBe("2026-06-01");
    expect(worked.at(-1)!.date).toBe("2026-06-30");
  });

  it("reports the shortfall when even the whole month cannot hold the hours", () => {
    // June 2026 has 22 weekdays; at 8 h/day that is 176 hours, so 200 cannot fit.
    const schedule = generate({ working_days: 22, total_hours: 200, rules: rules({ max_hours_per_day: 8 }) });
    const worked = schedule.days.filter((d) => d.hours > 0);

    expect(worked).toHaveLength(22);
    expect(Math.max(...worked.map((d) => d.hours))).toBe(8);
    expect(schedule.total_hours).toBe(176);
    expect(schedule.requested_hours).toBe(200);
    expect(schedule.overtime.leftover_hours).toBe(24);
    expect(codes(schedule)).toContain("overtime_unassigned");
    // Whatever was scheduled still reconciles with the printed rows.
    expect(sumWorkedCents(schedule)).toBe(17600);
  });
});

/* ── times, breaks and the work window ────────────────────────────── */

describe("shift times", () => {
  it("starts at the client's work_start_time and adds worked minutes + pauze", () => {
    // 40 h over 5 days = 8 h each; 8 h with a 4 h continuous limit is 2 blocks
    // and one 30-minute break.
    const schedule = generate({ total_hours: 40, working_days: 5 });
    const worked = schedule.days.filter((d) => d.kind === "worked");
    expect(worked).toHaveLength(5);
    expect(worked[0]).toMatchObject({ start: "08:00", end: "16:30", break_minutes: 30, hours: 8 });
    // Five days spread across June 2026's 22 eligible weekdays, ends included.
    expect(worked.map((d) => d.date))
      .toEqual(["2026-06-01", "2026-06-08", "2026-06-16", "2026-06-23", "2026-06-30"]);
  });

  it("honours a client that works outside the standard daytime window", () => {
    const schedule = generate({
      total_hours: 30, working_days: 5,    // 6 h on each of five days
      rules: rules({ work_start_time: "22:00", work_end_time: "23:59" }),
    });
    const worked = schedule.days.filter((d) => d.kind === "worked")[0];
    expect(worked.start).toBe("22:00");
    expect(worked.end).toBe("04:30");   // wraps past midnight
  });

  it("truncates part-hours to whole minutes, like the reference timesheet", () => {
    // 10 hours over 3 days → 3,33 / 3,33 / 3,34. A 3,33 h day is 199 minutes.
    const schedule = generate({ year: 2026, month: 6, total_hours: 10, working_days: 3, rules: rules({ work_start_time: "07:00" }) });
    const worked = schedule.days.filter((d) => d.kind === "worked");
    expect(worked.length).toBeGreaterThan(1);
    const first = worked[0];
    expect(formatHoursNL(first.hours)).toMatch(/^\d+(,\d+)?$/);
    // No break under the 4 h continuous limit, so end = start + worked minutes.
    expect(first.break_minutes).toBe(0);
  });

  it("warns when a day runs past the client's window instead of refusing it", () => {
    // 8 h a day — exactly the cap, so no expansion: 2 blocks, one 30-min break,
    // 08:00 → 16:30, well past a 12:00 window.
    const schedule = generate({ total_hours: 40, working_days: 5, rules: rules({ work_end_time: "12:00" }) });
    expect(schedule.days.filter((d) => d.kind === "worked")[0]).toMatchObject({ end: "16:30", break_minutes: 30 });
    expect(schedule.warnings.some((w) => /end after the client's 12:00 window/.test(w))).toBe(true);
    expect(schedule.total_hours).toBe(40);
  });
});

describe("degenerate requests", () => {
  it("produces a blank month for 0 hours", () => {
    const schedule = generate({ total_hours: 0 });
    expect(schedule.shifts).toHaveLength(0);
    expect(schedule.total_hours).toBe(0);
    expect(schedule.days.every((d) => d.kind !== "worked")).toBe(true);
    expect(schedule.days).toHaveLength(30);
  });

  it("schedules nothing when working_days is 0, and says why", () => {
    // 0 days means no working days, not "as few as possible" — the hours are
    // reported as unscheduled rather than quietly placed anyway.
    const schedule = generate({ working_days: 0, total_hours: 40 });
    expect(schedule.shifts).toHaveLength(0);
    expect(schedule.total_hours).toBe(0);
    expect(schedule.warnings.some((w) => /working_days is 0/.test(w))).toBe(true);
    // Every hour is leftover, since there was nowhere to put any of them.
    expect(schedule.overtime.leftover_hours).toBe(40);
    expect(codes(schedule)).toContain("overtime_unassigned");
  });

  it("never works a weekend, whatever the day count", () => {
    const schedule = generate({ working_days: 31, total_hours: 40 });
    expect(schedule.days.filter((d) => d.kind === "worked").every((d) => d.weekday <= 5)).toBe(true);
  });
});

describe("formatHoursNL", () => {
  it("prints Dutch hours without trailing zeros", () => {
    expect(formatHoursNL(3)).toBe("3");
    expect(formatHoursNL(3.33)).toBe("3,33");
    expect(formatHoursNL(12.5)).toBe("12,5");
    expect(formatHoursNL(0)).toBe("0");
  });
});

/* ── the 8-hour daily maximum ─────────────────────────────────────── */

describe("the 8-hour daily cap", () => {
  it("is the default, so an unconfigured client never gets a 9-hour day", () => {
    expect(DEFAULT_SCHEDULE_RULES.max_hours_per_day).toBe(8);

    const schedule = generate({ working_days: 22, total_hours: 160 });
    const worked = schedule.days.filter((d) => d.hours > 0);
    expect(Math.max(...worked.map((d) => d.hours))).toBeLessThanOrEqual(8);
    expect(schedule.total_hours).toBe(160);
    expect(schedule.overtime.leftover_hours).toBe(0);
  });

  it("caps at 8 rather than the old 10, spilling the difference", () => {
    // 90 hours over 10 days is 9 h/day. Under the old 10-hour cap that fitted;
    // against 8 the days hold 80 and 10 hours spill over.
    const schedule = generate({ working_days: 10, total_hours: 90 });
    const worked = schedule.days.filter((d) => d.hours > 0);

    expect(worked).toHaveLength(10);
    expect(worked.every((d) => d.hours === 8)).toBe(true);
    expect(schedule.total_hours).toBe(80);
    expect(schedule.overtime.leftover_hours).toBe(10);
  });

  it("reads the cap from the client's rules, never a hardcoded 8", () => {
    const schedule = generate({ working_days: 10, total_hours: 90, rules: rules({ max_hours_per_day: 9 }) });
    expect(schedule.total_hours).toBe(90);
    expect(schedule.overtime.leftover_hours).toBe(0);
    expect(codes(schedule)).not.toContain("overtime_unassigned");
  });

  it("splits evenly and stays under the cap when the hours do fit", () => {
    const schedule = generate({ working_days: 10, total_hours: 55 });
    const worked = schedule.days.filter((d) => d.hours > 0);
    expect(worked).toHaveLength(10);
    expect(Math.max(...worked.map((d) => d.hours))).toBeLessThanOrEqual(8);
    expect(sumWorkedCents(schedule)).toBe(5500);
    expect(schedule.overtime.leftover_hours).toBe(0);
  });
});

/* ── leftover overtime, and assigning it ──────────────────────────── */

describe("leftover overtime", () => {
  it("THE REPORTED CASE: 20 hours over 2 days caps both at 8 and reports 4", () => {
    const schedule = generate({ working_days: 2, total_hours: 20 });
    const worked = schedule.days.filter((d) => d.hours > 0);

    // Both requested days at the cap — no third day invented.
    expect(worked).toHaveLength(2);
    expect(worked.map((d) => d.hours)).toEqual([8, 8]);
    expect(schedule.total_hours).toBe(16);

    // …and the 4 remaining hours are reported, not placed.
    expect(schedule.overtime).toMatchObject({
      leftover_hours: 4, assigned_hours: 0, unassigned_hours: 4, assignments: [],
    });
    expect(schedule.days.every((d) => d.overtime_hours === 0)).toBe(true);

    const w = schedule.warning_details.find((x) => x.code === "overtime_unassigned")!;
    expect(w.kind).toBe("action");
    expect(w.message).toBe(
      "4 hours of overtime could not be scheduled within the requested 2 days at 8h/day — please assign them.",
    );
  });

  it("assigns the leftover to one date", () => {
    const base = generate({ working_days: 2, total_hours: 20 });
    const target = base.days.filter((d) => d.hours > 0)[1].date;

    const after = applyOvertimeAssignments(base, [{ date: target, hours: 4 }], rules());
    const day = after.days.find((d) => d.date === target)!;

    expect(day.hours).toBe(8);              // distributed hours untouched
    expect(day.overtime_hours).toBe(4);
    expect(after.totals.overtime_hours).toBe(4);
    expect(after.totals.hours).toBe(16);    // regular total unchanged
    expect(after.overtime.unassigned_hours).toBe(0);
    expect(codes(after)).not.toContain("overtime_unassigned");

    // 8 + 4 = a 12-hour span: breaks are computed across the whole day, so two
    // 30-minute breaks, and it ends at 08:00 + 12h + 1h.
    expect(day.break_minutes).toBe(60);
    expect(day.end).toBe("21:00");
  });

  it("splits the leftover across several dates", () => {
    const base = generate({ working_days: 2, total_hours: 20 });
    const [d1, d2] = base.days.filter((d) => d.hours > 0).map((d) => d.date);

    const after = applyOvertimeAssignments(base, [
      { date: d1, hours: 1.5 },
      { date: d2, hours: 2.5 },
    ], rules());

    expect(after.overtime.assignments).toEqual([
      { date: d1, hours: 1.5 }, { date: d2, hours: 2.5 },
    ]);
    expect(after.totals.overtime_hours).toBe(4);
    expect(after.overtime.unassigned_hours).toBe(0);
    expect(codes(after)).not.toContain("overtime_unassigned");
  });

  it("can put overtime on a date the plan left free, times and all", () => {
    const base = generate({ working_days: 2, total_hours: 20 });
    const free = base.days.find((d) => d.kind === "free")!;

    const after = applyOvertimeAssignments(base, [{ date: free.date, hours: 4 }], rules());
    const day = after.days.find((d) => d.date === free.date)!;

    expect(day.hours).toBe(0);
    expect(day.overtime_hours).toBe(4);
    expect(day.start).toBe("08:00");
    expect(day.end).toBe("12:00");          // 4 h, under the continuous limit
    expect(after.totals.worked_days).toBe(3);   // the two planned days plus this
  });

  it("reports what is still outstanding on a partial assignment", () => {
    const base = generate({ working_days: 2, total_hours: 20 });
    const target = base.days.filter((d) => d.hours > 0)[0].date;

    const after = applyOvertimeAssignments(base, [{ date: target, hours: 1 }], rules());
    expect(after.overtime).toMatchObject({ leftover_hours: 4, assigned_hours: 1, unassigned_hours: 3 });
    expect(after.warning_details.find((w) => w.code === "overtime_unassigned")!.message)
      .toMatch(/^3 hours of overtime/);
  });

  it("replaces the whole set, so an empty list clears the assignment", () => {
    const base = generate({ working_days: 2, total_hours: 20 });
    const target = base.days.filter((d) => d.hours > 0)[0].date;

    const assigned = applyOvertimeAssignments(base, [{ date: target, hours: 4 }], rules());
    const cleared = applyOvertimeAssignments(assigned, [], rules());

    expect(cleared.totals.overtime_hours).toBe(0);
    expect(cleared.days.every((d) => d.overtime_hours === 0)).toBe(true);
    expect(cleared.overtime.unassigned_hours).toBe(4);
    expect(codes(cleared)).toContain("overtime_unassigned");
  });

  it("merges duplicate dates and ignores non-positive entries", () => {
    expect(normaliseOvertimeAssignments([
      { date: "2026-06-02", hours: 1 },
      { date: "2026-06-01", hours: 2 },
      { date: "2026-06-02", hours: 1.5 },
      { date: "2026-06-03", hours: 0 },
      { date: "2026-06-04", hours: -2 },
    ])).toEqual([
      { date: "2026-06-01", hours: 2 },
      { date: "2026-06-02", hours: 2.5 },
    ]);
  });

  it("drops an assignment dated outside the month and says so", () => {
    const base = generate({ working_days: 2, total_hours: 20 });
    const after = applyOvertimeAssignments(base, [{ date: "2026-07-05", hours: 4 }], rules());

    expect(after.totals.overtime_hours).toBe(0);
    expect(codes(after)).toContain("overtime_outside_month");
    expect(after.warning_details.find((w) => w.code === "overtime_outside_month")!.message)
      .toMatch(/2026-07-05/);
  });

  it("keeps the day's own break rule when overtime lands on a short day", () => {
    // 3 regular + 1 overtime = 4 h, exactly the continuous limit: still no break.
    const base = generate({ working_days: 2, total_hours: 6 });
    const target = base.days.filter((d) => d.hours > 0)[0].date;
    const after = applyOvertimeAssignments(base, [{ date: target, hours: 1 }], rules());
    const day = after.days.find((d) => d.date === target)!;

    expect(day.hours).toBe(3);
    expect(day.overtime_hours).toBe(1);
    expect(day.break_minutes).toBe(0);
    expect(day.end).toBe("12:00");
  });
});

/* ── re-generating on top of an existing assignment ───────────────── */

describe("re-generation with assigned overtime", () => {
  it("preserves an assignment when the numbers still leave room for it", () => {
    const first = generate({ working_days: 2, total_hours: 20 });
    const target = first.days.filter((d) => d.hours > 0)[0].date;
    const assigned = applyOvertimeAssignments(first, [{ date: target, hours: 4 }], rules());

    // Same request again — the use case carries the stored assignments back in.
    const again = generate({
      working_days: 2, total_hours: 20,
      existing_overtime: assigned.overtime.assignments,
    });

    expect(again.days.find((d) => d.date === target)!.overtime_hours).toBe(4);
    expect(again.totals.overtime_hours).toBe(4);
    expect(again.overtime.unassigned_hours).toBe(0);
    expect(codes(again)).not.toContain("overtime_reassign_needed");
  });

  it("keeps the assignment but flags it when the new leftover is smaller", () => {
    const first = generate({ working_days: 2, total_hours: 20 });
    const target = first.days.filter((d) => d.hours > 0)[0].date;
    const assigned = applyOvertimeAssignments(first, [{ date: target, hours: 4 }], rules());

    // Re-generated with hours that now fit: nothing spills over any more, but
    // 4 hours are still assigned. It must not silently vanish.
    const again = generate({
      working_days: 2, total_hours: 16,
      existing_overtime: assigned.overtime.assignments,
    });

    expect(again.days.find((d) => d.date === target)!.overtime_hours).toBe(4);
    const flag = again.warning_details.find((w) => w.code === "overtime_reassign_needed")!;
    expect(flag).toBeDefined();
    expect(flag.kind).toBe("action");
    expect(flag.message).toMatch(/4 hours of overtime are assigned but only 0/);
  });

  it("re-reports the remainder when a re-generation spills more than is assigned", () => {
    const first = generate({ working_days: 2, total_hours: 20 });
    const target = first.days.filter((d) => d.hours > 0)[0].date;
    const assigned = applyOvertimeAssignments(first, [{ date: target, hours: 4 }], rules());

    // Now 24 hours over the same 2 days: 8 leftover, 4 of them already placed.
    const again = generate({
      working_days: 2, total_hours: 24,
      existing_overtime: assigned.overtime.assignments,
    });

    expect(again.overtime).toMatchObject({ leftover_hours: 8, assigned_hours: 4, unassigned_hours: 4 });
    expect(codes(again)).toContain("overtime_unassigned");
    expect(codes(again)).not.toContain("overtime_reassign_needed");
  });

  it("drops a carried assignment whose date is not in the new month", () => {
    const june = generate({ working_days: 2, total_hours: 20 });
    const target = june.days.filter((d) => d.hours > 0)[0].date;
    const assigned = applyOvertimeAssignments(june, [{ date: target, hours: 4 }], rules());

    const july = generate({
      year: 2026, month: 7, working_days: 2, total_hours: 20,
      existing_overtime: assigned.overtime.assignments,
    });

    expect(july.totals.overtime_hours).toBe(0);
    expect(codes(july)).toContain("overtime_outside_month");
  });
});
