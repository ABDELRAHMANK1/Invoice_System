/**
 * Supabase implementation of the monthly-schedule port.
 *
 * One row per (employee, year, month) — `employee_monthly_schedules_unique`
 * (migration 011) — so a re-generation is an upsert on that triple rather than a
 * second row: regenerating a month replaces it, it never accumulates versions.
 */

import { supabaseAdmin } from "@/lib/supabase-admin";
import type { EmployeeMonthlySchedule, MonthlyScheduleRepository, ScheduleStatus } from "@/lib/workforce/domain";
import { NotFoundError } from "@/lib/workforce/application/errors";

const TABLE = "employee_monthly_schedules";

type Row = Record<string, unknown>;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toSchedule(row: Row): EmployeeMonthlySchedule {
  return {
    id: String(row.id),
    employee_id: String(row.employee_id),
    client_id: String(row.client_id),
    year: num(row.year),
    month: num(row.month),
    total_hours: num(row.total_hours),
    working_days: num(row.working_days),
    status: String(row.status ?? "draft") as ScheduleStatus,
    schedule_data: (row.schedule_data as Record<string, unknown>) ?? {},
    generated_at: (row.generated_at as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export const supabaseMonthlyScheduleRepository: MonthlyScheduleRepository = {
  async findByPeriod(employeeId, year, month) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("employee_id", employeeId)
      .eq("year", year)
      .eq("month", month)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toSchedule(data) : null;
  },

  async listByClientPeriod(clientId, year, month) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("client_id", clientId)
      .eq("year", year)
      .eq("month", month);
    if (error) throw new Error(error.message);
    return (data ?? []).map(toSchedule);
  },

  async save(request, result) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .upsert(
        { ...request, ...result, updated_at: new Date().toISOString() },
        { onConflict: "employee_id,year,month" },
      )
      .select("*")
      .maybeSingle();
    if (error) {
      // The employee (or client) was deleted between the lookup and the write.
      if (error.code === "23503") throw new NotFoundError("Employee");
      throw new Error(error.message);
    }
    if (!data) throw new Error("Monthly schedule upsert returned no data");
    return toSchedule(data);
  },
};
