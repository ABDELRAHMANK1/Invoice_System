# API curl Examples

Set these first:

```bash
export API_BASE_URL="http://localhost:3000"
export API_KEY="change-me-in-production"
```

If `API_INTERNAL_KEY` is empty, remove the `x-api-key` header from the examples.

## Upload a File

```bash
curl -X POST "$API_BASE_URL/api/upload" \
  -H "x-api-key: $API_KEY" \
  -F "file=@/absolute/path/invoice.pdf" \
  -F "phone_number=+201012345678" \
  -F "file_type=pdf"
```

Response:

```json
{
  "file_url": "s3://your-bucket/whatsapp-invoices/201012345678/2026/04/13/uuid-invoice.pdf",
  "file_name": "invoice.pdf",
  "file_size": 123456,
  "mime_type": "application/pdf"
}
```

## Save File Metadata

```bash
curl -X POST "$API_BASE_URL/api/files" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "phone_number": "+201012345678",
    "file_url": "s3://your-bucket/whatsapp-invoices/201012345678/2026/04/13/file.pdf",
    "file_type": "pdf",
    "file_name": "invoice.pdf",
    "file_size": 123456,
    "mime_type": "application/pdf"
  }'
```

## Fetch Pending Files for n8n Workflow 2

```bash
curl "$API_BASE_URL/api/files?status=pending&limit=80&order=created_at_asc" \
  -H "x-api-key: $API_KEY"
```

## Mark Files Processing

```bash
curl -X PATCH "$API_BASE_URL/api/files/batch-status" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "ids": ["00000000-0000-0000-0000-000000000000"],
    "status": "processing"
  }'
```

## Run AI Extraction

```bash
curl -X POST "$API_BASE_URL/api/extract" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "file_urls": [
      "s3://your-bucket/whatsapp-invoices/201012345678/2026/04/13/file-1.jpg",
      "s3://your-bucket/whatsapp-invoices/201012345678/2026/04/13/file-2.pdf"
    ]
  }'
```

Response:

```json
[
  {
    "client_name": "Acme LLC",
    "invoice_number": "INV-1001",
    "date": "2026-04-13",
    "total_amount": 1000.5,
    "currency": "SAR",
    "confidence": 0.91
  }
]
```

## Save Extracted Invoices

```bash
curl -X POST "$API_BASE_URL/api/invoices/batch" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "invoices": [
      {
        "file_id": "00000000-0000-0000-0000-000000000000",
        "phone_number": "+201012345678",
        "invoice_number": "INV-1001",
        "client_name": "Acme LLC",
        "date": "2026-04-13",
        "total_amount": 1000.5,
        "currency": "SAR",
        "file_url": "s3://your-bucket/whatsapp-invoices/201012345678/2026/04/13/file.jpg",
        "confidence": 0.91,
        "status": "extracted"
      }
    ]
  }'
```

## Query Invoices for Dashboard

```bash
curl "$API_BASE_URL/api/invoices?phone=2010&from=2026-04-01&to=2026-04-30&page=1&limit=20" \
  -H "x-api-key: $API_KEY"
```

## Create Export Job

```bash
curl -X POST "$API_BASE_URL/api/export" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "phone": "+201012345678",
    "from": "2026-04-01",
    "to": "2026-04-30",
    "type": "excel"
  }'
```

Response:

```json
{
  "jobId": "11111111-1111-1111-1111-111111111111",
  "status": "processing",
  "type": "excel",
  "poll_url": "/api/export?jobId=11111111-1111-1111-1111-111111111111"
}
```

## Create Export and Generate Immediately

Use this from the dashboard or for a simple one-call integration.

```bash
curl -X POST "$API_BASE_URL/api/export" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "phone": "+201012345678",
    "from": "2026-04-01",
    "to": "2026-04-30",
    "type": "excel",
    "async_job": false
  }'
```

Response:

```json
{
  "jobId": "11111111-1111-1111-1111-111111111111",
  "status": "done",
  "type": "excel",
  "download_url": "https://signed-s3-url",
  "file_count": 25
}
```

## Generate Excel from n8n

```bash
curl -X POST "$API_BASE_URL/api/generate-excel" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "job_id": "11111111-1111-1111-1111-111111111111",
    "rows": [
      {
        "Invoice #": "INV-1001",
        "Client": "Acme LLC",
        "Phone": "+201012345678",
        "Date": "2026-04-13",
        "Amount": 1000.5,
        "Currency": "SAR",
        "File URL": "s3://your-bucket/path/file.jpg"
      }
    ],
    "summary": {
      "total_invoices": 1,
      "grand_total": "1000.50"
    }
  }'
```

## Generate ZIP from n8n

```bash
curl -X POST "$API_BASE_URL/api/generate-zip" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "job_id": "11111111-1111-1111-1111-111111111111",
    "file_urls": ["s3://your-bucket/path/file.jpg"]
  }'
```

## Mark Export Job Done

```bash
curl -X PATCH "$API_BASE_URL/api/export/11111111-1111-1111-1111-111111111111" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "status": "done",
    "download_url": "https://signed-s3-url",
    "file_count": 1
  }'
```

## Poll Export Job

```bash
curl "$API_BASE_URL/api/export?jobId=11111111-1111-1111-1111-111111111111" \
  -H "x-api-key: $API_KEY"
```
