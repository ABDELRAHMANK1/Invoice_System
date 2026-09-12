/**
 * The scheduling use case — wiring only.
 *
 * It gathers the inputs (employee, resolved rate, rules, holidays), hands them
 * to a `ScheduleGenerator`, and persists the result. It contains NO scheduling
 * logic and imports nothing from employee CRUD: its only coupling to the
 * algorithm is the `ScheduleGenerator` interface, which is why Phase 2 landed
 * `monthlyScheduleGenerator` without rewriting anything here.
 *
 * `working_days` (a MONTH total since migration 013) may be omitted by the
 * caller and is then taken from the employee's `default_working_days`. That
 * resolution has to happen after the employee is loaded, and this is the only
 * place that loads it.
 */

import type {
  ClientProfileRepository,
  ClientRateRepository,
  Employee,
  EmployeeMonthlySchedule,
  EmployeeRepository,
  MonthlyScheduleRepository,
  MonthlyScheduleRequest,
  PublicHolidayRepository,
  GeneratedSchedule,
  ScheduleGenerator,
  ScheduleRulesRepository,
} from "@/lib/workforce/domain";
import type { OvertimeAssignment } from "@/lib/workforce/domain";
import { applyOvertimeAssignments, effectiveHourlyRate } from "@/lib/workforce/domain";
import { NotFoundError, ValidationError } from "./errors";
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

/** The overtime assignments already stored on a schedule row, if any. */
function storedOvertime(schedule: EmployeeMonthlySchedule | null): OvertimeAssignment[] {
  const raw = (schedule?.schedule_data as { overtime?: { assignments?: unknown } } | undefined)
    ?.overtime?.assignments;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is OvertimeAssignment =>
      !!a && typeof (a as OvertimeAssignment).date === "string"
      && Number.isFinite((a as OvertimeAssignment).hours))
    .map((a) => ({ date: a.date, hours: Number(a.hours) }));
}

/** `working_days` omitted → the employee's own monthly default applies. */
export type MonthlyScheduleRequestInput =
  Omit<MonthlyScheduleRequest, "working_days"> & { working_days?: number };

export async function generateMonthlySchedule(
  deps: GenerateMonthlyScheduleDeps,
  input: MonthlyScheduleRequestInput,
): Promise<EmployeeMonthlySchedule> {
  const employee = await deps.employees.findById(input.client_id, input.employee_id);
  if (!employee) throw new NotFoundError("Employee");

  const request: MonthlyScheduleRequest = {
    ...input,
    working_days: input.working_days ?? employee.default_working_days,
  };

  const { from, to } = monthBounds(request.year, request.month);
  const [clientDefaultRate, rules, holidays, previous] = await Promise.all([
    deps.clients.getDefaultHourlyRate(request.client_id),
    getScheduleRules(deps, request.client_id),
    deps.holidays.listBetween(from, to),
    deps.schedules.findByPeriod(request.employee_id, request.year, request.month),
  ]);

  // RE-GENERATION POLICY: overtime a person assigned is PRESERVED, never
  // silently dropped. It is carried into the new plan on the same dates, and
  // `applyOvertimeAssignments` raises `overtime_reassign_needed` when the new
  // numbers no longer leave room for it, so a stale assignment surfaces as
  // something to review instead of vanishing or being trimmed away.
  const result = await deps.generator.generate({
    employee,
    hourly_rate: effectiveHourlyRate(employee, clientDefaultRate).rate,
    rules,
    request,
    holidays,
    existing_overtime: storedOvertime(previous),
  });

  return deps.schedules.save(request, {
    status: "generated",
    schedule_data: { ...result },
    generated_at: new Date().toISOString(),
  });
}

/**
 * Read back a stored schedule. Separate from generation on purpose: the table
 * and the PDF render what was generated, they never re-run the algorithm behind
 * the user's back.
 */
export async function getMonthlySchedule(
  deps: Pick<GenerateMonthlyScheduleDeps, "employees" | "schedules">,
  clientId: string,
  employeeId: string,
  year: number,
  month: number,
): Promise<EmployeeMonthlySchedule> {
  const employee = await deps.employees.findById(clientId, employeeId);
  if (!employee) throw new NotFoundError("Employee");
  const schedule = await deps.schedules.findByPeriod(employeeId, year, month);
  if (!schedule) throw new NotFoundError("Schedule");
  return schedule;
}

/** Everything the printed Urenlijst names: the worker and the Opdrachtgever. */
export interface TimesheetContext {
  employee: Employee;
  /** "Opdrachtgever". */
  client_name: string;
  schedule: EmployeeMonthlySchedule;
}

export async function getTimesheetContext(
  deps: Pick<GenerateMonthlyScheduleDeps, "employees" | "schedules"> & { profiles: ClientProfileRepository },
  clientId: string,
  employeeId: string,
  year: number,
  month: number,
): Promise<TimesheetContext> {
  const employee = await deps.employees.findById(clientId, employeeId);
  if (!employee) throw new NotFoundError("Employee");
  const [schedule, clientName] = await Promise.all([
    deps.schedules.findByPeriod(employeeId, year, month),
    deps.profiles.getName(clientId),
  ]);
  if (!schedule) throw new NotFoundError("Schedule");
  if (clientName == null) throw new NotFoundError("Client");
  return { employee, client_name: clientName, schedule };
}

/**
 * Assign leftover overtime to specific dates. A FULL REPLACE of the month's
 * assignment set — sending `[]` clears it, and sending several entries splits
 * the leftover across dates.
 *
 * It re-composes the stored schedule rather than re-running the generator, so
 * the distributed hours are untouched: only `overtime_hours`, the affected
 * days' times/breaks and the derived totals change.
 */
export async function assignScheduleOvertime(
  deps: Pick<GenerateMonthlyScheduleDeps, "employees" | "schedules" | "rules" | "clients">,
  clientId: string,
  employeeId: string,
  year: number,
  month: number,
  assignments: OvertimeAssignment[],
): Promise<EmployeeMonthlySchedule> {
  const employee = await deps.employees.findById(clientId, employeeId);
  if (!employee) throw new NotFoundError("Employee");

  const stored = await deps.schedules.findByPeriod(employeeId, year, month);
  if (!stored) throw new NotFoundError("Schedule");

  const schedule = stored.schedule_data as unknown as GeneratedSchedule;
  if (!Array.isArray(schedule?.days) || schedule.days.length === 0) {
    throw new ValidationError("This schedule has no generated days — regenerate it first");
  }

  const rules = await getScheduleRules(deps, clientId);
  const updated = applyOvertimeAssignments(schedule, assignments, rules);

  return deps.schedules.save(
    {
      employee_id: employeeId,
      client_id: clientId,
      year,
      month,
      total_hours: stored.total_hours,
      working_days: stored.working_days,
    },
    {
      status: stored.status,
      schedule_data: { ...updated },
      generated_at: stored.generated_at,
    },
  );
}
