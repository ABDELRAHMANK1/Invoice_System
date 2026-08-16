import { describe, it, expect } from "vitest";
import { parseAliases, formatAliases, aliasesPatch, aliasesSchema } from "@/lib/aliases";

describe("aliases — parseAliases", () => {
  it("splits on comma, trims, and drops empties", () => {
    expect(parseAliases(" akram , akram transport ,, ")).toEqual(["akram", "akram transport"]);
  });

  it("returns null when nothing is left, so the column clears", () => {
    expect(parseAliases("")).toBeNull();
    expect(parseAliases("  ,  , ")).toBeNull();
    expect(parseAliases(null)).toBeNull();
    expect(parseAliases(undefined)).toBeNull();
  });

  it("accepts an already-parsed array (n8n / scripts)", () => {
    expect(parseAliases([" buki ", "", "buki koeriers"])).toEqual(["buki", "buki koeriers"]);
  });
});

describe("aliases — formatAliases", () => {
  it("joins a text[] back into the comma-separated input value", () => {
    expect(formatAliases(["akram", "akram transport"])).toBe("akram, akram transport");
  });

  it("renders a null/empty column as an empty input", () => {
    expect(formatAliases(null)).toBe("");
    expect(formatAliases([])).toBe("");
  });

  it("round-trips through parseAliases", () => {
    expect(formatAliases(parseAliases("akram,  akram transport"))).toBe("akram, akram transport");
  });
});

describe("aliases — aliasesPatch", () => {
  it("omits the column entirely when the field wasn't sent (partial PATCH)", () => {
    expect(aliasesPatch(undefined)).toEqual({});
  });

  it("writes the parsed array when the field was sent", () => {
    expect(aliasesPatch("a, b")).toEqual({ aliases: ["a", "b"] });
    expect(aliasesPatch("")).toEqual({ aliases: null });
  });
});

describe("aliases — aliasesSchema", () => {
  it("accepts a string, an array, null and absence", () => {
    expect(aliasesSchema.safeParse("a, b").success).toBe(true);
    expect(aliasesSchema.safeParse(["a", "b"]).success).toBe(true);
    expect(aliasesSchema.safeParse(null).success).toBe(true);
    expect(aliasesSchema.safeParse(undefined).success).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(aliasesSchema.safeParse(42).success).toBe(false);
    expect(aliasesSchema.safeParse([1, 2]).success).toBe(false);
  });

  it("leaves a missing field undefined rather than null (would wipe the column)", () => {
    expect(aliasesSchema.parse(undefined)).toBeUndefined();
  });
});
