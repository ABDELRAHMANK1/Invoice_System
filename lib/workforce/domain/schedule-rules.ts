/**
 * Per-client scheduling rules — the constraints a future generator must respect.
 * Stored one row per client in `client_schedule_rules` (migration 011); a client
 * with no row falls back to DEFAULT_SCHEDULE_RULES below.
 *
 * These defaults mirror the column defaults in migration 011. If you change one,
 * change the other.
 */

export interface ScheduleRules {
  client_id: string;
  /** Max continuous working hours before a break is required. */
  max_continuous_hours: number;
  /** Length of that required break, in minutes. */
  break_minutes: number;
  /** Safety cap — no generated day may exceed this. */
  max_hours_per_day: number;
  /** Absent when the rules are the unsaved defaults. */
  created_at?: string;
  updated_at?: string;
}

export type ScheduleRulesInput = Pick<
  ScheduleRules,
  "max_continuous_hours" | "break_minutes" | "max_hours_per_day"
>;

export const DEFAULT_SCHEDULE_RULES: ScheduleRulesInput = {
  max_continuous_hours: 4,
  break_minutes: 30,
  max_hours_per_day: 10,
};

/** The stored rules for a client, or the defaults when nothing is saved yet. */
export function scheduleRulesOrDefaults(
  clientId: string,
  stored: ScheduleRules | null,
): ScheduleRules {
  return stored ?? { client_id: clientId, ...DEFAULT_SCHEDULE_RULES };
}

/**
 * Consistency check that spans two columns, so it can't live in a per-field
 * schema: a break is only meaningful if it can fit inside a working day.
 * Returns an error message, or null when the set is coherent.
 */
export function scheduleRulesError(rules: ScheduleRulesInput): string | null {
  if (rules.max_continuous_hours > rules.max_hours_per_day) {
    return "max_continuous_hours cannot exceed max_hours_per_day — a break would never be reachable";
  }
  return null;
}

/** Persistence port. Implemented in the infrastructure layer. */
export interface ScheduleRulesRepository {
  /** `null` when the client has never saved rules (caller applies the defaults). */
  findByClient(clientId: string): Promise<ScheduleRules | null>;
  save(clientId: string, input: ScheduleRulesInput): Promise<ScheduleRules>;
}
