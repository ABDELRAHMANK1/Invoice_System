-- Migration 009: task inbox + Telegram reminder support.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- This feature is intentionally isolated from the invoice pipeline. Tasks can
-- be created manually from the dashboard or posted by n8n from a Telegram bot.
-- n8n can poll due reminders with /api/tasks/reminders/due, send the Telegram
-- message, then PATCH the task to bump reminded_at/reminder_count.

create table if not exists public.tasks (
  id                       uuid primary key default gen_random_uuid(),
  title                    text not null,
  description              text,
  status                   text not null default 'new'
    check (status in ('new', 'in_progress', 'waiting', 'done', 'cancelled')),
  priority                 text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  source                   text not null default 'dashboard'
    check (source in ('dashboard', 'telegram', 'whatsapp', 'manual', 'n8n')),

  client_id                uuid references public.clients(id) on delete set null,
  client_name              text,
  related_invoice_id       uuid references public.invoices(id) on delete set null,
  related_invoice_number   text,

  telegram_chat_id         text,
  telegram_message_id      text,
  telegram_from            text,
  telegram_thread_id       text,
  -- message_id of the reminder message the bot sent, so a "done"/"snooze"
  -- reply in Telegram can be resolved back to this task.
  last_reminder_message_id text,

  due_at                   timestamptz,
  remind_at                timestamptz,
  reminded_at              timestamptz,
  reminder_count           integer not null default 0 check (reminder_count >= 0),
  last_reminder_error      text,
  snoozed_until            timestamptz,

  created_by               text,
  assigned_to              text,
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Re-runnable on a database where 009 was already applied before this column
-- existed (create table if not exists above would silently skip it).
alter table public.tasks add column if not exists last_reminder_message_id text;

create index if not exists idx_tasks_status_created_at
  on public.tasks (status, created_at desc);

create index if not exists idx_tasks_priority_created_at
  on public.tasks (priority, created_at desc);

create index if not exists idx_tasks_remind_at_open
  on public.tasks (remind_at asc)
  where remind_at is not null and status not in ('done', 'cancelled');

create index if not exists idx_tasks_due_at_open
  on public.tasks (due_at asc)
  where due_at is not null and status not in ('done', 'cancelled');

create index if not exists idx_tasks_client_id
  on public.tasks (client_id)
  where client_id is not null;

create index if not exists idx_tasks_telegram_chat
  on public.tasks (telegram_chat_id, created_at desc)
  where telegram_chat_id is not null;

-- Lookup for "done" / "snooze 2h" replies to a reminder message in Telegram.
create index if not exists idx_tasks_last_reminder_message
  on public.tasks (last_reminder_message_id)
  where last_reminder_message_id is not null;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

alter table public.tasks enable row level security;
