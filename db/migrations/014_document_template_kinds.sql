-- Migration 014: templates are no longer PDF-only.
-- Run once in the Supabase SQL Editor (idempotent / safe to re-run).
--
-- 008 assumed every template would be a fillable AcroForm PDF, so the upload
-- rejected anything else. That assumption is false: a legitimate, text-based,
-- non-scanned document (e.g. Managementovereenkomst_Vervoermanager.pdf) can have
-- NO form fields at all and use printed underscores as its blanks instead.
--
-- A template now carries its FILL MODE explicitly:
--
--   pdf_form         — AcroForm PDF. field_mapping is {pdfFieldName: clientColumn}.
--                      The original (and still the default) path.
--   docx_placeholder — .docx whose text carries {{placeholder}} tokens.
--                      field_mapping is {placeholderName: clientColumn} — the
--                      SAME generic shape, so the review UI is unchanged.
--   static           — any other document (a PDF with no fields, an .xlsx, a
--                      .docx with no placeholders). Downloaded blank only; it is
--                      never client-filled, so field_mapping stays '{}'.
--
-- mime_type records what was actually uploaded, so the download route can name
-- and serve the file correctly instead of assuming application/pdf.

alter table public.document_templates
  add column if not exists kind text not null default 'pdf_form',
  add column if not exists mime_type text;

-- Added separately (and dropped first) so a re-run can widen the allowed set
-- later without failing on an already-present constraint.
alter table public.document_templates
  drop constraint if exists document_templates_kind_check;
alter table public.document_templates
  add constraint document_templates_kind_check
  check (kind in ('pdf_form', 'docx_placeholder', 'static'));

-- Backfill: every row that predates this migration is an AcroForm PDF, which is
-- what the `kind` default already says. Only mime_type needs filling in.
update public.document_templates
   set mime_type = 'application/pdf'
 where mime_type is null;
