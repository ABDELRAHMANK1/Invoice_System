import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { assignOvertimeSchema } from "@/lib/workforce/application/employee-schema";
import { toHttpError } from "@/lib/workforce/application/errors";
import { assignScheduleOvertime } from "@/lib/workforce/application/generate-monthly-schedule";
import {
  supabaseClientRateRepository,
  supabaseEmployeeRepository,
  supabaseMonthlyScheduleRepository,
  supabaseScheduleRulesRepository,
} from "@/lib/workforce/infrastructure";

export const runtime = "nodejs";

// Assign the leftover overtime a generated month could not hold onto specific
// dates. The generator never places these hours itself — it caps every day at
// `max_hours_per_day` and reports the remainder — so this is the step that
// turns that remainder into real days.
//
// PUT, not POST, because it is a FULL REPLACE of the month's assignment set:
// one entry puts it all on a date, several split it across dates, and `[]`
// clears it. That makes a retry idempotent.
const deps = {
  employees: supabaseEmployeeRepository,
  clients:   supabaseClientRateRepository,
  rules:     supabaseScheduleRulesRepository,
  schedules: supabaseMonthlyScheduleRepository,
};

type Ctx = { params: Promise<{ id: string; employeeId: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, employeeId } = await params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (e) {
    console.warn(`[overtime.PUT] employee_id=${employeeId} invalid JSON body:`, e instanceof Error ? e.message : e);
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = assignOvertimeSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.warn(`[overtime.PUT] employee_id=${employeeId} validation failed:`, parsed.error.flatten());
    return jsonError("Invalid overtime assignment", 400, parsed.error.flatten());
  }

  const { year, month, assignments } = parsed.data;
  try {
    const saved = await assignScheduleOvertime(deps, id, employeeId, year, month, assignments);
    return NextResponse.json(saved);
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[overtime.PUT] employee_id=${employeeId} failed:`, e);
    return jsonError(message, status);
  }
}
