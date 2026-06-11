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
 * The exporter writes one workbook with up to two sheets:
 *
 *  - "Sheet1"  — verkoop only, 22-column Snelstart Boekingen layout (existing format,
 *               2 or 3 rows per invoice depending on VAT rate)
 *  - "Inkoop" — inkoop only, NEW native Snelstart 24-column import layout,
 *               6 fixed rows per invoice (Regel 5 → 0, top to bottom)
 *
 * Each sheet is only created when there are invoices of that direction.
 */

// ── Verkoop (Sheet1) column reference ──────────────────────────────────────
const V = {
  datum:           4,
  bookingId:       2,
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

// ── Inkoop (Inkoop) column reference — matches INKOOP_COLS order ──────────
const I = {
  dagboeknaam:             1,
  datum:                   2,
  regel:                   3,
  omschrijving:            4,
  grootboek:               5,
  grootboeknaam:           6,
  debet:                   7,
  credit:                  8,
  saldo:                   9,
  btwSoort:               10,
  factuurnummer:          11,
  dagboek:                12,
  dagboeksoort:           13,
  boekstuk:               14,
  gewijzigdDoorAccountant:15,
  relatiecode:            16,
  relatienaam:            17,
  grootboekrekeningType:  18,
  grootboekFunctie:       19,
  gemarkeerd:             20,
  bijlagen:               21,
  kostenplaats:           22,
} as const;

async function loadWorkbook(invoices: Parameters<typeof buildInvoiceExcelBuffer>[0]) {
  const buffer = await buildInvoiceExcelBuffer(invoices);
  const wb = new ExcelJS.Workbook();
  // ExcelJS's typed Buffer signature is narrower than Node's; runtime accepts both.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

function verkoopRow(sheet: ExcelJS.Worksheet, rowNum: number) {
  const row = sheet.getRow(rowNum);
  return {
    datum:           row.getCell(V.datum).value,
    dagboekNummer:   row.getCell(V.dagboekNummer).value,
    regel:           row.getCell(V.regel).value,
    debet:           Number(row.getCell(V.debet).value ?? 0),
    credit:          Number(row.getCell(V.credit).value ?? 0),
    grootboekNaam:   row.getCell(V.grootboekNaam).value,
    grootboekNummer: row.getCell(V.grootboekNummer).value,
    btwSoort:        row.getCell(V.btwSoort).value,
    btwPercentage:   row.getCell(V.btwPercentage).value,
    factuurNummer:   row.getCell(V.factuurNummer).value,
    relatieNaam:     row.getCell(V.relatieNaam).value,
  };
}

function inkoopRow(sheet: ExcelJS.Worksheet, rowNum: number) {
  const row = sheet.getRow(rowNum);
  return {
    dagboeknaam:           row.getCell(I.dagboeknaam).value,
    datum:                 row.getCell(I.datum).value,
    regel:                 row.getCell(I.regel).value,
    omschrijving:          row.getCell(I.omschrijving).value,
    grootboek:             row.getCell(I.grootboek).value,
    grootboeknaam:         row.getCell(I.grootboeknaam).value,
    debet:                 Number(row.getCell(I.debet).value ?? 0),
    credit:                Number(row.getCell(I.credit).value ?? 0),
    saldo:                 Number(row.getCell(I.saldo).value ?? 0),
    btwSoort:              row.getCell(I.btwSoort).value,
    factuurnummer:         row.getCell(I.factuurnummer).value,
    dagboek:               row.getCell(I.dagboek).value,
    dagboeksoort:          row.getCell(I.dagboeksoort).value,
    boekstuk:              row.getCell(I.boekstuk).value,
    relatiecode:           row.getCell(I.relatiecode).value,
    relatienaam:           row.getCell(I.relatienaam).value,
    grootboekrekeningType: row.getCell(I.grootboekrekeningType).value,
    grootboekFunctie:      row.getCell(I.grootboekFunctie).value,
  };
}

// ── Workbook structure ───────────────────────────────────────────────────

describe("buildInvoiceExcelBuffer — workbook structure", () => {
  it("returns a non-empty Buffer", async () => {
    const buffer = await buildInvoiceExcelBuffer([sampleInvoiceInkoop21]);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it("inkoop-only export contains only the 'Inkoop' sheet with frozen header", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21]);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Inkoop"]);
    const view = wb.getWorksheet("Inkoop")!.views?.[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe("frozen");
    expect(view?.ySplit).toBe(1);
  });

  it("verkoop-only export contains only the 'Sheet1' sheet with frozen header", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21]);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Sheet1"]);
    const view = wb.getWorksheet("Sheet1")!.views?.[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe("frozen");
    expect(view?.ySplit).toBe(1);
  });

  it("mixed export contains both 'Sheet1' and 'Inkoop' sheets", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21, sampleInvoiceInkoop21]);
    expect(wb.worksheets.map((s) => s.name).sort()).toEqual(["Inkoop", "Sheet1"]);
  });

  it("Sheet1 emits all 22 Boekingen columns in the header row", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21]);
    const header = wb.getWorksheet("Sheet1")!.getRow(1);
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

  it("Inkoop sheet emits all 24 native-Snelstart columns in the header row", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21]);
    const header = wb.getWorksheet("Inkoop")!.getRow(1);
    const titles: string[] = [];
    header.eachCell((cell) => titles.push(String(cell.value)));
    expect(titles).toEqual([
      "Dagboeknaam", "Datum", "Regel", "Omschrijving", "Grootboek",
      "Grootboeknaam", "Debet", "Credit", "Saldo", "Btw-soort",
      "Factuurnummer", "Dagboek", "Dagboeksoort", "Boekstuk",
      "Gewijzigd door accountant", "Relatiecode", "Relatienaam",
      "Grootboekrekening type", "Grootboek functie", "Gemarkeerd",
      "Bijlagen", "Kostenplaats", "Kostenplaatsnaam", "Bankomschrijving",
    ]);
  });
});

// ── VERKOOP — unchanged from prior format ──────────────────────────────────

describe("buildInvoiceExcelBuffer — VERKOOP (sales) format (unchanged)", () => {
  it("21% BTW → 3 rows: Debiteuren debet, Omzet hoog credit, BTW af te dragen hoog credit", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21]);
    const sheet = wb.getWorksheet("Sheet1")!;
    const row0 = verkoopRow(sheet, 2);
    const row1 = verkoopRow(sheet, 3);
    const row2 = verkoopRow(sheet, 4);

    expect(row0.dagboekNummer).toBe(1300);
    expect(row0.regel).toBe(0);
    expect(row0.debet).toBe(242);
    expect(row0.credit).toBe(0);
    expect(row0.grootboekNummer).toBe(1300);
    expect(row0.grootboekNaam).toBe("Debiteuren");
    expect(row0.btwSoort).toBe(0);

    expect(row1.regel).toBe(1);
    expect(row1.debet).toBe(0);
    expect(row1.credit).toBe(200);
    expect(row1.grootboekNummer).toBe(8100);
    expect(row1.grootboekNaam).toBe("Omzet hoog handelsgoederen");
    expect(row1.btwSoort).toBe(2);
    expect(row1.btwPercentage).toBe(21);

    expect(row2.regel).toBe(2);
    expect(row2.debet).toBe(0);
    expect(row2.credit).toBe(42);
    expect(row2.grootboekNummer).toBe(1671);
    expect(row2.grootboekNaam).toBe("BTW af te dragen hoog");
    expect(row2.btwSoort).toBe(2);

    expect(sheet.rowCount).toBe(4);
  });

  it("9% BTW → uses Omzet laag (8110), BTW af te dragen laag (1670), btwSoort=1", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop9]);
    const sheet = wb.getWorksheet("Sheet1")!;
    const row1 = verkoopRow(sheet, 3);
    const row2 = verkoopRow(sheet, 4);

    expect(row1.grootboekNummer).toBe(8110);
    expect(row1.grootboekNaam).toBe("Omzet laag handelsgoederen");
    expect(row1.btwSoort).toBe(1);
    expect(row1.btwPercentage).toBe(9);

    expect(row2.grootboekNummer).toBe(1670);
    expect(row2.grootboekNaam).toBe("BTW af te dragen laag");
    expect(row2.btwSoort).toBe(1);
  });

  it("0% BTW → 2 rows only (no BTW row), Omzet binnen EU (8170)", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop0]);
    const sheet = wb.getWorksheet("Sheet1")!;
    expect(sheet.rowCount).toBe(3);

    const row0 = verkoopRow(sheet, 2);
    const row1 = verkoopRow(sheet, 3);

    expect(row0.dagboekNummer).toBe(1300);
    expect(row0.debet).toBe(100);

    expect(row1.regel).toBe(1);
    expect(row1.credit).toBe(100);
    expect(row1.grootboekNummer).toBe(8170);
    expect(row1.grootboekNaam).toBe("Omzet binnen EU handelsgoederen");
    expect(row1.btwSoort).toBe(0);
  });
});

// ── INKOOP — new 24-col native Snelstart layout, 6 rows per invoice ────────

describe("buildInvoiceExcelBuffer — INKOOP (purchase) native Snelstart format", () => {
  it("always emits exactly 6 rows per invoice in order Regel 5 → 0", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21]);
    const sheet = wb.getWorksheet("Inkoop")!;
    expect(sheet.rowCount).toBe(7); // 1 header + 6 data

    const regels = [2, 3, 4, 5, 6, 7].map((r) => Number(sheet.getRow(r).getCell(I.regel).value));
    expect(regels).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it("21% BTW: synthesised breakdown writes vat_21 on Regel 4 (1680) and net_21 on Regel 1 (7002)", async () => {
    // total 121 incl 21% → net 100, vat 21
    const wb = await loadWorkbook([sampleInvoiceInkoop21]);
    const sheet = wb.getWorksheet("Inkoop")!;

    const r5 = inkoopRow(sheet, 2); // Regel 5 — BTW laag
    const r4 = inkoopRow(sheet, 3); // Regel 4 — BTW hoog
    const r3 = inkoopRow(sheet, 4); // Regel 3 — Inkoop laag
    const r2 = inkoopRow(sheet, 5); // Regel 2 — Emballage
    const r1 = inkoopRow(sheet, 6); // Regel 1 — Inkoop hoog
    const r0 = inkoopRow(sheet, 7); // Regel 0 — Crediteuren

    expect(r5).toMatchObject({ grootboek: 1679, grootboeknaam: "Btw te vorderen laag (inkopen)", debet: 0,   btwSoort: "Laag", grootboekrekeningType: "Balans",          grootboekFunctie: "BtwTeVorderenLaag" });
    expect(r4).toMatchObject({ grootboek: 1680, grootboeknaam: "Btw te vorderen hoog (inkopen)", debet: 21,  btwSoort: "Hoog", grootboekrekeningType: "Balans",          grootboekFunctie: "BtwTeVorderenHoog" });
    expect(r3).toMatchObject({ grootboek: 7001, grootboeknaam: "Inkopen laag tarief",            debet: 0,   btwSoort: "Laag", grootboekrekeningType: "Verlies & Winst", grootboekFunctie: "InkopenKostenLaag" });
    expect(r2).toMatchObject({ grootboek: 3090, grootboeknaam: "Emballage",                      debet: 0,   btwSoort: "Geen", grootboekrekeningType: "Balans",          grootboekFunctie: "Diversen" });
    expect(r1).toMatchObject({ grootboek: 7002, grootboeknaam: "Inkopen hoog tarief",            debet: 100, btwSoort: "Hoog", grootboekrekeningType: "Verlies & Winst", grootboekFunctie: "InkopenKostenHoog" });
    expect(r0).toMatchObject({ grootboek: 1600, grootboeknaam: "Crediteuren",                    debet: 0, credit: 121, btwSoort: "Geen", grootboekrekeningType: "Balans", grootboekFunctie: "DagboekInkoop" });
    expect(r0.saldo).toBe(-121);
  });

  it("9% BTW: synthesised breakdown writes vat_9 on Regel 5 (1679) and net_9 on Regel 3 (7001)", async () => {
    // total 109 incl 9% → net 100, vat 9
    const wb = await loadWorkbook([sampleInvoiceInkoop9]);
    const sheet = wb.getWorksheet("Inkoop")!;

    const r5 = inkoopRow(sheet, 2);
    const r3 = inkoopRow(sheet, 4);
    const r0 = inkoopRow(sheet, 7);

    expect(r5.debet).toBeCloseTo(9, 2);
    expect(r3.debet).toBeCloseTo(100, 2);
    expect(r0.credit).toBe(109);
  });

  it("0% BTW: still emits all 6 rows (mostly zero), Regel 0 carries the full total", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop0]);
    const sheet = wb.getWorksheet("Inkoop")!;
    expect(sheet.rowCount).toBe(7);

    // All VAT and net cells should be zero, only Regel 0 carries credit=total
    for (const r of [2, 3, 4, 5, 6]) {
      expect(Number(sheet.getRow(r).getCell(I.debet).value ?? 0)).toBe(0);
      expect(Number(sheet.getRow(r).getCell(I.credit).value ?? 0)).toBe(0);
    }
    const r0 = inkoopRow(sheet, 7);
    expect(r0.credit).toBe(100);
    expect(r0.grootboek).toBe(1600);
  });

  it("uses raw_extraction.vat_breakdown when present (DE MOOIJ example)", async () => {
    const deMooij = {
      ...sampleInvoiceInkoop21,
      total_amount: 755.38,
      raw_extraction: {
        vat_rate: 9,
        vat_breakdown: { net_21: 0, vat_21: 0, net_9: 693.01, vat_9: 62.37, net_0: 0, emballage: 0 },
      },
    };
    const wb = await loadWorkbook([deMooij]);
    const sheet = wb.getWorksheet("Inkoop")!;

    expect(inkoopRow(sheet, 2).debet).toBeCloseTo(62.37, 2);  // Regel 5 — BTW laag
    expect(inkoopRow(sheet, 3).debet).toBeCloseTo(0,     2);  // Regel 4 — BTW hoog
    expect(inkoopRow(sheet, 4).debet).toBeCloseTo(693.01,2);  // Regel 3 — Inkoop laag
    expect(inkoopRow(sheet, 5).debet).toBeCloseTo(0,     2);  // Regel 2 — Emballage
    expect(inkoopRow(sheet, 6).debet).toBeCloseTo(0,     2);  // Regel 1 — Inkoop hoog
    const r0 = inkoopRow(sheet, 7);
    expect(r0.credit).toBeCloseTo(755.38, 2);
    expect(r0.saldo).toBeCloseTo(-755.38, 2);
  });

  it("uses emballage on Regel 2 when the breakdown includes it", async () => {
    const withEmballage = {
      ...sampleInvoiceInkoop21,
      total_amount: 132.80,
      raw_extraction: {
        vat_rate: 21,
        vat_breakdown: { net_21: 100, vat_21: 21, net_9: 0, vat_9: 0, net_0: 0, emballage: 10.80 },
      },
    };
    const wb = await loadWorkbook([withEmballage]);
    const sheet = wb.getWorksheet("Inkoop")!;
    expect(inkoopRow(sheet, 5)).toMatchObject({ grootboek: 3090, grootboeknaam: "Emballage", debet: 10.80 });
  });

  it("propagates Factuurnummer, Relatienaam, Dagboeknaam and Boekstuk to every row of an invoice", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21]);
    const sheet = wb.getWorksheet("Inkoop")!;
    for (let r = 2; r <= 7; r++) {
      const row = inkoopRow(sheet, r);
      expect(row.factuurnummer).toBe("INV-0001");
      expect(row.relatienaam).toBe("Nema Food B.V.");
      expect(row.dagboeknaam).toBe("Crediteuren");
      expect(row.dagboek).toBe(1600);
      expect(row.dagboeksoort).toBe("dagboek Inkoop");
      expect(row.boekstuk).toBe(1);
    }
  });

  it("writes a Date object into the Datum column", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21]);
    const sheet = wb.getWorksheet("Inkoop")!;
    expect(sheet.getRow(2).getCell(I.datum).value).toBeInstanceOf(Date);
  });
});

// ── Multi-invoice & defaults ───────────────────────────────────────────────

describe("buildInvoiceExcelBuffer — multi-invoice & defaults", () => {
  it("inkoop rowCount = 1 header + 6 × invoices", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21, sampleInvoiceInkoop9, sampleInvoiceInkoop0]);
    const sheet = wb.getWorksheet("Inkoop")!;
    expect(sheet.rowCount).toBe(1 + 6 * 3);
  });

  it("Boekstuk increments per inkoop invoice and stays identical across its 6 rows", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21, sampleInvoiceInkoop9]);
    const sheet = wb.getWorksheet("Inkoop")!;
    // Rows 2-7 belong to invoice #1, rows 8-13 belong to invoice #2
    for (let r = 2; r <= 7; r++) expect(Number(sheet.getRow(r).getCell(I.boekstuk).value)).toBe(1);
    for (let r = 8; r <= 13; r++) expect(Number(sheet.getRow(r).getCell(I.boekstuk).value)).toBe(2);
  });

  it("defaults to 'inkoop' direction when invoice_direction is null", async () => {
    const wb = await loadWorkbook([
      { ...sampleInvoiceInkoop21, invoice_direction: null },
    ]);
    // No verkoop sheet, only Inkoop
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Inkoop"]);
    expect(inkoopRow(wb.getWorksheet("Inkoop")!, 7).grootboek).toBe(1600);
  });

  it("clamps invalid vat_rate to 21% default in the synthesis fallback", async () => {
    const wb = await loadWorkbook([
      { ...sampleInvoiceInkoop21, raw_extraction: { vat_rate: 99 } },
    ]);
    const sheet = wb.getWorksheet("Inkoop")!;
    expect(sheet.rowCount).toBe(7);
    // 21% synthesis → vat_21=21 on Regel 4
    expect(Number(sheet.getRow(3).getCell(I.debet).value)).toBeCloseTo(21, 2);
  });

  it("falls back to bookingId for Relatiecode when no supplier mapping is attached", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21, sampleInvoiceInkoop9]);
    const sheet = wb.getWorksheet("Inkoop")!;
    // Each invoice spans 6 rows; Relatiecode = boekstuk when relatie_code is unset
    expect(Number(sheet.getRow(2).getCell(I.relatiecode).value)).toBe(1);
    expect(Number(sheet.getRow(8).getCell(I.relatiecode).value)).toBe(2);
  });

  it("uses supplied relatie_code on every row when attached", async () => {
    const tagged = { ...sampleInvoiceInkoop21, relatie_code: "12" };
    const wb = await loadWorkbook([tagged]);
    const sheet = wb.getWorksheet("Inkoop")!;
    for (let r = 2; r <= 7; r++) {
      expect(String(sheet.getRow(r).getCell(I.relatiecode).value)).toBe("12");
    }
  });
});
