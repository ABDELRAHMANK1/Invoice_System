import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildInvoiceExcelBuffer } from "@/lib/export-builders";
import {
  sampleInvoiceInkoop21,
  sampleInvoiceInkoop9,
  sampleInvoiceInkoop0,
  sampleInvoiceVerkoop21,
  sampleInvoiceVerkoop9,
  sampleInvoiceVerkoop0,
} from "@/__tests__/fixtures/invoices";

/**
 * The exporter writes the Snelstart "Boekingen" sheet:
 *  - Row 1 (header) — column titles
 *  - Then 2 or 3 data rows per invoice (3 when VAT is non-zero, 2 when VAT is 0%)
 *
 * Column index (1-based) reference:
 *  4 = Datum, 7 = DagboekNummer, 9 = Regel, 10 = Debet, 11 = Credit,
 *  12 = GrootboekNaam, 13 = GrootboekNummer, 14 = BtwSoort, 15 = BtwPercentage,
 *  18 = FactuurNummer, 21 = RelatieNaam
 */
const COL = {
  datum:           4,
  dagboekNummer:   7,
  regel:           9,
  debet:          10,
  credit:         11,
  grootboekNaam:  12,
  grootboekNummer:13,
  btwSoort:       14,
  btwPercentage:  15,
  factuurNummer:  18,
  relatieNaam:    21,
} as const;

async function loadSheet(invoices: Parameters<typeof buildInvoiceExcelBuffer>[0]) {
  const buffer = await buildInvoiceExcelBuffer(invoices);
  const wb = new ExcelJS.Workbook();
  // ExcelJS's typed Buffer signature is narrower than Node's; runtime accepts both.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.getWorksheet("Sheet1")!;
}

function rowValues(sheet: ExcelJS.Worksheet, rowNum: number) {
  const row = sheet.getRow(rowNum);
  return {
    datum:           row.getCell(COL.datum).value,
    dagboekNummer:   row.getCell(COL.dagboekNummer).value,
    regel:           row.getCell(COL.regel).value,
    debet:           Number(row.getCell(COL.debet).value ?? 0),
    credit:          Number(row.getCell(COL.credit).value ?? 0),
    grootboekNaam:   row.getCell(COL.grootboekNaam).value,
    grootboekNummer: row.getCell(COL.grootboekNummer).value,
    btwSoort:        row.getCell(COL.btwSoort).value,
    btwPercentage:   row.getCell(COL.btwPercentage).value,
    factuurNummer:   row.getCell(COL.factuurNummer).value,
    relatieNaam:     row.getCell(COL.relatieNaam).value,
  };
}

describe("buildInvoiceExcelBuffer — workbook structure", () => {
  it("returns a non-empty Buffer", async () => {
    const buffer = await buildInvoiceExcelBuffer([sampleInvoiceInkoop21]);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it("contains exactly one worksheet named 'Sheet1' with frozen header", async () => {
    const sheet = await loadSheet([sampleInvoiceInkoop21]);
    expect(sheet.name).toBe("Sheet1");
    const view = sheet.views?.[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe("frozen");
    expect(view?.ySplit).toBe(1);
  });

  it("emits all 22 Boekingen columns in the header row", async () => {
    const sheet = await loadSheet([sampleInvoiceInkoop21]);
    const header = sheet.getRow(1);
    const titles: string[] = [];
    header.eachCell((cell) => titles.push(String(cell.value)));
    expect(titles).toEqual([
      "JournaalPostId", "BookingId", "Betalingstermijn", "Datum",
      "DagboekSoort", "DagboekNaam", "DagboekNummer", "Omschrijving",
      "Regel", "Debet", "Credit", "GrootboekNaam", "GrootboekNummer",
      "BtwSoort", "BtwPercentage", "Boekstuk", "FactuurNummerId",
      "FactuurNummer", "KostenplaatsOmschrijving", "KostenplaatsNummer",
      "RelatieNaam", "RelatieCode",
    ]);
  });
});

describe("buildInvoiceExcelBuffer — VERKOOP (sales) format", () => {
  it("21% BTW → 3 rows: Debiteuren debet, Omzet hoog credit, BTW af te dragen hoog credit", async () => {
    // total 242 incl. 21% → excl 200, btw 42
    const sheet = await loadSheet([sampleInvoiceVerkoop21]);

    // Header is row 1; data rows start at row 2
    const row0 = rowValues(sheet, 2);
    const row1 = rowValues(sheet, 3);
    const row2 = rowValues(sheet, 4);

    // Regel 0 — Debiteuren
    expect(row0.dagboekNummer).toBe(1300);
    expect(row0.regel).toBe(0);
    expect(row0.debet).toBe(242);
    expect(row0.credit).toBe(0);
    expect(row0.grootboekNummer).toBe(1300);
    expect(row0.grootboekNaam).toBe("Debiteuren");
    expect(row0.btwSoort).toBe(0);

    // Regel 1 — Omzet hoog (8100), btwSoort=2 for 21%
    expect(row1.regel).toBe(1);
    expect(row1.debet).toBe(0);
    expect(row1.credit).toBe(200);
    expect(row1.grootboekNummer).toBe(8100);
    expect(row1.grootboekNaam).toBe("Omzet hoog handelsgoederen");
    expect(row1.btwSoort).toBe(2);
    expect(row1.btwPercentage).toBe(21);

    // Regel 2 — BTW af te dragen hoog (1671)
    expect(row2.regel).toBe(2);
    expect(row2.debet).toBe(0);
    expect(row2.credit).toBe(42);
    expect(row2.grootboekNummer).toBe(1671);
    expect(row2.grootboekNaam).toBe("BTW af te dragen hoog");
    expect(row2.btwSoort).toBe(2);

    // Sheet should have exactly 1 header + 3 data rows
    expect(sheet.rowCount).toBe(4);
  });

  it("9% BTW → uses Omzet laag (8110), BTW af te dragen laag (1670), btwSoort=1", async () => {
    const sheet = await loadSheet([sampleInvoiceVerkoop9]);
    const row1 = rowValues(sheet, 3);
    const row2 = rowValues(sheet, 4);

    expect(row1.grootboekNummer).toBe(8110);
    expect(row1.grootboekNaam).toBe("Omzet laag handelsgoederen");
    expect(row1.btwSoort).toBe(1);
    expect(row1.btwPercentage).toBe(9);

    expect(row2.grootboekNummer).toBe(1670);
    expect(row2.grootboekNaam).toBe("BTW af te dragen laag");
    expect(row2.btwSoort).toBe(1);
  });

  it("0% BTW → 2 rows only (no BTW row), Omzet binnen EU (8170)", async () => {
    const sheet = await loadSheet([sampleInvoiceVerkoop0]);

    expect(sheet.rowCount).toBe(3); // 1 header + 2 data

    const row0 = rowValues(sheet, 2);
    const row1 = rowValues(sheet, 3);

    expect(row0.dagboekNummer).toBe(1300);
    expect(row0.debet).toBe(100);

    expect(row1.regel).toBe(1);
    expect(row1.credit).toBe(100);
    expect(row1.grootboekNummer).toBe(8170);
    expect(row1.grootboekNaam).toBe("Omzet binnen EU handelsgoederen");
    expect(row1.btwSoort).toBe(0);
  });
});

describe("buildInvoiceExcelBuffer — INKOOP (purchase) format", () => {
  it("21% BTW → 3 rows: Crediteuren credit, Inkoop debet, BTW te vorderen debet", async () => {
    // total 121 incl. 21% → excl 100, btw 21
    const sheet = await loadSheet([sampleInvoiceInkoop21]);

    const row0 = rowValues(sheet, 2);
    const row1 = rowValues(sheet, 3);
    const row2 = rowValues(sheet, 4);

    // Regel 0 — Crediteuren
    expect(row0.dagboekNummer).toBe(1600);
    expect(row0.regel).toBe(0);
    expect(row0.debet).toBe(0);
    expect(row0.credit).toBe(121);
    expect(row0.grootboekNummer).toBe(1600);
    expect(row0.grootboekNaam).toBe("Crediteuren");
    expect(row0.btwSoort).toBe(0);

    // Regel 1 — Inkoop (7001)
    expect(row1.regel).toBe(1);
    expect(row1.debet).toBe(100);
    expect(row1.credit).toBe(0);
    expect(row1.grootboekNummer).toBe(7001);
    expect(row1.grootboekNaam).toBe("Inkoop laag tarief");
    expect(row1.btwSoort).toBe(1);

    // Regel 2 — BTW te vorderen (1681)
    expect(row2.regel).toBe(2);
    expect(row2.debet).toBe(21);
    expect(row2.credit).toBe(0);
    expect(row2.grootboekNummer).toBe(1681);
    expect(row2.grootboekNaam).toBe("BTW te vorderen laag (inkopen)");
    expect(row2.btwSoort).toBe(1);

    expect(sheet.rowCount).toBe(4);
  });

  it("9% BTW → still uses 7001/1681 (low-rate purchase accounts)", async () => {
    const sheet = await loadSheet([sampleInvoiceInkoop9]);
    // 109 incl 9% → excl 100, btw 9
    const row1 = rowValues(sheet, 3);
    const row2 = rowValues(sheet, 4);

    expect(row1.debet).toBeCloseTo(100, 2);
    expect(row1.grootboekNummer).toBe(7001);
    expect(row2.debet).toBeCloseTo(9, 2);
    expect(row2.grootboekNummer).toBe(1681);
  });

  it("0% BTW → 2 rows only (no BTW row), Inkopen vrij (7003)", async () => {
    const sheet = await loadSheet([sampleInvoiceInkoop0]);

    expect(sheet.rowCount).toBe(3);

    const row0 = rowValues(sheet, 2);
    const row1 = rowValues(sheet, 3);

    expect(row0.credit).toBe(100);
    expect(row0.grootboekNummer).toBe(1600);

    expect(row1.regel).toBe(1);
    expect(row1.debet).toBe(100);
    expect(row1.grootboekNummer).toBe(7003);
    expect(row1.grootboekNaam).toBe("Inkopen vrij");
    expect(row1.btwSoort).toBe(0);
  });
});

describe("buildInvoiceExcelBuffer — invoice metadata & multi-row", () => {
  it("propagates FactuurNummer and RelatieNaam to every row of an invoice", async () => {
    const sheet = await loadSheet([sampleInvoiceInkoop21]);
    for (let r = 2; r <= 4; r++) {
      const row = rowValues(sheet, r);
      expect(row.factuurNummer).toBe("INV-0001");
      expect(row.relatieNaam).toBe("Nema Food B.V.");
    }
  });

  it("writes a Date object into the Datum column (col 4)", async () => {
    const sheet = await loadSheet([sampleInvoiceInkoop21]);
    const value = sheet.getRow(2).getCell(COL.datum).value;
    expect(value).toBeInstanceOf(Date);
  });

  it("handles multiple invoices: row count = 1 header + sum of per-invoice rows", async () => {
    // 3 + 2 + 3 + 2 = 10 data rows + 1 header = 11
    const sheet = await loadSheet([
      sampleInvoiceInkoop21,
      sampleInvoiceInkoop0,
      sampleInvoiceVerkoop21,
      sampleInvoiceVerkoop0,
    ]);
    expect(sheet.rowCount).toBe(11);
  });

  it("BookingId increments per invoice (1, 2, 3, ...)", async () => {
    const sheet = await loadSheet([
      sampleInvoiceInkoop21, // 3 rows, bookingId=1
      sampleInvoiceVerkoop21, // 3 rows, bookingId=2
    ]);
    // BookingId is column 2
    expect(sheet.getRow(2).getCell(2).value).toBe(1);
    expect(sheet.getRow(4).getCell(2).value).toBe(1); // same invoice still bookingId 1
    expect(sheet.getRow(5).getCell(2).value).toBe(2); // new invoice
  });

  it("defaults to 'inkoop' direction when invoice_direction is null", async () => {
    const sheet = await loadSheet([
      { ...sampleInvoiceInkoop21, invoice_direction: null },
    ]);
    expect(rowValues(sheet, 2).dagboekNummer).toBe(1600); // Crediteuren
  });

  it("clamps invalid vat_rate to 21% default", async () => {
    const sheet = await loadSheet([
      { ...sampleInvoiceInkoop21, raw_extraction: { vat_rate: 99 } },
    ]);
    // Should still produce 3 rows (treated as 21%)
    expect(sheet.rowCount).toBe(4);
    expect(rowValues(sheet, 3).btwPercentage).toBe(21);
  });
});
