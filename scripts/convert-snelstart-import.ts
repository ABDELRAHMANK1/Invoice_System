/**
 * Standalone one-off converter: a raw Snelstart "Alle-facturen" export →
 * our native Snelstart Boekingen VERKOOP sheet.
 *
 * The parsing / BTW / matching / summary logic lives in lib/snelstart-convert.ts
 * and is shared with the dashboard API route (app/api/snelstart-import). This
 * file is just the CLI shell: arg parsing, loading customers from Supabase,
 * printing the summary, and writing the output workbook.
 *
 * Pure file-to-file. It NEVER writes to Supabase or the invoices table; it only
 * (optionally) READS the customers table to resolve Relatiecodes by fuzzy name
 * match. If no Supabase credentials are present it skips matching and leaves
 * those Relatiecodes blank — the conversion still runs.
 *
 * Source layout (one client's sales): header on ROW 6 —
 *   Factuurnummer | Datum | Status | Client | Klantnummer |
 *   Bedrag exclusief BTW | Bedrag inclusief BTW
 * "Client" here is the COUNTERPARTY Oranje sold to → our `customers` table.
 *
 * Usage:
 *   npx tsx scripts/convert-snelstart-import.ts <input.xlsx> [options]
 *     --out <file.xlsx>   also write the converted workbook (default: dry-run,
 *                         prints a summary only)
 *     --client <uuid>     scope customer matching to one client_id
 *     --sheet <name>      source sheet name (default: first sheet)
 *
 * The reused builder (lib/export-builders) transitively imports modules that
 * validate Supabase env at load, so we set placeholders BEFORE dynamically
 * importing it and only touch the real DB when genuine credentials exist.
 */

import ExcelJS from "exceljs";
import {
  SNELSTART_HEADER_ROW,
  convertSnelstartSheet,
  type SnelstartCustomer,
  type SnelstartSummary,
} from "@/lib/snelstart-convert";

// Capture whether real Supabase creds exist, THEN drop in placeholders so the
// env-validating import graph (lib/env, lib/storage — reached via the dynamic
// import of lib/export-builders) doesn't throw when they're absent.
const HAS_SUPABASE = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://placeholder.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "placeholder-service-role-key";
process.env.AWS_REGION ||= "eu-north-1";
process.env.AWS_ACCESS_KEY_ID ||= "placeholder";
process.env.AWS_SECRET_ACCESS_KEY ||= "placeholder";
process.env.AWS_S3_BUCKET ||= "placeholder-bucket";

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

async function loadCustomers(clientId?: string): Promise<SnelstartCustomer[]> {
  if (!HAS_SUPABASE) return [];
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin");
    let q = supabaseAdmin.from("customers").select("id,client_id,name,relatie_code");
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q.limit(10000);
    if (error) { console.warn(`[convert] customers query failed: ${error.message} — matching skipped`); return []; }
    return (data ?? []) as SnelstartCustomer[];
  } catch (e) {
    console.warn(`[convert] could not reach Supabase: ${(e as Error).message} — matching skipped`);
    return [];
  }
}

function fmtEUR(n: number): string {
  return n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printSummary(inputPath: string, s: SnelstartSummary): void {
  console.log("\n──────── Snelstart import conversion ────────");
  console.log(`Source file        : ${inputPath}`);
  console.log(`Sheet              : ${s.sheetName}`);
  console.log(`Data rows (row ${SNELSTART_HEADER_ROW + 1}+) : ${s.totalDataRows}`);
  console.log(`  skipped (Concept): ${s.skippedConcept}`);
  console.log(`  imported         : ${s.imported}`);
  console.log(`BTW rate split     : 21% → ${s.rateCounts[21]}   9% → ${s.rateCounts[9]}   0%/geen → ${s.rateCounts[0]}`);
  console.log(`  of which zeroed  : ${s.btwZeroed}  (rate couldn't snap to {0,9,21})`);
  console.log(`Relatiecode (fuzzy name-match vs customers table):`);
  console.log(`  matched          : ${s.matched}`);
  console.log(`  blank (no match) : ${s.blank}`);
  console.log(`  customers loaded : ${s.customersLoaded}${HAS_SUPABASE ? "" : "  ⚠ NO Supabase creds — every row is blank; run with real env"}`);
  console.log(`Totals (imported)  : incl € ${fmtEUR(s.sumIncl)}   |  source excl € ${fmtEUR(s.sumExclSource)}`);
  console.log("  ↑ compare incl against the SUM at the top of the source file (cell G).");

  if (s.unmatchedNames.length > 0) {
    console.log(`\n── Unmatched customer names (${s.unmatchedNames.length} distinct) — review/add in the dashboard, or leave blank for Ammar ──`);
    for (const { name, count } of s.unmatchedNames) console.log(`  • ${name}${count > 1 ? `  (${count} invoices)` : ""}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.input);
  const sheet = args.sheet ? wb.getWorksheet(args.sheet) : wb.worksheets[0];
  if (!sheet) throw new Error(`Sheet not found${args.sheet ? `: ${args.sheet}` : ""}`);

  const customers = await loadCustomers(args.client);
  const { rows, summary } = convertSnelstartSheet(sheet, customers);

  printSummary(args.input, summary);

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
