import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const schema = z.object({
  reminded_at: z.string().optional().nullable(),
  next_remind_at: z.string().optional().nullable(),
  // message_id of the Telegram reminder the bot just sent — lets a later
  // "done" / "snooze 2h" reply be resolved back to this task.
  message_id: z.union([z.string(), z.number()]).optional().nullable(),
  error: z.string().optional().nullable(),
});

function isoOrNow(value: string | null | undefined, field: string): { value: string; error?: string } {
  if (value == null || value === "") return { value: new Date().toISOString() };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { value: "", error: `${field} must be a valid date/time` };
  return { value: d.toISOString() };
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid reminder payload", 400, parsed.error.flatten());

  const sentAt = isoOrNow(parsed.data.reminded_at, "reminded_at");
  if (sentAt.error) return jsonError(sentAt.error, 400);
  let nextRemindAt: string | null = null;
  if (parsed.data.next_remind_at !== undefined && parsed.data.next_remind_at !== null && parsed.data.next_remind_at !== "") {
    const next = isoOrNow(parsed.data.next_remind_at, "next_remind_at");
    if (next.error) return jsonError(next.error, 400);
    nextRemindAt = next.value;
  }

  const { data: current, error: readError } = await supabaseAdmin
    .from("tasks")
    .select("reminder_count,remind_at")
    .eq("id", id)
    .single();
  if (readError) return jsonError(readError.code === "PGRST116" ? "Task not found" : readError.message, readError.code === "PGRST116" ? 404 : 500);

  const failed = Boolean(parsed.data.error);

  // A failed delivery must NOT consume the reminder: keep remind_at where it is
  // (unless n8n explicitly reschedules) and leave reminded_at/count untouched so
  // the task stays in /reminders/due and gets retried on the next poll.
  const patch: Record<string, unknown> = failed
    ? {
        remind_at: nextRemindAt ?? current?.remind_at ?? null,
        last_reminder_error: parsed.data.error,
      }
    : {
        reminded_at: sentAt.value,
        reminder_count: Number(current?.reminder_count ?? 0) + 1,
        remind_at: nextRemindAt,
        last_reminder_error: null,
        snoozed_until: null,
      };

  if (!failed && parsed.data.message_id != null && parsed.data.message_id !== "") {
    patch.last_reminder_message_id = String(parsed.data.message_id);
  }

  const { data, error } = await supabaseAdmin
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}
