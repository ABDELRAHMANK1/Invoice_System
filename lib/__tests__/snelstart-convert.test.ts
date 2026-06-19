import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  convertSnelstartSheet,
  deriveVatRate,
  decodeEntities,
  SnelstartFormatError,
  SNELSTART_HEADER_ROW,
  type SnelstartCustomer,
} from "@/lib/snelstart-convert";

const HEADER = ["Factuurnummer", "Datum", "Status", "Client", "Klantnummer", "Bedrag exclusief BTW", "Bedrag inclusief BTW"];

function buildSheet(rows: Array<Array<string | number | null>>, header: string[] = HEADER): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Alle-facturen");
  header.forEach((h, i) => { ws.getRow(SNELSTART_HEADER_ROW).getCell(i + 1).value = h; });
  rows.forEach((r, idx) => {
    const row = ws.getRow(SNELSTART_HEADER_ROW + 1 + idx);
    r.forEach((v, i) => { row.getCell(i + 1).value = v as ExcelJS.CellValue; });
  });
  return ws;
}

const customers: SnelstartCustomer[] = [
  { id: "c1", client_id: "x", name: "Nema Food B.V.", relatie_code: "10" },
  { id: "c2", client_id: "x", name: "Mar-One Food", relatie_code: "20" },
];

// [Factuurnummer, Datum, Status, Client, Klantnummer, excl, incl]
const SAMPLE: Array<Array<string | number | null>> = [
  ["concept", "2026-06-19", "Concept", "Sisou", null, 0, 0],     // skipped
  [2357, "2026-06-01", "Open", "Nema Food", 999, 100, 121],      // 21%, matches Nema (source Klantnummer ignored)
  [2358, "2026-06-02", "Betaald", "Mar-One", null, 100, 109],    // 9%, matches Mar-One
  [2359, "2026-06-03", "Open", "EU Buyer", null, 100, 100],      // 0%, blank
  [2360, "2026-06-04", "Te laat", "Weird Co", null, 100, 150],   // 50% → un-snappable → zeroed, blank
];

describe("deriveVatRate", () => {
  it("snaps to {0,9,21} within ~1 point", () => {
    expect(deriveVatRate(100, 121)).toEqual({ rate: 21, zeroed: false });
    expect(deriveVatRate(100, 109)).toEqual({ rate: 9, zeroed: false });
    expect(deriveVatRate(100, 109.5)).toEqual({ rate: 9, zeroed: false }); // 9.5 within 1 of 9
    expect(deriveVatRate(100, 100)).toEqual({ rate: 0, zeroed: false });   // genuinely 0%
  });
  it("zeroes (rate 0) when the computed rate can't snap", () => {
    expect(deriveVatRate(100, 150)).toEqual({ rate: 0, zeroed: true });    // 50%
    expect(deriveVatRate(100, 103)).toEqual({ rate: 0, zeroed: true });    // 3%
  });
  it("treats excl<=0 / no BTW as plain 0%", () => {
    expect(deriveVatRate(0, 0)).toEqual({ rate: 0, zeroed: false });
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric HTML entities", () => {
    expect(decodeEntities("B&amp;Z partners")).toBe("B&Z partners");
    expect(decodeEntities("Str&#039;eat fast food")).toBe("Str'eat fast food");
    expect(decodeEntities("a &lt;b&gt; c")).toBe("a <b> c");
  });
});

describe("convertSnelstartSheet", () => {
  it("skips Concept, derives BTW, fuzzy-matches customers, and tallies the summary", () => {
    const { rows, summary } = convertSnelstartSheet(buildSheet(SAMPLE), customers);

    expect(summary.totalDataRows).toBe(5);
    expect(summary.skippedConcept).toBe(1);
    expect(summary.imported).toBe(4);
    expect(summary.rateCounts).toEqual({ 0: 2, 9: 1, 21: 1 });
    expect(summary.btwZeroed).toBe(1);
    expect(summary.matched).toBe(2);
    expect(summary.blank).toBe(2);
    expect(summary.customersLoaded).toBe(2);
    expect(summary.sumIncl).toBe(480);        // 121+109+100+150
    expect(summary.sumExclSource).toBe(400);  // 100×4
    // Unmatched names, sorted (both count 1 → alphabetical).
    expect(summary.unmatchedNames).toEqual([
      { name: "EU Buyer", count: 1 },
      { name: "Weird Co", count: 1 },
    ]);

    // Rows carry the resolved relatie_code, factuurnummer, and synthesised rate.
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ invoice_number: "2357", relatie_code: "10", invoice_direction: "verkoop", total_amount: 121 });
    expect((rows[0].raw_extraction as { vat_rate: number }).vat_rate).toBe(21);
    expect(rows[1]).toMatchObject({ invoice_number: "2358", relatie_code: "20" });
    expect(rows[2].relatie_code).toBeNull();  // EU Buyer — blank
    expect(rows[3].relatie_code).toBeNull();  // Weird Co — blank
    expect((rows[3].raw_extraction as { vat_rate: number }).vat_rate).toBe(0); // zeroed
  });

  it("leaves every Relatiecode blank when no customers are supplied", () => {
    const { summary } = convertSnelstartSheet(buildSheet(SAMPLE), []);
    expect(summary.matched).toBe(0);
    expect(summary.blank).toBe(4);
  });

  it("throws SnelstartFormatError when a required column is missing", () => {
    const badHeader = ["Factuurnummer", "Datum", "Status", "WrongName", "Klantnummer", "Bedrag exclusief BTW", "Bedrag inclusief BTW"];
    expect(() => convertSnelstartSheet(buildSheet(SAMPLE, badHeader), customers)).toThrow(SnelstartFormatError);
  });
});
