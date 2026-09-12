import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SCHEDULE_RULES } from "@/lib/workforce/domain";

/**
 * Migration 015 — "lower the daily cap to 8, but only where it is still the old
 * default".
 *
 * There is no Postgres in this test environment (no docker, no local server), so
 * these tests do NOT execute the SQL. They cover it two ways:
 *   1. a SPECIFICATION test of the selection rule over fixture rows — the rule
 *      the SQL implements, stated independently;
 *   2. a DRIFT GUARD that reads the real .sql file and asserts the predicates
 *      that rule depends on are actually the ones written there.
 * Together they catch the realistic failure (someone edits the migration, or
 * the rule is misremembered) without pretending to run the database.
 */

const SQL = readFileSync(
  join(process.cwd(), "db/migrations/015_max_hours_per_day_8.sql"),
  "utf8",
);

/** Just the UPDATE statement — the read-only reporting queries below it also
 *  mention max_hours_per_day and must not be mistaken for the write. */
const UPDATE_STATEMENT = /update\s+public\.client_schedule_rules[\s\S]*?;/i.exec(SQL)?.[0] ?? "";

const OLD_DEFAULT = 10;
const NEW_CAP = 8;

interface RulesRow {
  client_id: string;
  max_hours_per_day: number;
  max_continuous_hours: number;
}

/** The rule migration 015 implements, as a pure function over rows. */
function applyMigration015(rows: RulesRow[]): RulesRow[] {
  return rows.map((row) =>
    row.max_hours_per_day === OLD_DEFAULT
      ? {
          ...row,
          max_hours_per_day: NEW_CAP,
          max_continuous_hours: Math.min(row.max_continuous_hours, NEW_CAP),
        }
      : row,
  );
}

const row = (client_id: string, max_hours_per_day: number, max_continuous_hours = 4): RulesRow =>
  ({ client_id, max_hours_per_day, max_continuous_hours });

describe("migration 015 — which rows it touches", () => {
  it("lowers rows still sitting at the old default of 10", () => {
    const [out] = applyMigration015([row("c1", 10)]);
    expect(out.max_hours_per_day).toBe(8);
  });

  it("leaves every deliberately customised value alone", () => {
    // Including values ABOVE the new cap: the instruction is not to overwrite a
    // customisation, so 12 survives and is reported for manual review instead.
    const before = [row("c1", 6), row("c2", 9), row("c3", 12), row("c4", 8), row("c5", 24)];
    expect(applyMigration015(before)).toEqual(before);
  });

  it("is idempotent — a second run changes nothing", () => {
    const once = applyMigration015([row("c1", 10), row("c2", 12)]);
    expect(applyMigration015(once)).toEqual(once);
  });

  it("clamps max_continuous_hours on the rows it lowers, keeping them coherent", () => {
    // A 9-hour continuous threshold under an 8-hour day is the incoherent state
    // scheduleRulesError rejects; the DB has no cross-column check to stop it,
    // so the migration must not create it.
    const [out] = applyMigration015([row("c1", 10, 9)]);
    expect(out.max_hours_per_day).toBe(8);
    expect(out.max_continuous_hours).toBe(8);
    expect(out.max_continuous_hours).toBeLessThanOrEqual(out.max_hours_per_day);
  });

  it("does not raise a continuous threshold that was already lower", () => {
    const [out] = applyMigration015([row("c1", 10, 4)]);
    expect(out.max_continuous_hours).toBe(4);
  });

  it("never touches a customised row's continuous threshold either", () => {
    const [out] = applyMigration015([row("c1", 12, 11)]);
    expect(out).toEqual(row("c1", 12, 11));
  });
});

describe("migration 015 — the SQL matches that rule", () => {
  it("has exactly one UPDATE, selecting on the old default and not a range", () => {
    expect(UPDATE_STATEMENT).not.toBe("");
    expect(SQL.match(/update\s+public\./gi) ?? []).toHaveLength(1);
    expect(UPDATE_STATEMENT).toMatch(/where\s+max_hours_per_day\s*=\s*10/i);
    // A range would sweep up customised values like 12.
    expect(UPDATE_STATEMENT).not.toMatch(/where[\s\S]*max_hours_per_day\s*[<>]/i);
  });

  it("writes the new cap and clamps the continuous threshold with it", () => {
    expect(UPDATE_STATEMENT).toMatch(/set\s+max_hours_per_day\s*=\s*8/i);
    expect(UPDATE_STATEMENT).toMatch(/max_continuous_hours\s*=\s*least\(max_continuous_hours,\s*8\)/i);
  });

  it("lowers the column default for rows created later", () => {
    expect(SQL).toMatch(/alter\s+column\s+max_hours_per_day\s+set\s+default\s+8/i);
  });

  it("reports rows left above the new cap instead of hiding them", () => {
    expect(SQL).toMatch(/max_hours_per_day\s*>\s*8/);
    expect(SQL).toMatch(/raise notice/i);
  });

  it("agrees with the code default it mirrors", () => {
    expect(DEFAULT_SCHEDULE_RULES.max_hours_per_day).toBe(NEW_CAP);
  });
});
