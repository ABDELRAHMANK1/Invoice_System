/**
 * Supabase implementation of the employee + client-rate ports.
 *
 * The only layer that knows about `supabaseAdmin`, table names and column
 * shapes. Rows are mapped to domain entities here — PostgREST serialises
 * `numeric` columns as JSON numbers, but the mapper coerces defensively so a
 * string can never reach the rate arithmetic.
 */

import { supabaseAdmin } from "@/lib/supabase-admin";
import type {
  ClientRateRepository,
  Employee,
  EmployeeInput,
  EmployeePatch,
  EmployeeRepository,
} from "@/lib/workforce/domain";
import { NotFoundError } from "@/lib/workforce/application/errors";

const TABLE = "employees";

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toEmployee(row: Row): Employee {
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    name: String(row.name ?? ""),
    phone: (row.phone as string | null) ?? null,
    hourly_rate: num(row.hourly_rate),
    default_days_per_week: num(row.default_days_per_week) ?? 0,
    active: row.active !== false,
    notes: (row.notes as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

/** Drop keys the caller didn't send, so a PATCH never nulls an untouched column. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function findEmployeeById(clientId: string, employeeId: string): Promise<Employee | null> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("id", employeeId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toEmployee(data) : null;
}

export const supabaseEmployeeRepository: EmployeeRepository = {
  async listByClient(clientId, opts) {
    let query = supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("client_id", clientId);
    if (opts?.activeOnly) query = query.eq("active", true);

    // Active first, then by name — the same ordering the client GET uses for
    // suppliers and customers.
    const { data, error } = await query
      .order("active", { ascending: false })
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toEmployee);
  },

  findById: findEmployeeById,

  async create(clientId, input) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .insert({ ...definedOnly(input), client_id: clientId })
      .select("*")
      .single();
    if (error) {
      // Foreign-key violation — the client was deleted between the check and here.
      if (error.code === "23503") throw new NotFoundError("Client");
      throw new Error(error.message);
    }
    if (!data) throw new Error("Employee insert returned no data");
    return toEmployee(data);
  },

  async update(clientId, employeeId, patch) {
    const payload = definedOnly(patch);
    if (Object.keys(payload).length === 0) {
      // Nothing to write — return the row as-is rather than issuing an empty UPDATE.
      return findEmployeeById(clientId, employeeId);
    }
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", employeeId)
      .eq("client_id", clientId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toEmployee(data) : null;
  },

  async delete(clientId, employeeId) {
    const { error } = await supabaseAdmin
      .from(TABLE)
      .delete()
      .eq("id", employeeId)
      .eq("client_id", clientId);
    if (error) throw new Error(error.message);
  },
};

export const supabaseClientRateRepository: ClientRateRepository = {
  async getDefaultHourlyRate(clientId) {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("default_hourly_rate")
      .eq("id", clientId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError("Client");
    return num(data.default_hourly_rate);
  },

  async setDefaultHourlyRate(clientId, rate) {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .update({ default_hourly_rate: rate })
      .eq("id", clientId)
      .select("default_hourly_rate")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError("Client");
    return num(data.default_hourly_rate);
  },

  async exists(clientId) {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  },
};
