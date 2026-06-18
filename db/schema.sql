-- WhatsApp Invoice SaaS database schema for Supabase/PostgreSQL.
-- Run this entire file once in Supabase SQL Editor.

create extension if not exists "pgcrypto";

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  phone_number varchar(32) not null,
  file_key text not null,
  file_type varchar(10) not null check (file_type in ('image', 'pdf')),
  file_name text,
  file_size bigint check (file_size is null or file_size >= 0),
  mime_type varchar(120),
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'error')),
  error_message text,
  invoice_direction varchar(10)
    check (invoice_direction is null or invoice_direction in ('inkoop', 'verkoop')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references public.files(id) on delete set null,
  phone_number varchar(32) not null,
  invoice_number varchar(120) not null,
  client_name text,
  date date,
  total_amount numeric(15, 2) check (total_amount is null or total_amount >= 0),
  currency char(3) not null default 'EUR',
  file_url text not null,
  raw_extraction jsonb not null default '{}'::jsonb,
  status varchar(20) not null default 'extracted'
    check (status in ('extracted', 'pending', 'error')),
  confidence numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_invoice_number_unique unique (invoice_number)
);

create table if not exists public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  type varchar(10) not null check (type in ('excel', 'zip')),
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'error')),
  filters jsonb not null default '{}'::jsonb,
  download_url text,
  file_count integer check (file_count is null or file_count >= 0),
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_files_phone on public.files (phone_number);
create index if not exists idx_files_created_at on public.files (created_at desc);
create index if not exists idx_files_phone_created_at on public.files (phone_number, created_at desc);
create index if not exists idx_files_status_created_at on public.files (status, created_at asc)
  where status in ('pending', 'processing', 'error');

create index if not exists idx_invoices_phone on public.invoices (phone_number);
create index if not exists idx_invoices_date on public.invoices (date desc);
create index if not exists idx_invoices_created_at on public.invoices (created_at desc);
create index if not exists idx_invoices_phone_date on public.invoices (phone_number, date desc);
create index if not exists idx_invoices_phone_created_at on public.invoices (phone_number, created_at desc);

create index if not exists idx_export_jobs_status_created_at on public.export_jobs (status, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists files_set_updated_at on public.files;
create trigger files_set_updated_at
before update on public.files
for each row execute function public.set_updated_at();

drop trigger if exists invoices_set_updated_at on public.invoices;
create trigger invoices_set_updated_at
before update on public.invoices
for each row execute function public.set_updated_at();

alter table public.files enable row level security;
alter table public.invoices enable row level security;
alter table public.export_jobs enable row level security;

-- The backend uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- Add dashboard user policies later when you add login/tenants.

-- ── Migration: invoice_direction ─────────────────────────────────────────────
-- Run these two statements once in the Supabase SQL Editor.
-- All existing rows default to 'inkoop'.

alter table public.files
  add column if not exists invoice_direction text not null default 'inkoop'
    check (invoice_direction in ('inkoop', 'verkoop'));

alter table public.invoices
  add column if not exists invoice_direction text not null default 'inkoop'
    check (invoice_direction in ('inkoop', 'verkoop'));

-- ── Migration 006: invoices.customer_name (verkoop counterparty) ──────────────
-- Denormalised customer name for manual VERKOOP invoices, mirroring
-- supplier_name (inkoop). See db/migrations/006_invoices_customer_name.sql.

alter table public.invoices
  add column if not exists customer_name text;

-- ── Migration 007: invoices export tracking ───────────────────────────────────
-- export_count / last_exported_at + increment_invoice_exports(uuid[]), bumped
-- whenever an invoice is included in a successful Excel export.
-- See db/migrations/007_invoices_export_tracking.sql.

alter table public.invoices
  add column if not exists export_count     integer not null default 0,
  add column if not exists last_exported_at timestamptz;

create or replace function public.increment_invoice_exports(p_ids uuid[])
returns void
language sql
as $$
  update public.invoices
     set export_count     = export_count + 1,
         last_exported_at = now()
   where id = any(p_ids);
$$;
