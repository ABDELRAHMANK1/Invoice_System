/**
 * Request-body validation for the employee + schedule-rules endpoints, as zod
 * field bundles spread into both the create and the patch schema so the two
 * can't drift — the same pattern as lib/customer-schema.ts.
 */

import { z } from "zod";
import { DEFAULT_SCHEDULE_RULES } from "@/lib/workforce/domain";

/** Money field, matching the numeric(15, 2) non-negative columns. */
const rateField = z.number().nonnegative().max(1_000_000).optional().nullable();

export const employeeFields = {
  phone:                 z.string().max(32).optional().nullable(),
  /** "Functie" on the timesheet (migration 012). */
  function_title:        z.string().max(200).optional().nullable(),
  /** null clears the override → the employee inherits the client's rate. */
  hourly_rate:           rateField,
  /** Default working days per MONTH, so 0..31 rather than 0..7. */
  default_working_days:  z.number().int().min(0).max(31).optional(),
  active:                z.boolean().optional(),
  notes:                 z.string().max(2000).optional().nullable(),
};

export const createEmployeeSchema = z.object({
  name: z.string().min(1).max(200),
  ...employeeFields,
});

export const patchEmployeeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  ...employeeFields,
});

/**
 * `clients.default_hourly_rate` — spread into the clients PATCH schema so the
 * one column this feature adds to an existing table is validated identically
 * wherever it is written.
 */
export const clientDefaultHourlyRateField = { default_hourly_rate: rateField };

/** Wall-clock "HH:MM" (or "HH:MM:SS" as Postgres hands `time` back), normalised to HH:MM. */
const clockTimeField = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Time must be HH:MM")
  .transform((v) => v.slice(0, 5));

/**
 * PUT is a full replace, so every rule is written on every save. The two work-window
 * fields (migration 012) default rather than being required: a client saved before
 * they existed, or a caller that only cares about the break rules, still gets a
 * coherent row instead of a 400.
 */
export const scheduleRulesSchema = z.object({
  max_continuous_hours: z.number().positive().max(24),
  break_minutes:        z.number().int().min(0).max(480),
  max_hours_per_day:    z.number().positive().max(24),
  work_start_time:      clockTimeField.default(DEFAULT_SCHEDULE_RULES.work_start_time),
  work_end_time:        clockTimeField.default(DEFAULT_SCHEDULE_RULES.work_end_time),
});

/**
 * One generation request. Both amounts are MONTH totals: `total_hours` for the
 * month and `working_days` days across that month (never a per-week count).
 * `working_days` is optional — omitted, the use case falls back to the
 * employee's `default_working_days`.
 */
export const generateScheduleSchema = z.object({
  year:         z.number().int().min(2000).max(2100),
  month:        z.number().int().min(1).max(12),
  total_hours:  z.number().nonnegative().max(1000),
  working_days: z.number().int().min(0).max(31).optional(),
});

export type CreateEmployeeBody = z.infer<typeof createEmployeeSchema>;
export type PatchEmployeeBody = z.infer<typeof patchEmployeeSchema>;
export type ScheduleRulesBody = z.infer<typeof scheduleRulesSchema>;
export type GenerateScheduleBody = z.infer<typeof generateScheduleSchema>;
