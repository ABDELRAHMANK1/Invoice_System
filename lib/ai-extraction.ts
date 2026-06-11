import OpenAI from "openai";
import { env } from "@/lib/env";
import { signedReadUrl } from "@/lib/storage";
import type { ExtractedInvoice } from "@/lib/types";

const client = env.openAiApiKey ? new OpenAI({ apiKey: env.openAiApiKey }) : null;

function emptyResult(): ExtractedInvoice {
  return {
    client_name: null,
    supplier_name: null,
    invoice_number: null,
    date: null,
    total_amount: null,
    currency: null,
    vat_rate: 21,
    vat_breakdown: null,
    transaction_type: "inkoop",
    confidence: 0
  };
}

function parseJsonArray(text: string): ExtractedInvoice[] {
  const cleaned = text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("AI response was not a JSON array");

  return parsed.map((item) => {
    const rawVat = Number(item.vat_rate ?? 21);
    const vatRate = [0, 9, 21].includes(rawVat) ? rawVat : 21;
    const txType = item.transaction_type === "verkoop" ? "verkoop" : "inkoop";

    let vatBreakdown: ExtractedInvoice["vat_breakdown"] = null;
    if (item.vat_breakdown && typeof item.vat_breakdown === "object") {
      const bd = {
        net_21:    Number(item.vat_breakdown.net_21)    || 0,
        vat_21:    Number(item.vat_breakdown.vat_21)    || 0,
        net_9:     Number(item.vat_breakdown.net_9)     || 0,
        vat_9:     Number(item.vat_breakdown.vat_9)     || 0,
        net_0:     Number(item.vat_breakdown.net_0)     || 0,
        emballage: Number(item.vat_breakdown.emballage) || 0,
      };
      // Collapse an all-zero breakdown to null so the export builder falls back
      // to the vat_rate + total_amount synthesis instead of writing six zeros.
      const allZero = bd.net_21 === 0 && bd.vat_21 === 0 && bd.net_9 === 0 && bd.vat_9 === 0 && bd.net_0 === 0 && bd.emballage === 0;
      vatBreakdown = allZero ? null : bd;

      // Diagnostic: warn when the breakdown sum diverges from the stated total
      // by more than a euro. Most often this means the model missed a BTW row.
      if (vatBreakdown && typeof item.total_amount === "number" && item.total_amount > 0) {
        const bdSum = bd.net_21 + bd.vat_21 + bd.net_9 + bd.vat_9 + bd.net_0 + bd.emballage;
        const diff = Math.abs(bdSum - item.total_amount);
        if (diff > 1) {
          console.warn(`[ai-extraction] vat_breakdown sum (${bdSum.toFixed(2)}) ≠ total_amount (${item.total_amount}) for invoice ${item.invoice_number ?? "<unknown>"} — diff ${diff.toFixed(2)}. The model likely missed a BTW row.`, bd);
        }
      }
    }

    return {
      client_name: item.client_name ?? null,
      supplier_name: item.supplier_name ?? null,
      invoice_number: item.invoice_number ?? null,
      date: item.date ?? null,
      total_amount: typeof item.total_amount === "number" ? item.total_amount : item.total_amount ? Number(item.total_amount) : null,
      currency: item.currency ?? null,
      vat_rate: vatRate,
      vat_breakdown: vatBreakdown,
      transaction_type: txType,
      confidence: typeof item.confidence === "number" ? item.confidence : null
    };
  });
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 700 * attempt ** 2));
      }
    }
  }

  throw lastError;
}

const EXTRACTION_PROMPT = `
IMPORTANT — MULTI-DOCUMENT IMAGES: Some invoice photos contain multiple overlapping documents (e.g. a payment receipt stapled or placed on top of the actual invoice). In this case:
- The INVOICE is the larger background document with the supplier letterhead, line items table, and BTW summary table at the bottom.
- The RECEIPT/BETALING slip is the smaller foreground document showing only a payment total and terminal info.
- You MUST extract data from the INVOICE, not the receipt.
- The BTW breakdown table is ALWAYS on the invoice (bottom section), never on the receipt.
- If you see "BETALING", "Kopie Kaarthouder", "V-PAY", "Terminal", "Auth. code" — that is a payment receipt, ignore it for extraction purposes.

You are an expert invoice data extraction system. Documents may be written in Arabic, English, Dutch, or any other language. Always read the full document carefully before responding.

Extract invoice data from each attached file in order.
Return ONLY a valid JSON array with exactly one object per input file.
Use null for any field you cannot find or are not confident about.

Required JSON keys for each object:
  client_name       – The name of the company that RECEIVED this invoice (the buyer/client). Look at the LEFT side or bottom-left of the document — under "Factuur aan:", "Bill To:", "Naam:", "Klant:", "Debiteur:", or any address block that shows who the invoice was sent TO. This is Oranje's client. Preserve original script (Arabic or Latin). Do not translate. Examples: header says "ATAPACK Cash & Carry B.V.", left side says "Fruitoase" → client_name = "Fruitoase"; header says "Nema Food B.V.", Naam says "Roni Market" → client_name = "Roni Market".
  supplier_name     – The name of the company that ISSUED this invoice (the vendor/supplier). Look at the TOP of the document — the letterhead, header, logo area, or the most prominent company name at the top-right. Preserve original script. Do not translate. Examples: header says "ATAPACK Cash & Carry B.V." → supplier_name = "ATAPACK Cash & Carry B.V."; header says "Nema Food B.V." → supplier_name = "Nema Food B.V.".
  invoice_number    – The invoice or document number (رقم الفاتورة / factuurnummer / invoice no). Keep as string.
  date              – Invoice date in ISO format YYYY-MM-DD.
  total_amount      – Grand total as a plain number INCLUDING tax/VAT/BTW/ضريبة. No currency symbols.
  currency          – ISO 4217 three-letter code (SAR, AED, EGP, EUR, USD, GBP …). Detect from symbol or context.
  vat_rate          – Dominant VAT rate as integer (21, 9, or 0). The rate with the largest non-zero tax amount. Keep for backwards compatibility.
  vat_breakdown     – TRANSCRIBE EVERY ROW of the invoice's BTW/VAT summary table into this object. This is a transcription task, not a selection task — vat_rate above picks ONE dominant rate, vat_breakdown captures ALL of them. The two fields are INDEPENDENT. Do NOT zero out the smaller rate just because another rate has a larger amount; do NOT collapse the table into a single rate.

                      ★ INVOICE TYPES YOU WILL ENCOUNTER (any of these is normal — none is exceptional):
                        a. Only 9% — typical food invoice. Fill only net_9/vat_9; leave everything else 0.
                        b. Only 21% — typical non-food (packaging, services). Fill only net_21/vat_21; leave everything else 0.
                        c. Both 9% AND 21% — VERY COMMON in food wholesale (mixed goods). BOTH rate pairs must be filled. This is the failure case you've been getting wrong; assume mixed until you've actually counted the rows.
                        d. 9% / 21% / 0% all three — wholesale with emballage. Fill all three buckets.
                      Before writing any number, look at the BTW table and count how many rows it has. The number of rows equals the number of rate pairs you must fill.

                      ★ NO-DATA CASE: If you cannot find ANY non-zero value for vat_breakdown — i.e. you would otherwise output every field as 0 — return null for the whole object instead. A null vat_breakdown is the explicit "I could not read the BTW table" signal; an all-zero object is wrong because it suppresses the export builder's fallback (which would otherwise synthesise the breakdown from vat_rate + total_amount). Use null only when you genuinely cannot read the breakdown; if even one rate's Bedrag or B.T.W. is non-zero, return the object.

                      ★ THE #1 MISTAKE (do not make it):
                      Given an invoice whose BTW table has rows for both 21% and 9%, returning {net_21:0, vat_21:0, net_9:X, vat_9:Y} because 9% has the larger amounts. This is WRONG. Both pairs must be filled.

                      ★ PROCEDURE (follow in order):
                      Step 1. Locate the BTW/VAT summary block. On Dutch invoices it sits near the bottom (often bottom-left) above the grand total, with columns "Btw %" / "Bedrag" (or "Grondslag") / "B.T.W." (or "BTW bedrag"). It has 1–3 rows, one per rate. On photo/JPG/PNG invoices read carefully — numbers may be small. For multi-page invoices, the VAT summary table is often on the LAST page. Always check all pages before filling vat_breakdown. Look for sections labeled "VAT INFORMATION", "BTW Overzicht", "Btw%", or any summary table showing base amounts and tax amounts per rate.

                      → PDF-SPECIFIC: When the input is a PDF, the BTW table is sometimes flattened into plain text that has lost its column lines — it may appear as a sequence of triplets like "9,00 247,81 22,30" then "21,00 73,55 15,44" (rate, base, tax) on adjacent lines. Treat each such triplet as ONE row of the BTW table. Do not merge two triplets into one row, and do not stop after the first triplet.

                      Step 2. For EACH row of that table (do not skip any, even if its B.T.W. is 0):
                        - 21% row → net_21 = Bedrag, vat_21 = B.T.W.
                        - 9%  row → net_9  = Bedrag, vat_9  = B.T.W.
                        - 0%  row:
                            · Bedrag > 0  → emballage = that Bedrag (Dutch invoices use the 0% row for fust/statiegeld/emballage). Leave net_0 = 0.
                            · Bedrag = 0  → leave both net_0 and emballage = 0 for this row.

                      Step 2b. PERCENTAGE INFERENCE — if a row shows a Bedrag and a B.T.W. but the rate column is missing/unreadable, compute the rate yourself:
                          inferred_rate = round( B.T.W. / Bedrag * 100 )
                        Then bucket: 19–23 → 21%, 7–11 → 9%, 0–1 → 0%. Use the inferred rate to map the row in Step 2.
                        Example: Bedrag=247.81, B.T.W.=22.30 → 22.30 / 247.81 * 100 ≈ 9.00 → 9% row → net_9=247.81, vat_9=22.30.

                      Step 3. Scan the rest of the invoice for:
                        - A separately labelled "Fust" / "Emballage" / "Statiegeld" / "Leeggoed" total → if not already in emballage, add it.
                        - A "vrijgesteld" / "verlegd" / "intracommunautair" base outside the BTW table → put it in net_0.

                      Step 4. Sanity check: net_21 + vat_21 + net_9 + vat_9 + net_0 + emballage must equal total_amount within a few cents. If it doesn't, you almost certainly missed a row of the BTW table — go back to step 1 and re-read it before answering. A common pattern: when the sum is short by an amount that itself looks like ~21% of some base, you missed the 21% row.

                      ★ FIELD NAME VARIATIONS to recognize (different suppliers label the same column differently — match the label to the correct JSON field):
                        - net_9  (base amount at 9%):  may appear as "Base 9% VAT", "Grondslag 9%", "Bedrag 9%", "Btw% 9.00 Bedrag", "Artikel laag", "Base laag".
                        - vat_9  (tax amount at 9%):   may appear as "VAT 9%", "BTW 9%", "Btw laag", "B.T.W. 9%".
                        - net_21 (base amount at 21%): may appear as "Base 21% VAT", "Grondslag 21%", "Bedrag 21%", "Btw% 21.00 Bedrag", "Artikel hoog", "Base hoog".
                        - vat_21 (tax amount at 21%): may appear as "VAT 21%", "BTW 21%", "Btw hoog", "B.T.W. 21%".
                        - emballage: may appear as "Fust", "Statiegeld", "Emballage", or a 0% row with non-zero amount.

                      Shape (plain numbers only, no currency symbols, use 0 when absent):
                      { "net_21": <num>, "vat_21": <num>, "net_9": <num>, "vat_9": <num>, "net_0": <num>, "emballage": <num> }

                      ★ WORKED EXAMPLE — the failure case to memorise (Mix Food, total €369.91):
                      BTW table on the invoice reads:
                          0%   | Bedrag 10.80   | B.T.W. 0.00
                          9%   | Bedrag 247.81  | B.T.W. 22.30
                          21%  | Bedrag 73.55   | B.T.W. 15.44
                      CORRECT output:
                          {"net_21":73.55, "vat_21":15.44, "net_9":247.81, "vat_9":22.30, "net_0":0, "emballage":10.80}
                      Sum check: 73.55 + 15.44 + 247.81 + 22.30 + 0 + 10.80 = 369.90 ≈ 369.91. Good.
                      INCORRECT output (the bug — do NOT do this):
                          {"net_21":0, "vat_21":0, "net_9":247.81, "vat_9":22.30, "net_0":0, "emballage":0}
                      Sum check: 270.11 ≠ 369.91 → you missed the 21% row AND the 0% emballage row.

                      Other examples:
                      - Single 9%: grondslag €693.01, bedrag €62.37 → {"net_21":0,"vat_21":0,"net_9":693.01,"vat_9":62.37,"net_0":0,"emballage":0}
                      - Single 21%: grondslag €185.17, bedrag €38.89 → {"net_21":185.17,"vat_21":38.89,"net_9":0,"vat_9":0,"net_0":0,"emballage":0}
                      - Both rates + separate "Fust €10.80" line outside the BTW table → fill all rate fields AND emballage=10.80.
  transaction_type  – Almost always "inkoop". Only set to "verkoop" if the document explicitly says "Verkoopfactuur" or clearly shows it is a sales invoice issued BY the user's own company. Default "inkoop".
  confidence        – Your confidence 0.0–1.0 that the extraction is correct.

Arabic-specific rules:
  - Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) must be converted to Western numerals (0123456789).
  - Hijri (هجري) dates must be converted to Gregorian (YYYY-MM-DD). If only month+year given, use day 01.
  - Common Arabic date formats: DD/MM/YYYY, YYYY/MM/DD, D Month YYYY (١٤ أبريل ٢٠٢٦).
  - Currency symbols: ر.س or ريال = SAR, د.إ = AED, ج.م = EGP, د.ك = KWD, ر.ق = QAR, ر.ع = OMR.
  - Arabic invoice number may appear after: رقم الفاتورة / رقم المستند / فاتورة رقم.
  - Client name may appear after: اسم العميل / المورد / الجهة / الشركة.
  - Total may appear after: الإجمالي / المبلغ الإجمالي / إجمالي الفاتورة / المبلغ شامل الضريبة.

Dutch-specific rules:
  - Invoice number: factuurnummer / factnr.
  - Total: totaalbedrag / totaal incl. btw.
  - Currency: € = EUR.

English-specific rules:
  - Invoice number: invoice no / inv # / reference.
  - Total: total amount / amount due / grand total.

Return only the raw JSON array. No markdown, no explanation, no extra text.
`.trim();

export async function extractInvoicesFromUrls(fileUrls: string[]): Promise<ExtractedInvoice[]> {
  if (fileUrls.length === 0) return [];
  if (fileUrls.length > 10) throw new Error("Batch too large. Send 5-10 files per extraction request.");
  if (!client) throw new Error("OPENAI_API_KEY is not configured");

  // Generate signed URLs for S3 files
  const signedUrls = await Promise.all(
    fileUrls.map(async (fileUrl) =>
      fileUrl.startsWith("s3://") ? signedReadUrl(fileUrl, 60 * 20) : fileUrl
    )
  );

  // Download files and convert to base64 so GPT can read them regardless of URL format
  const fileBuffers = await Promise.all(
    signedUrls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download file from S3: ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      const mimeType = res.headers.get("content-type") || "application/octet-stream";
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return { base64, mimeType };
    })
  );

  return withRetry(async () => {
    const content: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: EXTRACTION_PROMPT
      },
      ...fileBuffers.map(({ base64, mimeType }, index) => {
        const originalLower = fileUrls[index].toLowerCase();

        const isPdf =
          mimeType === "application/pdf" ||
          originalLower.includes(".pdf");

        if (isPdf) {
          return {
            type: "input_file",
            filename: "invoice.pdf",
            file_data: `data:application/pdf;base64,${base64}`
          };
        }

        const imageMime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
        return {
          type: "input_image",
          image_url: `data:${imageMime};base64,${base64}`,
          detail: "high"
        };
      })
    ];

    const response = await client.responses.create({
      model: env.aiModel,
      input: [
        {
          role: "user",
          content: content as never
        }
      ],
      temperature: 0
    });

    const outputText = response.output_text;
    const results = parseJsonArray(outputText);

    return fileUrls.map((_, index) => results[index] ?? emptyResult());
  });
}
