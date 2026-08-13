import { describe, it, expect } from "vitest";
import { guessFieldMapping, sanitizeFieldMapping } from "@/lib/template-fill";

describe("guessFieldMapping", () => {
  it("does NOT auto-map _IBAN fields (the g-rekening trap — must default to unmapped)", () => {
    // Deblokkering g-rekening: 2.1_IBAN.* is a g-rekening number, NOT the client's
    // own IBAN. Aanvraag g-rekening: 1e.1_IBAN.* is an old bank account. Neither
    // may auto-fill from the client's iban column — they stay blank for the human.
    const m = guessFieldMapping(["2.1_IBAN.0", "2.1_IBAN.1", "1e.1_IBAN.0", "1e.1_IBAN.1"]);
    expect(m["2.1_IBAN.0"]).toBeUndefined();
    expect(m["2.1_IBAN.1"]).toBeUndefined();
    expect(m["1e.1_IBAN.0"]).toBeUndefined();
    expect(m["1e.1_IBAN.1"]).toBeUndefined();
  });

  it("maps the client-level token fields across all 3 Belastingdienst forms", () => {
    // Real field names pulled from the 3 PDFs.
    const m = guessFieldMapping([
      // form 1 (loonheffingen)
      "1.5.1_KVK", "1.7.0_PC", "6.1_TEL", "1.2._RSIN",
      // form 2 (deblokkering)
      "1.1_RFB", "1.2_KVK", "1.4_TEL", "1.5_EM",
      // form 3 (aanvraag)
      "1.2_RFB", "1.7_KVK", "1d.1_OB.1",
    ]);
    expect(m["1.5.1_KVK"]).toBe("kvk_number");
    expect(m["1.2_KVK"]).toBe("kvk_number");
    expect(m["1.7_KVK"]).toBe("kvk_number");
    expect(m["1.7.0_PC"]).toBe("postcode");     // _PC token now recognised
    expect(m["6.1_TEL"]).toBe("phone_number");
    expect(m["1.4_TEL"]).toBe("phone_number");
    expect(m["1.5_EM"]).toBe("email");          // _EM token now recognised
    expect(m["1.2._RSIN"]).toBe("rsin");        // _RSIN → rsin
    expect(m["1.1_RFB"]).toBe("rsin");          // _RFB → rsin
    expect(m["1.2_RFB"]).toBe("rsin");
    // _OB (omzetbelasting split box) is deliberately NOT mapped — btw_number is
    // stored as the full "NL…B01" and can't be split into the 9+2 boxes.
    expect(m["1d.1_OB.1"]).toBeUndefined();
  });

  it("never fills another company's RSIN (_RFN) or a person's number (_BSN) from client RSIN", () => {
    // form 3 §1g: _RFN is another onderneming's RSIN, _BSN a director/owner bsn.
    const m = guessFieldMapping(["1g.1.4_RFN", "1g.1.1_BSN", "1.4_BSN"]);
    expect(m["1g.1.4_RFN"]).toBeUndefined();
    expect(m["1g.1.1_BSN"]).toBeUndefined();
    expect(m["1.4_BSN"]).toBeUndefined();
  });

  it("leaves opaque numeric field names unmapped (need manual mapping in review)", () => {
    const m = guessFieldMapping(["1.0", "1.3", "1.6.0", "1.7.1", "5.date01.d_F"]);
    expect(Object.keys(m)).toHaveLength(0);
  });
});

describe("sanitizeFieldMapping (server-side safety gate)", () => {
  const fields = ["2.1_IBAN.0", "2.1_IBAN.1", "4.0"];

  it("keeps valid field → real-column pairs (the happy path)", () => {
    const out = sanitizeFieldMapping({ "4.0": "name" }, fields);
    expect(out).toEqual({ "4.0": "name" });
  });

  it("keeps a human's correction that unmapped a wrong auto-match", () => {
    // User removed the bogus 2.1_IBAN.* → iban guesses and only kept 4.0 → name.
    const edited = { "4.0": "name" };
    expect(sanitizeFieldMapping(edited, fields)).toEqual({ "4.0": "name" });
  });

  it("drops a target that isn't in the allow-list (tampered request)", () => {
    const tampered = { "4.0": "password", "2.1_IBAN.0": "iban" };
    const out = sanitizeFieldMapping(tampered, fields);
    expect(out).toEqual({ "2.1_IBAN.0": "iban" }); // bogus target gone, valid one kept
    expect(out).not.toHaveProperty("4.0");
  });

  it("drops a field that doesn't exist in the uploaded PDF (tampered request)", () => {
    const tampered = { "9.9_INJECTED": "iban", "4.0": "name" };
    const out = sanitizeFieldMapping(tampered, fields);
    expect(out).toEqual({ "4.0": "name" });
  });

  it("drops non-string values", () => {
    const out = sanitizeFieldMapping({ "4.0": 123, "2.1_IBAN.0": null }, fields);
    expect(out).toEqual({});
  });

  it("accepts a Set of fields too", () => {
    expect(sanitizeFieldMapping({ "4.0": "city" }, new Set(fields))).toEqual({ "4.0": "city" });
  });
});
