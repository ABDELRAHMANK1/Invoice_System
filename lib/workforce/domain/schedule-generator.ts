/**
 * ScheduleGenerator — the Phase 2 seam. INTERFACE ONLY, no implementation, on
 * purpose: Phase 1 ships the data model, CRUD and UI, and the algorithm lands
 * behind this type without touching anything else.
 *
 * The scheduling use case (lib/workforce/application/generate-monthly-schedule.ts)
 * depends on THIS type and nothing from employee CRUD, so an implementation can
 * be developed and tested in isolation.
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

export interface GeneratedSchedule {
  shifts: ScheduleShift[];
  /** Sum of `shifts[].hours` — may fall short of the request; see `warnings`. */
  total_hours: number;
  /** Human-readable notes: hours that wouldn't fit, holidays skipped, … */
  warnings: string[];
}

/**
 * Phase 2 implements this. Deliberately a single pure-ish method: given the
 * input above, return the plan. Persistence stays in the use case.
 */
export interface ScheduleGenerator {
  generate(input: ScheduleGenerationInput): Promise<GeneratedSchedule>;
}
