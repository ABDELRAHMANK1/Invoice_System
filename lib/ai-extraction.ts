import OpenAI from "openai";
import { env } from "@/lib/env";
import { signedReadUrl } from "@/lib/storage";
import type { ExtractedInvoice } from "@/lib/types";

const client = env.openAiApiKey ? new OpenAI({ apiKey: env.openAiApiKey }) : null;

function emptyResult(): ExtractedInvoice {
  return {
    client_name: null,
    invoice_number: null,
    date: null,
    total_amount: null,
    currency: null,
    vat_rate: 21,
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
      invoice_number: item.invoice_number ?? null,
      date: item.date ?? null,
      total_amount: typeof item.total_amount === "number" ? item.total_amount : item.total_amount ? Number(item.total_amount) : null,
      currency: item.currency ?? null,
      vat_rate: vatRate,
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
  client_name       – The name of the company that ISSUED this invoice (the supplier/vendor). Look at the TOP of the document — the letterhead, header, logo area, or the most prominent company name. Do NOT use the "Naam:", "Bill To:", "Factuur aan:", or "Klant:" field — those refer to the RECIPIENT of the invoice, not the supplier. Preserve original script (Arabic or Latin). Do not translate. Examples: header says "Nema Food B.V.", Naam says "Roni Market" → client_name = "Nema Food B.V."; header says "RAJEH FOOD", under Factuur says "Roni Market" → client_name = "RAJEH FOOD".
  invoice_number    – The invoice or document number (رقم الفاتورة / factuurnummer / invoice no). Keep as string.
  date              – Invoice date in ISO format YYYY-MM-DD.
  total_amount      – Grand total as a plain number INCLUDING tax/VAT/BTW/ضريبة. No currency symbols.
  currency          – ISO 4217 three-letter code (SAR, AED, EGP, EUR, USD, GBP …). Detect from symbol or context.
  vat_rate          – VAT/BTW/ضريبة القيمة المضافة percentage as integer: exactly 21, 9, or 0. Use dominant rate. Default 21.
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

  const signedUrls = await Promise.all(
    fileUrls.map(async (fileUrl) => (fileUrl.startsWith("s3://") ? signedReadUrl(fileUrl, 60 * 20) : fileUrl))
  );

  return withRetry(async () => {
    const content: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: EXTRACTION_PROMPT
      },
      ...signedUrls.map((url) => {
        const lower = url.toLowerCase();
        if (lower.includes(".pdf") || lower.includes("content-type=application%2Fpdf")) {
          return { type: "input_file", file_url: url };
        }

        return { type: "input_image", image_url: url, detail: "high" };
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
