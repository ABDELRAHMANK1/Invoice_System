/**
 * The storage shape for a generated monthly schedule (`employee_monthly_schedules`,
 * migration 011). Phase 1 defines the shape only — nothing writes these rows yet.
 */

export const SCHEDULE_STATUSES = ["draft", "generated", "approved", "archived"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/** What was asked for: "160 hours across 5 days a week in March 2027". */
export interface MonthlyScheduleRequest {
  employee_id: string;
  client_id: string;
  year: number;
  month: number;
  total_hours: number;
  days_per_week: number;
}

export interface EmployeeMonthlySchedule extends MonthlyScheduleRequest {
  id: string;
  status: ScheduleStatus;
  /**
   * Free-form generator output — shifts, warnings, whatever Phase 2 needs. Kept
   * as jsonb (like invoices.line_items / raw_extraction) so the generated shape
   * can evolve without another migration. `{}` until a generator fills it.
   */
  schedule_data: Record<string, unknown>;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Persistence port. No implementation in Phase 1 — nothing writes schedules yet. */
export interface MonthlyScheduleRepository {
  findByPeriod(employeeId: string, year: number, month: number): Promise<EmployeeMonthlySchedule | null>;
  listByClientPeriod(clientId: string, year: number, month: number): Promise<EmployeeMonthlySchedule[]>;
  save(request: MonthlyScheduleRequest, result: {
    status: ScheduleStatus;
    schedule_data: Record<string, unknown>;
    generated_at: string | null;
  }): Promise<EmployeeMonthlySchedule>;
}
