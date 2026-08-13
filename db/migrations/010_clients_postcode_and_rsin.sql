-- Migration 010: add postcode + rsin to clients.
-- Run once in the Supabase SQL Editor.
--
-- Adds two client-level columns needed to auto-fill the Belastingdienst document
-- templates (Loonheffingen aanmelding, Deblokkering g-rekening, Aanvraag
-- g-rekening) from a client's master data:
--
--   postcode  — the client's postcode. Previously the single-line `address`
--               column held street + house number only (no postcode on clients),
--               so the forms' `_PC` boxes had nothing to fill. `address` is kept
--               as-is (still the street + house-number line); postcode is stored
--               separately. Existing rows keep their `address`; postcode is left
--               NULL and back-filled on next edit — deliberately NOT regex-split
--               from `address`, which is unreliable on real records.
--   rsin      — RSIN / fiscaal nummer. Appears on all three forms (`_RSIN`/`_RFB`).
--               NOTE this is the client's OWN number only; the forms' `_RFN`
--               (another company's RSIN) and `_BSN` (a person's number) are
--               different identifiers and are never filled from this column.
--
-- Both nullable — existing clients have no data for them.

alter table public.clients
  add column if not exists postcode text,
  add column if not exists rsin     text;
