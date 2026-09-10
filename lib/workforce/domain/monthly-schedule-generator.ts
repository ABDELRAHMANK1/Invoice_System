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
 * 7. `max_hours_per_day` is never violated. If the requested days can't hold the
 *    hours, the selection is re-spread over MORE days (the same even spread, just
 *    with a bigger n, so the extra load stays distributed across the month);
 *    only when the month runs out of eligible days does the schedule fall short —
 *    reported as a warning, never silently dropped.
 * 8. A day over `max_continuous_hours` is split into `ceil(hours / max_continuous)`
 *    blocks with a `break_minutes` break between each, all inside the same day.
 *    Pauze is the sum of those breaks (0 for a short day, 30 for one, 60 for two).
 * 9. Begintijd is the client's `work_start_time`; Eindtijd is start + worked
 *    minutes + pauze. Running past `work_end_time` is a warning, not an error —
 *    the window is a default, not a hard cap (the hard cap is max_hours_per_day).
 */

import type { PublicHoliday } from "./public-holiday";
import { clockToMinutes, minutesToClock } from "./schedule-rules";
import type {
  GeneratedSchedule,
  ScheduleDay,
  ScheduleGenerationInput,
  ScheduleGenerator,
  ScheduleShift,
} from "./schedule-generator";

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
  input: Pick<ScheduleGenerationInput, "rules" | "request" | "holidays">,
): GeneratedSchedule {
  const { rules, request, holidays } = input;
  const warnings: string[] = [];

  const holidayByDate = new Map<string, PublicHoliday>(holidays.map((h) => [h.date, h]));
  const all = monthDays(request.year, request.month);

  const eligible: EligibleDay[] = all
    .filter((d) => d.weekday <= LAST_WORKING_WEEKDAY && !holidayByDate.has(d.date));

  const skippedHolidays = all
    .filter((d) => d.weekday <= LAST_WORKING_WEEKDAY && holidayByDate.has(d.date))
    .map((d) => `${holidayByDate.get(d.date)!.name} (${d.date})`);
  if (skippedHolidays.length > 0) {
    warnings.push(`Public holidays skipped: ${skippedHolidays.join(", ")}.`);
  }

  // `working_days` counts the WHOLE MONTH, so it is bounded by the month's
  // eligible weekdays rather than by the length of a week.
  const requestedDays = Math.max(0, Math.trunc(request.working_days));
  if (requestedDays > eligible.length) {
    warnings.push(
      `${requestedDays} working days requested but the month has only ${eligible.length} ` +
      `eligible weekday${eligible.length === 1 ? "" : "s"} (weekends and public holidays excluded), ` +
      "so every one of them is worked.",
    );
  }
  if (requestedDays === 0 && request.total_hours > 0) {
    warnings.push("working_days is 0, so no working days could be selected.");
  }

  // Rule 7: widen the selection before the cap is ever violated. Widening means
  // re-spreading over a bigger n, not appending days at the end, so the extra
  // load stays evenly distributed across the month.
  // `working_days: 0` is not "as few days as possible", it is "no working days":
  // widening there would schedule days the caller explicitly ruled out, so the
  // hours are reported as unscheduled instead.
  const capPerDay = Math.max(0, rules.max_hours_per_day);
  const daysNeeded = capPerDay > 0 ? Math.ceil(Math.round(request.total_hours * 100) / (capPerDay * 100) - EPS) : 0;
  let targetDays = Math.min(requestedDays, eligible.length);
  if (requestedDays > 0 && daysNeeded > targetDays) {
    const grown = Math.min(daysNeeded, eligible.length);
    if (grown > targetDays) {
      warnings.push(
        `${grown - targetDays} extra working day${grown - targetDays === 1 ? "" : "s"} added beyond the ` +
        `${requestedDays} requested: ${request.total_hours} hours do not fit in ` +
        `${targetDays} day${targetDays === 1 ? "" : "s"} at ${rules.max_hours_per_day} h/day.`,
      );
      targetDays = grown;
    }
  }

  const workingDays = selectEvenlySpreadDays(eligible, targetDays);

  const { hours: perDay, unplacedCents } = distributeHours(request.total_hours, workingDays.length, capPerDay);
  if (unplacedCents > 0) {
    warnings.push(
      `${(unplacedCents / 100).toFixed(2)} hours could not be scheduled: the month has only ` +
      `${eligible.length} eligible working day${eligible.length === 1 ? "" : "s"} at ` +
      `${rules.max_hours_per_day} h/day.`,
    );
  }

  const startMinutes = clockToMinutes(rules.work_start_time) ?? 8 * 60;
  const windowEnd = clockToMinutes(rules.work_end_time);

  const plannedByDate = new Map<string, { hours: number; breakMinutes: number; start: string; end: string; endMinutes: number }>();
  workingDays.forEach((day, i) => {
    const hours = perDay[i] ?? 0;
    if (hours <= 0) return;
    const breakMinutes = breakCountForDay(hours, rules.max_continuous_hours) * rules.break_minutes;
    // Truncated, not rounded: 3,33 h is 199 minutes of work, so 07:00 + pauze
    // ends at 10:49 — the same arithmetic the reference timesheet uses.
    const workedMinutes = Math.floor(hours * 60 + 1e-6);
    const endMinutes = startMinutes + workedMinutes + breakMinutes;
    plannedByDate.set(day.date, {
      hours,
      breakMinutes,
      start: minutesToClock(startMinutes),
      end: minutesToClock(endMinutes),
      endMinutes,
    });
  });

  const overruns = [...plannedByDate.values()].filter((p) => windowEnd != null && p.endMinutes > windowEnd);
  if (overruns.length > 0 && windowEnd != null) {
    const latest = minutesToClock(Math.max(...overruns.map((p) => p.endMinutes)));
    warnings.push(
      `${overruns.length} day${overruns.length === 1 ? "" : "s"} end after the client's ` +
      `${rules.work_end_time} window (latest ${latest}).`,
    );
  }

  const days: ScheduleDay[] = all.map((d) => {
    const dayName = DUTCH_WEEKDAYS[d.weekday - 1];
    const planned = plannedByDate.get(d.date);
    if (planned) {
      return {
        date: d.date, weekday: d.weekday, day_name: dayName, kind: "worked",
        holiday_name: null,
        start: planned.start, end: planned.end,
        break_minutes: planned.breakMinutes, hours: planned.hours,
      };
    }
    const holiday = holidayByDate.get(d.date);
    const kind = d.weekday > LAST_WORKING_WEEKDAY ? "weekend" : holiday ? "holiday" : "free";
    return {
      date: d.date, weekday: d.weekday, day_name: dayName, kind,
      holiday_name: holiday?.name ?? null,
      start: null, end: null, break_minutes: 0, hours: 0,
    };
  });

  const shifts: ScheduleShift[] = days
    .filter((d) => d.kind === "worked")
    .map((d) => ({ date: d.date, start: d.start!, end: d.end!, hours: d.hours, break_minutes: d.break_minutes }));

  // Summed in cents so the total is exactly the sum of the printed rows.
  const totalHours = shifts.reduce((sum, s) => sum + Math.round(s.hours * 100), 0) / 100;

  return {
    shifts,
    days,
    total_hours: totalHours,
    requested_hours: request.total_hours,
    totals: { hours: totalHours, overtime_hours: 0, km_allowance: 0, worked_days: shifts.length },
    warnings,
  };
}

export const monthlyScheduleGenerator: ScheduleGenerator = {
  async generate(input) {
    return generateMonthlyScheduleData(input);
  },
};
