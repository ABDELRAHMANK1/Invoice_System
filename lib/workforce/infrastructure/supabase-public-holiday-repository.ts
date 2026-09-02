/**
 * Supabase implementation of the public-holiday port.
 *
 * `year` is a generated column in Postgres (see migration 011), so it is read
 * but never written — `upsertMany` sends `country`, `date` and `name` only, and
 * conflicts on the (country, date) unique constraint, which makes re-seeding a
 * year idempotent.
 */

import { supabaseAdmin } from "@/lib/supabase-admin";
import type { PublicHoliday, PublicHolidayRepository } from "@/lib/workforce/domain";
import { DEFAULT_HOLIDAY_COUNTRY } from "@/lib/workforce/domain";

const TABLE = "public_holidays";

type Row = Record<string, unknown>;

function toHoliday(row: Row): PublicHoliday {
  return {
    id: String(row.id),
    country: String(row.country ?? DEFAULT_HOLIDAY_COUNTRY),
    date: String(row.date),
    year: Number(row.year),
    name: String(row.name ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export const supabasePublicHolidayRepository: PublicHolidayRepository = {
  async listByYear(year, country = DEFAULT_HOLIDAY_COUNTRY) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("country", country)
      .eq("year", year)
      .order("date", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toHoliday);
  },

  async listBetween(fromDate, toDate, country = DEFAULT_HOLIDAY_COUNTRY) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("country", country)
      .gte("date", fromDate)
      .lte("date", toDate)
      .order("date", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toHoliday);
  },

  async upsertMany(holidays) {
    if (holidays.length === 0) return 0;
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .upsert(holidays, { onConflict: "country,date" })
      .select("id");
    if (error) throw new Error(error.message);
    return (data ?? []).length;
  },
};
