// Bulk Snelstart Converter — turns an EXTERNAL raw invoice spreadsheet (e.g. a
// legacy-system export, NOT our own `invoices` table) into verkoop
// InvoiceExportRows, ready to feed lib/export-builders' buildInvoiceExcelBuffer.
//
// Distinct from lib/snelstart-convert (which parses Snelstart's own fixed
// "Alle-facturen" export at header row 6). This one:
//   • detects the header row + aliases columns, so slightly different column
//     names / a title band above the header still parse;
//   • computes the VAT rate from incl − excl and, for rates that DON'T snap to
//     {0,9,21}, keeps the REAL excl/btw numbers and flags the row instead of
//     forcing it into a bucket;
//   • treats Status "Concept" as a draft: a single zero-amount booking line;
//   • leaves Relatiecode blank + flags rows whose Client name has no confident
//     match against the chosen client's `customers` (reusing the shared fuzzy
//     matcher from lib/relatie-match — NOT the source file's own Klantnummer).
//
// PURE: no Supabase / S3 / env / IO. Callers load the workbook + customers.

import type ExcelJS from "exceljs";
import { bestNameMatch } from "@/lib/relatie-match";
import { cellText, cellNum, cellDateISO } from "@/lib/snelstart-convert";
import type { InvoiceExportRow, VerkoopVariant } from "@/lib/export-builders";

export const RAW_MAX_BYTES = 5 * 1024 * 1024;
/** How many leading rows to scan when locating the header row. */
const HEADER_SCAN_ROWS = 20;

export interface RawConvertCustomer {
  id: string;
  name: string;
  relatie_code: string | null;
}

export interface RawConvertSummary {
  sheetName: string;
  detectedColumns: string[];
  headerRow: number;
  totalDataRows: number;
  imported: number;
  concept: number;
  matched: number;
  blank: number;
  anomalous: number;
  rateCounts: { 0: number; 9: number; 21: number };
  customersLoaded: number;
  sumIncl: number;
  sumExcl: number;
  /** Distinct unmatched Client names (blank Relatiecode), most frequent first. */
  unmatchedNames: { name: string; count: number }[];
  /** Invoices whose VAT rate didn't snap to {0,9,21}. */
  anomalousInvoices: { invoice: string; rate: number }[];
}

export interface RawConvertResult {
  rows: InvoiceExportRow[];
  summary: RawConvertSummary;
}

/** Thrown when the sheet has no recognisable header → HTTP 400. */
export class RawConvertFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawConvertFormatError";
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── header detection ──────────────────────────────────────────────────────

type Field = "factuurnummer" | "datum" | "client" | "excl" | "incl" | "status" | "klantnummer";

const REQUIRED_FIELDS: Field[] = ["factuurnummer", "datum", "client", "excl", "incl"];

// Normalised header aliases. Match is lowercased with spaces/punctuation stripped.
const FIELD_ALIASES: Record<Field, string[]> = {
  factuurnummer: ["factuurnummer", "factuurnr", "factuurnrs", "factuur", "invoicenumber", "invoiceno", "invoicenr", "nummer", "number", "nr"],
  datum:         ["datum", "date", "factuurdatum", "invoicedate"],
  client:        ["client", "klant", "customer", "relatie", "relatienaam", "naam", "debiteur", "afnemer", "clientname", "klantnaam", "customername"],
  excl:          ["bedragexclusiefbtw", "bedragexclbtw", "exclusiefbtw", "exclbtw", "excl", "bedragexcl", "nettobedrag", "netto", "amountexclvat", "exclvat", "subtotaal", "bedragexclusief"],
  incl:          ["bedraginclusiefbtw", "bedraginclbtw", "inclusiefbtw", "inclbtw", "incl", "bedragincl", "totaalbedrag", "totaal", "amountinclvat", "inclvat", "total", "bedraginclusief"],
  status:        ["status", "factuurstatus"],
  klantnummer:   ["klantnummer", "klantnr", "customernumber", "customerno"],
};

function normHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_.\-/()]/g, "");
}

interface HeaderMatch {
  rowNum: number;
  cols: Partial<Record<Field, number>>;
}

/** Scan the first HEADER_SCAN_ROWS for the row that resolves the most fields;
 *  require all REQUIRED_FIELDS. Returns the best qualifying row. */
function detectHeader(sheet: ExcelJS.Worksheet): HeaderMatch {
  const lastScan = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
  let best: HeaderMatch | null = null;

  for (let r = 1; r <= lastScan; r += 1) {
    const cols: Partial<Record<Field, number>> = {};
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const norm = normHeader(cellText(cell.value));
      if (!norm) return;
      for (const field of Object.keys(FIELD_ALIASES) as Field[]) {
        if (cols[field] != null) continue;
        if (FIELD_ALIASES[field].includes(norm)) { cols[field] = col; return; }
      }
    });
    const score = Object.keys(cols).length;
    if (best === null || score > Object.keys(best.cols).length) best = { rowNum: r, cols };
    if (REQUIRED_FIELDS.every((f) => cols[f] != null)) return { rowNum: r, cols };
  }

  const found = best ? (Object.keys(best.cols) as Field[]) : [];
  const missing = REQUIRED_FIELDS.filter((f) => !found.includes(f));
  throw new RawConvertFormatError(
    `Could not find an invoice header row. Missing required column${missing.length === 1 ? "" : "s"}: ` +
      `${missing.join(", ")}. Expected at least: Factuurnummer, Datum, Client, Bedrag exclusief BTW, Bedrag inclusief BTW.`,
  );
}

// ── VAT classification ────────────────────────────────────────────────────

interface VatClass {
  variant: VerkoopVariant;
  net: number;
  btw: number;
  rate: number;
  /** Bucketed rate for display/summary (0/9/21); null when anomalous. */
  bucket: 0 | 9 | 21 | null;
  anomalous: boolean;
}

/** Classify from real excl/incl, keeping real numbers. Snaps to {0,9,21} within
 *  1 point; otherwise anomalous → real net/btw kept on laag/hoog accounts, flagged. */
function classifyVat(excl: number, incl: number): VatClass {
  const diff = incl - excl;
  // Genuine 0% / no BTW → Omzet binnen EU (net carries the full amount).
  if (excl <= 0 || diff <= 0.005) {
    return { variant: "vrij", net: round2(incl), btw: 0, rate: 0, bucket: 0, anomalous: false };
  }

  const rate = (diff / excl) * 100;
  const net = round2(excl);
  const btw = round2(diff);

  const snap: { r: 0 | 9 | 21; v: VerkoopVariant }[] = [
    { r: 0, v: "vrij" }, { r: 9, v: "laag" }, { r: 21, v: "hoog" },
  ];
  let nearest = snap[0];
  let bestDist = Infinity;
  for (const s of snap) {
    const d = Math.abs(rate - s.r);
    if (d < bestDist) { bestDist = d; nearest = s; }
  }

  if (bestDist <= 1) {
    if (nearest.r === 0) return { variant: "vrij", net: round2(incl), btw: 0, rate, bucket: 0, anomalous: false };
    return { variant: nearest.v, net, btw, rate, bucket: nearest.r, anomalous: false };
  }

  // Anomalous: keep the real numbers on a BTW-bearing variant (laag/hoog,
  // whichever is closer) so nothing is silently dropped; flag for review.
  const variant: VerkoopVariant = Math.abs(rate - 9) <= Math.abs(rate - 21) ? "laag" : "hoog";
  return { variant, net, btw, rate, bucket: null, anomalous: true };
}

// ── core conversion ───────────────────────────────────────────────────────

/**
 * Convert an external raw invoice worksheet into verkoop InvoiceExportRows +
 * a summary. `customers` (already scoped to the chosen client by the caller)
 * drive the fuzzy Relatiecode match.
 *
 * @throws RawConvertFormatError when no invoice header row can be located.
 */
export function convertRawInvoiceSheet(
  sheet: ExcelJS.Worksheet,
  customers: RawConvertCustomer[],
): RawConvertResult {
  const { rowNum: headerRow, cols } = detectHeader(sheet);
  const cell = (row: ExcelJS.Row, field: Field) => {
    const c = cols[field];
    return c == null ? undefined : row.getCell(c).value;
  };

  let totalDataRows = 0, concept = 0, matched = 0, blank = 0, anomalous = 0;
  let sumIncl = 0, sumExcl = 0;
  const rateCounts: Record<0 | 9 | 21, number> = { 0: 0, 9: 0, 21: 0 };
  const unmatched = new Map<string, number>();
  const anomalousInvoices: { invoice: string; rate: number }[] = [];

  const rows: InvoiceExportRow[] = [];
  const nowIso = new Date().toISOString();

  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const factuur = cellText(cell(row, "factuurnummer") ?? null);
    const client  = cellText(cell(row, "client") ?? null);
    const status  = cols.status != null ? cellText(cell(row, "status") ?? null) : "";
    const excl    = cellNum(cell(row, "excl") ?? null);
    const incl    = cellNum(cell(row, "incl") ?? null);

    // Wholly blank spacer row → skip silently.
    if (!factuur && !client && excl === 0 && incl === 0 && !status) continue;
    totalDataRows += 1;

    // Fuzzy Relatiecode match against this client's customers (name only).
    const nameMatch = client ? bestNameMatch(customers, (c) => c.name, client) : null;
    const code = nameMatch?.match.relatie_code?.trim() || "";
    let relatieCode: string | null = null;
    const noteParts: string[] = [];
    if (code) {
      relatieCode = code;
      matched += 1;
    } else {
      blank += 1;
      const key = client || "(blank name)";
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
      noteParts.push(`No Relatiecode match${client ? ` for "${client}"` : ""}`);
    }

    const isConcept = status.toLowerCase() === "concept";

    let verkoopAmounts: { net: number; btw: number; variant: VerkoopVariant };
    let totalAmount: number;
    let bucketRate: 0 | 9 | 21 | null;

    if (isConcept) {
      // Draft: a single zero-amount booking line, no VAT split.
      concept += 1;
      verkoopAmounts = { net: 0, btw: 0, variant: "draft" };
      totalAmount = 0;
      bucketRate = null;
    } else {
      const cls = classifyVat(excl, incl);
      verkoopAmounts = { net: cls.net, btw: cls.btw, variant: cls.variant };
      totalAmount = incl;
      bucketRate = cls.bucket;
      sumIncl += incl;
      sumExcl += excl;
      if (cls.anomalous) {
        anomalous += 1;
        anomalousInvoices.push({ invoice: factuur || `(row ${r})`, rate: Math.round(cls.rate * 10) / 10 });
        noteParts.push(`Anomalous VAT rate ${cls.rate.toFixed(1)}% — verify`);
      } else if (cls.bucket != null) {
        rateCounts[cls.bucket] += 1;
      }
    }

    rows.push({
      id: `raw-${r}`,
      invoice_number: factuur,
      client_name: client || null,
      customer_name: client || null,
      customer_id: null,
      phone_number: "",
      date: cellDateISO(cell(row, "datum") ?? null),
      total_amount: totalAmount,
      currency: "EUR",
      file_url: "",
      status: "extracted",
      created_at: nowIso,
      invoice_direction: "verkoop",
      raw_extraction: { vat_rate: bucketRate },
      relatie_code: relatieCode,
      verkoop_amounts: verkoopAmounts,
      review_note: noteParts.length ? noteParts.join("; ") : null,
    });
  }

  const unmatchedNames = [...unmatched.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    rows,
    summary: {
      sheetName: sheet.name,
      detectedColumns: (Object.keys(cols) as Field[]).filter((f) => cols[f] != null),
      headerRow,
      totalDataRows,
      imported: rows.length,
      concept,
      matched,
      blank,
      anomalous,
      rateCounts,
      customersLoaded: customers.length,
      sumIncl: round2(sumIncl),
      sumExcl: round2(sumExcl),
      unmatchedNames,
      anomalousInvoices,
    },
  };
}
