import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  convertRawInvoiceSheet,
  RawConvertFormatError,
  type RawConvertCustomer,
} from "@/lib/raw-invoice-convert";
import { buildInvoiceExcelBuffer } from "@/lib/export-builders";

const CUSTOMERS: RawConvertCustomer[] = [
  { id: "c1", name: "RAJEH FOOD", relatie_code: "1041" },
  { id: "c2", name: "Albert Heijn B.V.", relatie_code: "2002" },
];

/** Build a worksheet: optional junk band, a header row, then data rows. */
function sheetOf(header: string[], data: (string | number)[][], junkRows: (string | number)[][] = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Facturen");
  for (const j of junkRows) ws.addRow(j);
  ws.addRow(header);
  for (const d of data) ws.addRow(d);
  return ws;
}

const HEADER = ["Factuurnummer", "Datum", "Client", "Status", "Bedrag exclusief BTW", "Bedrag inclusief BTW"];

describe("convertRawInvoiceSheet — header detection", () => {
  it("finds the header under a title band and with slightly-varied names", () => {
    const ws = sheetOf(
      ["Factuurnr", "Datum", "Klant", "Bedrag excl", "Bedrag incl"],
      [["F1", "2026-01-02", "RAJEH FOOD", 100, 121]],
      [["Facturenoverzicht 2026"], ["gegenereerd op 2026-01-31"]],
    );
    const { rows, summary } = convertRawInvoiceSheet(ws, CUSTOMERS);
    expect(summary.headerRow).toBe(3);
    expect(rows).toHaveLength(1);
    expect(summary.detectedColumns).toEqual(expect.arrayContaining(["factuurnummer", "datum", "client", "excl", "incl"]));
  });

  it("throws RawConvertFormatError listing missing required columns", () => {
    const ws = sheetOf(["Factuurnummer", "Datum", "Client"], [["F1", "2026-01-02", "X"]]);
    expect(() => convertRawInvoiceSheet(ws, CUSTOMERS)).toThrow(RawConvertFormatError);
    try {
      convertRawInvoiceSheet(ws, CUSTOMERS);
    } catch (e) {
      expect((e as Error).message).toMatch(/excl/);
      expect((e as Error).message).toMatch(/incl/);
    }
  });
});

describe("convertRawInvoiceSheet — VAT classification", () => {
  it("snaps 21% / 9% / 0% and keeps real net/btw", () => {
    const ws = sheetOf(HEADER, [
      ["F21", "2026-01-02", "RAJEH FOOD", "Betaald", 100, 121],
      ["F9",  "2026-01-03", "RAJEH FOOD", "Betaald", 100, 109],
      ["F0",  "2026-01-04", "RAJEH FOOD", "Betaald", 100, 100],
    ]);
    const { rows, summary } = convertRawInvoiceSheet(ws, CUSTOMERS);
    expect(summary.rateCounts).toEqual({ 0: 1, 9: 1, 21: 1 });
    expect(summary.anomalous).toBe(0);

    expect(rows[0].verkoop_amounts).toEqual({ net: 100, btw: 21, variant: "hoog" });
    expect(rows[1].verkoop_amounts).toEqual({ net: 100, btw: 9, variant: "laag" });
    expect(rows[2].verkoop_amounts).toEqual({ net: 100, btw: 0, variant: "vrij" });
  });

  it("flags an anomalous rate but keeps the real numbers on the closest tarief", () => {
    const ws = sheetOf(HEADER, [["FX", "2026-01-05", "RAJEH FOOD", "Betaald", 100, 115]]);
    const { rows, summary } = convertRawInvoiceSheet(ws, CUSTOMERS);
    expect(summary.anomalous).toBe(1);
    expect(summary.anomalousInvoices).toEqual([{ invoice: "FX", rate: 15 }]);
    expect(rows[0].verkoop_amounts).toEqual({ net: 100, btw: 15, variant: "laag" });
    expect(rows[0].review_note).toMatch(/Anomalous VAT rate 15\.0%/);
    // Anomalous rows are excluded from the snapped rate counts.
    expect(summary.rateCounts).toEqual({ 0: 0, 9: 0, 21: 0 });
  });

  it("treats Status 'Concept' as a zero-amount draft (single booking line, no VAT split)", () => {
    const ws = sheetOf(HEADER, [["FC", "2026-01-06", "RAJEH FOOD", "Concept", 50, 60]]);
    const { rows, summary } = convertRawInvoiceSheet(ws, CUSTOMERS);
    expect(summary.concept).toBe(1);
    expect(summary.sumIncl).toBe(0); // draft excluded from totals
    expect(rows[0].total_amount).toBe(0);
    expect(rows[0].verkoop_amounts).toEqual({ net: 0, btw: 0, variant: "draft" });
  });
});

describe("convertRawInvoiceSheet — Relatiecode matching", () => {
  it("resolves relatie_code via fuzzy name match; unmatched → blank + review note", () => {
    const ws = sheetOf(HEADER, [
      ["F1", "2026-01-02", "Rajeh Food B.V.", "Betaald", 100, 121],
      ["F2", "2026-01-03", "Totally Unknown Co", "Betaald", 100, 121],
    ]);
    const { rows, summary } = convertRawInvoiceSheet(ws, CUSTOMERS);
    expect(rows[0].relatie_code).toBe("1041");
    expect(rows[0].review_note).toBeNull();
    expect(rows[1].relatie_code).toBeNull();
    expect(rows[1].review_note).toMatch(/No Relatiecode match/);
    expect(summary.matched).toBe(1);
    expect(summary.blank).toBe(1);
    expect(summary.unmatchedNames).toEqual([{ name: "Totally Unknown Co", count: 1 }]);
  });
});

describe("convertRawInvoiceSheet → buildInvoiceExcelBuffer flagging", () => {
  it("highlights flagged rows and pins the review note as a RelatieCode comment", async () => {
    const ws = sheetOf(HEADER, [
      ["F1", "2026-01-02", "RAJEH FOOD", "Betaald", 100, 121],          // clean, matched
      ["F2", "2026-01-03", "Unknown Co", "Betaald", 100, 115],          // unmatched + anomalous
    ]);
    const { rows } = convertRawInvoiceSheet(ws, CUSTOMERS);
    const buffer = await buildInvoiceExcelBuffer(rows, { blankUnmatchedRelatiecode: true, flagReviewRows: true });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Verkoop")!;

    // Invoice F1 → rows 2-4 (clean, no solid fill). Invoice F2 → rows 5-7 (flagged).
    const patternOf = (row: number, col: number) =>
      (sheet.getRow(row).getCell(col).fill as ExcelJS.FillPattern | undefined)?.pattern;

    const cleanCell = sheet.getRow(2).getCell(22); // RelatieCode
    expect(patternOf(2, 22)).not.toBe("solid");
    expect(cleanCell.note == null).toBe(true);

    const flaggedFirst = sheet.getRow(5).getCell(22);
    const fill = flaggedFirst.fill as ExcelJS.FillPattern | undefined;
    expect(fill?.pattern).toBe("solid");
    expect(String(fill?.fgColor?.argb)).toContain("FFF3CD");
    const note = flaggedFirst.note as unknown;
    const noteText = typeof note === "string" ? note : (note as { texts?: { text: string }[] })?.texts?.map((t) => t.text).join("") ?? "";
    expect(noteText).toMatch(/No Relatiecode match/);
    expect(noteText).toMatch(/Anomalous VAT/);
    // Whole flagged band is filled (all 3 rows).
    for (const r of [5, 6, 7]) expect(patternOf(r, 10)).toBe("solid");
  });
});
