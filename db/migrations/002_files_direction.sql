-- Add invoice_direction to files table
alter table public.files
  add column if not exists invoice_direction varchar(10)
    check (invoice_direction is null or invoice_direction in ('inkoop', 'verkoop'));

create index if not exists idx_files_direction
  on public.files (invoice_direction)
  where invoice_direction is not null;
