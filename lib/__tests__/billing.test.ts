import { describe, it, expect } from "vitest";
import { computeTotals, trunc2, formatNL } from "@/lib/billing";

describe("computeTotals", () => {
  it("computes line totals, subtotal, btw and total (single 21% rate)", () => {
    const t = computeTotals(
      [
        { description: "RT TWB 1205", quantity: 22.5, unit_price: 30 },
        { description: "RT TWB 1316", quantity: 16.33, unit_price: 30 },
      ],
      21,
    );
    expect(t.items[0].line_total).toBe(675.0);
    expect(t.items[1].line_total).toBe(489.9);
    expect(t.subtotal).toBe(1164.9);
    expect(t.btw_amount).toBe(244.62);          // 1164.90 * 0.21 = 244.629 → 244.62 (truncated)
    expect(t.total).toBe(1409.52);
  });

  it("TRUNCATES btw rather than rounding (matches the reference invoice)", () => {
    // 11.742,98 * 21% = 2466.0258 → 2466.02, not 2466.03
    const t = computeTotals([{ description: "x", quantity: 1, unit_price: 11742.98 }], 21);
    expect(t.subtotal).toBe(11742.98);
    expect(t.btw_amount).toBe(2466.02);
    expect(t.total).toBe(14209.0);
  });

  it("handles 0% BTW (btw_amount 0, total == subtotal)", () => {
    const t = computeTotals([{ description: "vrij", quantity: 3, unit_price: 10 }], 0);
    expect(t.subtotal).toBe(30);
    expect(t.btw_amount).toBe(0);
    expect(t.total).toBe(30);
  });

  it("handles 9% and an empty item list", () => {
    expect(computeTotals([{ description: "a", quantity: 2, unit_price: 50 }], 9).btw_amount).toBe(9);
    const empty = computeTotals([], 21);
    expect(empty.subtotal).toBe(0);
    expect(empty.total).toBe(0);
  });

  it("ignores non-finite / garbage quantities and prices", () => {
    const t = computeTotals([{ description: "x", quantity: NaN, unit_price: 10 }], 21);
    expect(t.subtotal).toBe(0);
  });
});

describe("trunc2 / formatNL", () => {
  it("truncates to 2 decimals without float dust", () => {
    expect(trunc2(489.90000000000003)).toBe(489.9);
    expect(trunc2(2466.0258)).toBe(2466.02);
    expect(trunc2(0.1 + 0.2)).toBe(0.3);
  });
  it("formats Dutch money", () => {
    expect(formatNL(14209)).toBe("14.209,00");
    expect(formatNL(10632.6)).toBe("10.632,60");
    expect(formatNL(675)).toBe("675,00");
  });
});
