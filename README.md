# WhatsApp Invoice SaaS

Production-ready starter for WhatsApp invoice ingestion, private S3 storage, Supabase PostgreSQL metadata, AI extraction, n8n batch automation, and a Next.js dashboard.

## Run the Database, Step by Step

Think of the database like a notebook with organized pages. We need to create the pages before the app can write invoices into them.

1. Open [Supabase](https://supabase.com) and create a new project.
2. Wait until the project says it is ready.
3. In the left menu, click **SQL Editor**.
4. Click **New query**.
5. Open [`db/schema.sql`](/Users/abdelrahmankhalid/Downloads/files/db/schema.sql).
6. Copy all of it.
7. Paste it into Supabase SQL Editor.
8. Click **Run**.
9. Supabase now has the three tables: `files`, `invoices`, and `export_jobs`.

Now get the connection values:

1. In Supabase, open **Project Settings**.
2. Open **API**.
3. Copy **Project URL** into `NEXT_PUBLIC_SUPABASE_URL`.
4. Copy **service_role key** into `SUPABASE_SERVICE_ROLE_KEY`.
5. Keep the service role key secret. It is the master key.

## Connect the App

1. Copy `.env.example` to `.env.local`.
2. Fill in Supabase, AWS S3, OpenAI, and API key values.
3. Install dependencies.
4. Run the app.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## AWS S3 Setup

1. Create a private S3 bucket.
2. Keep **Block all public access** on.
3. Create an IAM user or role with permission for this bucket only.
4. Add these permissions: `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`.
5. Put the credentials in `.env.local`.

The app stores URLs like:

```text
s3://bucket/whatsapp-invoices/201012345678/2026/04/13/file.pdf
```

The dashboard and exports use signed URLs when a real download is needed.

## n8n Setup

Import your three workflow JSON files:

- `/Users/abdelrahmankhalid/Downloads/workflow1_whatsapp_incoming.json`
- `/Users/abdelrahmankhalid/Downloads/workflow2_ai_extraction.json`
- `/Users/abdelrahmankhalid/Downloads/workflow3_export.json`

Set n8n environment variables:

```text
API_BASE_URL=https://your-api-domain.com
WHATSAPP_PHONE_ID=your-meta-phone-id
```

If `API_INTERNAL_KEY` is set in the app, add this header to each n8n HTTP Request node that calls the backend:

```text
x-api-key: same-secret-value
```

## What to Run First

1. Run Supabase SQL.
2. Configure `.env.local`.
3. Start the Next.js app.
4. Test `GET /api/files`.
5. Import n8n workflow 1 and test one WhatsApp image.
6. Run workflow 2 manually.
7. Open the dashboard.
8. Test Excel export.

## Important Production Notes

- Add real dashboard authentication before giving this dashboard to users.
- Keep S3 private.
- Keep batch extraction at 5-10 files.
- Use one tenant table and tenant IDs when you turn this into a multi-company SaaS.
- For huge ZIP exports, move ZIP building into a background worker instead of a serverless route.
