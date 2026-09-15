-- Migration 017: stable task board ordering — open tasks first, by priority.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- `status` and `priority` are TEXT columns with check constraints, not Postgres
-- enums, so ordering by them directly sorts alphabetically ('high' < 'low' <
-- 'normal' < 'urgent') — meaningless. PostgREST cannot express a CASE in an
-- .order(), so the rank is materialised here instead and ordered by name.
--
-- Stored generated columns (not a view) so the existing `select("*")` queries
-- and the ordering index both see them without any other route changing.

alter table public.tasks
  add column if not exists status_rank smallint
    generated always as (
      case when status in ('done', 'cancelled') then 1 else 0 end
    ) stored;

alter table public.tasks
  add column if not exists priority_rank smallint
    generated always as (
      case priority
        when 'urgent' then 0
        when 'high'   then 1
        when 'normal' then 2
        when 'low'    then 3
        else 4
      end
    ) stored;

-- The list query's exact sort: open before closed, urgent before low, newest
-- first inside a tie.
create index if not exists idx_tasks_board_order
  on public.tasks (status_rank asc, priority_rank asc, created_at desc);
