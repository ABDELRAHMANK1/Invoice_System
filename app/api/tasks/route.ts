import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, pagination, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const TASK_STATUSES = ["new", "in_progress", "waiting", "done", "cancelled"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const TASK_SOURCES = ["dashboard", "telegram", "whatsapp", "manual", "n8n"] as const;

const dateField = z.union([z.string(), z.literal("")]).optional().nullable();

const createSchema = z.object({
  title:                  z.string().trim().min(1).max(500),
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
});

function isoOrNull(value: string | null | undefined, field: string): { value: string | null; error?: string } {
  if (value == null || value === "") return { value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { value: null, error: `${field} must be a valid date/time` };
  return { value: d.toISOString() };
}

function statusTimestamps(status: (typeof TASK_STATUSES)[number]) {
  const now = new Date().toISOString();
  return {
    completed_at: status === "done" ? now : null,
    cancelled_at: status === "cancelled" ? now : null,
  };
}

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { page, limit, from: rangeFrom, to: rangeTo } = pagination(req, 50, 500);
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const priority = sp.get("priority");
  const source = sp.get("source");
  const q = sp.get("q")?.trim();
  const client = sp.get("client")?.trim();
  const createdFrom = sp.get("from");
  const createdTo = sp.get("to");
  const openOnly = sp.get("open") === "1";
  const reminderDue = sp.get("reminder_due") === "1";
  const now = sp.get("now") || new Date().toISOString();
  // Telegram lookups for n8n: resolve an incoming reply back to its task.
  const telegramChatId = sp.get("telegram_chat_id")?.trim();
  const telegramMessageId = sp.get("telegram_message_id")?.trim();
  const reminderMessageId = sp.get("reminder_message_id")?.trim();

  let query = supabaseAdmin
    .from("tasks")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(rangeFrom, rangeTo);

  if (status && TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])) {
    query = query.eq("status", status);
  } else if (openOnly) {
    query = query.not("status", "in", "(done,cancelled)");
  }
  if (telegramChatId) query = query.eq("telegram_chat_id", telegramChatId);
  if (telegramMessageId) query = query.eq("telegram_message_id", telegramMessageId);
  if (reminderMessageId) query = query.eq("last_reminder_message_id", reminderMessageId);
  if (priority && TASK_PRIORITIES.includes(priority as (typeof TASK_PRIORITIES)[number])) query = query.eq("priority", priority);
  if (source && TASK_SOURCES.includes(source as (typeof TASK_SOURCES)[number])) query = query.eq("source", source);
  if (createdFrom) query = query.gte("created_at", createdFrom);
  if (createdTo) query = query.lte("created_at", /^\d{4}-\d{2}-\d{2}$/.test(createdTo) ? `${createdTo}T23:59:59.999Z` : createdTo);
  if (client) query = query.or(`client_name.ilike.%${client.replace(/[%_]/g, "")}%,telegram_from.ilike.%${client.replace(/[%_]/g, "")}%`);
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, "")}%`;
    query = query.or(`title.ilike.${pattern},description.ilike.${pattern},related_invoice_number.ilike.${pattern}`);
  }
  if (reminderDue) {
    query = query.not("status", "in", "(done,cancelled)").not("remind_at", "is", null).lte("remind_at", now);
  }

  const { data, error, count } = await query;
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    data: data ?? [],
    total: count ?? 0,
    page,
    limit,
    totalPages: Math.ceil((count ?? 0) / limit),
  });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid task payload", 400, parsed.error.flatten());

  const due = isoOrNull(parsed.data.due_at, "due_at");
  if (due.error) return jsonError(due.error, 400);
  const remind = isoOrNull(parsed.data.remind_at, "remind_at");
  if (remind.error) return jsonError(remind.error, 400);
  const reminded = isoOrNull(parsed.data.reminded_at, "reminded_at");
  if (reminded.error) return jsonError(reminded.error, 400);
  const snoozed = isoOrNull(parsed.data.snoozed_until, "snoozed_until");
  if (snoozed.error) return jsonError(snoozed.error, 400);

  const status = parsed.data.status ?? "new";
  const row = {
    title:                  parsed.data.title,
    description:            parsed.data.description || null,
    status,
    priority:               parsed.data.priority ?? "normal",
    source:                 parsed.data.source ?? "dashboard",
    client_id:              parsed.data.client_id ?? null,
    client_name:            parsed.data.client_name || null,
    related_invoice_id:     parsed.data.related_invoice_id ?? null,
    related_invoice_number: parsed.data.related_invoice_number || null,
    telegram_chat_id:       parsed.data.telegram_chat_id || null,
    telegram_message_id:    parsed.data.telegram_message_id || null,
    telegram_from:          parsed.data.telegram_from || null,
    telegram_thread_id:     parsed.data.telegram_thread_id || null,
    due_at:                 due.value,
    remind_at:              remind.value,
    reminded_at:            reminded.value,
    snoozed_until:          snoozed.value,
    created_by:             parsed.data.created_by || null,
    assigned_to:            parsed.data.assigned_to || null,
    ...statusTimestamps(status),
  };

  const { data, error } = await supabaseAdmin
    .from("tasks")
    .insert(row)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
