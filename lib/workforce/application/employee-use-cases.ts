/**
 * Employee use cases — list / create / update / deactivate / delete, plus the
 * client's default rate.
 *
 * Everything here talks to repository PORTS (lib/workforce/domain), never to
 * Supabase, so these run against fakes in tests and against
 * lib/workforce/infrastructure in production.
 */

import type {
  ClientRateRepository,
  Employee,
  EmployeeInput,
  EmployeePatch,
  EmployeeRepository,
  EffectiveHourlyRate,
} from "@/lib/workforce/domain";
import { effectiveHourlyRate } from "@/lib/workforce/domain";
import { NotFoundError } from "./errors";

export interface EmployeeDeps {
  employees: EmployeeRepository;
  clients: ClientRateRepository;
}

/** An employee plus the rate actually in effect — what the dashboard renders. */
export interface EmployeeWithRate extends Employee {
  effective_hourly_rate: EffectiveHourlyRate;
}

function withRate(employee: Employee, clientDefaultRate: number | null): EmployeeWithRate {
  return { ...employee, effective_hourly_rate: effectiveHourlyRate(employee, clientDefaultRate) };
}

/**
 * A client's employees, each carrying its resolved rate. The client's default
 * is read once and applied to every row rather than per employee.
 */
export async function listEmployees(
  deps: EmployeeDeps,
  clientId: string,
  opts?: { activeOnly?: boolean },
): Promise<{ employees: EmployeeWithRate[]; client_default_hourly_rate: number | null }> {
  const [rows, clientDefaultRate] = await Promise.all([
    deps.employees.listByClient(clientId, opts),
    deps.clients.getDefaultHourlyRate(clientId),
  ]);
  return {
    employees: rows.map((e) => withRate(e, clientDefaultRate)),
    client_default_hourly_rate: clientDefaultRate,
  };
}

export async function getEmployee(
  deps: EmployeeDeps,
  clientId: string,
  employeeId: string,
): Promise<EmployeeWithRate> {
  const employee = await deps.employees.findById(clientId, employeeId);
  if (!employee) throw new NotFoundError("Employee");
  return withRate(employee, await deps.clients.getDefaultHourlyRate(clientId));
}

/**
 * Create. The client is checked first so a stale dashboard posting against a
 * deleted client_id gets a 404 instead of a raw foreign-key 500 — same guard
 * the customers endpoint uses.
 */
export async function createEmployee(
  deps: EmployeeDeps,
  clientId: string,
  input: EmployeeInput,
): Promise<EmployeeWithRate> {
  if (!(await deps.clients.exists(clientId))) throw new NotFoundError("Client");
  const created = await deps.employees.create(clientId, input);
  return withRate(created, await deps.clients.getDefaultHourlyRate(clientId));
}

export async function updateEmployee(
  deps: EmployeeDeps,
  clientId: string,
  employeeId: string,
  patch: EmployeePatch,
): Promise<EmployeeWithRate> {
  const updated = await deps.employees.update(clientId, employeeId, patch);
  if (!updated) throw new NotFoundError("Employee");
  return withRate(updated, await deps.clients.getDefaultHourlyRate(clientId));
}

/**
 * Deactivate rather than delete: an employee who has worked is referenced by
 * past schedules, so the row stays and only `active` flips. Its own use case
 * (not just "PATCH active:false") because that intent is the one the UI, and
 * later the generator, actually mean.
 */
export async function deactivateEmployee(
  deps: EmployeeDeps,
  clientId: string,
  employeeId: string,
): Promise<EmployeeWithRate> {
  return updateEmployee(deps, clientId, employeeId, { active: false });
}

export async function deleteEmployee(
  deps: EmployeeDeps,
  clientId: string,
  employeeId: string,
): Promise<void> {
  const existing = await deps.employees.findById(clientId, employeeId);
  if (!existing) throw new NotFoundError("Employee");
  await deps.employees.delete(clientId, employeeId);
}

/**
 * Set (or clear, with `null`) the client's default hourly rate — the rate every
 * employee without an override inherits.
 */
export async function setClientDefaultHourlyRate(
  deps: Pick<EmployeeDeps, "clients">,
  clientId: string,
  rate: number | null,
): Promise<number | null> {
  if (!(await deps.clients.exists(clientId))) throw new NotFoundError("Client");
  return deps.clients.setDefaultHourlyRate(clientId, rate);
}
