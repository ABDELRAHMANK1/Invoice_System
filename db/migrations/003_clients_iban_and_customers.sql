-- Migration 003: add IBAN to clients.
-- Run once in the Supabase SQL Editor.
--
-- NOTE: an earlier draft of this migration also created a `client_customers`
-- table. That was a misunderstanding — a client's counterparties are its
-- SUPPLIERS (the existing `suppliers` table), not separate customers. The
-- drop below is a safety net in case the earlier version was already run.

alter table public.clients
  add column if not exists iban text;

drop table if exists public.client_customers cascade;
