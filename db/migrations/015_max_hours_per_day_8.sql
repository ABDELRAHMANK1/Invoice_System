-- Migration 015: the maximum working day drops from 10 hours to 8.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- The client confirmed a worker is never scheduled more than eight hours in a
-- single day. Two things change: the column default for new rule rows, and the
-- existing rows that are still carrying the old default of 10.
--
-- ── Which rows this touches, and why ─────────────────────────────────────
-- ONLY rows with `max_hours_per_day = 10` — the exact old default. Everything
-- else is left alone.
--
-- There is no stored signal that reliably separates "never customised" from
-- "deliberately set to 10":
--   • the only writer is PUT /api/clients/:id/schedule-rules, a FULL replace,
--     so every row was written by someone pressing Save in the Scheduling card;
--   • that form pre-fills the defaults, so a row holding 10 may simply be a
--     field the user never touched;
--   • `created_at = updated_at` does NOT identify an untouched row here: the
--     repository's upsert always sends an explicit client-side `updated_at`,
--     while `created_at` comes from the server's now(), so the two differ by
--     network latency even on a first insert. There is no history table either.
-- So the value itself is the only honest discriminator, and it is good enough:
--   • 10  → either untouched, or a deliberate choice that the new rule now
--           overrides anyway (10 > 8 is exactly what the client outlawed);
--   • anything else (6, 9, 12, …) → a value the old default never produced, so
--           unambiguously deliberate. Left untouched, per instruction.
--
-- ⚠️ A row deliberately set ABOVE 8 but not equal to 10 (e.g. 12) is NOT
-- lowered and will keep scheduling days longer than the new maximum. The
-- notices below list any such row so it can be reviewed by hand.
--
-- As of writing, `client_schedule_rules` is EMPTY (0 rows; all clients read
-- DEFAULT_SCHEDULE_RULES at runtime via scheduleRulesOrDefaults), so the UPDATE
-- below currently affects nothing and only the column default matters. The
-- row-level logic exists to be correct whenever rows do appear, and on any
-- other environment where they already have.

-- ── the default for rows created from now on ──────────────────────────────
-- Mirrors DEFAULT_SCHEDULE_RULES in lib/workforce/domain/schedule-rules.ts.
-- Keep the two in sync.
alter table public.client_schedule_rules
  alter column max_hours_per_day set default 8;

do $$
declare
  lowered   integer;
  clamped   integer;
  untouched integer;
  still_over record;
begin
  -- ── rows still at the old default ───────────────────────────────────────
  -- `max_continuous_hours` is clamped alongside it: the coherence rule
  -- (scheduleRulesError — a break threshold must be reachable inside a working
  -- day) lives in application code, NOT as a DB constraint, so lowering the cap
  -- under an existing 9- or 10-hour continuous threshold would leave a row the
  -- database accepts but the next Save rejects with a 400. Clamping keeps every
  -- touched row coherent.
  -- Counted BEFORE the update: RETURNING would only see the new value, so it
  -- cannot tell a row that was clamped from one that was already under 8.
  select count(*) into clamped
    from public.client_schedule_rules
   where max_hours_per_day = 10 and max_continuous_hours > 8;

  update public.client_schedule_rules
     set max_hours_per_day    = 8,
         max_continuous_hours = least(max_continuous_hours, 8)
   where max_hours_per_day = 10;
  get diagnostics lowered = row_count;

  raise notice 'client_schedule_rules: % row(s) lowered from 10 to 8 h/day (% of them also had max_continuous_hours clamped).',
    lowered, clamped;

  select count(*) into untouched
    from public.client_schedule_rules
   where max_hours_per_day <> 8;
  raise notice 'client_schedule_rules: % row(s) left at a custom max_hours_per_day.', untouched;

  -- Anything still above the new maximum is a deliberate customisation this
  -- migration deliberately does not overwrite. Surface it rather than hide it.
  for still_over in
    select client_id, max_hours_per_day
      from public.client_schedule_rules
     where max_hours_per_day > 8
     order by max_hours_per_day desc
  loop
    raise notice 'REVIEW: client % keeps a custom % h/day, above the new 8 h maximum.',
      still_over.client_id, still_over.max_hours_per_day;
  end loop;
end $$;
