import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { generateScheduleSchema } from "@/lib/workforce/application/employee-schema";
import { toHttpError } from "@/lib/workforce/application/errors";
import {
  generateMonthlySchedule,
  getMonthlySchedule,
} from "@/lib/workforce/application/generate-monthly-schedule";
import { monthlyScheduleGenerator } from "@/lib/workforce/domain";
import {
  supabaseClientRateRepository,
  supabaseEmployeeRepository,
  supabaseMonthlyScheduleRepository,
  supabasePublicHolidayRepository,
  supabaseScheduleRulesRepository,
} from "@/lib/workforce/infrastructure";

export const runtime = "nodejs";

// One employee's schedule for one month.
//   POST — generate (and store) it; regenerating a month replaces the row.
//   GET  — read back what was generated, for the dashboard table + the PDF.
// A thin shell as usual: validate, call a use case, map the error. The algorithm
// is `monthlyScheduleGenerator`, injected here through the ScheduleGenerator
// interface, never imported by the use case itself.
const deps = {
  employees: supabaseEmployeeRepository,
  clients:   supabaseClientRateRepository,
  rules:     supabaseScheduleRulesRepository,
  holidays:  supabasePublicHolidayRepository,
  schedules: supabaseMonthlyScheduleRepository,
  generator: monthlyScheduleGenerator,
};

type Ctx = { params: Promise<{ id: string; employeeId: string }> };

/** `?year=&month=`, both required — a schedule is always about one month. */
function periodFrom(req: NextRequest): { year: number; month: number } | null {
  const year = Number(req.nextUrl.searchParams.get("year"));
  const month = Number(req.nextUrl.searchParams.get("month"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, employeeId } = await params;
  const period = periodFrom(req);
  if (!period) return jsonError("year and month query parameters are required", 400);

  try {
    return NextResponse.json(await getMonthlySchedule(deps, id, employeeId, period.year, period.month));
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[schedule.GET] employee_id=${employeeId} failed:`, e);
    return jsonError(message, status);
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, employeeId } = await params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (e) {
    console.warn(`[schedule.POST] employee_id=${employeeId} invalid JSON body:`, e instanceof Error ? e.message : e);
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = generateScheduleSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.warn(`[schedule.POST] employee_id=${employeeId} validation failed:`, parsed.error.flatten());
    return jsonError("Invalid schedule request", 400, parsed.error.flatten());
  }

  try {
    // `working_days` may be absent — the use case then applies the employee's
    // own default_working_days.
    const saved = await generateMonthlySchedule(deps, {
      client_id: id,
      employee_id: employeeId,
      ...parsed.data,
    });
    return NextResponse.json(saved, { status: 201 });
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[schedule.POST] employee_id=${employeeId} failed:`, e);
    return jsonError(message, status);
  }
}
