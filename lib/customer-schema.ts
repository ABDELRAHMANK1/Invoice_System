import { z } from "zod";
import { aliasesSchema } from "@/lib/aliases";
import { BTW_RATES, PRICING_MODELS } from "@/lib/types";

/**
 * The customer-only "Invoicing settings" columns, as zod fields to spread into
 * both the create and the patch schema so the two can't drift.
 *
 * NOTE these belong to `customers` only — suppliers (Leveranciers) don't have
 * them and their routes are deliberately untouched.
 */
export const customerInvoicingFields = {
  btw_rate:        z.number().int()
                    .refine((r) => (BTW_RATES as readonly number[]).includes(r),
                            { message: `btw_rate must be one of ${BTW_RATES.join(", ")}` })
                    .optional(),
  btw_verlegd:     z.boolean().optional(),
  pricing_model:   z.enum(PRICING_MODELS).optional(),
  default_rate:    z.number().nonnegative().max(1_000_000).optional().nullable(),
  aliases:         aliasesSchema,
  message_pattern: z.string().max(2000).optional().nullable(),
};

/**
 * Reverse charge means no VAT is charged at all, so the rate must be 0. The
 * drawer already pins it, but a direct API caller could send an inconsistent
 * pair — normalise it here rather than storing a contradiction.
 */
export function normaliseBtwVerlegd<T extends { btw_verlegd?: boolean; btw_rate?: number }>(
  data: T,
): T & { btw_rate?: number } {
  return data.btw_verlegd === true ? { ...data, btw_rate: 0 } : data;
}

/** The two fields the reverse-charge rule spans, as stored on a customer row. */
export interface BtwVerlegdState {
  btw_verlegd?: boolean | null;
  btw_number?: string | null;
}

/**
 * Merge an incoming (possibly partial) payload over the stored row for just
 * these two fields. A key that wasn't sent keeps its stored value — that's the
 * whole point: a PATCH carrying only `btw_verlegd: true` must still be checked
 * against the `btw_number` already on the row. Pass `{}` as `existing` for a
 * create.
 */
export function mergeBtwVerlegdState(existing: BtwVerlegdState, incoming: BtwVerlegdState): BtwVerlegdState {
  return {
    btw_verlegd: incoming.btw_verlegd !== undefined ? incoming.btw_verlegd : existing.btw_verlegd,
    btw_number:  incoming.btw_number  !== undefined ? incoming.btw_number  : existing.btw_number,
  };
}

/**
 * The reverse-charge notice printed on a verkoop invoice embeds the
 * recipient's VAT number, so a customer saved with `btw_verlegd` and no
 * `btw_number` would produce a legally invalid invoice. Returns an error
 * message for that state, or null when the row is fine.
 *
 * Validate the MERGED state (see `mergeBtwVerlegdState`), never the raw
 * payload — the drawer sends both fields but n8n and other API callers PATCH
 * partially.
 */
export function btwVerlegdError(state: BtwVerlegdState): string | null {
  if (state.btw_verlegd !== true) return null;
  if ((state.btw_number ?? "").trim() !== "") return null;
  return "btw_number is required when btw_verlegd is true — the reverse-charge notice on the invoice needs the recipient's VAT number";
}
