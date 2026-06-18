-- Migration 006: invoices.customer_name — denormalised verkoop counterparty.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- Manual invoices can now be VERKOOP (a client SELLS to one of its CUSTOMERS).
-- For inkoop we already denormalise the counterparty name into `supplier_name`;
-- this column is the verkoop mirror — the customer's name. Inkoop rows leave it
-- null, verkoop rows leave `supplier_name` null. The n8n OCR pipeline never
-- writes it and is unaffected (nullable, no default beyond null).

alter table public.invoices
  add column if not exists customer_name text;
