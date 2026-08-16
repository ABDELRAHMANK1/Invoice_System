/**
 * Aliases (`clients.aliases`, `customers.aliases`) are a Postgres `text[]` but
 * are edited as a single comma-separated input in the dashboard. Both
 * directions of that conversion live here so the client form, the customer
 * drawer and their API routes can't drift apart.
 */

import { z } from "zod";

/**
 * UI string (or an already-parsed array) → the `text[]` value to store.
 * Splits on comma, trims each entry, drops empties. Returns `null` when
 * nothing is left, so clearing the input clears the column.
 */
export function parseAliases(input: unknown): string[] | null {
  if (input == null) return null;
  const parts = Array.isArray(input)
    ? input.map((a) => String(a))
    : String(input).split(",");
  const cleaned = parts.map((a) => a.trim()).filter((a) => a.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

/** Stored `text[]` → the comma-separated string the form input shows. */
export function formatAliases(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((a) => String(a).trim()).filter((a) => a.length > 0).join(", ");
  }
  return String(value).trim();
}

/**
 * Request-body shape for an aliases field: the dashboard sends the raw
 * comma-separated string, n8n / scripts may send an array. Deliberately NOT a
 * `.transform()` — that would make a missing key parse to `null` and wipe the
 * column on every unrelated PATCH.
 */
export const aliasesSchema = z
  .union([z.string().max(1000), z.array(z.string().max(200)).max(50)])
  .optional()
  .nullable();

/**
 * Turn a parsed `aliases` value into the update fragment to spread into a
 * Supabase payload — `{}` when the field wasn't sent, so PATCH stays partial.
 */
export function aliasesPatch(value: string | string[] | null | undefined) {
  return value === undefined ? {} : { aliases: parseAliases(value) };
}
