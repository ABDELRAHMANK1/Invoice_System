/**
 * Per-client scheduling rules — the constraints the generator must respect.
 * Stored one row per client in `client_schedule_rules` (migrations 011 + 012); a
 * client with no row falls back to DEFAULT_SCHEDULE_RULES below.
 *
 * These defaults mirror the column defaults in migrations 011/012. If you change
 * one, change the other.
 */

/** Wall-clock "HH:MM". The `time` columns are wall clock, never an instant. */
export type ClockTime = string;

export interface ScheduleRules {
  client_id: string;
  /** Max continuous working hours before a break is required. */
  max_continuous_hours: number;
  /** Length of that required break, in minutes. */
  break_minutes: number;
  /** Safety cap — no generated day may exceed this. */
  max_hours_per_day: number;
  /** Start of the client's working window; every generated Begintijd. */
  work_start_time: ClockTime;
  /** End of the window. Soft: overrunning it is a warning, not a rejection. */
  work_end_time: ClockTime;
  /** Absent when the rules are the unsaved defaults. */
  created_at?: string;
  updated_at?: string;
}

export type ScheduleRulesInput = Pick<
  ScheduleRules,
  "max_continuous_hours" | "break_minutes" | "max_hours_per_day" | "work_start_time" | "work_end_time"
>;

export const DEFAULT_SCHEDULE_RULES: ScheduleRulesInput = {
  max_continuous_hours: 4,
  break_minutes: 30,
  max_hours_per_day: 10,
  work_start_time: "08:00",
  work_end_time: "17:00",
};

/** The stored rules for a client, or the defaults when nothing is saved yet. */
export function scheduleRulesOrDefaults(
  clientId: string,
  stored: ScheduleRules | null,
): ScheduleRules {
  return stored ?? { client_id: clientId, ...DEFAULT_SCHEDULE_RULES };
}

/** "HH:MM" / "HH:MM:SS" → minutes since midnight; null when unparseable. */
export function clockToMinutes(time: ClockTime | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((time ?? "").trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since midnight → "HH:MM". Wraps past midnight so a long day still prints. */
export function minutesToClock(minutes: number): ClockTime {
  const wrapped = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/**
 * Consistency checks that span two columns, so they can't live in a per-field
 * schema. Returns an error message, or null when the set is coherent.
 */
export function scheduleRulesError(rules: ScheduleRulesInput): string | null {
  if (rules.max_continuous_hours > rules.max_hours_per_day) {
    return "max_continuous_hours cannot exceed max_hours_per_day — a break would never be reachable";
  }
  const start = clockToMinutes(rules.work_start_time);
  const end = clockToMinutes(rules.work_end_time);
  if (start == null || end == null) return "work_start_time and work_end_time must be HH:MM times";
  if (end <= start) return "work_end_time must be later than work_start_time";
  return null;
}

/** Persistence port. Implemented in the infrastructure layer. */
export interface ScheduleRulesRepository {
  /** `null` when the client has never saved rules (caller applies the defaults). */
  findByClient(clientId: string): Promise<ScheduleRules | null>;
  save(clientId: string, input: ScheduleRulesInput): Promise<ScheduleRules>;
}
