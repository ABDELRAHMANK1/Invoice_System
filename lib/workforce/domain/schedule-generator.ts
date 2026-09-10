/**
 * ScheduleGenerator — the seam Phase 1 left open and Phase 2 fills in.
 *
 * The scheduling use case (lib/workforce/application/generate-monthly-schedule.ts)
 * depends on THIS type and nothing from employee CRUD, so an implementation can
 * be developed and tested in isolation. The implementation is
 * `monthlyScheduleGenerator` in ./monthly-schedule-generator.ts — still pure, so
 * it stays in the domain layer next to this interface.
 *
 * Phase 2 widened `GeneratedSchedule` ADDITIVELY: `shifts` / `total_hours` /
 * `warnings` mean exactly what they meant before, and `days` + `totals` carry
 * the whole-month view the timesheet renders.
 */

import type { Employee } from "./employee";
import type { PublicHoliday } from "./public-holiday";
import type { ScheduleRules } from "./schedule-rules";
import type { MonthlyScheduleRequest } from "./monthly-schedule";

/** Everything a generator is allowed to look at. No repositories, no IO. */
export interface ScheduleGenerationInput {
  employee: Employee;
  /** The employee's own rate, or the client's default — already resolved. */
  hourly_rate: number | null;
  rules: ScheduleRules;
  request: MonthlyScheduleRequest;
  /** Public holidays falling inside the requested month. */
  holidays: PublicHoliday[];
}

/** One planned working day. Times are local "HH:MM" wall clock. */
export interface ScheduleShift {
  date: string;
  start: string;
  end: string;
  /** Paid hours, excluding `break_minutes`. */
  hours: number;
  break_minutes: number;
}

/** Why a calendar day looks the way it does on the timesheet. */
export const SCHEDULE_DAY_KINDS = ["worked", "weekend", "holiday", "free"] as const;
export type ScheduleDayKind = (typeof SCHEDULE_DAY_KINDS)[number];

/**
 * One calendar day — EVERY day of the month gets one, worked or not, because
 * the Urenlijst prints the full month in date order (blank rows included).
 */
export interface ScheduleDay {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Dutch weekday name — the "Dag" column. */
  day_name: string;
  kind: ScheduleDayKind;
  /** Set only on `holiday` days. */
  holiday_name: string | null;
  /** Times + hours are non-null only on `worked` days. */
  start: string | null;
  end: string | null;
  break_minutes: number;
  hours: number;
}

/**
 * The footer row. `overtime_hours` / `km_allowance` are structurally 0: the
 * Overuren and Km-vergoeding columns are manual, out of this feature's scope,
 * and only kept so the printed totals row reconciles column-for-column.
 */
export interface ScheduleTotals {
  hours: number;
  overtime_hours: number;
  km_allowance: number;
  worked_days: number;
}

export interface GeneratedSchedule {
  shifts: ScheduleShift[];
  /** Every day of the month in date order — the timesheet's rows. */
  days: ScheduleDay[];
  /** Sum of `shifts[].hours` — may fall short of the request; see `warnings`. */
  total_hours: number;
  /** What the caller asked for, kept so a shortfall is visible in the record. */
  requested_hours: number;
  totals: ScheduleTotals;
  /** Human-readable notes: hours that wouldn't fit, holidays skipped, … */
  warnings: string[];
}

/**
 * Deliberately a single pure-ish method: given the input above, return the plan.
 * Persistence stays in the use case.
 */
export interface ScheduleGenerator {
  generate(input: ScheduleGenerationInput): Promise<GeneratedSchedule>;
}
