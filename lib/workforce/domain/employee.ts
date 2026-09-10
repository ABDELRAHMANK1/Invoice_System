/**
 * Employee — a worker a client PAYS, as opposed to a supplier (a party the
 * client buys from) or a customer (a party it sells to). Its own per-client
 * table keyed by `client_id`, same as those two (migration 011).
 *
 * Domain layer: pure types + rules, no Supabase, no Next.js, no zod. The
 * repository below is a PORT — the Supabase implementation lives in
 * lib/workforce/infrastructure.
 */

export interface Employee {
  id: string;
  client_id: string;
  name: string;
  phone: string | null;
  /** Job title — printed as "Functie" on the monthly timesheet (migration 012). */
  function_title: string | null;
  /** Override. `null` means "inherit the client's default_hourly_rate". */
  hourly_rate: number | null;
  /** Default number of working days per MONTH — pre-fills a generation request. */
  default_working_days: number;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Everything a create needs: the client is passed separately by the caller. */
export interface EmployeeInput {
  name: string;
  phone?: string | null;
  function_title?: string | null;
  hourly_rate?: number | null;
  default_working_days?: number;
  active?: boolean;
  notes?: string | null;
}

/** A partial update. An absent key keeps its stored value. */
export type EmployeePatch = Partial<EmployeeInput>;

/**
 * Default when an employee has no `default_working_days` of its own. 22 is the
 * usual Dutch full-time working month (5 days × 52/12 weeks), i.e. the monthly
 * re-expression of the 5-days-a-week default this replaced (migration 013).
 */
export const DEFAULT_WORKING_DAYS = 22;

/** Where an employee's rate actually comes from, for the UI's override badge. */
export type RateSource = "employee" | "client" | "none";

export interface EffectiveHourlyRate {
  rate: number | null;
  source: RateSource;
}

/**
 * The rate an employee is actually paid: their own `hourly_rate` when set,
 * otherwise the client's default. `source` tells the dashboard whether to mark
 * the row as an override or as inherited; `none` means neither is on file, so
 * a schedule can't be costed yet.
 *
 * A 0 rate is a real (deliberate) value, not "unset" — only `null`/`undefined`
 * falls through to the client default.
 */
export function effectiveHourlyRate(
  employee: Pick<Employee, "hourly_rate">,
  clientDefaultRate: number | null | undefined,
): EffectiveHourlyRate {
  if (employee.hourly_rate != null) return { rate: employee.hourly_rate, source: "employee" };
  if (clientDefaultRate != null) return { rate: clientDefaultRate, source: "client" };
  return { rate: null, source: "none" };
}

/** Persistence port for employees. Implemented in the infrastructure layer. */
export interface EmployeeRepository {
  listByClient(clientId: string, opts?: { activeOnly?: boolean }): Promise<Employee[]>;
  findById(clientId: string, employeeId: string): Promise<Employee | null>;
  create(clientId: string, input: EmployeeInput): Promise<Employee>;
  update(clientId: string, employeeId: string, patch: EmployeePatch): Promise<Employee | null>;
  delete(clientId: string, employeeId: string): Promise<void>;
}

/**
 * The non-rate client facts this feature needs. Today that is only the name —
 * the "Opdrachtgever" line on a timesheet — kept off `ClientRateRepository` so
 * that port keeps meaning exactly what it says.
 */
export interface ClientProfileRepository {
  /** `null` when the client doesn't exist. */
  getName(clientId: string): Promise<string | null>;
}

/** Persistence port for the one client column this feature owns. */
export interface ClientRateRepository {
  /** `null` when the client exists but has no rate; throws when it doesn't exist. */
  getDefaultHourlyRate(clientId: string): Promise<number | null>;
  setDefaultHourlyRate(clientId: string, rate: number | null): Promise<number | null>;
  exists(clientId: string): Promise<boolean>;
}
