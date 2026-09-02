import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCHEDULE_RULES,
  dutchPublicHolidays,
  easterSunday,
  effectiveHourlyRate,
  koningsdag,
  scheduleRulesError,
  scheduleRulesOrDefaults,
} from "@/lib/workforce/domain";
import type { Employee, EmployeeRepository, ClientRateRepository } from "@/lib/workforce/domain";
import {
  createEmployee,
  deactivateEmployee,
  listEmployees,
  setClientDefaultHourlyRate,
  updateEmployee,
} from "@/lib/workforce/application/employee-use-cases";
import { NotFoundError } from "@/lib/workforce/application/errors";

/* ── domain: rate inheritance ─────────────────────────────────────── */

const employee = (over: Partial<Employee> = {}): Employee => ({
  id: "e1",
  client_id: "c1",
  name: "Jan de Vries",
  phone: null,
  hourly_rate: null,
  default_days_per_week: 5,
  active: true,
  notes: null,
  created_at: "",
  updated_at: "",
  ...over,
});

describe("effectiveHourlyRate", () => {
  it("uses the employee's own rate when set", () => {
    expect(effectiveHourlyRate(employee({ hourly_rate: 22.5 }), 18)).toEqual({ rate: 22.5, source: "employee" });
  });

  it("falls back to the client's default when the employee has none", () => {
    expect(effectiveHourlyRate(employee(), 18)).toEqual({ rate: 18, source: "client" });
  });

  it("treats a 0 override as a real rate, not as unset", () => {
    expect(effectiveHourlyRate(employee({ hourly_rate: 0 }), 18)).toEqual({ rate: 0, source: "employee" });
  });

  it("reports 'none' when neither side has a rate", () => {
    expect(effectiveHourlyRate(employee(), null)).toEqual({ rate: null, source: "none" });
  });
});

/* ── domain: Dutch public holidays ────────────────────────────────── */

describe("dutch public holidays", () => {
  // Reference Easter Sundays (Gregorian computus).
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2028, "2028-04-16"],
  ])("computes Easter %i as %s", (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });

  it("moves Koningsdag to 26 April when the 27th is a Sunday", () => {
    expect(koningsdag(2025)).toBe("2025-04-26"); // 27 Apr 2025 is a Sunday
    expect(koningsdag(2026)).toBe("2026-04-27");
  });

  it("derives the Easter-based holidays for 2026", () => {
    const byName = Object.fromEntries(dutchPublicHolidays(2026).map((h) => [h.name, h.date]));
    expect(byName["Goede Vrijdag"]).toBe("2026-04-03");
    expect(byName["Eerste Paasdag"]).toBe("2026-04-05");
    expect(byName["Tweede Paasdag"]).toBe("2026-04-06");
    expect(byName["Hemelvaartsdag"]).toBe("2026-05-14");
    expect(byName["Eerste Pinksterdag"]).toBe("2026-05-24");
    expect(byName["Tweede Pinksterdag"]).toBe("2026-05-25");
  });

  it("includes the fixed days and returns them in date order", () => {
    const list = dutchPublicHolidays(2027);
    expect(list).toHaveLength(11);
    expect(list[0]).toMatchObject({ date: "2027-01-01", name: "Nieuwjaarsdag", country: "NL" });
    expect(list.at(-1)).toMatchObject({ date: "2027-12-26", name: "Tweede Kerstdag" });
    const dates = list.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

/* ── domain: schedule rules ───────────────────────────────────────── */

describe("schedule rules", () => {
  it("falls back to the documented defaults when nothing is stored", () => {
    expect(scheduleRulesOrDefaults("c1", null)).toEqual({ client_id: "c1", ...DEFAULT_SCHEDULE_RULES });
    expect(DEFAULT_SCHEDULE_RULES).toEqual({ max_continuous_hours: 4, break_minutes: 30, max_hours_per_day: 10 });
  });

  it("rejects a break threshold a working day can never reach", () => {
    expect(scheduleRulesError({ max_continuous_hours: 12, break_minutes: 30, max_hours_per_day: 10 }))
      .toMatch(/max_continuous_hours cannot exceed/);
    expect(scheduleRulesError(DEFAULT_SCHEDULE_RULES)).toBeNull();
  });
});

/* ── application: use cases against fake repositories ─────────────── */

function fakeRepos(seed: Employee[] = [], clientRate: number | null = null, clientExists = true) {
  const rows = [...seed];
  const employees: EmployeeRepository = {
    async listByClient(clientId, opts) {
      return rows.filter((e) => e.client_id === clientId && (!opts?.activeOnly || e.active));
    },
    async findById(clientId, id) {
      return rows.find((e) => e.id === id && e.client_id === clientId) ?? null;
    },
    async create(clientId, input) {
      const row = employee({ ...input, id: `e${rows.length + 1}`, client_id: clientId });
      rows.push(row);
      return row;
    },
    async update(clientId, id, patch) {
      const i = rows.findIndex((e) => e.id === id && e.client_id === clientId);
      if (i < 0) return null;
      rows[i] = { ...rows[i], ...patch } as Employee;
      return rows[i];
    },
    async delete(clientId, id) {
      const i = rows.findIndex((e) => e.id === id && e.client_id === clientId);
      if (i >= 0) rows.splice(i, 1);
    },
  };
  let rate = clientRate;
  const clients: ClientRateRepository = {
    async getDefaultHourlyRate() { return rate; },
    async setDefaultHourlyRate(_clientId, next) { rate = next; return rate; },
    async exists() { return clientExists; },
  };
  return { deps: { employees, clients }, rows, currentRate: () => rate };
}

describe("employee use cases", () => {
  it("lists employees with their resolved rate and the client default", async () => {
    const { deps } = fakeRepos([
      employee({ id: "e1", name: "Ali", hourly_rate: 25 }),
      employee({ id: "e2", name: "Bo" }),
    ], 18);

    const { employees, client_default_hourly_rate } = await listEmployees(deps, "c1");
    expect(client_default_hourly_rate).toBe(18);
    expect(employees.map((e) => e.effective_hourly_rate)).toEqual([
      { rate: 25, source: "employee" },
      { rate: 18, source: "client" },
    ]);
  });

  it("filters to active employees when asked", async () => {
    const { deps } = fakeRepos([
      employee({ id: "e1", name: "Ali" }),
      employee({ id: "e2", name: "Bo", active: false }),
    ]);
    const { employees } = await listEmployees(deps, "c1", { activeOnly: true });
    expect(employees.map((e) => e.id)).toEqual(["e1"]);
  });

  it("refuses to create against a client that does not exist", async () => {
    const { deps } = fakeRepos([], null, false);
    await expect(createEmployee(deps, "gone", { name: "Ali" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deactivating keeps the row and only flips `active`", async () => {
    const { deps, rows } = fakeRepos([employee({ id: "e1", hourly_rate: 20 })], 18);
    const updated = await deactivateEmployee(deps, "c1", "e1");
    expect(updated.active).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0].hourly_rate).toBe(20);
  });

  it("clearing hourly_rate makes the employee inherit the client rate again", async () => {
    const { deps } = fakeRepos([employee({ id: "e1", hourly_rate: 30 })], 18);
    const updated = await updateEmployee(deps, "c1", "e1", { hourly_rate: null });
    expect(updated.effective_hourly_rate).toEqual({ rate: 18, source: "client" });
  });

  it("404s when updating an employee of another client", async () => {
    const { deps } = fakeRepos([employee({ id: "e1", client_id: "other" })]);
    await expect(updateEmployee(deps, "c1", "e1", { name: "X" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sets and clears the client's default hourly rate", async () => {
    const { deps, currentRate } = fakeRepos([], null);
    expect(await setClientDefaultHourlyRate(deps, "c1", 21.5)).toBe(21.5);
    expect(currentRate()).toBe(21.5);
    expect(await setClientDefaultHourlyRate(deps, "c1", null)).toBeNull();
  });
});
