import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { createEmployeeSchema } from "@/lib/workforce/application/employee-schema";
import { createEmployee, listEmployees } from "@/lib/workforce/application/employee-use-cases";
import { toHttpError } from "@/lib/workforce/application/errors";
import {
  supabaseClientRateRepository,
  supabaseEmployeeRepository,
} from "@/lib/workforce/infrastructure";

export const runtime = "nodejs";

// Employees — the workers a client PAYS. Mirrors the suppliers/customers
// endpoints (same auth, same response shapes), but the route is a thin shell:
// validation here, everything else in lib/workforce/application.
const deps = { employees: supabaseEmployeeRepository, clients: supabaseClientRateRepository };

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  const activeOnly = req.nextUrl.searchParams.get("active") === "1";

  try {
    // A bare array, like the suppliers/customers endpoints. Each row carries its
    // resolved `effective_hourly_rate` so a caller never has to join the client.
    const { employees } = await listEmployees(deps, id, { activeOnly });
    return NextResponse.json(employees);
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[employees.GET] client_id=${id} failed:`, e);
    return jsonError(message, status);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;

  // Surface a malformed body explicitly instead of silently coercing to {}.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (e) {
    console.warn(`[employees.POST] client_id=${id} invalid JSON body:`, e instanceof Error ? e.message : e);
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = createEmployeeSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.warn(`[employees.POST] client_id=${id} validation failed:`, parsed.error.flatten());
    return jsonError("Invalid employee data", 400, parsed.error.flatten());
  }

  try {
    const created = await createEmployee(deps, id, parsed.data);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[employees.POST] insert failed for client_id=${id}:`, e);
    return jsonError(message, status);
  }
}
