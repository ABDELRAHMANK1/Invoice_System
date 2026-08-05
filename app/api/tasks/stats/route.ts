import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const OPEN = "(done,cancelled)";

// GET /api/tasks/stats
//
// Table-wide counts for the Tasks page stat cards. The list endpoint only
// reports the total for the current filter+page, which made the cards describe
// the visible rows rather than the workload. These are count-only queries
// (head: true) so nothing is transferred but the numbers.
export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const now = req.nextUrl.searchParams.get("now") || new Date().toISOString();
  const count = () => supabaseAdmin.from("tasks").select("id", { count: "exact", head: true });

  const [open, due, urgent, done] = await Promise.all([
    count().not("status", "in", OPEN),
    count().not("status", "in", OPEN).not("remind_at", "is", null).lte("remind_at", now),
    count().not("status", "in", OPEN).eq("priority", "urgent"),
    count().eq("status", "done"),
  ]);

  const failed = [open, due, urgent, done].find((r) => r.error);
  if (failed?.error) return jsonError(failed.error.message, 500);

  return NextResponse.json({
    open:   open.count ?? 0,
    due:    due.count ?? 0,
    urgent: urgent.count ?? 0,
    done:   done.count ?? 0,
  });
}
