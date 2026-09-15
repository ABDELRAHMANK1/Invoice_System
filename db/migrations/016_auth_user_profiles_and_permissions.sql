-- Migration 016: session-based auth — user profiles + per-user permissions.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- This replaces the HTTP Basic Auth popup (middleware.ts) with real Supabase
-- Auth sessions. `auth.users` stays the single source of truth for credentials;
-- everything this dashboard needs ON TOP of a credential lives here:
--
--   user_profiles     — one row per auth user: display name, role, status.
--   user_permissions  — one row per (user, permission_key) for EMPLOYEES only.
--
-- ── Role vs. permission ───────────────────────────────────────────────────
-- `owner` and `developer` bypass `user_permissions` ENTIRELY. Their access is
-- granted BY ROLE, not by row, so an owner can never lock themselves out by
-- deleting permission rows, and a new permission key never has to be
-- backfilled for them. Only `employee` is checked against the table.
-- The same rule is implemented once in lib/auth/permissions.ts — keep the two
-- in sync if the roles ever change.
--
-- ── Why a trigger creates the profile ─────────────────────────────────────
-- The profile row is created by an AFTER INSERT trigger on auth.users rather
-- than by the /signup route. A signup can also arrive from the Supabase
-- dashboard, an invite link or a future OAuth provider; a trigger is the only
-- place that catches all of them, so "an auth user with no profile" — which
-- would be an account that passes the session gate and then crashes every
-- page that reads a role — cannot happen.

-- ── user_profiles ─────────────────────────────────────────────────────────
create table if not exists public.user_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  role       text not null default 'employee'
    check (role in ('owner', 'developer', 'employee')),
  status     text not null default 'pending'
    check (status in ('pending', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_profiles is
  'Dashboard identity for an auth.users row. status=pending has no dashboard access.';

create index if not exists user_profiles_role_idx   on public.user_profiles (role);
create index if not exists user_profiles_status_idx on public.user_profiles (status);

-- ── user_permissions ──────────────────────────────────────────────────────
-- `granted` is a boolean rather than the row's mere existence so the Users page
-- can store an explicit "no" and round-trip the full checkbox state without
-- deleting rows. A MISSING row and `granted = false` both mean "denied".
create table if not exists public.user_permissions (
  user_id        uuid not null references public.user_profiles(id) on delete cascade,
  permission_key text not null
    check (permission_key in (
      'view_invoices',
      'edit_invoices',
      'export_excel',
      'manage_clients',
      'manage_users',
      'delete_data'
    )),
  granted        boolean not null default false,
  created_at     timestamptz not null default now(),
  primary key (user_id, permission_key)
);

comment on table public.user_permissions is
  'Per-permission grants for role=employee. Ignored for owner/developer.';

create index if not exists user_permissions_user_idx on public.user_permissions (user_id);

-- ── updated_at ────────────────────────────────────────────────────────────
create or replace function public.touch_user_profile()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_profiles_touch on public.user_profiles;
create trigger user_profiles_touch
  before update on public.user_profiles
  for each row execute function public.touch_user_profile();

-- ── auth.users → user_profiles ────────────────────────────────────────────
-- SECURITY DEFINER: the insert happens inside Supabase's auth schema
-- transaction, where the acting role has no rights on public.user_profiles.
-- `on conflict do nothing` keeps a re-run (or a restored auth row) harmless.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, full_name, role, status)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    'employee',
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill: any auth user that predates this migration (or was created in the
-- Supabase dashboard before the trigger existed) gets a pending profile.
insert into public.user_profiles (id, full_name, role, status)
select u.id,
       nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), ''),
       'employee',
       'pending'
from auth.users u
on conflict (id) do nothing;

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Every server route in the dashboard uses the SERVICE ROLE key and therefore
-- bypasses RLS. These policies exist for the anon-key session client that
-- middleware.ts and the dashboard layout use to read the CURRENT user's own
-- role/status — without them that read returns nothing and every signed-in
-- user looks pending.
alter table public.user_profiles    enable row level security;
alter table public.user_permissions enable row level security;

-- Reading a role inside a user_profiles policy would recurse through that same
-- policy. SECURITY DEFINER breaks the cycle by running the lookup as the
-- function owner, for whom RLS does not apply.
create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_profiles where id = auth.uid();
$$;

drop policy if exists user_profiles_select_self on public.user_profiles;
create policy user_profiles_select_self on public.user_profiles
  for select using (
    id = auth.uid()
    or public.current_profile_role() in ('owner', 'developer')
  );

-- No insert/update/delete policies on purpose: profiles are written ONLY by the
-- trigger above and by the service-role Users API. A signed-in user cannot
-- promote themselves.

drop policy if exists user_permissions_select_self on public.user_permissions;
create policy user_permissions_select_self on public.user_permissions
  for select using (
    user_id = auth.uid()
    or public.current_profile_role() in ('owner', 'developer')
  );

-- ── Bootstrap the first owner ─────────────────────────────────────────────
-- Nothing here promotes anyone automatically: "the first account to sign up
-- becomes owner" is a race that hands the workspace to whoever reaches /signup
-- first. Sign up through the dashboard, then run this ONCE with your own email:
--
--   update public.user_profiles
--      set role = 'owner', status = 'active'
--    where id = (select id from auth.users where email = 'you@example.com');
--
-- After that, every further account is approved from Settings > Users.

do $$
declare
  owner_count integer;
begin
  select count(*) into owner_count
  from public.user_profiles
  where role in ('owner', 'developer') and status = 'active';

  if owner_count = 0 then
    raise notice 'No active owner/developer yet — approve one with the UPDATE in the comment above, or nobody can reach Settings > Users.';
  end if;
end;
$$;
