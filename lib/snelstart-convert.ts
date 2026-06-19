// Shared core of the Snelstart "Alle-facturen" → verkoop Boekingen conversion.
// Used by BOTH the CLI (scripts/convert-snelstart-import.ts) and the dashboard
// API route (app/api/snelstart-import/route.ts) so the parsing/matching/BTW
// logic lives in exactly one place.
//
// Deliberately PURE: no Supabase, no S3, no env, no file/console I/O. The
// callers load the workbook (file vs upload), fetch customers from the DB, and
// render/print the summary. `InvoiceExportRow` is imported as a TYPE only, so
// this module never triggers lib/export-builders' env-validating import graph.

import type ExcelJS from "exceljs";
import { scoreMatch } from "@/lib/relatie-match";
import type { InvoiceExportRow } from "@/lib/export-builders";

/** Header row in the raw Snelstart export; data begins on the next row. */
export const SNELSTART_HEADER_ROW = 6;

/** Max upload accepted by the API route — a spreadsheet like this is tiny. */
export const SNELSTART_MAX_BYTES = 5 * 1024 * 1024;

/** Customer record needed for matching (subset of the customers table). */
export interface SnelstartCustomer {
  id: string;
  client_id: string;
  name: string;
  relatie_code: string | null;
}

export interface SnelstartSummary {
  sheetName: string;
  totalDataRows: number;
  skippedConcept: number;
  imported: number;
  btwZeroed: number;
  rateCounts: { 0: number; 9: number; 21: number };
  matched: number;
  blank: number;
  customersLoaded: number;
  sumIncl: number;
  sumExclSource: number;
  /** Distinct unmatched customer names (blank Relatiecode), sorted by count desc. */
  unmatchedNames: { name: string; count: number }[];
}

export interface SnelstartConvertResult {
  rows: InvoiceExportRow[];
  summary: SnelstartSummary;
}

/** Thrown when the uploaded sheet isn't the expected Snelstart shape → HTTP 400. */
export class SnelstartFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnelstartFormatError";
  }
}

// ── cell helpers ────────────────────────────────────────────────────────────

// HTML-entity decode — the source escapes names like "B&amp;Z" / "Str&#039;eat".
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&") // last: avoid double-decoding "&amp;#39;"
    .trim();
}

// ExcelJS cell → string, flattening formula/richText/hyperlink shapes.
export function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return decodeEntities(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("text" in v) return decodeEntities(String(v.text));
    if ("result" in v) return decodeEntities(String(v.result));
    if ("richText" in v && Array.isArray(v.richText)) {
      return decodeEntities((v.richText as Array<{ text: string }>).map((p) => p.text).join(""));
    }
  }
  return "";
}

export function cellNum(value: ExcelJS.CellValue): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("result" in v && typeof v.result === "number") return v.result;
  }
  const n = Number(String(cellText(value)).replace(/[^0-9.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export function cellDateISO(value: ExcelJS.CellValue): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const t = cellText(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const VAT_RATES = [0, 9, 21] as const;
export type VatRate = (typeof VAT_RATES)[number];

/** Compute the BTW rate from excl/incl, snapping to {0,9,21} within ~1 point. */
export function deriveVatRate(excl: number, incl: number): { rate: VatRate; zeroed: boolean } {
  const diff = incl - excl;
  if (excl <= 0 || diff <= 0.005) return { rate: 0, zeroed: false }; // genuinely 0% / no BTW
  const raw = (diff / excl) * 100;
  let nearest: VatRate = 0;
  let bestDist = Infinity;
  for (const r of VAT_RATES) {
    const d = Math.abs(raw - r);
    if (d < bestDist) { bestDist = d; nearest = r; }
  }
  if (bestDist <= 1) return { rate: nearest, zeroed: false };
  // Un-snappable rate (e.g. mixed/garbled): zero the BTW but keep the row.
  return { rate: 0, zeroed: true };
}

// ── core conversion ─────────────────────────────────────────────────────────

const REQUIRED_COLUMNS = [
  "Factuurnummer",
  "Datum",
  "Status",
  "Client",
  "Bedrag exclusief BTW",
  "Bedrag inclusief BTW",
] as const;
// NOTE: the source's own "Klantnummer" column is deliberately IGNORED — it's
// from Ammar's old system and is NOT our relatie_code. Relatiecodes come only
// from a fuzzy name-match against our customers table.

/**
 * Convert a raw Snelstart "Alle-facturen" worksheet into verkoop
 * InvoiceExportRows + a summary. Customers (already scoped to one client by the
 * caller) drive the fuzzy Relatiecode match; no match → blank relatie_code.
 *
 * @throws SnelstartFormatError when the header row is missing required columns.
 */
export function convertSnelstartSheet(
  sheet: ExcelJS.Worksheet,
  customers: SnelstartCustomer[],
): SnelstartConvertResult {
  // Map header columns by name so column order can't silently drift.
  const header = sheet.getRow(SNELSTART_HEADER_ROW);
  const colOf: Record<string, number> = {};
  header.eachCell((cell, col) => { colOf[cellText(cell.value).toLowerCase()] = col; });
  const need = (name: string) => {
    const c = colOf[name.toLowerCase()];
    if (!c) {
      throw new SnelstartFormatError(
        `This doesn't look like a Snelstart "Alle-facturen" export: column "${name}" not found in header row ${SNELSTART_HEADER_ROW}.`,
      );
    }
    return c;
  };
  const cols = Object.fromEntries(REQUIRED_COLUMNS.map((n) => [n, need(n)])) as Record<(typeof REQUIRED_COLUMNS)[number], number>;

  let totalDataRows = 0, skippedConcept = 0, btwZeroed = 0, matched = 0, blank = 0;
  const unmatched = new Map<string, number>();
  const rateCounts: Record<VatRate, number> = { 0: 0, 9: 0, 21: 0 };
  let sumIncl = 0, sumExclSource = 0;

  const rows: InvoiceExportRow[] = [];
  const nowIso = new Date().toISOString();

  for (let r = SNELSTART_HEADER_ROW + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const factuur = cellText(row.getCell(cols.Factuurnummer).value);
    const status  = cellText(row.getCell(cols.Status).value);
    const client  = cellText(row.getCell(cols.Client).value);
    // Wholly blank row → skip silently (trailing spacers).
    if (!factuur && !status && !client) continue;

    totalDataRows++;
    if (status.toLowerCase() === "concept") { skippedConcept++; continue; }

    const excl = cellNum(row.getCell(cols["Bedrag exclusief BTW"]).value);
    const incl = cellNum(row.getCell(cols["Bedrag inclusief BTW"]).value);

    const { rate, zeroed } = deriveVatRate(excl, incl);
    if (zeroed) btwZeroed++;
    rateCounts[rate]++;
    sumIncl += incl;
    sumExclSource += excl;

    // Relatiecode: fuzzy-match the customer name against our customers table
    // only. No confident match → blank (tracked for review), no other fallback.
    let relatieCode: string | null = null;
    let best: { code: string | null; score: number } | null = null;
    for (const c of customers) {
      const score = scoreMatch(c.name, client);
      if (score > 0 && (best === null || score > best.score)) best = { code: c.relatie_code, score };
    }
    if (best && best.code) {
      relatieCode = best.code;
      matched++;
    } else {
      blank++;
      const key = client || "(blank name)";
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    }

    rows.push({
      id: `import-${r}`,
      invoice_number: factuur,
      client_name: client || null,
      customer_name: client || null, // counterparty → Relatienaam on the verkoop sheet
      customer_id: null,
      phone_number: "",
      date: cellDateISO(row.getCell(cols.Datum).value),
      total_amount: incl,
      currency: "EUR",
      file_url: "",
      status: "extracted",
      created_at: nowIso,
      invoice_direction: "verkoop",
      raw_extraction: { vat_rate: rate },
      relatie_code: relatieCode,
    });
  }

  const unmatchedNames = [...unmatched.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    rows,
    summary: {
      sheetName: sheet.name,
      totalDataRows,
      skippedConcept,
      imported: rows.length,
      btwZeroed,
      rateCounts,
      matched,
      blank,
      customersLoaded: customers.length,
      sumIncl: Math.round(sumIncl * 100) / 100,
      sumExclSource: Math.round(sumExclSource * 100) / 100,
      unmatchedNames,
    },
  };
}
