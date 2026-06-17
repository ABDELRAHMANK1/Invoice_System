-- Migration 005: customers table (mirrors live public.suppliers) + invoices.customer_id
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- A client's counterparties are of two kinds:
--   suppliers — parties the client BUYS from  (inkoop)   [already exists]
--   customers — parties the client SELLS to   (verkoop)  [new, this migration]
-- Two separate top-level tables (NOT a unified counterparties table) so the
-- existing suppliers code, the n8n pipeline, and the Excel import stay untouched.
--
-- Columns/types/defaults/nullability below were mirrored from the LIVE
-- suppliers schema (introspected via PostgREST), not from lib/types.ts.
-- client_id on-delete is cascade (a client's customers are owned children
-- that vanish with the client), confirmed by the project owner.

-- ── customers: column-for-column mirror of public.suppliers ───────────────
create table if not exists public.customers (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  name         text not null,
  relatie_code text,
  address      text,
  postcode     text,
  city         text,
  kvk          text,
  btw_number   text,
  iban         text,
  email        text,
  phone        text,
  payment_days integer default 0,
  active       boolean default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_customers_client_id on public.customers (client_id);
create index if not exists idx_customers_name      on public.customers (name);

-- Reuse the shared set_updated_at() trigger function (already in the DB).
drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

alter table public.customers enable row level security;

-- ── invoices.customer_id — forward-compat for verkoop (no flow built yet) ──
alter table public.invoices
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

create index if not exists idx_invoices_customer_id on public.invoices (customer_id);

-- An invoice is EITHER inkoop (supplier_id) OR verkoop (customer_id), never
-- both. Both-null stays allowed: the n8n OCR pipeline inserts rows with
-- free-text client_name/supplier_name and NO FKs, and must keep working.
alter table public.invoices
  drop constraint if exists invoices_one_counterparty;
alter table public.invoices
  add constraint invoices_one_counterparty
  check (supplier_id is null or customer_id is null);
