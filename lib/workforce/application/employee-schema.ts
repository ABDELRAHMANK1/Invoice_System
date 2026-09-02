/**
 * Request-body validation for the employee + schedule-rules endpoints, as zod
 * field bundles spread into both the create and the patch schema so the two
 * can't drift — the same pattern as lib/customer-schema.ts.
 */

import { z } from "zod";

/** Money field, matching the numeric(15, 2) non-negative columns. */
const rateField = z.number().nonnegative().max(1_000_000).optional().nullable();

export const employeeFields = {
  phone:                 z.string().max(32).optional().nullable(),
  /** null clears the override → the employee inherits the client's rate. */
  hourly_rate:           rateField,
  default_days_per_week: z.number().int().min(0).max(7).optional(),
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

export const scheduleRulesSchema = z.object({
  max_continuous_hours: z.number().positive().max(24),
  break_minutes:        z.number().int().min(0).max(480),
  max_hours_per_day:    z.number().positive().max(24),
});

export type CreateEmployeeBody = z.infer<typeof createEmployeeSchema>;
export type PatchEmployeeBody = z.infer<typeof patchEmployeeSchema>;
export type ScheduleRulesBody = z.infer<typeof scheduleRulesSchema>;
