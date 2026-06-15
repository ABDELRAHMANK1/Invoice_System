# CLAUDE.md — Oranji Invoice Automation

System context that future Claude Code sessions should read before changing
anything. Keep this file up to date when infrastructure or workflows move.

## 1. Project overview

**Oranji** is an invoice-automation platform. Clients send PDF / image invoices
over WhatsApp → an n8n workflow extracts the data → a Next.js dashboard lets
the back office review, export, and reconcile them.

End-to-end pieces:

- **n8n workflow** — receives the WhatsApp inbound, runs the parser pipeline
  (text extraction, AI extraction, merge), upserts into Supabase.
- **PDF parser microservice** — Python/FastAPI on a VPS, handles
  rule-based text extraction and PDF-to-image rendering.
- **Next.js dashboard** — clients/suppliers CRUD, invoice list/edit,
  Snelstart Boekingen Excel export, bulk supplier import.
- **Supabase** — Postgres + storage. Tables: `clients`, `suppliers`,
  `invoices`, `files`, `export_jobs`.
- **S3 (eu-north-1)** — invoice file storage + signed Excel export downloads.

Languages: TypeScript (Next.js + tests), Python (FastAPI parser). Money flows
in EUR. Verkoop = sales, inkoop = purchase — both have a 25-column native
Snelstart Boekingen export sheet built by `lib/export-builders.ts`.

## 2. VPS

- Host: `root@187.124.181.44` (alias: `srv1542496`, Ubuntu 24.04, x86_64)
- pdf-service runs as a systemd unit, listening on port `5000`
  (`systemctl status pdf-service` / `journalctl -u pdf-service`).
- n8n runs in a Docker container on the same VPS. The Docker host gateway,
  reachable from inside n8n containers, is `172.18.0.1`.

## 3. PDF parser service

Source-controlled mirror at `pdf-service/` in this repo. Live copy at
`/opt/pdf-service/` on the VPS.

```
/opt/pdf-service/
├── main.py               — FastAPI app
├── invoice_parser.py     — text → structured invoice fields
└── *.bak                 — timestamped backups left after each deploy
```

### Endpoints

- **`POST /parse-invoice`** — multipart form, field `text`. Returns the
  invoice dict (see below). Side note: this is rule-based, no LLM calls.
- **`POST /pdf-to-image`** — multipart `file` OR raw `application/pdf` body.
  Renders page 1 at ~200 DPI with PyMuPDF, returns
  `{"image": "<base64 PNG>", "format": "png", "size_bytes": N}`.
- **`GET /health`** — liveness, returns `{"status": "ok"}`.

### `/parse-invoice` response shape

```json
{
  "supplier_name": null,
  "client_name":   null,
  "invoice_number": "string",
  "date":           "YYYY-MM-DD",
  "total_amount":   0.0,
  "currency":       "EUR",
  "vat_rate":       0 | 9 | 21,
  "vat_breakdown": {
    "net_21": 0, "vat_21": 0,
    "net_9":  0, "vat_9":  0,
    "net_0":  0, "emballage": 0
  },
  "transaction_type": "inkoop"
}
```

`supplier_name` and `client_name` are **always null** here — they're produced
by the AI extraction step in n8n and merged in later.

### VAT extraction — arithmetic-first, then patterns

`extract_vat_breakdown` runs **`try_arithmetic` first**, and only falls through
to the supplier-specific patterns below when it can't find a confident result
(it returns `False`, leaving the breakdown untouched). The patterns are
unchanged — arithmetic is an additional front layer, not a replacement.

**`try_arithmetic`** reasons from the numbers themselves instead of matching a
layout:

- **Step 1 — pair scan.** Across *every* number in the text, a `(net, vat)` pair
  is valid when `vat ≈ net × rate` for rate ∈ {9, 21} within 2%. It picks the
  per-rate combination whose `net+vat` sum lands closest to the total.
  - **Total anchor**: the total used here is `max(labelled total, largest money
    amount in the text)` — the grand total (incl. VAT) is the biggest euro
    figure on a normal invoice, so this anchors correctly even when no total
    *label* was recognised upstream. "Money" = a number written with two
    decimals; bare quantities, invoice numbers, dates and `N%` rate literals are
    excluded. **This is what stops line-item pairs (e.g. `88 × 0.09 ≈ 7.95`)
    being picked over the BTW-summary pair** — the summary pair is the one that
    actually sums to the total.
  - **Shortlist**: candidates are the tightest-fitting pairs by error *plus* any
    pair that on its own nearly explains the total (within 5%), so a correct
    summary pair is never crowded out of the shortlist by coincidental
    line-item pairs.
  - **Confidence gate**: the chosen pairs must explain the total (within 1% /
    5¢). If they fall short — e.g. a 0%/emballage row is missing (Mix Food) or
    the net isn't printed as a literal (Tunnel computes it as `total − vat`) —
    arithmetic **defers** so the real pattern handles it.
- **Step 2 — subtotal inference.** No pair found but a total + a subtotal/net
  amount exist → `VAT = total − subtotal`, `rate = round(VAT/subtotal×100)`,
  filed under 9% (±1) or 21% (±2). Subtotal keywords: `totaal ex btw`,
  `sub-totaal`, `nettobedrag`, `belastbaar basis`, `basis bedrag btw`,
  `grondslag`, `bedrag excl`, `totaal excl`, `excl. btw`. Total keywords:
  `totaalbedrag incl`, `totaal incl`, `totaal te betalen`, `totaal in euro`,
  `reeds voldaan`, `te betalen`, `totaal` (generic last).
- **Step 3** — nothing confident → fall through to the patterns.

Net is always the larger number, vat the smaller, so arithmetic is layout- and
order-agnostic (it handles SAFE's vat-before-net rows without caring about order).

### Supported VAT patterns (`invoice_parser.py`)

These run only when `try_arithmetic` defers.

1. **Mix Food** — triplet rows: `0,00 10,80 0,0000` / `9,00 247,81 22,3029` / `21,00 73,55 15,4455`.
2. **Base N% VAT (general)** — `try_base_vat`, handles BOTH layouts:
   - Normal: `Base 21% VAT: € 46.34` (label → amount).
   - Reversed: `€ 46.34Base 21% VAT:` (amount → label) — detected when a digit
     is glued directly in front of `Base`; net is then the number *before* the
     label, not after it.
   Each net is read deterministically from its `Base N% VAT` label; the matching
   VAT amount is then chosen by **arithmetic cross-check** — among every number
   in the text, the one closest to `net × rate` (within `max(0.5, target×5%)`).
   This is needed because reversed invoices scatter the VAT amounts away from
   their `VAT N%:` labels. Runs *before* the older Alaseel pass.
3. **Alaseel** — English labels via stop-word-bounded windows so `Total EX VAT`
   doesn't bleed in. Now largely superseded by #2; kept as a fallback.
4. **Jan de Geus** — Dutch hoog/laag: `Artikel laag X / BTW laag Y`.
5. **Tunnel/toll receipt** — single rate + total: `BTW (21,00%): X / PRIJS INCL: Y`.
6. **Deniz Fruit** (`try_deniz`) — one row per rate behind word labels:
   `BTW 9%  Excl. BTW € 37,00  BTW € 3,33  Incl. BTW € 40,33` (net = Excl. BTW,
   vat = the bare BTW after it).
7. **SAFE** (`try_safe`) — inline `BTW <rate>% <vat> <net>` rows, e.g.
   `BTW 9%  € 14,54  € 161,55`. Note SAFE lists **vat before net**; the two
   amounts must be on the same line so a row can't swallow a `Totaal` below it.
8. **S&F / Sunflower** (`try_sunflower`) — `net → rate% → vat (→ total)` row,
   space- or `|`-delimited: `€ 24,90  9%  € 2,24  € 27,14`. Net is the number
   before the rate, vat the one after.
9. **Aras Patisserie** (`try_aras`) — handwritten: `Sub-totaal: 32,00` (net) +
   `btw 9%: 2,88` (vat). Gated on a `Sub-totaal` label so it can't poach SAFE.
10. **MOCCA** (`try_mocca`) — rolled-up totals only, no per-rate breakdown:
    `totaal ex btw: 180,30` / `totaal btw: 16,22`. Rate is inferred from
    `round(btw/net*100)` and the pair filed under 9% (±1) or 21% (±2).
11. **Slagerij Overschie** (`try_slagerij`) — per-line items `… | 15,96 | 9%`,
    summed per rate.

VAT rate normalisation: anything not in `{0, 9, 21}` → `0`.

**Total reconciliation** (`parse_invoice`): after the breakdown is built, if the
sum of `net+vat` exceeds the label-extracted `total_amount`, the sum wins. This
recovers the total when no total label fired (Sunflower inline, Deniz) or a
label grabbed a net cell (Sunflower table's `Totaalbedrag`). It only overrides
*upward* — a label total already above the breakdown means a row is missing, not
wrong, so it's left intact.

### Local tests

```bash
python3 pdf-service/test_parser.py     # runs the 3 spec cases, expects 3/3 PASS
```

### Deploy from this Mac

```bash
scp -i ~/.ssh/id_ed25519_new \
    pdf-service/main.py pdf-service/invoice_parser.py \
    root@187.124.181.44:/opt/pdf-service/
ssh -i ~/.ssh/id_ed25519_new root@187.124.181.44 \
    'systemctl restart pdf-service && systemctl is-active pdf-service'
```

Each scp overwrites the live file. Always back up first if iterating:

```bash
ssh -i ~/.ssh/id_ed25519_new root@187.124.181.44 \
  'cp /opt/pdf-service/{main.py,invoice_parser.py} /tmp/'
```

## 4. SSH access to the VPS

- Private key: `~/.ssh/id_ed25519_new` (created passphrase-less for headless use).
- Public key fingerprint: `ssh-ed25519 ...IFMleZwZXDDzy8KCRO21RV3t+aAXARSeOgHjlzaxuyQD claude-code`.
- Lives in `/root/.ssh/authorized_keys` on the VPS.
- The original `~/.ssh/id_ed25519` (passphrase-protected) is also authorised
  but unusable from headless subprocesses unless added to ssh-agent via
  `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`.

Always use the `id_ed25519_new` key:

```bash
ssh -i ~/.ssh/id_ed25519_new root@187.124.181.44
```

## 5. n8n workflow

- Host: `n8n.srv1542496.hstgr.cloud` (runs in Docker on the same VPS as
  pdf-service).
- Workflow: **RAG Invoice Assistant**.
- Trigger: inbound WhatsApp / Telegram with an invoice attachment.
- Steps (high level):
  1. Download the file from the message.
  2. **Extract from File** — splits text-PDFs vs scanned-PDFs/images.
     - `true` branch (text PDF) → readable text → goes to merge.
     - `false` branch (scan/image) → `/pdf-to-image` → GPT-4o vision → merge.
  3. AI Agent extracts structured fields (supplier_name, client_name, …).
  4. Merge with the rule-based parser output (see task in §6).
  5. Upsert into Supabase via the dashboard's `/api/invoices/batch` endpoint.

When n8n nodes call services on the VPS host they must use `172.18.0.1`,
**not** `localhost` — `localhost` inside the container is the container itself.

## 6. Current task — wire `/parse-invoice` into the n8n workflow

The Python parser is live (commit `afe5d6c`) and the three spec curl tests
pass. Next step is to send each invoice's extracted text through it from
n8n so we get a rule-based `vat_breakdown` alongside the AI's
`supplier_name` / `client_name`.

### Where to insert the node

Right after the **Extract from File** node, on the **`false` (real text PDF)
branch**. Image-only branches don't need this — they already get vision-LLM
extraction.

### HTTP Request node settings

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `http://172.18.0.1:5000/parse-invoice` |
| Authentication | None |
| Body content type | `Form-Data` |
| Form field name | `text` |
| Form field value | `{{ $json.text }}` |
| Response format | `JSON` |

(`172.18.0.1` is the Docker bridge gateway — `localhost` from inside the
n8n container would be the container itself, not the VPS host.)

### Merge step (after AI Agent)

Take `vat_breakdown`, `total_amount`, `vat_rate`, `currency`, `date`,
`invoice_number` from the **parser** node, and `supplier_name`, `client_name`
from the **AI Agent** node. Send the combined object to
`POST /api/invoices/batch` on the dashboard.

Fallback rule: if the parser returned `vat_breakdown` with **all six values
equal to 0**, prefer the AI breakdown if it has any. The dashboard's
upsert schema already treats an all-zero `vat_breakdown` as null so the
Excel builder falls back to the `vat_rate + total_amount` synthesis —
this is intentional, do not change it.

## 7. Dashboard

- **Repo:** `github.com/ABDELRAHMANK1/Invoice_System` (`origin/main`).
- **Hosting:** Vercel.
- Stack: Next.js 15 (App Router), TypeScript, Supabase, ExcelJS for the
  Snelstart Boekingen export.
- Run locally:
  ```bash
  npm install
  npm run dev            # http://localhost:3000
  npm run build          # type-check + production build
  npx vitest run         # 98 unit tests
  npx playwright test    # 12 e2e tests
  ```
- Key files:
  - `lib/export-builders.ts` — Snelstart Boekingen Excel builder
    (verkoop + inkoop sheets, 25 cols each).
  - `lib/ai-extraction.ts` — OpenAI extraction prompt for AI fallback.
  - `app/api/export/route.ts` — Excel export endpoint, includes the fuzzy
    Relatiecode lookup (`scoreMatch` uses Levenshtein for OCR typos).
  - `app/api/clients/[id]/suppliers/...` — supplier CRUD + `/bulk` xlsx import.
  - `app/(dashboard)/clients/[id]/page.tsx` — client detail + supplier table.

## Conventions worth knowing before editing

- **Number formatting in exports**: `#,##0.00`. Truncation, not banker's
  rounding (Excel cells store the float; the format is display-only).
- **Btw-soort label**: text on verkoop sheet (`"Hoog"|"Laag"|"Geen"`),
  numeric code on inkoop sheet (`0|1|2`). Do not "harmonise" them — Snelstart
  imports each sheet under different rules.
- **`relatie_code` is a TEXT column** in Supabase, not numeric — leading
  zeros matter. The export builder defensively `String(...).trim()`s it.
- **vat_breakdown null = builder fallback**. An all-zero breakdown is
  collapsed to null in `lib/ai-extraction.ts` `parseJsonArray` so the
  builder synthesises from `vat_rate + total_amount` instead of writing
  six zeros.
- **Phone-number matching is formatting-tolerant** (see `phonePattern` in
  `lib/query.ts`). Don't add an exact-string fallback.
- **n8n uses the Docker host IP** (`172.18.0.1`) to reach VPS services, not
  `localhost`.
