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
 *
 * OVERTIME. The generator never schedules a day past `max_hours_per_day`, and
 * never invents extra days to make hours fit. Whatever `total_hours` exceeds
 * `working_days × max_hours_per_day` is LEFTOVER — reported, not placed — and a
 * human assigns it to specific dates afterwards. Assigned overtime is carried
 * per day in `ScheduleDay.overtime_hours`, deliberately separate from `hours`:
 * `hours` is what the algorithm distributed, `overtime_hours` is what a person
 * decided, and the timesheet prints them in different columns.
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
  /**
   * Overtime a person already assigned for this month, carried in by the use
   * case on a RE-generation so it is not silently discarded. Absent on a first
   * generation. See `overtime_reassign_needed`.
   */
  existing_overtime?: OvertimeAssignment[];
}

/** Overtime a human assigned to one date. Hours are per date, not cumulative. */
export interface OvertimeAssignment {
  /** ISO date, YYYY-MM-DD. Must fall inside the schedule's month. */
  date: string;
  hours: number;
}

/** One planned working day. Times are local "HH:MM" wall clock. */
export interface ScheduleShift {
  date: string;
  start: string;
  end: string;
  /** Distributed hours, excluding `break_minutes` and `overtime_hours`. */
  hours: number;
  /** Manually assigned overtime on this date; 0 on an untouched day. */
  overtime_hours: number;
  /** Breaks across the WHOLE worked span, regular + overtime. */
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
  /**
   * Times are non-null whenever the day carries worked time — that is
   * `hours > 0` OR `overtime_hours > 0`, so a date that only ever received
   * manually assigned overtime still prints a start and an end.
   */
  start: string | null;
  end: string | null;
  /** Breaks across the WHOLE worked span, regular + overtime. */
  break_minutes: number;
  /** What the algorithm distributed. Never above `max_hours_per_day`. */
  hours: number;
  /**
   * What a person assigned on top — the "Overuren" column. 0 until someone
   * assigns leftover hours to this date. Kept apart from `hours` so the two
   * never blur: one is generated, the other is a human decision.
   */
  overtime_hours: number;
}

/**
 * The footer row. `km_allowance` is still structurally 0 — that column stays
 * manual and out of scope — but `overtime_hours` is now real: the sum of what
 * has been assigned across the month.
 */
export interface ScheduleTotals {
  /** Sum of the distributed `hours`, excluding overtime. */
  hours: number;
  /** Sum of the assigned `overtime_hours`. */
  overtime_hours: number;
  km_allowance: number;
  /** Days carrying worked time — regular hours, assigned overtime, or both. */
  worked_days: number;
}

/** The month's overtime position: what spilled over, and what was done with it. */
export interface ScheduleOvertime {
  /**
   * `requested_hours` minus what the capped days could hold — the hours a
   * person still has to place. Does NOT shrink as assignments are made; see
   * `unassigned_hours` for what is still outstanding.
   */
  leftover_hours: number;
  /** Sum of `assignments[].hours`. */
  assigned_hours: number;
  /** `leftover_hours - assigned_hours`, floored at 0. */
  unassigned_hours: number;
  /** Per-date assignments, in date order. */
  assignments: OvertimeAssignment[];
}

/**
 * What a warning is really telling the reader — the dashboard styles by this,
 * because these call for different reactions:
 *   action   — the schedule is incomplete until a PERSON does something. The
 *              dashboard turns these into a form, not a note.
 *   input    — the numbers as typed look wrong; go re-check them.
 *   capacity — the month genuinely cannot hold the request. The input may be
 *              perfectly correct; the calendar is the limit.
 *   info     — the generator handled something on its own; nothing to act on.
 */
export const SCHEDULE_WARNING_KINDS = ["action", "input", "capacity", "info"] as const;
export type ScheduleWarningKind = (typeof SCHEDULE_WARNING_KINDS)[number];

export const SCHEDULE_WARNING_CODES = [
  /** Leftover hours the capped days could not hold, awaiting assignment. */
  "overtime_unassigned",
  /** A re-generation changed the leftover; existing assignments need review. */
  "overtime_reassign_needed",
  /** An assignment's date fell outside the month and was dropped. */
  "overtime_outside_month",
  /** working_days is 0 but hours were requested. */
  "no_working_days",
  /** More days requested than the month has eligible weekdays. */
  "days_requested_exceed_month",
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
  /** Leftover / assigned overtime for the month. */
  overtime: ScheduleOvertime;
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
