# WhatsApp Invoice Processing SaaS

## 1. Full System Architecture

This system has four production boundaries:

1. WhatsApp and n8n receive media, download it from Meta, and send it to this backend.
2. The backend stores binary files in private AWS S3 and stores only metadata/URLs in Supabase PostgreSQL.
3. n8n runs async batch extraction every 5 minutes, sending 5-10 files per AI request.
4. The dashboard reads paginated API data and requests Excel or ZIP exports through async export jobs.

Request path:

`WhatsApp -> n8n webhook -> /api/upload -> S3 -> /api/files -> Supabase -> n8n batch worker -> /api/extract -> /api/invoices/batch -> dashboard/export APIs`

Files are never stored in PostgreSQL. The `files.file_url` and `invoices.file_url` values point to S3 object URLs in `s3://bucket/key` format. Downloads use short-lived signed URLs.

## 2. Database Design

Run [`db/schema.sql`](/Users/abdelrahmankhalid/Downloads/files/db/schema.sql) in Supabase SQL Editor.

Core tables:

`files`

- One row per WhatsApp image/PDF.
- `phone_number` is indexed for dashboard search.
- `created_at` is indexed for date filtering and batch ordering.
- `status` allows async processing: `pending`, `processing`, `done`, `error`.

`invoices`

- One row per extracted invoice.
- `invoice_number` is unique, preventing duplicate invoices.
- `file_id` links back to `files.id`.
- `file_url` is duplicated intentionally so exports do not require a join for common reads.

`export_jobs`

- Tracks Excel and ZIP jobs.
- n8n workflow 3 creates the job, generates the file, uploads it, then PATCHes the job as done.

Indexes are optimized for:

- `phone_number + created_at` file search.
- `phone_number + date` invoice search.
- `status + created_at` pending-file scans.
- unique invoice numbers.

## 3. Backend API

Implemented routes:

- `POST /api/upload`: multipart upload from n8n to private S3.
- `POST /api/files`: save file metadata.
- `GET /api/files`: list files with `phone`, `from`, `to`, `status`, `page`, `limit`, `order`.
- `PATCH /api/files/[id]/status`: update one file status.
- `PATCH /api/files/batch-status`: update many file statuses.
- `GET /api/invoices`: list invoices with `phone`, `from`, `to`, `page`, `limit`.
- `POST /api/invoices/batch`: upsert extracted invoices by `invoice_number`.
- `POST /api/extract`: batch AI extraction for 1-10 file URLs.
- `POST /api/export`: create async export job by default, or generate immediately with `async_job: false`.
- `GET /api/export?jobId=...`: poll export job.
- `PATCH /api/export/[jobId]`: n8n updates export job result.
- `POST /api/generate-excel`: build Excel and upload to S3.
- `POST /api/generate-zip`: build ZIP and upload to S3.
- `GET|POST /api/download-files`: direct ZIP export helper.

For production, set `API_INTERNAL_KEY` and send it from n8n as:

`x-api-key: your-secret-value`

## 4. Dashboard

The dashboard is implemented in [`app/page.tsx`](/Users/abdelrahmankhalid/Downloads/files/app/page.tsx) with styles in [`app/globals.css`](/Users/abdelrahmankhalid/Downloads/files/app/globals.css).

It includes:

- phone input
- from/to date filters
- invoice table
- raw files table
- pagination
- loading state
- error notices
- Excel export button
- ZIP download button

## 5. AI Extraction Logic

[`lib/ai-extraction.ts`](/Users/abdelrahmankhalid/Downloads/files/lib/ai-extraction.ts) accepts multiple file URLs, signs S3 URLs, sends the batch to the AI model, and expects an ordered JSON array:

```json
[
  {
    "client_name": "Acme LLC",
    "invoice_number": "INV-1005",
    "date": "2026-04-12",
    "total_amount": 1250.75,
    "currency": "SAR",
    "confidence": 0.92
  }
]
```

Rules:

- maximum 10 files per request
- returns one object per input URL
- missing fields become `null`
- retries transient failures 3 times
- keeps output order identical to input order

## 6. n8n Workflow Details

### Workflow 1: Incoming WhatsApp

Your JSON already does the correct shape:

1. Webhook receives Meta WhatsApp payload.
2. Verification branch returns `hub.challenge`.
3. Code node extracts `phone_number`, `media_id`, and `file_type`.
4. Respond immediately with HTTP 200 so WhatsApp does not retry.
5. Fetch Meta media URL.
6. Download binary media.
7. POST binary to `/api/upload`.
8. POST returned `file_url`, `file_name`, `file_size`, and metadata to `/api/files`.
9. Send WhatsApp acknowledgment.

Production additions:

- Add `x-api-key` header to backend HTTP nodes.
- Keep the ACK before heavy work.
- Add an n8n error workflow that PATCHes `/api/files/[id]/status` when metadata already exists.

### Workflow 2: AI Processing

Your JSON already uses the scalable pattern:

1. Schedule every 5 minutes.
2. Fetch `/api/files?status=pending&limit=80&order=created_at_asc`.
3. Split files into items.
4. Split in batches of 8.
5. Mark batch `processing`.
6. POST file URLs to `/api/extract`.
7. Merge results with file IDs and phone numbers.
8. POST valid invoices to `/api/invoices/batch`.
9. Mark successes `done`.
10. Mark missing/failed invoices `error`.
11. Wait 2 seconds before the next batch.

Keep batch size between 5 and 10. That balances cost, model context, and rate limits.

### Workflow 3: Export Request

Your JSON works as an async export worker:

1. Webhook receives `{ phone, from, to, type }`.
2. POST `/api/export` to create job.
3. Respond `202 Accepted` quickly.
4. Fetch invoices/files by filters.
5. For Excel, build rows and POST `/api/generate-excel`.
6. For ZIP, build file URL list and POST `/api/generate-zip`.
7. PATCH `/api/export/[jobId]` with `status: done` and `download_url`.
8. Optionally send WhatsApp message with the signed URL.

## 7. File Storage

AWS S3 is private. Object names use:

`whatsapp-invoices/{phone}/{yyyy}/{mm}/{dd}/{uuid}-{originalName}`

Exports use:

`exports/{excel|zip}/{yyyy-mm-dd}/{jobId}.{xlsx|zip}`

Security:

- Bucket blocks public access.
- Backend writes files with IAM credentials.
- Database stores only `s3://bucket/key`.
- Users receive signed URLs that expire, usually after 24 hours for exports.

## 8. Performance Decisions

- PostgreSQL indexes target phone/date/status access patterns.
- n8n does AI extraction asynchronously.
- AI batches are capped at 10 files.
- Dashboard APIs are paginated.
- Exports are job based, not long browser requests.
- ZIP creation has a 500-file direct helper cap. For very large tenants, move ZIP building to a queue worker.

## 9. Example Requests

See [`docs/API_CURL.md`](/Users/abdelrahmankhalid/Downloads/files/docs/API_CURL.md) for curl commands matching your n8n workflows.
