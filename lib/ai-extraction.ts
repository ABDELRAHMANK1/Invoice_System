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
    return {
      client_name: item.client_name ?? null,
      supplier_name: item.supplier_name ?? null,
      invoice_number: item.invoice_number ?? null,
      date: item.date ?? null,
      total_amount: typeof item.total_amount === "number" ? item.total_amount : item.total_amount ? Number(item.total_amount) : null,
      currency: item.currency ?? null,
      vat_rate: vatRate,
      vat_breakdown: item.vat_breakdown && typeof item.vat_breakdown === "object" ? {
        net_21: Number(item.vat_breakdown.net_21) || 0,
        vat_21: Number(item.vat_breakdown.vat_21) || 0,
        net_9: Number(item.vat_breakdown.net_9) || 0,
        vat_9: Number(item.vat_breakdown.vat_9) || 0,
        net_0: Number(item.vat_breakdown.net_0) || 0,
        emballage: Number(item.vat_breakdown.emballage) || 0
      } : null,
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
  vat_breakdown     – An object with the FULL BTW breakdown of the invoice. Most Dutch invoices have a BTW table near the bottom with one row per rate (typically labelled "Btw%", "Bedrag" or "Grondslag", and "B.T.W." or "BTW bedrag"). YOU MUST READ EVERY ROW OF THAT TABLE — do not stop after the first non-zero row. All values are plain numbers (no currency symbols), use 0 when that rate is not present.

                      Field mapping (one BTW table row → one pair of fields):
                        • The Btw%=21 row  → "net_21" = Bedrag/Grondslag,  "vat_21" = B.T.W.
                        • The Btw%=9  row  → "net_9"  = Bedrag/Grondslag,  "vat_9"  = B.T.W.
                        • The Btw%=0  row  with B.T.W.=0:
                            - If its Bedrag > 0, that line represents emballage / statiegeld / fust → put the Bedrag into "emballage", leave "net_0" = 0.
                            - Otherwise (or if there is a separate "verlegd"/"vrijgesteld"/"intracommunautair" line) → put it into "net_0".
                        • A separately labelled "Fust" / "Emballage" / "Statiegeld" total → "emballage".

                      Shape:
                      {
                        "net_21": <Bedrag at 21%>,
                        "vat_21": <B.T.W. at 21%>,
                        "net_9":  <Bedrag at 9%>,
                        "vat_9":  <B.T.W. at 9%>,
                        "net_0":  <0% / vrijgesteld / verlegd base>,
                        "emballage": <emballage / statiegeld / fust amount>
                      }

                      Examples:
                      - BTW table: 9% → grondslag €693.01, bedrag €62.37; nothing at 21% → {"net_21":0,"vat_21":0,"net_9":693.01,"vat_9":62.37,"net_0":0,"emballage":0}
                      - BTW table: 21% → grondslag €185.17, bedrag €38.89 → {"net_21":185.17,"vat_21":38.89,"net_9":0,"vat_9":0,"net_0":0,"emballage":0}
                      - BTW table: 0% → 10.80/0.00, 9% → 247.81/22.30, 21% → 73.55/15.44 → {"net_21":73.55,"vat_21":15.44,"net_9":247.81,"vat_9":22.30,"net_0":0,"emballage":10.80}
                      - BTW table has both rates plus a separate "Fust €10.80" line → fill all rate fields AND emballage=10.80.

                      Validation: net_21 + vat_21 + net_9 + vat_9 + net_0 + emballage should equal total_amount (small rounding differences are OK). If your numbers do not add up, re-read the BTW table — you probably missed a row.
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
