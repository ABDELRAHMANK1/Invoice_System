import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { scheduleRulesSchema } from "@/lib/workforce/application/employee-schema";
import { toHttpError } from "@/lib/workforce/application/errors";
import {
  getScheduleRules,
  saveScheduleRules,
} from "@/lib/workforce/application/schedule-rules-use-cases";
import {
  supabaseClientRateRepository,
  supabaseScheduleRulesRepository,
} from "@/lib/workforce/infrastructure";

export const runtime = "nodejs";

// Per-client scheduling constraints for the future generator. A client that has
// never saved rules reads DEFAULT_SCHEDULE_RULES instead of a 404, so a caller
// always gets a usable set. PUT is a full replace — all three values are
// required, because they only make sense as a coherent triple.
const deps = { rules: supabaseScheduleRulesRepository, clients: supabaseClientRateRepository };

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  try {
    return NextResponse.json(await getScheduleRules(deps, id));
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[schedule-rules.GET] client_id=${id} failed:`, e);
    return jsonError(message, status);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  const parsed = scheduleRulesSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid schedule rules", 400, parsed.error.flatten());

  try {
    return NextResponse.json(await saveScheduleRules(deps, id, parsed.data));
  } catch (e) {
    const { message, status } = toHttpError(e);
    if (status >= 500) console.error(`[schedule-rules.PUT] client_id=${id} failed:`, e);
    return jsonError(message, status);
  }
}
