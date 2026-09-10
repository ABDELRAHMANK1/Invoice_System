/**
 * Supabase implementation of the schedule-rules port.
 * One row per client — `client_id` is the primary key, so a save is an upsert.
 */

import { supabaseAdmin } from "@/lib/supabase-admin";
import type { ScheduleRules, ScheduleRulesRepository } from "@/lib/workforce/domain";
import { DEFAULT_SCHEDULE_RULES } from "@/lib/workforce/domain";
import { NotFoundError } from "@/lib/workforce/application/errors";

const TABLE = "client_schedule_rules";

type Row = Record<string, unknown>;

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Postgres hands `time` back as "08:00:00"; the domain works in "HH:MM". */
function clock(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : fallback;
}

function toRules(row: Row): ScheduleRules {
  return {
    client_id: String(row.client_id),
    max_continuous_hours: num(row.max_continuous_hours, DEFAULT_SCHEDULE_RULES.max_continuous_hours),
    break_minutes: num(row.break_minutes, DEFAULT_SCHEDULE_RULES.break_minutes),
    max_hours_per_day: num(row.max_hours_per_day, DEFAULT_SCHEDULE_RULES.max_hours_per_day),
    work_start_time: clock(row.work_start_time, DEFAULT_SCHEDULE_RULES.work_start_time),
    work_end_time: clock(row.work_end_time, DEFAULT_SCHEDULE_RULES.work_end_time),
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
  };
}

export const supabaseScheduleRulesRepository: ScheduleRulesRepository = {
  async findByClient(clientId) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toRules(data) : null;
  },

  async save(clientId, input) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .upsert({ ...input, client_id: clientId, updated_at: new Date().toISOString() },
              { onConflict: "client_id" })
      .select("*")
      .maybeSingle();
    if (error) {
      if (error.code === "23503") throw new NotFoundError("Client");
      throw new Error(error.message);
    }
    if (!data) throw new Error("Schedule rules upsert returned no data");
    return toRules(data);
  },
};
