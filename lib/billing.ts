// Server-authoritative invoice math. The client preview may compute the same
// numbers for UX, but the API always recomputes here and stores/serves these.
//
// Money is TRUNCATED to 2 decimals (not rounded) to match the rest of the
// platform (Snelstart export uses #,##0.00 truncation) and the reference
// invoice: 11.742,98 × 21% = 2.466,0258 → 2.466,02 (truncated), Σ = 14.209,00.

export interface LineItemInput {
  description: string;
  quantity: number;
  unit_price: number;
}

export interface LineItem extends LineItemInput {
  line_total: number;
}

export interface InvoiceTotals {
  items: LineItem[];
  subtotal: number;
  btw_rate: number;
  btw_amount: number;
  total: number;
}

/** Truncate to 2 decimals. The +epsilon guards against binary-float dust
 *  (e.g. 489.90000000000003 * 100) without ever rounding a real cent up. */
export function trunc2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.trunc((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
}

/**
 * Compute line totals + invoice totals from raw line items and a single BTW
 * rate. Returns normalised items (with line_total) plus subtotal / btw / total.
 *
 * Kept deliberately simple (one rate) but shaped so per-line rates can be added
 * later: group items by rate, sum each grondslag, and the BTW table becomes
 * multi-row — callers already treat `btw_amount`/`subtotal` as the rolled-up
 * figures.
 */
export function computeTotals(rawItems: LineItemInput[], btwRate: number): InvoiceTotals {
  const rate = Number.isFinite(btwRate) ? btwRate : 0;

  const items: LineItem[] = (rawItems || []).map((it) => {
    const quantity = Number(it.quantity) || 0;
    const unit_price = Number(it.unit_price) || 0;
    return {
      description: it.description ?? "",
      quantity,
      unit_price,
      line_total: trunc2(quantity * unit_price),
    };
  });

  const subtotal = trunc2(items.reduce((sum, it) => sum + it.line_total, 0));
  const btw_amount = trunc2(subtotal * (rate / 100));
  const total = trunc2(subtotal + btw_amount);

  return { items, subtotal, btw_rate: rate, btw_amount, total };
}

/** Dutch money format: 1.234,56 (thousands dot, decimal comma, 2 decimals). */
export function formatNL(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(2);           // already 2dp; values are pre-truncated
  const [intPart, dec] = fixed.split(".");
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${withThousands},${dec}`;
}
