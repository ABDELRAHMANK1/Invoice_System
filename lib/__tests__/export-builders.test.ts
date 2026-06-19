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
 * The exporter writes one workbook with up to two sheets — both now use the
 * native Snelstart Boekingen import layout:
 *
 *  - "Verkoop" — verkoop only, 25 columns, 2 or 3 rows per invoice
 *                (Regel 2 → 1 → 0 for 21%/9%, or Regel 1 → 0 for 0% verlegd).
 *  - "Inkoop"  — inkoop only, 25 columns, 6 fixed rows per invoice
 *                (Regel 5 → 0, top to bottom).
 *
 * Each sheet is only created when there are invoices of that direction.
 */

// ── Verkoop sheet column reference (matches VERKOOP_COLS order) ────────────
const V = {
  bookingId:               1,
  dagboeknaam:             2,
  datum:                   3,
  regel:                   4,
  omschrijving:            5,
  grootboek:               6,
  grootboeknaam:           7,
  debet:                   8,
  credit:                  9,
  saldo:                  10,
  btwSoort:               11,
  factuurnummer:          12,
  dagboek:                13,
  dagboeksoort:           14,
  boekstuk:               15,
  gewijzigdDoorAccountant:16,
  relatiecode:            17,
  relatienaam:            18,
  grootboekrekeningType:  19,
  grootboekFunctie:       20,
  gemarkeerd:             21,
  bijlagen:               22,
  bankomschrijving:       23,
  kostenplaats:           24,
  kostenplaatsnaam:       25,
} as const;

// ── Inkoop sheet column reference (matches INKOOP_COLS order) ──────────────
const I = {
  bookingId:               1,
  dagboeknaam:             2,
  datum:                   3,
  regel:                   4,
  omschrijving:            5,
  grootboek:               6,
  grootboeknaam:           7,
  debet:                   8,
  credit:                  9,
  saldo:                  10,
  btwSoort:               11,
  factuurnummer:          12,
  dagboek:                13,
  dagboeksoort:           14,
  boekstuk:               15,
  gewijzigdDoorAccountant:16,
  relatiecode:            17,
  relatienaam:            18,
  grootboekrekeningType:  19,
  grootboekFunctie:       20,
  gemarkeerd:             21,
  bijlagen:               22,
  kostenplaats:           23,
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
    bookingId:             row.getCell(V.bookingId).value,
    dagboeknaam:           row.getCell(V.dagboeknaam).value,
    datum:                 row.getCell(V.datum).value,
    regel:                 row.getCell(V.regel).value,
    omschrijving:          row.getCell(V.omschrijving).value,
    grootboek:             row.getCell(V.grootboek).value,
    grootboeknaam:         row.getCell(V.grootboeknaam).value,
    debet:                 Number(row.getCell(V.debet).value ?? 0),
    credit:                Number(row.getCell(V.credit).value ?? 0),
    saldo:                 Number(row.getCell(V.saldo).value ?? 0),
    btwSoort:              row.getCell(V.btwSoort).value,
    factuurnummer:         row.getCell(V.factuurnummer).value,
    dagboek:               row.getCell(V.dagboek).value,
    dagboeksoort:          row.getCell(V.dagboeksoort).value,
    boekstuk:              row.getCell(V.boekstuk).value,
    relatiecode:           row.getCell(V.relatiecode).value,
    relatienaam:           row.getCell(V.relatienaam).value,
    grootboekrekeningType: row.getCell(V.grootboekrekeningType).value,
    grootboekFunctie:      row.getCell(V.grootboekFunctie).value,
  };
}

function inkoopRow(sheet: ExcelJS.Worksheet, rowNum: number) {
  const row = sheet.getRow(rowNum);
  return {
    bookingId:             row.getCell(I.bookingId).value,
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

  it("verkoop-only export contains only the 'Verkoop' sheet with frozen header", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21]);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Verkoop"]);
    const view = wb.getWorksheet("Verkoop")!.views?.[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe("frozen");
    expect(view?.ySplit).toBe(1);
  });

  it("mixed export contains both 'Verkoop' and 'Inkoop' sheets", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21, sampleInvoiceInkoop21]);
    expect(wb.worksheets.map((s) => s.name).sort()).toEqual(["Inkoop", "Verkoop"]);
  });

  it("Verkoop sheet emits all 25 native-Snelstart columns in the header row", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21]);
    const header = wb.getWorksheet("Verkoop")!.getRow(1);
    const titles: string[] = [];
    header.eachCell((cell) => titles.push(String(cell.value)));
    expect(titles).toEqual([
      "BookingId", "Dagboeknaam", "Datum", "Regel", "Omschrijving", "Grootboek",
      "Grootboeknaam", "Debet", "Credit", "Saldo", "Btw-soort",
      "Factuurnummer", "Dagboek", "Dagboeksoort", "Boekstuk",
      "Gewijzigd door accountant", "Relatiecode", "Relatienaam",
      "Grootboekrekening type", "Grootboek functie", "Gemarkeerd",
      "Bijlagen", "Bankomschrijving", "Kostenplaats", "Kostenplaatsnaam",
    ]);
  });

  it("Inkoop sheet emits all 25 native-Snelstart columns in the header row", async () => {
    const wb = await loadWorkbook([sampleInvoiceInkoop21]);
    const header = wb.getWorksheet("Inkoop")!.getRow(1);
    const titles: string[] = [];
    header.eachCell((cell) => titles.push(String(cell.value)));
    expect(titles).toEqual([
      "BookingId", "Dagboeknaam", "Datum", "Regel", "Omschrijving", "GrootboekNummer",
      "Grootboeknaam", "Debet", "Credit", "Saldo", "BtwSoort",
      "Factuurnummer", "DagboekNummer", "Dagboeksoort", "Boekstuk",
      "Gewijzigd door accountant", "Relatiecode", "Relatienaam",
      "Grootboekrekening type", "Grootboek functie", "Gemarkeerd",
      "Bijlagen", "Kostenplaats", "Kostenplaatsnaam", "Bankomschrijving",
    ]);
  });
});

// ── VERKOOP — new 25-col native Snelstart layout, Regel 2 → 1 → 0 ──────────

describe("buildInvoiceExcelBuffer — VERKOOP (sales) native Snelstart format", () => {
  it("21% BTW → 3 rows ordered Regel 2 → 1 → 0 with hoog accounts (1671/8200/1300)", async () => {
    // total 242 incl 21% → net 200, btw 42
    const wb = await loadWorkbook([sampleInvoiceVerkoop21]);
    const sheet = wb.getWorksheet("Verkoop")!;
    expect(sheet.rowCount).toBe(4); // 1 header + 3 data

    const r2 = verkoopRow(sheet, 2); // Regel 2 — BTW af te dragen hoog
    const r1 = verkoopRow(sheet, 3); // Regel 1 — Omzet hoog
    const r0 = verkoopRow(sheet, 4); // Regel 0 — Debiteuren

    expect(r2).toMatchObject({
      regel: 2, grootboek: 1671, grootboeknaam: "Btw af te dragen hoog (verkopen)",
      debet: 0, credit: 42, saldo: -42,
      btwSoort: 2, grootboekrekeningType: "Balans", grootboekFunctie: "BtwAfTeDragenHoog",
    });
    expect(r1).toMatchObject({
      regel: 1, grootboek: 8200, grootboeknaam: "Omzet hoog (diensten)",
      debet: 0, credit: 200, saldo: -200,
      btwSoort: 2, grootboekrekeningType: "Verlies & Winst", grootboekFunctie: "VerkopenOmzetHoog",
    });
    expect(r0).toMatchObject({
      regel: 0, grootboek: 1300, grootboeknaam: "Debiteuren",
      debet: 242, credit: 0, saldo: 242,
      btwSoort: 0, grootboekrekeningType: "Balans", grootboekFunctie: "DagboekVerkoop",
    });
  });

  it("9% BTW → uses laag accounts (1670/8210), numeric btwSoort=1", async () => {
    // total 109 incl 9% → net 100, btw 9
    const wb = await loadWorkbook([sampleInvoiceVerkoop9]);
    const sheet = wb.getWorksheet("Verkoop")!;
    expect(sheet.rowCount).toBe(4);

    const r2 = verkoopRow(sheet, 2);
    const r1 = verkoopRow(sheet, 3);

    expect(r2).toMatchObject({
      grootboek: 1670, grootboeknaam: "Btw af te dragen laag (verkopen)",
      credit: 9, btwSoort: 1, grootboekFunctie: "BtwAfTeDragenLaag",
    });
    expect(r1).toMatchObject({
      grootboek: 8210, grootboeknaam: "Omzet laag (diensten)",
      credit: 100, btwSoort: 1, grootboekFunctie: "VerkopenOmzetLaag",
    });
  });

  it("0% BTW (verlegd) → 2 rows only (no BTW row), Omzet binnen EU diensten (8170)", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop0]);
    const sheet = wb.getWorksheet("Verkoop")!;
    expect(sheet.rowCount).toBe(3); // 1 header + 2 data

    const r1 = verkoopRow(sheet, 2); // Regel 1 — Omzet vrijgesteld
    const r0 = verkoopRow(sheet, 3); // Regel 0 — Debiteuren

    expect(r1).toMatchObject({
      regel: 1, grootboek: 8170, grootboeknaam: "Omzet binnen EU diensten",
      debet: 0, credit: 100, btwSoort: 0, grootboekFunctie: "VerkopenOmzetVrijgesteld",
    });
    expect(r0).toMatchObject({
      regel: 0, grootboek: 1300, debet: 100, credit: 0, btwSoort: 0,
    });
  });

  it("propagates Factuurnummer, Relatienaam, Dagboeknaam and Boekstuk to every row", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21]);
    const sheet = wb.getWorksheet("Verkoop")!;
    for (let r = 2; r <= 4; r++) {
      const row = verkoopRow(sheet, r);
      expect(row.factuurnummer).toBe("INV-V-0001");
      expect(row.relatienaam).toBe("RAJEH FOOD");
      expect(row.dagboeknaam).toBe("Debiteuren");
      expect(row.dagboek).toBe(1300);
      expect(row.dagboeksoort).toBe("dagboek Verkoop");
      expect(row.boekstuk).toBe(1);
      expect(row.bookingId).toBe(1);
    }
  });

  it("Relatienaam = customer_name when present (mirror of inkoop supplier_name), falling back to client_name", async () => {
    const withCustomer = { ...sampleInvoiceVerkoop21, customer_name: "Albert Heijn B.V." };
    const wb = await loadWorkbook([withCustomer]);
    const sheet = wb.getWorksheet("Verkoop")!;
    for (let r = 2; r <= 4; r++) {
      expect(verkoopRow(sheet, r).relatienaam).toBe("Albert Heijn B.V.");
      expect(verkoopRow(sheet, r).omschrijving).toBe("Albert Heijn B.V.");
    }
    // No customer_name → still falls back to client_name.
    const wb2 = await loadWorkbook([sampleInvoiceVerkoop21]);
    expect(verkoopRow(wb2.getWorksheet("Verkoop")!, 2).relatienaam).toBe("RAJEH FOOD");
  });

  it("Boekstuk + BookingId increment per verkoop invoice and stay identical across its rows", async () => {
    const wb = await loadWorkbook([sampleInvoiceVerkoop21, sampleInvoiceVerkoop9]);
    const sheet = wb.getWorksheet("Verkoop")!;
    // Invoice #1 spans rows 2-4 (3 rows), invoice #2 spans rows 5-7 (3 rows)
    for (let r = 2; r <= 4; r++) {
      expect(Number(sheet.getRow(r).getCell(V.boekstuk).value)).toBe(1);
      expect(Number(sheet.getRow(r).getCell(V.bookingId).value)).toBe(1);
    }
    for (let r = 5; r <= 7; r++) {
      expect(Number(sheet.getRow(r).getCell(V.boekstuk).value)).toBe(2);
      expect(Number(sheet.getRow(r).getCell(V.bookingId).value)).toBe(2);
    }
  });

  it("Tulp Transportbedrijf real-world case (total 1577.38 @ 21%) matches Ammar's reference table", async () => {
    const tulp = {
      ...sampleInvoiceVerkoop21,
      invoice_number: "2026038",
      client_name:    "Tulp Transportbedrijf B.V.",
      total_amount:   1577.38,
      raw_extraction: { vat_rate: 21 },
    };
    const wb = await loadWorkbook([tulp]);
    const sheet = wb.getWorksheet("Verkoop")!;

    const r2 = verkoopRow(sheet, 2);
    const r1 = verkoopRow(sheet, 3);
    const r0 = verkoopRow(sheet, 4);

    expect(r2.credit).toBeCloseTo(273.76, 2);
    expect(r2.saldo).toBeCloseTo(-273.76, 2);
    expect(r1.credit).toBeCloseTo(1303.62, 2);
    expect(r1.saldo).toBeCloseTo(-1303.62, 2);
    expect(r0.debet).toBeCloseTo(1577.38, 2);
    expect(r0.saldo).toBeCloseTo(1577.38, 2);
  });
});

// ── INKOOP — 25-col native Snelstart layout, 6 rows per invoice ────────────

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

    expect(r5).toMatchObject({ grootboek: 1679, grootboeknaam: "Btw te vorderen laag (inkopen)", debet: 0,   btwSoort: 1, grootboekrekeningType: "Balans",          grootboekFunctie: "BtwTeVorderenLaag" });
    expect(r4).toMatchObject({ grootboek: 1680, grootboeknaam: "Btw te vorderen hoog (inkopen)", debet: 21,  btwSoort: 2, grootboekrekeningType: "Balans",          grootboekFunctie: "BtwTeVorderenHoog" });
    expect(r3).toMatchObject({ grootboek: 7001, grootboeknaam: "Inkopen laag tarief",            debet: 0,   btwSoort: 1, grootboekrekeningType: "Verlies & Winst", grootboekFunctie: "InkopenKostenLaag" });
    expect(r2).toMatchObject({ grootboek: 3090, grootboeknaam: "Emballage",                      debet: 0,   btwSoort: 0, grootboekrekeningType: "Balans",          grootboekFunctie: "Diversen" });
    expect(r1).toMatchObject({ grootboek: 7002, grootboeknaam: "Inkopen hoog tarief",            debet: 100, btwSoort: 2, grootboekrekeningType: "Verlies & Winst", grootboekFunctie: "InkopenKostenHoog" });
    expect(r0).toMatchObject({ grootboek: 1600, grootboeknaam: "Crediteuren",                    debet: 0, credit: 121, btwSoort: 0, grootboekrekeningType: "Balans", grootboekFunctie: "DagboekInkoop" });
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
    expect(inkoopRow(sheet, 5)).toMatchObject({ grootboek: 3090, grootboeknaam: "Emballage", debet: 10.80, btwSoort: 0 });
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

  it("blankUnmatchedRelatiecode leaves the Relatiecode cell empty instead of the boekstuk fallback", async () => {
    // No relatie_code attached → default fills boekstuk; opt-in keeps it blank.
    const buffer = await buildInvoiceExcelBuffer([sampleInvoiceVerkoop21], { blankUnmatchedRelatiecode: true });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Verkoop")!;
    for (let r = 2; r <= 4; r++) {
      const cell = sheet.getRow(r).getCell(V.relatiecode).value;
      expect(cell == null || cell === "").toBe(true);
      expect(verkoopRow(sheet, r).relatienaam).toBe("RAJEH FOOD"); // name still present
    }
  });
});
