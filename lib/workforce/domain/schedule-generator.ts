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

/**
 * What a warning is really telling the reader — the dashboard styles by this,
 * because these three call for different reactions:
 *   input    — the numbers AS TYPED look wrong; go re-check them. The generator
 *              may well have compensated, but a likely data-entry mistake is
 *              worth surfacing anyway.
 *   capacity — the month genuinely cannot hold the request. The input may be
 *              perfectly correct; the calendar is the limit.
 *   info     — the generator handled something on its own; nothing to act on.
 */
export const SCHEDULE_WARNING_KINDS = ["input", "capacity", "info"] as const;
export type ScheduleWarningKind = (typeof SCHEDULE_WARNING_KINDS)[number];

export const SCHEDULE_WARNING_CODES = [
  /** total_hours / working_days, as entered, is over max_hours_per_day. */
  "input_exceeds_daily_cap",
  /** working_days is 0 but hours were requested. */
  "no_working_days",
  /** More days requested than the month has eligible weekdays. */
  "days_requested_exceed_month",
  /** Hours that no eligible day could take. */
  "hours_unplaced",
  /** The selection grew past the request to respect the daily cap. */
  "days_expanded",
  /** Public holidays fell on weekdays and were skipped. */
  "holidays_skipped",
  /** A day ends after the client's work_end_time. */
  "window_overrun",
] as const;
export type ScheduleWarningCode = (typeof SCHEDULE_WARNING_CODES)[number];

export interface ScheduleWarning {
  code: ScheduleWarningCode;
  kind: ScheduleWarningKind;
  message: string;
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
  /**
   * Human-readable notes: hours that wouldn't fit, holidays skipped, …
   * Kept as flat strings so schedules generated before `warning_details`
   * existed still render; it is exactly `warning_details.map(w => w.message)`.
   */
  warnings: string[];
  /** The same notes, classified — see `ScheduleWarning`. */
  warning_details: ScheduleWarning[];
}

/**
 * Deliberately a single pure-ish method: given the input above, return the plan.
 * Persistence stays in the use case.
 */
export interface ScheduleGenerator {
  generate(input: ScheduleGenerationInput): Promise<GeneratedSchedule>;
}
