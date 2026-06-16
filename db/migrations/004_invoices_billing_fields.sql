-- Migration 004: billing fields for dashboard-created (manual) invoices.
-- Run once in the Supabase SQL Editor (safe to re-run — idempotent).
--
-- An inkoop invoice records: a CLIENT received this invoice FROM one of its
-- SUPPLIERS (the existing `suppliers` table). So we link both client_id and
-- supplier_id. The earlier draft of this migration linked `customer_id` to a
-- (now removed) `client_customers` table — this version repurposes it to
-- supplier_id and drops the old column.
--
-- IMPORTANT: every column is nullable / defaulted. The external n8n OCR
-- pipeline keeps inserting rows that fill the free-text `client_name` /
-- `supplier_name` columns with NO `client_id` / `supplier_id`, and never sends
-- these fields. Nothing here is NOT NULL, so that pipeline keeps working.
-- The existing `file_url` and `raw_extraction` columns are left untouched.

alter table public.invoices
  add column if not exists client_id   uuid references public.clients(id)   on delete set null,
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null,
  add column if not exists description text,
  add column if not exists line_items  jsonb not null default '[]'::jsonb,
  add column if not exists btw_rate     numeric(5, 2),
  add column if not exists subtotal     numeric(15, 2),
  add column if not exists btw_amount   numeric(15, 2);

-- Repurposed: the old customer_id (FK to the removed client_customers) is gone.
alter table public.invoices
  drop column if exists customer_id;

create index if not exists idx_invoices_client_id   on public.invoices (client_id);
create index if not exists idx_invoices_supplier_id on public.invoices (supplier_id);
