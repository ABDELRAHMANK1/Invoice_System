-- Migration 013: the "days" input becomes a MONTHLY total, not a weekly count.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- Phase 2 scheduled a repeating weekly weekday pattern, so both the employee
-- default and the per-schedule request counted days PER WEEK. The generator now
-- takes a single number for the whole month and spreads exactly that many days
-- across it, which makes both generation inputs month-level and consistent:
--   total_hours   — hours for the whole month   (unchanged)
--   working_days  — working days for the whole month   (was days_per_week)
--
-- Renaming rather than reinterpreting in place, deliberately: leaving a column
-- called `*_days_per_week` holding a monthly number is exactly the silent
-- mismatch this migration exists to remove. Both renames carry a ONE-TIME data
-- conversion, guarded by the presence of the old column so a re-run can never
-- convert twice.

-- ── employees.default_days_per_week → default_working_days ────────────────
-- The per-employee default that pre-fills the generation form. Existing values
-- are weekly counts, so they are re-expressed monthly with the standard 52/12
-- weeks-per-month factor (5/week → 22, the usual Dutch working month).
do $$
declare
  con record;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees'
      and column_name = 'default_days_per_week'
  ) then
    -- The inline 0..7 range check has to go before the column can hold 22.
    for con in
      select conname from pg_constraint
      where conrelid = 'public.employees'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) ilike '%default_days_per_week%'
    loop
      execute format('alter table public.employees drop constraint %I', con.conname);
    end loop;

    alter table public.employees rename column default_days_per_week to default_working_days;
    update public.employees
       set default_working_days = least(31, round(default_working_days * 52.0 / 12.0));

    alter table public.employees
      add constraint employees_default_working_days_check
        check (default_working_days >= 0 and default_working_days <= 31);
  end if;
end $$;

-- ── employee_monthly_schedules.days_per_week → working_days ───────────────
-- What was requested for that month. Stored schedules already carry the real
-- day-by-day plan in `schedule_data`, so the honest conversion is to COUNT the
-- days the generator actually worked; the 52/12 factor is only the fallback for
-- a row whose schedule_data has no day list (a draft, or a pre-Phase-2 row).
do $$
declare
  con record;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employee_monthly_schedules'
      and column_name = 'days_per_week'
  ) then
    for con in
      select conname from pg_constraint
      where conrelid = 'public.employee_monthly_schedules'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) ilike '%days_per_week%'
    loop
      execute format('alter table public.employee_monthly_schedules drop constraint %I', con.conname);
    end loop;

    alter table public.employee_monthly_schedules rename column days_per_week to working_days;
    update public.employee_monthly_schedules s
       set working_days = case
             when jsonb_typeof(s.schedule_data -> 'days') = 'array' then (
               select count(*)
               from jsonb_array_elements(s.schedule_data -> 'days') d
               where d ->> 'kind' = 'worked'
             )
             else least(31, round(s.working_days * 52.0 / 12.0))
           end;

    alter table public.employee_monthly_schedules
      add constraint employee_monthly_schedules_working_days_check
        check (working_days >= 0 and working_days <= 31);
  end if;
end $$;
