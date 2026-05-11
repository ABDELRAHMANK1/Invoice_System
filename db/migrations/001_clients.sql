-- Migration 001: clients table
-- Run once in Supabase SQL Editor

create table if not exists public.clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  phone_number varchar(32),
  email        text,
  address      text,
  city         text,
  country      char(2) not null default 'NL',
  btw_number   text,
  kvk_number   text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_clients_name on public.clients (name);
create index if not exists idx_clients_phone on public.clients (phone_number);
create index if not exists idx_clients_created_at on public.clients (created_at desc);

create trigger clients_set_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

alter table public.clients enable row level security;
