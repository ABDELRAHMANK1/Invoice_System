-- Migration 011: employees + the storage a future salary-schedule generator needs.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- Phase 1 is data model + CRUD only. NOTHING here generates a schedule — the
-- generator is an interface in lib/workforce/domain/schedule-generator.ts with
-- no implementation, and `employee_monthly_schedules` exists purely so Phase 2
-- has somewhere to write.
--
-- A client's people fall in three buckets now:
--   suppliers — parties the client BUYS from   (inkoop)   [migration 003/schema]
--   customers — parties the client SELLS to    (verkoop)  [migration 005]
--   employees — workers the client PAYS                   [new, this migration]
-- Same shape as the other two: its own top-level table keyed by client_id,
-- cascade-deleted with the client. Deliberately NOT folded into suppliers or
-- customers — an employee has no relatie_code, no BTW number, and never lands
-- in a Snelstart export.

-- ── clients.default_hourly_rate ───────────────────────────────────────────
-- The client's default pay rate, inherited by every employee that doesn't set
-- its own `hourly_rate`. numeric(15,2) + a non-negative check matches every
-- other money column in this schema (invoices.total_amount / subtotal /
-- btw_amount). Nullable — existing clients have no rate on file.
alter table public.clients
  add column if not exists default_hourly_rate numeric(15, 2)
    check (default_hourly_rate is null or default_hourly_rate >= 0);

-- ── employees ─────────────────────────────────────────────────────────────
create table if not exists public.employees (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients(id) on delete cascade,
  name                  text not null,
  phone                 text,
  -- NULL means "inherit clients.default_hourly_rate". A row that sets this is
  -- an override; the dashboard shows which of the two is in effect.
  hourly_rate           numeric(15, 2) check (hourly_rate is null or hourly_rate >= 0),
  default_days_per_week integer not null default 5
    check (default_days_per_week >= 0 and default_days_per_week <= 7),
  active                boolean not null default true,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_employees_client_id on public.employees (client_id);
create index if not exists idx_employees_name      on public.employees (name);

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at
before update on public.employees
for each row execute function public.set_updated_at();

alter table public.employees enable row level security;

-- ── client_schedule_rules ─────────────────────────────────────────────────
-- One row per client (client_id IS the primary key — a client has exactly one
-- rule set). A client with no row uses DEFAULT_SCHEDULE_RULES in
-- lib/workforce/domain/schedule-rules.ts, which carries the same numbers as the
-- column defaults below; keep the two in sync if either changes.
create table if not exists public.client_schedule_rules (
  client_id            uuid primary key references public.clients(id) on delete cascade,
  -- Max continuous working hours before a break becomes mandatory.
  max_continuous_hours numeric(4, 2) not null default 4
    check (max_continuous_hours > 0 and max_continuous_hours <= 24),
  -- Length of that mandatory break.
  break_minutes        integer not null default 30
    check (break_minutes >= 0 and break_minutes <= 480),
  -- Safety cap: no generated day may exceed this many hours.
  max_hours_per_day    numeric(4, 2) not null default 10
    check (max_hours_per_day > 0 and max_hours_per_day <= 24),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

drop trigger if exists client_schedule_rules_set_updated_at on public.client_schedule_rules;
create trigger client_schedule_rules_set_updated_at
before update on public.client_schedule_rules
for each row execute function public.set_updated_at();

alter table public.client_schedule_rules enable row level security;

-- ── public_holidays ───────────────────────────────────────────────────────
-- Official public holidays, stored per DATE rather than as weekday rules:
-- Goede Vrijdag, Pasen, Hemelvaart and Pinksteren are Easter-derived and move
-- every year, and Koningsdag shifts to 26 April when 27 April is a Sunday, so
-- no fixed rule table would work.
--
-- Rows are NOT seeded here. They are generated per year by the pure
-- `dutchPublicHolidays(year)` function (lib/workforce/domain/public-holiday.ts)
-- and upserted with `npx tsx scripts/seed-public-holidays.ts <year…>`. See that
-- file for why a computed seed beats both a hand-written yearly INSERT and a
-- runtime dependency on an external holiday API.
--
-- `year` is a generated column so it can never drift from `date` while still
-- being cheap to filter on ("all holidays in 2027").
create table if not exists public.public_holidays (
  id         uuid primary key default gen_random_uuid(),
  country    char(2) not null default 'NL',
  date       date not null,
  year       integer generated always as (extract(year from date)::integer) stored,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_holidays_country_date_unique unique (country, date)
);

create index if not exists idx_public_holidays_country_year
  on public.public_holidays (country, year);

drop trigger if exists public_holidays_set_updated_at on public.public_holidays;
create trigger public_holidays_set_updated_at
before update on public.public_holidays
for each row execute function public.set_updated_at();

alter table public.public_holidays enable row level security;

-- ── employee_monthly_schedules (Phase 2 target — write-only shape) ────────
-- The request ("give this employee 160 hours across 5 days a week in March
-- 2027") plus the generated result. Phase 1 never writes here; the table exists
-- so the generator has a destination and this migration never has to be
-- revisited. `schedule_data` is deliberately a free-form jsonb document (the
-- same pattern as invoices.line_items / invoices.raw_extraction) so the shape of
-- a generated schedule can evolve without another migration.
create table if not exists public.employee_monthly_schedules (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  client_id     uuid not null references public.clients(id)   on delete cascade,
  year          integer not null check (year >= 2000 and year <= 2100),
  month         integer not null check (month >= 1 and month <= 12),
  -- What was asked for.
  total_hours   numeric(7, 2) not null check (total_hours >= 0),
  days_per_week integer not null check (days_per_week >= 0 and days_per_week <= 7),
  status        text not null default 'draft'
    check (status in ('draft', 'generated', 'approved', 'archived')),
  -- What the generator produced (shifts, warnings, …). Empty until Phase 2.
  schedule_data jsonb not null default '{}'::jsonb,
  generated_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint employee_monthly_schedules_unique unique (employee_id, year, month)
);

create index if not exists idx_employee_monthly_schedules_client_period
  on public.employee_monthly_schedules (client_id, year desc, month desc);

drop trigger if exists employee_monthly_schedules_set_updated_at on public.employee_monthly_schedules;
create trigger employee_monthly_schedules_set_updated_at
before update on public.employee_monthly_schedules
for each row execute function public.set_updated_at();

alter table public.employee_monthly_schedules enable row level security;
