import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { buildTimesheetPdf } from "@/lib/timesheet-pdf";
import { toHttpError } from "@/lib/workforce/application/errors";
import { getTimesheetContext } from "@/lib/workforce/application/generate-monthly-schedule";
import { DUTCH_MONTHS } from "@/lib/workforce/domain";
import type { ScheduleDay, ScheduleTotals } from "@/lib/workforce/domain";
import {
  supabaseClientProfileRepository,
  supabaseEmployeeRepository,
  supabaseMonthlyScheduleRepository,
} from "@/lib/workforce/infrastructure";

export const runtime = "nodejs";

// The printable monthly Urenlijst.
//
// Unlike GET /api/invoices/[id]/download — which redirects to a signed S3 URL
// because the invoice PDF is the stored artifact — this one renders on demand
// and streams the bytes back. A timesheet is a pure projection of
// `schedule_data`, so storing it would add a bucket lifecycle and a file_url
// column for a file that can always be rebuilt byte-identically. `?inline=1`
// previews in-tab, matching the invoice route's convention.
const deps = {
  employees: supabaseEmployeeRepository,
  schedules: supabaseMonthlyScheduleRepository,
  profiles:  supabaseClientProfileRepository,
};

type Ctx = { params: Promise<{ id: string; employeeId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, employeeId } = await params;
  const year = Number(req.nextUrl.searchParams.get("year"));
  const month = Number(req.nextUrl.searchParams.get("month"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return jsonError("year and month query parameters are required", 400);
  }

  try {
    const { employee, client_name, schedule } = await getTimesheetContext(deps, id, employeeId, year, month);

    const data = schedule.schedule_data as { days?: ScheduleDay[]; totals?: ScheduleTotals };
    const days = data.days ?? [];
    if (days.length === 0) {
      // A row written before the generator existed, or an empty one.
      return jsonError("This schedule has no generated days — regenerate it first", 409);
    }
    const totals = data.totals ?? { hours: 0, overtime_hours: 0, km_allowance: 0, worked_days: 0 };

    const pdf = await buildTimesheetPdf({
      client: { name: client_name },
      employee: { name: employee.name, function_title: employee.function_title },
      period: { year, month },
      days,
      totals,
    });

    const inline = req.nextUrl.searchParams.get("inline") === "1";
    const safeName = `Urenlijst ${DUTCH_MONTHS[month - 1]} ${year} - ${employee.name}`
      .replace(/[\r\n"\\]/g, "")
      .replace(/[^\w.\- ]/g, "_")
      .slice(0, 120);

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[schedule.pdf] employee_id=${employeeId} failed:`, e);
    return jsonError(message, status);
  }
}
