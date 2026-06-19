/**
 * Standalone one-off converter: a raw Snelstart "Alle-facturen" export →
 * our native Snelstart Boekingen VERKOOP sheet.
 *
 * Pure file-to-file. It NEVER writes to Supabase or the invoices table; it only
 * (optionally) READS the customers table to resolve Relatiecodes by fuzzy name
 * match. If no Supabase credentials are present it simply skips matching and
 * leaves those Relatiecodes blank — the conversion still runs.
 *
 * Source layout (one client's sales): header on ROW 6 —
 *   Factuurnummer | Datum | Status | Client | Klantnummer |
 *   Bedrag exclusief BTW | Bedrag inclusief BTW
 * "Client" here is the COUNTERPARTY Oranje sold to → our `customers` table.
 *
 * Row rules:
 *   • Skip rows where Status = "Concept" (no invoice number yet).
 *   • Import every other status (Open, Betaald, Te laat) as-is.
 *   • BTW rate is not given: compute round(((incl-excl)/excl)*100) and snap to
 *     the nearest of {0,9,21} when within ~1 point; otherwise zero the BTW for
 *     that row (still include it, rate 0).
 *   • Relatiecode: prefer the source Klantnummer when present, else fuzzy-match
 *     the Client name against the customers table (reusing lib/relatie-match),
 *     else leave blank.
 *   • Factuurnummer is used as-is.
 *
 * Usage:
 *   npx tsx scripts/convert-snelstart-import.ts <input.xlsx> [options]
 *     --out <file.xlsx>   also write the converted workbook (default: dry-run,
 *                         prints a summary only)
 *     --client <uuid>     scope customer matching to one client_id
 *     --sheet <name>      source sheet name (default: first sheet)
 *
 * The reused builder (lib/export-builders) transitively imports modules that
 * validate Supabase env at load, so we set placeholders BEFORE importing it and
 * only touch the real DB when genuine credentials exist.
 */

import ExcelJS from "exceljs";
import { scoreMatch } from "@/lib/relatie-match";
import type { InvoiceExportRow } from "@/lib/export-builders";

// Capture whether real Supabase creds exist, THEN drop in placeholders so the
// env-validating import graph (lib/env, lib/storage) doesn't throw when they're
// absent. We only ever call buildInvoiceExcelBuffer (pure ExcelJS) and write the
// buffer ourselves — the S3 client built at import of lib/storage is never used.
const HAS_SUPABASE = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://placeholder.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "placeholder-service-role-key";
process.env.AWS_REGION ||= "eu-north-1";
process.env.AWS_ACCESS_KEY_ID ||= "placeholder";
process.env.AWS_SECRET_ACCESS_KEY ||= "placeholder";
process.env.AWS_S3_BUCKET ||= "placeholder-bucket";

const HEADER_ROW = 6; // header row in the source file; data starts at HEADER_ROW + 1

type Args = { input: string; out?: string; client?: string; sheet?: string };

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--client") out.client = argv[++i];
    else if (a === "--sheet") out.sheet = argv[++i];
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  if (!positional[0]) {
    throw new Error("Usage: npx tsx scripts/convert-snelstart-import.ts <input.xlsx> [--out <file.xlsx>] [--client <uuid>] [--sheet <name>]");
  }
  return { input: positional[0], out: out.out, client: out.client, sheet: out.sheet };
}

// HTML-entity decode — the source escapes names like "B&amp;Z" / "Str&#039;eat".
function decodeEntities(s: string): string {
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
function cellText(value: ExcelJS.CellValue): string {
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

function cellNum(value: ExcelJS.CellValue): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("result" in v && typeof v.result === "number") return v.result;
  }
  const n = Number(String(cellText(value)).replace(/[^0-9.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function cellDateISO(value: ExcelJS.CellValue): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const t = cellText(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const VAT_RATES = [0, 9, 21] as const;
type VatRate = (typeof VAT_RATES)[number];

/** Compute the BTW rate from excl/incl, snapping to {0,9,21} within ~1 point. */
function deriveVatRate(excl: number, incl: number): { rate: VatRate; zeroed: boolean } {
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

type CustomerRow = { id: string; client_id: string; name: string; relatie_code: string | null };

async function loadCustomers(clientId?: string): Promise<CustomerRow[]> {
  if (!HAS_SUPABASE) return [];
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin");
    let q = supabaseAdmin.from("customers").select("id,client_id,name,relatie_code");
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q.limit(10000);
    if (error) { console.warn(`[convert] customers query failed: ${error.message} — matching skipped`); return []; }
    return (data ?? []) as CustomerRow[];
  } catch (e) {
    console.warn(`[convert] could not reach Supabase: ${(e as Error).message} — matching skipped`);
    return [];
  }
}

function fmtEUR(n: number): string {
  return n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.input);
  const sheet = args.sheet ? wb.getWorksheet(args.sheet) : wb.worksheets[0];
  if (!sheet) throw new Error(`Sheet not found${args.sheet ? `: ${args.sheet}` : ""}`);

  // Map header columns by name so column order can't silently drift.
  const header = sheet.getRow(HEADER_ROW);
  const colOf: Record<string, number> = {};
  header.eachCell((cell, col) => { colOf[cellText(cell.value).toLowerCase()] = col; });
  const need = (name: string) => {
    const c = colOf[name.toLowerCase()];
    if (!c) throw new Error(`Column "${name}" not found in header row ${HEADER_ROW}. Found: ${Object.keys(colOf).join(", ")}`);
    return c;
  };
  const cFactuur = need("Factuurnummer");
  const cDatum   = need("Datum");
  const cStatus  = need("Status");
  const cClient  = need("Client");
  const cExcl    = need("Bedrag exclusief BTW");
  const cIncl    = need("Bedrag inclusief BTW");
  // NOTE: the source's own "Klantnummer" column is deliberately IGNORED — it's
  // from Ammar's old system and is NOT our relatie_code. Relatiecodes come only
  // from a fuzzy name-match against our customers table.

  const customers = await loadCustomers(args.client);

  // Counters for the summary.
  let totalDataRows = 0, skippedConcept = 0, btwZeroed = 0;
  let fuzzyMatched = 0, unmatched = 0;
  const unmatchedNames = new Map<string, number>(); // name → row count, for review
  const rateCounts: Record<VatRate, number> = { 0: 0, 9: 0, 21: 0 };
  let sumIncl = 0, sumExclSource = 0;

  const rows: InvoiceExportRow[] = [];
  const nowIso = new Date().toISOString();

  for (let r = HEADER_ROW + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const factuur = cellText(row.getCell(cFactuur).value);
    const status  = cellText(row.getCell(cStatus).value);
    const client  = cellText(row.getCell(cClient).value);
    // Wholly blank row → skip silently (trailing spacers).
    if (!factuur && !status && !client) continue;

    totalDataRows++;
    if (status.toLowerCase() === "concept") { skippedConcept++; continue; }

    const excl = cellNum(row.getCell(cExcl).value);
    const incl = cellNum(row.getCell(cIncl).value);

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
      fuzzyMatched++;
    } else {
      unmatched++;
      const key = client || "(blank name)";
      unmatchedNames.set(key, (unmatchedNames.get(key) ?? 0) + 1);
    }

    rows.push({
      id: `import-${r}`,
      invoice_number: factuur,
      client_name: client || null,
      customer_name: client || null, // counterparty → Relatienaam on the verkoop sheet
      customer_id: null,
      phone_number: "",
      date: cellDateISO(row.getCell(cDatum).value),
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

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n──────── Snelstart import conversion ────────");
  console.log(`Source file        : ${args.input}`);
  console.log(`Sheet              : ${sheet.name}`);
  console.log(`Data rows (row ${HEADER_ROW + 1}+) : ${totalDataRows}`);
  console.log(`  skipped (Concept): ${skippedConcept}`);
  console.log(`  imported         : ${rows.length}`);
  console.log(`BTW rate split     : 21% → ${rateCounts[21]}   9% → ${rateCounts[9]}   0%/geen → ${rateCounts[0]}`);
  console.log(`  of which zeroed  : ${btwZeroed}  (rate couldn't snap to {0,9,21})`);
  console.log(`Relatiecode (fuzzy name-match vs customers table):`);
  console.log(`  matched          : ${fuzzyMatched}`);
  console.log(`  blank (no match) : ${unmatched}`);
  console.log(`  customers loaded : ${customers.length}${HAS_SUPABASE ? "" : "  ⚠ NO Supabase creds — every row is blank; run with real env"}`);
  console.log(`Totals (imported)  : incl € ${fmtEUR(sumIncl)}   |  source excl € ${fmtEUR(sumExclSource)}`);
  console.log("  ↑ compare incl against the SUM at the top of the source file (cell G).");

  if (unmatchedNames.size > 0) {
    const sorted = [...unmatchedNames.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    console.log(`\n── Unmatched customer names (${sorted.length} distinct) — review/add in the dashboard, or leave blank for Ammar ──`);
    for (const [name, count] of sorted) console.log(`  • ${name}${count > 1 ? `  (${count} invoices)` : ""}`);
  }

  if (!args.out) {
    console.log("\nDRY RUN — no file written. Re-run with --out <file.xlsx> to produce the workbook.\n");
    return;
  }

  const { buildInvoiceExcelBuffer } = await import("@/lib/export-builders");
  // Unmatched rows must keep a BLANK Relatiecode (no boekstuk fallback) so Ammar
  // can fill them in manually.
  const buffer = await buildInvoiceExcelBuffer(rows, { blankUnmatchedRelatiecode: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(args.out, buffer);
  console.log(`\nWrote ${rows.length} invoices → ${args.out}\n`);
}

main().catch((e) => { console.error(`\n[convert] ERROR: ${e.message}\n`); process.exit(1); });
