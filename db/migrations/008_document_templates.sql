-- Migration 008: document_templates table.
-- Run once in the Supabase SQL Editor.
--
-- Backs the "Document Templates" feature: a fillable AcroForm PDF is stored in
-- S3 (s3_key), and field_mapping maps each PDF form-field name to a column on
-- the `clients` table. field_mapping stays GENERIC — {"pdfFieldName":
-- "clientColumnName"} — so new templates with completely different fields are
-- added the same way, no schema change per template.

create table if not exists public.document_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  s3_key        text,
  field_mapping jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_document_templates_created_at
  on public.document_templates (created_at desc);

alter table public.document_templates enable row level security;
