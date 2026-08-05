import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isReminderPending, type ReminderTask } from "@/lib/task-reminders";

export const runtime = "nodejs";

// GET /api/tasks/reminders/due?limit=20
//
// Polling endpoint for n8n. Returns open tasks whose reminder time is due and
// that have not already been delivered for that remind_at (see
// isReminderPending). After sending the Telegram message n8n should call
// POST /api/tasks/:id/reminded so the task drops out of this list.
export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") || 20), 1), 100);
  const now = req.nextUrl.searchParams.get("now") || new Date().toISOString();
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) return jsonError("now must be a valid date/time", 400);

  const { data, error } = await supabaseAdmin
    .from("tasks")
    .select("id,title,description,status,priority,source,client_id,client_name,related_invoice_number,telegram_chat_id,telegram_message_id,telegram_from,telegram_thread_id,last_reminder_message_id,due_at,remind_at,reminded_at,reminder_count,snoozed_until,created_at")
    .not("status", "in", "(done,cancelled)")
    .not("remind_at", "is", null)
    .lte("remind_at", now)
    // Over-fetch: the pending filter below can drop rows, so ask for headroom
    // and only then trim to the caller's limit.
    .order("remind_at", { ascending: true })
    .limit(limit * 3);

  if (error) return jsonError(error.message, 500);

  const pending = ((data ?? []) as ReminderTask[]).filter((t) => isReminderPending(t, nowMs)).slice(0, limit);
  return NextResponse.json({ data: pending, now });
}
