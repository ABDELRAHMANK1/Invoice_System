import { describe, it, expect } from "vitest";
import {
  significantTokens,
  levenshtein,
  tokenSimilar,
  scoreMatch,
  bestNameMatch,
} from "@/lib/relatie-match";

describe("relatie-match — significantTokens", () => {
  it("lowercases, strips punctuation, and drops legal-form stopwords", () => {
    expect(significantTokens("Nema Food B.V.")).toEqual(["nema", "food"]);
    expect(significantTokens("ATAPACK Cash & Carry B.V.")).toEqual(["atapack"]);
  });

  it("drops 1-char tokens and handles null/empty", () => {
    expect(significantTokens("A b cd")).toEqual(["cd"]);
    expect(significantTokens(null)).toEqual([]);
    expect(significantTokens("")).toEqual([]);
  });
});

describe("relatie-match — levenshtein & tokenSimilar", () => {
  it("computes edit distance", () => {
    expect(levenshtein("alaseel", "alseel")).toBe(1);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("tolerates typos scaled by length, stays strict on short tokens", () => {
    expect(tokenSimilar("alaseel", "alseel")).toBe(true); // len>=4, dist 1
    expect(tokenSimilar("transport", "transbort")).toBe(true); // len>=8, dist 1
    expect(tokenSimilar("bv", "bb")).toBe(false); // too short to tolerate
    expect(tokenSimilar("food", "ford")).toBe(true); // len 4, dist 1
  });
});

describe("relatie-match — scoreMatch", () => {
  it("scores token overlap with a substring bonus", () => {
    // exact-ish: 2 token overlap + substring bonus
    expect(scoreMatch("Nema Food B.V.", "Nema Food")).toBeGreaterThanOrEqual(2);
    // one OCR typo still matches
    expect(scoreMatch("Alseel Trading", "Alaseel Trading")).toBeGreaterThan(0);
    // unrelated names → 0
    expect(scoreMatch("Tulp Transport", "Mar-One Food")).toBe(0);
  });

  it("returns 0 when either side has no significant tokens", () => {
    expect(scoreMatch("B.V.", "Nema")).toBe(0);
    expect(scoreMatch("Nema", "")).toBe(0);
  });
});

describe("relatie-match — bestNameMatch", () => {
  const customers = [
    { code: "100", name: "Albert Heijn B.V." },
    { code: "200", name: "Jumbo Supermarkten" },
    { code: "300", name: "RAJEH FOOD" },
  ];

  it("picks the best-scoring candidate", () => {
    const best = bestNameMatch(customers, (c) => c.name, "Rajeh Food");
    expect(best?.match.code).toBe("300");
  });

  it("returns null when nothing scores above zero", () => {
    expect(bestNameMatch(customers, (c) => c.name, "Totally Unrelated GmbH")).toBeNull();
  });
});
