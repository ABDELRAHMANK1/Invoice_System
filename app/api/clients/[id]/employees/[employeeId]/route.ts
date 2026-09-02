import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { patchEmployeeSchema } from "@/lib/workforce/application/employee-schema";
import {
  deactivateEmployee,
  deleteEmployee,
  getEmployee,
  updateEmployee,
} from "@/lib/workforce/application/employee-use-cases";
import { toHttpError } from "@/lib/workforce/application/errors";
import {
  supabaseClientRateRepository,
  supabaseEmployeeRepository,
} from "@/lib/workforce/infrastructure";

export const runtime = "nodejs";

const deps = { employees: supabaseEmployeeRepository, clients: supabaseClientRateRepository };

type Ctx = { params: Promise<{ id: string; employeeId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, employeeId } = await params;
  try {
    return NextResponse.json(await getEmployee(deps, id, employeeId));
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[employees.GET] employee_id=${employeeId} failed:`, e);
    return jsonError(message, status);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, employeeId } = await params;
  const parsed = patchEmployeeSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid employee data", 400, parsed.error.flatten());

  try {
    // `{ active: false }` on its own is the deactivate intent (the row is kept —
    // past schedules reference it), so it goes through that use case rather than
    // a generic field update.
    const keys = Object.keys(parsed.data);
    const isDeactivate = keys.length === 1 && keys[0] === "active" && parsed.data.active === false;
    const updated = isDeactivate
      ? await deactivateEmployee(deps, id, employeeId)
      : await updateEmployee(deps, id, employeeId, parsed.data);
    return NextResponse.json(updated);
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[employees.PATCH] employee_id=${employeeId} failed:`, e);
    return jsonError(message, status);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, employeeId } = await params;
  try {
    await deleteEmployee(deps, id, employeeId);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[employees.DELETE] employee_id=${employeeId} failed:`, e);
    return jsonError(message, status);
  }
}
