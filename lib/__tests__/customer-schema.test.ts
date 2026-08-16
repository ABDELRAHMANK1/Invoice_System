import { describe, it, expect } from "vitest";
import {
  btwVerlegdError,
  mergeBtwVerlegdState,
  normaliseBtwVerlegd,
} from "@/lib/customer-schema";

describe("customer-schema — normaliseBtwVerlegd", () => {
  it("pins the rate to 0 when reverse charge is on", () => {
    expect(normaliseBtwVerlegd({ btw_verlegd: true, btw_rate: 21 }).btw_rate).toBe(0);
    // even when the caller omitted the rate entirely
    expect(normaliseBtwVerlegd({ btw_verlegd: true }).btw_rate).toBe(0);
  });

  it("leaves the rate alone otherwise", () => {
    expect(normaliseBtwVerlegd({ btw_verlegd: false, btw_rate: 9 }).btw_rate).toBe(9);
    expect(normaliseBtwVerlegd({ btw_rate: 21 }).btw_rate).toBe(21);
  });
});

describe("customer-schema — mergeBtwVerlegdState", () => {
  it("keeps the stored value for a field the PATCH didn't send", () => {
    const merged = mergeBtwVerlegdState(
      { btw_verlegd: false, btw_number: "NL0012" },
      { btw_verlegd: true },
    );
    expect(merged).toEqual({ btw_verlegd: true, btw_number: "NL0012" });
  });

  it("lets the payload win for a field it did send, including an explicit clear", () => {
    const merged = mergeBtwVerlegdState(
      { btw_verlegd: true, btw_number: "NL0012" },
      { btw_number: null },
    );
    expect(merged).toEqual({ btw_verlegd: true, btw_number: null });
  });

  it("treats an empty stored row as a create", () => {
    expect(mergeBtwVerlegdState({}, { btw_verlegd: true, btw_number: "NL1" }))
      .toEqual({ btw_verlegd: true, btw_number: "NL1" });
  });
});

describe("customer-schema — btwVerlegdError", () => {
  it("rejects reverse charge without a VAT number", () => {
    expect(btwVerlegdError({ btw_verlegd: true, btw_number: null })).toMatch(/btw_number is required/);
    expect(btwVerlegdError({ btw_verlegd: true, btw_number: "" })).toMatch(/btw_number is required/);
    expect(btwVerlegdError({ btw_verlegd: true, btw_number: "   " })).toMatch(/btw_number is required/);
    expect(btwVerlegdError({ btw_verlegd: true })).toMatch(/btw_number is required/);
  });

  it("accepts reverse charge with a VAT number", () => {
    expect(btwVerlegdError({ btw_verlegd: true, btw_number: "NL001234567B01" })).toBeNull();
  });

  it("ignores a missing VAT number when reverse charge is off", () => {
    expect(btwVerlegdError({ btw_verlegd: false, btw_number: null })).toBeNull();
    expect(btwVerlegdError({ btw_number: null })).toBeNull();
    expect(btwVerlegdError({})).toBeNull();
  });

  it("catches the partial-PATCH case that the raw payload alone would miss", () => {
    // Payload only flips the flag; the stored row has no VAT number.
    const payload = { btw_verlegd: true };
    expect(btwVerlegdError(payload)).not.toBeNull();
    expect(btwVerlegdError(mergeBtwVerlegdState({ btw_number: null }, payload))).not.toBeNull();
    // Same payload, but the stored row already has one → fine.
    expect(btwVerlegdError(mergeBtwVerlegdState({ btw_number: "NL1" }, payload))).toBeNull();
  });
});
