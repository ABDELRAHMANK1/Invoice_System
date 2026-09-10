-- Migration 012: the two fields the monthly Urenlijst (timesheet) generator needs
-- on top of migration 011. Run once in the Supabase SQL Editor (idempotent).
--
-- Phase 2 turns the `ScheduleGenerator` interface from Phase 1 into a real
-- algorithm + a printable timesheet. Two things were missing from the schema:
--   1. the employee's job title  — printed as "Functie" in the header;
--   2. the client's work-time window — the Begintijd every generated day starts
--      at (and the Eindtijd it is expected to stay within).
-- NOTHING here touches pay: `employees.hourly_rate` / `clients.default_hourly_rate`
-- stay exactly as migration 011 left them and are not read by this feature.

-- ── employees.function_title ──────────────────────────────────────────────
-- "Functie" on the timesheet (e.g. "Sorteermedewerker"). Plain nullable text,
-- same shape as employees.phone/notes — existing rows have no title on file and
-- the header line is simply omitted when it is null.
alter table public.employees
  add column if not exists function_title text;

-- ── client_schedule_rules.work_start_time / work_end_time ─────────────────
-- The client's default working window. It lives HERE, not on `clients`, because:
--   • `client_schedule_rules` already IS the per-client scheduling constraint
--     row (one row per client, client_id as PK) — a start/end time is the same
--     kind of fact as max_continuous_hours or break_minutes, read at the same
--     moment by the same code;
--   • `ScheduleGenerationInput` (lib/workforce/domain/schedule-generator.ts)
--     already carries `rules`, so the generator gets the window without widening
--     the Phase 2 seam or adding a repository;
--   • `clients` is a wide table shared with the invoicing / export / n8n flows.
--     Scheduling columns there would spread this feature across two owners and
--     over two `select *` paths that have nothing to do with scheduling.
-- `time` (without time zone) is the right type: this is a wall-clock shift
-- boundary ("we start at 08:00"), not an instant, and it must not shift with DST
-- the way a timestamptz would.
--
-- Defaults 08:00–17:00 mirror DEFAULT_SCHEDULE_RULES in
-- lib/workforce/domain/schedule-rules.ts — as with the three columns above, if
-- you change one, change the other.
alter table public.client_schedule_rules
  add column if not exists work_start_time time not null default '08:00',
  add column if not exists work_end_time   time not null default '17:00';

-- A window has to be a window: the end must come after the start. (How many
-- hours actually fit inside it is a soft constraint — a day that runs past
-- work_end_time is reported as a generator warning, not rejected here.)
alter table public.client_schedule_rules
  drop constraint if exists client_schedule_rules_work_window;
alter table public.client_schedule_rules
  add constraint client_schedule_rules_work_window
    check (work_end_time > work_start_time);
