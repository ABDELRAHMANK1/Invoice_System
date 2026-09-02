/**
 * Seed Dutch public holidays into `public_holidays` for one or more years.
 *
 * Dates are COMPUTED (lib/workforce/domain/public-holiday.ts), not hand-written:
 * Goede Vrijdag / Pasen / Hemelvaart / Pinksteren move with Easter each year and
 * Koningsdag shifts when 27 April is a Sunday. See that file for why the dates
 * are computed locally and persisted, rather than fetched from a holiday API at
 * request time.
 *
 * Run with real Supabase env loaded:
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/seed-public-holidays.ts 2026 2027
 *
 * With no arguments it seeds the current year and the next one. Idempotent: the
 * upsert conflicts on (country, date), so re-running only refreshes names.
 * Pass --dry to print the dates without writing.
 */
import { dutchPublicHolidays } from "@/lib/workforce/domain";
import { supabasePublicHolidayRepository } from "@/lib/workforce/infrastructure";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const years = args
    .filter((a) => /^\d{4}$/.test(a))
    .map(Number);

  if (years.length === 0) {
    const thisYear = new Date().getUTCFullYear();
    years.push(thisYear, thisYear + 1);
  }

  for (const year of years) {
    const holidays = dutchPublicHolidays(year);
    console.log(`\n${year} — ${holidays.length} holidays`);
    for (const h of holidays) console.log(`  ${h.date}  ${h.name}`);

    if (dryRun) continue;
    const written = await supabasePublicHolidayRepository.upsertMany(holidays);
    console.log(`  → upserted ${written} rows`);
  }

  if (dryRun) console.log("\n(dry run — nothing written)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
