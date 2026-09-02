/**
 * Dutch public holidays.
 *
 * Storage is per DATE (table `public_holidays`, migration 011) rather than a set
 * of weekday rules, because most of the list moves every year:
 *   • Goede Vrijdag, Pasen, Hemelvaart and Pinksteren are all derived from
 *     Easter Sunday, which is a lunar calculation, not a calendar rule.
 *   • Koningsdag is 27 April, except when that is a Sunday — then it moves to
 *     26 April.
 *
 * The rows are produced by `dutchPublicHolidays(year)` below (pure, dependency
 * free, unit-tested) and upserted by scripts/seed-public-holidays.ts. That is the
 * middle path between the two obvious options:
 *   • hand-written SQL per year — no dependency, but silently runs out and a
 *     generated schedule would then quietly treat Tweede Paasdag as a work day;
 *   • an external holiday API/library at runtime — always current, but adds a
 *     network dependency (and a failure mode) to a serverless request path, for
 *     a calculation that is ~20 lines and has not changed since 1583.
 * Computing them locally and persisting them keeps the table queryable and
 * hand-editable (a client-specific closure can be added as a row) with no new
 * dependency and no yearly SQL to remember.
 */

export interface PublicHoliday {
  id: string;
  country: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Generated from `date` in Postgres — never set it by hand. */
  year: number;
  name: string;
  created_at: string;
  updated_at: string;
}

/** What the seeder writes; `year` is derived by the database. */
export interface PublicHolidayInput {
  country: string;
  date: string;
  name: string;
}

export const DEFAULT_HOLIDAY_COUNTRY = "NL";

/** UTC-only date math — a local-time Date would shift the day near DST. */
function isoDate(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/**
 * Easter Sunday for a Gregorian year — the "anonymous Gregorian computus".
 * Returns an ISO date string.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(Date.UTC(year, month - 1, day));
}

/** Koningsdag: 27 April, moved back to the 26th when the 27th is a Sunday. */
export function koningsdag(year: number): string {
  const april27 = Date.UTC(year, 3, 27);
  return new Date(april27).getUTCDay() === 0 ? isoDate(april27 - DAY_MS) : isoDate(april27);
}

/**
 * The official Dutch public holidays for a year, in date order.
 * Bevrijdingsdag is included every year: it is a national holiday annually even
 * though most CAOs only give the day off every fifth year — whether it is a paid
 * day off is a client policy, not a calendar fact.
 */
export function dutchPublicHolidays(year: number): PublicHolidayInput[] {
  const easterMs = Date.parse(`${easterSunday(year)}T00:00:00Z`);
  const fromEaster = (offsetDays: number) => isoDate(easterMs + offsetDays * DAY_MS);

  const days: Array<[string, string]> = [
    [isoDate(Date.UTC(year, 0, 1)), "Nieuwjaarsdag"],
    [fromEaster(-2), "Goede Vrijdag"],
    [fromEaster(0), "Eerste Paasdag"],
    [fromEaster(1), "Tweede Paasdag"],
    [koningsdag(year), "Koningsdag"],
    [isoDate(Date.UTC(year, 4, 5)), "Bevrijdingsdag"],
    [fromEaster(39), "Hemelvaartsdag"],
    [fromEaster(49), "Eerste Pinksterdag"],
    [fromEaster(50), "Tweede Pinksterdag"],
    [isoDate(Date.UTC(year, 11, 25)), "Eerste Kerstdag"],
    [isoDate(Date.UTC(year, 11, 26)), "Tweede Kerstdag"],
  ];

  return days
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, name]) => ({ country: DEFAULT_HOLIDAY_COUNTRY, date, name }));
}

/** Persistence port. Implemented in the infrastructure layer. */
export interface PublicHolidayRepository {
  listByYear(year: number, country?: string): Promise<PublicHoliday[]>;
  /** Between two ISO dates, inclusive — what a monthly generator asks for. */
  listBetween(fromDate: string, toDate: string, country?: string): Promise<PublicHoliday[]>;
  /** Idempotent upsert on (country, date) — re-seeding a year is safe. */
  upsertMany(holidays: PublicHolidayInput[]): Promise<number>;
}
