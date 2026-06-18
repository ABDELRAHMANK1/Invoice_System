-- Migration 007: track Excel-export inclusion per invoice.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- Each time an invoice is included in a successfully generated Boekingen Excel
-- export, export_count is incremented and last_exported_at is bumped. The
-- dashboard's Invoices table surfaces an "Exported?" tick (count > 0) and the
-- running count. Columns are additive and defaulted, so the n8n OCR pipeline
-- and every existing write path are unaffected.

alter table public.invoices
  add column if not exists export_count     integer not null default 0,
  add column if not exists last_exported_at timestamptz;

-- Atomic per-id increment used by the export route's tracking hook. SECURITY
-- DEFINER not needed — the backend calls it with the service role.
create or replace function public.increment_invoice_exports(p_ids uuid[])
returns void
language sql
as $$
  update public.invoices
     set export_count     = export_count + 1,
         last_exported_at = now()
   where id = any(p_ids);
$$;
