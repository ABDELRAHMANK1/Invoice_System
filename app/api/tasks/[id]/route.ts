import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const TASK_STATUSES = ["new", "in_progress", "waiting", "done", "cancelled"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const TASK_SOURCES = ["dashboard", "telegram", "whatsapp", "manual", "n8n"] as const;

const dateField = z.union([z.string(), z.literal("")]).optional().nullable();

const patchSchema = z.object({
  title:                  z.string().trim().min(1).max(500).optional(),
  description:            z.string().trim().max(5000).optional().nullable(),
  status:                 z.enum(TASK_STATUSES).optional(),
  priority:               z.enum(TASK_PRIORITIES).optional(),
  source:                 z.enum(TASK_SOURCES).optional(),
  client_id:              z.string().uuid().optional().nullable(),
  client_name:            z.string().trim().max(300).optional().nullable(),
  related_invoice_id:     z.string().uuid().optional().nullable(),
  related_invoice_number: z.string().trim().max(120).optional().nullable(),
  telegram_chat_id:       z.string().trim().max(120).optional().nullable(),
  telegram_message_id:    z.string().trim().max(120).optional().nullable(),
  telegram_from:          z.string().trim().max(200).optional().nullable(),
  telegram_thread_id:     z.string().trim().max(120).optional().nullable(),
  due_at:                 dateField,
  remind_at:              dateField,
  reminded_at:            dateField,
  snoozed_until:          dateField,
  created_by:             z.string().trim().max(200).optional().nullable(),
  assigned_to:            z.string().trim().max(200).optional().nullable(),
  last_reminder_error:    z.string().trim().max(1000).optional().nullable(),
  last_reminder_message_id: z.string().trim().max(120).optional().nullable(),
});

function isoOrNull(value: string | null | undefined, field: string): { value: string | null; error?: string } {
  if (value == null || value === "") return { value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { value: null, error: `${field} must be a valid date/time` };
  return { value: d.toISOString() };
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;
  const { data, error } = await supabaseAdmin.from("tasks").select("*").eq("id", id).single();
  if (error) return jsonError(error.code === "PGRST116" ? "Task not found" : error.message, error.code === "PGRST116" ? 404 : 500);
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid task payload", 400, parsed.error.flatten());

  const patch: Record<string, unknown> = {};
  const passthrough = [
    "title",
    "status",
    "priority",
    "source",
    "client_id",
    "related_invoice_id",
  ] as const;
  for (const key of passthrough) {
    if (parsed.data[key] !== undefined) patch[key] = parsed.data[key];
  }
  const nullableText = [
    "description",
    "client_name",
    "related_invoice_number",
    "telegram_chat_id",
    "telegram_message_id",
    "telegram_from",
    "telegram_thread_id",
    "created_by",
    "assigned_to",
    "last_reminder_error",
    "last_reminder_message_id",
  ] as const;
  for (const key of nullableText) {
    if (parsed.data[key] !== undefined) patch[key] = parsed.data[key] || null;
  }

  for (const key of ["due_at", "remind_at", "reminded_at", "snoozed_until"] as const) {
    if (parsed.data[key] !== undefined) {
      const parsedDate = isoOrNull(parsed.data[key], key);
      if (parsedDate.error) return jsonError(parsedDate.error, 400);
      patch[key] = parsedDate.value;
    }
  }

  if (parsed.data.status) {
    const now = new Date().toISOString();
    if (parsed.data.status === "done") {
      patch.completed_at = now;
      patch.cancelled_at = null;
    } else if (parsed.data.status === "cancelled") {
      patch.cancelled_at = now;
      patch.completed_at = null;
    } else {
      patch.completed_at = null;
      patch.cancelled_at = null;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return jsonError(error.code === "PGRST116" ? "Task not found" : error.message, error.code === "PGRST116" ? 404 : 500);
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await context.params;
  const { error } = await supabaseAdmin.from("tasks").delete().eq("id", id);
  if (error) return jsonError(error.message, 500);
  return new NextResponse(null, { status: 204 });
}
