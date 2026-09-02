/**
 * The Phase 2 scheduling use case — wiring only.
 *
 * It gathers the inputs (employee, resolved rate, rules, holidays), hands them
 * to a `ScheduleGenerator`, and persists the result. It contains NO scheduling
 * logic and imports nothing from employee CRUD: its only coupling to the
 * algorithm is the `ScheduleGenerator` interface, so Phase 2 can land an
 * implementation without touching this file.
 *
 * Nothing calls this yet — no generator exists to pass in, and the dashboard's
 * "Generate monthly schedule" button is deliberately disabled.
 */

import type {
  ClientRateRepository,
  EmployeeMonthlySchedule,
  EmployeeRepository,
  MonthlyScheduleRepository,
  MonthlyScheduleRequest,
  PublicHolidayRepository,
  ScheduleGenerator,
  ScheduleRulesRepository,
} from "@/lib/workforce/domain";
import { effectiveHourlyRate } from "@/lib/workforce/domain";
import { NotFoundError } from "./errors";
import { getScheduleRules } from "./schedule-rules-use-cases";

export interface GenerateMonthlyScheduleDeps {
  employees: EmployeeRepository;
  clients: ClientRateRepository;
  rules: ScheduleRulesRepository;
  holidays: PublicHolidayRepository;
  schedules: MonthlyScheduleRepository;
  /** The algorithm. Phase 2 supplies it; there is no default. */
  generator: ScheduleGenerator;
}

/** First and last ISO date of a month, for the holiday lookup. */
function monthBounds(year: number, month: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last of this
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export async function generateMonthlySchedule(
  deps: GenerateMonthlyScheduleDeps,
  request: MonthlyScheduleRequest,
): Promise<EmployeeMonthlySchedule> {
  const employee = await deps.employees.findById(request.client_id, request.employee_id);
  if (!employee) throw new NotFoundError("Employee");

  const { from, to } = monthBounds(request.year, request.month);
  const [clientDefaultRate, rules, holidays] = await Promise.all([
    deps.clients.getDefaultHourlyRate(request.client_id),
    getScheduleRules(deps, request.client_id),
    deps.holidays.listBetween(from, to),
  ]);

  const result = await deps.generator.generate({
    employee,
    hourly_rate: effectiveHourlyRate(employee, clientDefaultRate).rate,
    rules,
    request,
    holidays,
  });

  return deps.schedules.save(request, {
    status: "generated",
    schedule_data: { ...result },
    generated_at: new Date().toISOString(),
  });
}
