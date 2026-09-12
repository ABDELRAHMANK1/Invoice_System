/**
 * The monthly schedule generator — the implementation of the `ScheduleGenerator`
 * interface Phase 1 left open.
 *
 * Pure: it takes the request, the client's rules and the month's public holidays
 * and returns the plan. No repositories, no IO, no clock — the same inputs always
 * produce the same schedule, which is what makes the whole thing unit-testable
 * and what lets the timesheet be re-rendered from `schedule_data` at any time.
 *
 * HOURS ONLY. `ScheduleGenerationInput.hourly_rate` is part of the Phase 1
 * interface and is deliberately never read here: this feature schedules time, it
 * never costs it.
 *
 * ── The rules, in order ────────────────────────────────────────────────────
 * 1. Every calendar day of the month gets a row (`days`), worked or not.
 * 2. Saturdays and Sundays are never eligible.
 * 3. Dates in `holidays` are never eligible — a holiday on a weekday reads as a
 *    blank row, exactly like an unselected weekday.
 * 4. WHICH days get worked: `working_days` is a MONTH total, not a weekly count.
 *    `selectEvenlySpreadDays` takes the eligible days of the month (weekends and
 *    holidays already removed) and picks positions
 *    `round(i × (m − 1) / (n − 1))` in that list, so the first and the last
 *    eligible weekday of the month are always worked and the gaps between the
 *    rest are as equal as the calendar allows. A single day goes to the middle of
 *    the month. Because it indexes the ELIGIBLE list, a holiday or a partial
 *    first/last week never clusters the days at the start — those dates simply
 *    are not positions that can be chosen.
 * 5. Asking for more days than the month has eligible weekdays works every one of
 *    them and says so in `warnings`.
 * 6. `total_hours` is split evenly (to the cent) over the selected days; the
 *    remainder cents land on the LAST days, so the day totals always sum back to
 *    the request exactly.
 * 7. `max_hours_per_day` is a HARD cap and the day count is fixed at what was
 *    requested. The generator does NOT invent extra days to make the hours fit,
 *    and never puts more than the cap on a day. Whatever does not fit —
 *    `total_hours - working_days × cap` — is LEFTOVER overtime: reported via
 *    `overtime.leftover_hours` and an `action` warning, never placed
 *    automatically. A person assigns it to dates afterwards
 *    (`applyOvertimeAssignments`), which is the only thing that ever writes
 *    `ScheduleDay.overtime_hours`.
 * 8. A day over `max_continuous_hours` is split into `ceil(hours / max_continuous)`
 *    blocks with a `break_minutes` break between each, all inside the same day.
 *    Pauze is the sum of those breaks (0 for a short day, 30 for one, 60 for two).
 *    This is computed over the day's WHOLE worked span — regular hours plus any
 *    assigned overtime — so an 8 + 4 day gets the breaks a 12-hour day needs.
 * 9. Begintijd is the client's `work_start_time`; Eindtijd is start + worked
 *    minutes + pauze. Running past `work_end_time` is a warning, not an error —
 *    the window is a default, not a hard cap (the hard cap is max_hours_per_day,
 *    and it applies to the generated hours; assigned overtime is a human
 *    override of exactly that, so it may legitimately push a day past it).
 */

import type { PublicHoliday } from "./public-holiday";
import { clockToMinutes, minutesToClock } from "./schedule-rules";
import type {
  GeneratedSchedule,
  ScheduleDay,
  ScheduleGenerationInput,
  ScheduleGenerator,
  ScheduleShift,
  ScheduleWarning,
  ScheduleWarningCode,
  ScheduleWarningKind,
  OvertimeAssignment,
} from "./schedule-generator";
import type { ScheduleRules } from "./schedule-rules";

/** ISO weekday (1 = Monday) → Dutch name, as printed in the "Dag" column. */
export const DUTCH_WEEKDAYS = [
  "Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag",
] as const;

/** Month number (1-based) → Dutch month name, for the timesheet title/total row. */
export const DUTCH_MONTHS = [
  "Januari", "Februari", "Maart", "April", "Mei", "Juni",
  "Juli", "Augustus", "September", "Oktober", "November", "December",
] as const;

/** ISO weekday 5 = Friday. 6 and 7 are the weekend and are never scheduled. */
export const LAST_WORKING_WEEKDAY = 5;

/**
 * Hours the Dutch way: comma decimal, trailing zeros trimmed — 3 → "3",
 * 3.33 → "3,33". Lives here rather than next to the PDF so the on-screen table
 * and the printed one can never disagree (and so a client component can import
 * it without pulling pdfkit in).
 */
export function formatHoursNL(hours: number): string {
  return hours.toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

const DAY_MS = 86_400_000;
/** Float slack: 8 / 4 must be 2 blocks, not 3, and 3.33 h must floor to 199 min. */
const EPS = 1e-9;

/* ── calendar helpers (UTC only — a local Date would shift days near DST) ── */

function isoDate(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** ISO weekday, 1 = Monday … 7 = Sunday. */
function isoWeekday(utcMs: number): number {
  return new Date(utcMs).getUTCDay() || 7;
}

/** Every day of the month, in order. */
export function monthDays(year: number, month: number): Array<{ ms: number; date: string; weekday: number }> {
  const days: Array<{ ms: number; date: string; weekday: number }> = [];
  const first = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 1);
  for (let ms = first; ms < end; ms += DAY_MS) {
    days.push({ ms, date: isoDate(ms), weekday: isoWeekday(ms) });
  }
  return days;
}

/* ── which weekdays get worked ────────────────────────────────────────────── */

interface EligibleDay {
  ms: number;
  date: string;
  weekday: number;
}

/**
 * Pick `count` days out of `eligible`, spread as evenly across it as possible.
 *
 * Positions are `round(i × (m − 1) / (count − 1))` over the eligible list, the
 * same both-ends-anchored formula the old weekly pattern used, now applied to the
 * whole month instead of to one week:
 *   • the first and last eligible weekday of the month are always worked, so the
 *     month is covered end to end rather than front-loaded;
 *   • the gaps in between are as equal as the calendar allows;
 *   • `count === 1` is the exception — a lone day goes to the MIDDLE of the
 *     month rather than to its first day.
 * It indexes the ELIGIBLE list, so weekends, holidays and stub weeks can never
 * absorb a slot: they were removed before the spread is computed.
 */
export function selectEvenlySpreadDays<T>(eligible: T[], count: number): T[] {
  const m = eligible.length;
  const n = Math.min(Math.max(Math.trunc(count), 0), m);
  if (n === 0) return [];
  if (n === m) return [...eligible];
  if (n === 1) return [eligible[Math.floor((m - 1) / 2)]];

  // With n < m the step is > 1, so the rounded positions strictly increase; the
  // `seen` guard is belt-and-braces against a duplicate day ever being emitted.
  const seen = new Set<number>();
  const picked: T[] = [];
  for (let i = 0; i < n; i++) {
    let index = Math.round((i * (m - 1)) / (n - 1));
    while (seen.has(index) && index < m - 1) index++;
    if (seen.has(index)) continue;
    seen.add(index);
    picked.push(eligible[index]);
  }
  return picked;
}

/* ── hours ────────────────────────────────────────────────────────────────── */

/**
 * Split `totalHours` over `dayCount` days without ever exceeding `maxPerDay`.
 * Works in whole cents of an hour so the parts always sum back to the request.
 * The remainder lands on the last days; anything the cap won't take is returned
 * as `unplacedCents` for the caller to warn about.
 */
export function distributeHours(
  totalHours: number,
  dayCount: number,
  maxPerDay: number,
): { hours: number[]; unplacedCents: number } {
  const totalCents = Math.round(totalHours * 100);
  if (dayCount <= 0) return { hours: [], unplacedCents: Math.max(0, totalCents) };
  if (totalCents <= 0) return { hours: new Array(dayCount).fill(0), unplacedCents: 0 };

  const capCents = Math.max(0, Math.floor(maxPerDay * 100));
  const base = Math.floor(totalCents / dayCount);
  let remainder = totalCents - base * dayCount;

  // Even split, remainder on the LAST days.
  const cents = new Array<number>(dayCount).fill(base);
  for (let i = dayCount - 1; i >= 0 && remainder > 0; i--, remainder--) cents[i]++;

  // Push anything over the cap onto the days that still have headroom, earliest
  // first. Only the even split's remainder cents can land here (the caller sizes
  // the day count so `base` already fits), but the pass is written generally so a
  // caller that can't add days still gets a legal schedule plus a shortfall.
  let overflow = 0;
  for (let i = 0; i < dayCount; i++) {
    if (cents[i] > capCents) { overflow += cents[i] - capCents; cents[i] = capCents; }
  }
  for (let i = 0; i < dayCount && overflow > 0; i++) {
    const headroom = capCents - cents[i];
    if (headroom <= 0) continue;
    const move = Math.min(headroom, overflow);
    cents[i] += move;
    overflow -= move;
  }

  return { hours: cents.map((c) => c / 100), unplacedCents: overflow };
}

/** Breaks required for a day: one between every pair of continuous blocks. */
export function breakCountForDay(hours: number, maxContinuousHours: number): number {
  if (hours <= 0 || maxContinuousHours <= 0) return 0;
  return Math.max(0, Math.ceil(hours / maxContinuousHours - EPS) - 1);
}

/* ── the generator ────────────────────────────────────────────────────────── */

/**
 * The algorithm itself. It reads only the three fields it is entitled to —
 * `rules`, `request`, `holidays` — so it can be called directly (tests, the PDF
 * re-render path) without inventing an employee or a rate.
 */
export function generateMonthlyScheduleData(
  input: Pick<ScheduleGenerationInput, "rules" | "request" | "holidays" | "existing_overtime">,
): GeneratedSchedule {
  const { rules, request, holidays } = input;

  // Warnings are collected classified (see ScheduleWarning) and flattened to
  // `warnings` at the end, so the dashboard can style "check your input" apart
  // from "the month is full" without pattern-matching on message text.
  const warningList: ScheduleWarning[] = [];
  const warn = (code: ScheduleWarningCode, kind: ScheduleWarningKind, message: string) => {
    warningList.push({ code, kind, message });
  };

  const holidayByDate = new Map<string, PublicHoliday>(holidays.map((h) => [h.date, h]));
  const all = monthDays(request.year, request.month);

  const eligible: EligibleDay[] = all
    .filter((d) => d.weekday <= LAST_WORKING_WEEKDAY && !holidayByDate.has(d.date));

  const skippedHolidays = all
    .filter((d) => d.weekday <= LAST_WORKING_WEEKDAY && holidayByDate.has(d.date))
    .map((d) => `${holidayByDate.get(d.date)!.name} (${d.date})`);
  if (skippedHolidays.length > 0) {
    warn("holidays_skipped", "info", `Public holidays skipped: ${skippedHolidays.join(", ")}.`);
  }

  // `working_days` counts the WHOLE MONTH, so it is bounded by the month's
  // eligible weekdays rather than by the length of a week.
  const requestedDays = Math.max(0, Math.trunc(request.working_days));
  if (requestedDays > eligible.length) {
    warn("days_requested_exceed_month", "capacity",
      `${requestedDays} working days requested but the month has only ${eligible.length} ` +
      `eligible weekday${eligible.length === 1 ? "" : "s"} (weekends and public holidays excluded), ` +
      "so every one of them is worked.",
    );
  }
  if (requestedDays === 0 && request.total_hours > 0) {
    warn("no_working_days", "input", "working_days is 0, so no working days could be selected.");
  }

  // Rule 7: the cap is HARD and the day count is fixed at what was requested.
  // Nothing here grows the selection — hours that do not fit become leftover
  // overtime for a person to place, which is what `distributeHours` reports as
  // `unplacedCents`.
  const capPerDay = Math.max(0, rules.max_hours_per_day);
  const targetDays = Math.min(requestedDays, eligible.length);
  const workingDays = selectEvenlySpreadDays(eligible, targetDays);

  const { hours: perDay, unplacedCents } = distributeHours(request.total_hours, workingDays.length, capPerDay);

  const regularByDate = new Map<string, number>();
  workingDays.forEach((day, i) => {
    const hours = perDay[i] ?? 0;
    if (hours > 0) regularByDate.set(day.date, hours);
  });

  const base = composeSchedule({
    all,
    holidayByDate,
    regularByDate,
    overtimeByDate: new Map(),
    rules,
    requestedHours: request.total_hours,
    leftoverHours: unplacedCents / 100,
    requestedDays,
    structuralWarnings: warningList,
  });

  // A re-generation carries the person's existing assignments back in rather
  // than dropping them; `applyOvertimeAssignments` re-checks them against the
  // new leftover and flags any mismatch.
  const carried = input.existing_overtime ?? [];
  return carried.length > 0 ? applyOvertimeAssignments(base, carried, rules) : base;
}

/* ── composing days, shifts, totals and the derived warnings ─────────────── */

interface ComposeInput {
  all: Array<{ ms: number; date: string; weekday: number }>;
  holidayByDate: Map<string, PublicHoliday>;
  /** Distributed hours per date. */
  regularByDate: Map<string, number>;
  /** Human-assigned overtime per date. */
  overtimeByDate: Map<string, number>;
  rules: ScheduleRules;
  requestedHours: number;
  /** Hours the capped days could not hold. */
  leftoverHours: number;
  requestedDays: number;
  /** Warnings decided before composition (holidays, day-count problems). */
  structuralWarnings: ScheduleWarning[];
}

/**
 * Build the month's rows from "how many regular hours" + "how much assigned
 * overtime" per date. Shared by generation and by re-assignment so a day's
 * times, breaks and the derived warnings are computed in exactly one place.
 */
function composeSchedule(input: ComposeInput): GeneratedSchedule {
  const {
    all, holidayByDate, regularByDate, overtimeByDate, rules,
    requestedHours, leftoverHours, requestedDays, structuralWarnings,
  } = input;

  const warningList: ScheduleWarning[] = [...structuralWarnings];
  const warn = (code: ScheduleWarningCode, kind: ScheduleWarningKind, message: string) => {
    warningList.push({ code, kind, message });
  };

  const startMinutes = clockToMinutes(rules.work_start_time) ?? 8 * 60;
  const windowEnd = clockToMinutes(rules.work_end_time);

  const days: ScheduleDay[] = all.map((d) => {
    const dayName = DUTCH_WEEKDAYS[d.weekday - 1];
    const holiday = holidayByDate.get(d.date);
    const hours = regularByDate.get(d.date) ?? 0;
    const overtime = overtimeByDate.get(d.date) ?? 0;
    const kind: ScheduleDay["kind"] = hours > 0
      ? "worked"
      : d.weekday > LAST_WORKING_WEEKDAY ? "weekend" : holiday ? "holiday" : "free";

    // A date with only assigned overtime still prints times: someone worked it.
    if (hours <= 0 && overtime <= 0) {
      return {
        date: d.date, weekday: d.weekday, day_name: dayName, kind,
        holiday_name: holiday?.name ?? null,
        start: null, end: null, break_minutes: 0, hours: 0, overtime_hours: 0,
      };
    }

    // Breaks span the WHOLE worked day, so 8 regular + 4 overtime gets the two
    // breaks a 12-hour day needs, not the one its 8 regular hours would.
    const span = hours + overtime;
    const breakMinutes = breakCountForDay(span, rules.max_continuous_hours) * rules.break_minutes;
    // Truncated, not rounded: 3,33 h is 199 minutes of work, so 07:00 + pauze
    // ends at 10:49 — the same arithmetic the reference timesheet uses.
    const endMinutes = startMinutes + Math.floor(span * 60 + 1e-6) + breakMinutes;
    return {
      date: d.date, weekday: d.weekday, day_name: dayName, kind,
      holiday_name: holiday?.name ?? null,
      start: minutesToClock(startMinutes),
      end: minutesToClock(endMinutes),
      break_minutes: breakMinutes,
      hours,
      overtime_hours: overtime,
      _endMinutes: endMinutes,
    } as ScheduleDay & { _endMinutes: number };
  });

  const overruns = days
    .map((d) => (d as ScheduleDay & { _endMinutes?: number })._endMinutes)
    .filter((m): m is number => m != null && windowEnd != null && m > windowEnd);
  if (overruns.length > 0 && windowEnd != null) {
    warn("window_overrun", "info",
      `${overruns.length} day${overruns.length === 1 ? "" : "s"} end after the client's ` +
      `${rules.work_end_time} window (latest ${minutesToClock(Math.max(...overruns))}).`,
    );
  }
  // Scratch field for the overrun check only — never part of the stored shape.
  for (const d of days) delete (d as ScheduleDay & { _endMinutes?: number })._endMinutes;

  const shifts: ScheduleShift[] = days
    .filter((d) => d.hours > 0 || d.overtime_hours > 0)
    .map((d) => ({
      date: d.date, start: d.start!, end: d.end!,
      hours: d.hours, overtime_hours: d.overtime_hours, break_minutes: d.break_minutes,
    }));

  // Summed in cents so the totals are exactly the sum of the printed rows.
  const cents = (pick: (d: ScheduleDay) => number) =>
    days.reduce((sum, d) => sum + Math.round(pick(d) * 100), 0) / 100;
  const totalHours = cents((d) => d.hours);
  const assignedHours = cents((d) => d.overtime_hours);

  const assignments: OvertimeAssignment[] = days
    .filter((d) => d.overtime_hours > 0)
    .map((d) => ({ date: d.date, hours: d.overtime_hours }));

  const unassigned = Math.max(0, Math.round((leftoverHours - assignedHours) * 100)) / 100;
  if (unassigned > 0) {
    warn("overtime_unassigned", "action",
      `${formatHoursNL(unassigned)} hours of overtime could not be scheduled within the ` +
      `requested ${requestedDays} day${requestedDays === 1 ? "" : "s"} at ` +
      `${formatHoursNL(rules.max_hours_per_day)}h/day — please assign them.`,
    );
  }

  return {
    shifts,
    days,
    total_hours: totalHours,
    requested_hours: requestedHours,
    totals: {
      hours: totalHours,
      overtime_hours: assignedHours,
      km_allowance: 0,
      worked_days: shifts.length,
    },
    overtime: {
      leftover_hours: leftoverHours,
      assigned_hours: assignedHours,
      unassigned_hours: unassigned,
      assignments,
    },
    warnings: warningList.map((w) => w.message),
    warning_details: warningList,
  };
}

/* ── assigning leftover overtime ─────────────────────────────────────────── */

/** Merge duplicate dates, drop non-positive entries, round to whole cents. */
export function normaliseOvertimeAssignments(assignments: OvertimeAssignment[]): OvertimeAssignment[] {
  const byDate = new Map<string, number>();
  for (const a of assignments) {
    const hours = Number(a.hours);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    byDate.set(a.date, Math.round(((byDate.get(a.date) ?? 0) + hours) * 100) / 100);
  }
  return [...byDate.entries()]
    .map(([date, hours]) => ({ date, hours }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Place manually assigned overtime onto a generated schedule.
 *
 * A pure transform on a finished `GeneratedSchedule`: it re-derives each day's
 * times and breaks over the new worked span, recomputes the totals and the
 * derived warnings, and REPLACES any previous assignment set (so the caller
 * always sends the full list — that is also how an assignment is cleared).
 *
 * Everything it needs is already in the schedule: `days[].hours` is the
 * distributed part, which assignment never changes, and the month's leftover is
 * `requested_hours - total_hours`.
 */
export function applyOvertimeAssignments(
  schedule: GeneratedSchedule,
  assignments: OvertimeAssignment[],
  rules: ScheduleRules,
): GeneratedSchedule {
  const normalised = normaliseOvertimeAssignments(assignments);
  const inMonth = new Set(schedule.days.map((d) => d.date));

  const kept = normalised.filter((a) => inMonth.has(a.date));
  const dropped = normalised.filter((a) => !inMonth.has(a.date));

  // Structural warnings survive re-assignment untouched; the derived ones
  // (window overrun, unassigned overtime) are recomputed by composeSchedule,
  // and the re-generation flag is re-evaluated below.
  const DERIVED = new Set<ScheduleWarningCode>([
    "window_overrun", "overtime_unassigned", "overtime_outside_month", "overtime_reassign_needed",
  ]);
  const structural = schedule.warning_details.filter((w) => !DERIVED.has(w.code));

  if (dropped.length > 0) {
    structural.push({
      code: "overtime_outside_month",
      kind: "input",
      message:
        `${dropped.length} overtime assignment${dropped.length === 1 ? "" : "s"} fell outside this ` +
        `month and ${dropped.length === 1 ? "was" : "were"} dropped: ${dropped.map((a) => a.date).join(", ")}.`,
    });
  }

  const leftover = Math.round((schedule.requested_hours - schedule.total_hours) * 100) / 100;
  const assignedHours = kept.reduce((sum, a) => sum + Math.round(a.hours * 100), 0) / 100;

  // The person assigned more than the month actually spilled over — almost
  // always because the schedule was re-generated with different numbers
  // underneath an existing assignment. Flag it rather than silently trimming.
  const overAssigned = Math.round((assignedHours - leftover) * 100) / 100;
  if (overAssigned > 0) {
    structural.push({
      code: "overtime_reassign_needed",
      kind: "action",
      message:
        `${formatHoursNL(assignedHours)} hours of overtime are assigned but only ` +
        `${formatHoursNL(leftover)} spilled over${leftover === 0 ? "" : " this time"} — ` +
        "the schedule was re-generated with different numbers. Please review the assignment.",
    });
  }

  return composeSchedule({
    all: schedule.days.map((d) => ({ ms: 0, date: d.date, weekday: d.weekday })),
    holidayByDate: new Map(
      schedule.days
        .filter((d) => d.holiday_name)
        .map((d) => [d.date, { date: d.date, name: d.holiday_name! } as PublicHoliday]),
    ),
    regularByDate: new Map(schedule.days.filter((d) => d.hours > 0).map((d) => [d.date, d.hours])),
    overtimeByDate: new Map(kept.map((a) => [a.date, a.hours])),
    rules,
    requestedHours: schedule.requested_hours,
    leftoverHours: leftover,
    requestedDays: schedule.days.filter((d) => d.hours > 0).length || 0,
    structuralWarnings: structural,
  });
}

export const monthlyScheduleGenerator: ScheduleGenerator = {
  async generate(input) {
    return generateMonthlyScheduleData(input);
  },
};
