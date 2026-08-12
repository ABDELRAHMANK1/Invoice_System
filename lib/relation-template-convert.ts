// Snelstart relation-template converter — reshapes an EXTERNAL supplier
// (Leveranciers) or customer (Klanten) spreadsheet into Snelstart's exact
// accepted "Relaties" import template, ready to upload under Snelstart's
// "Bestand uploaden".
//
// Unlike lib/raw-invoice-convert (which produces Boekingen rows and needs the
// DB for Relatiecode matching), this is a pure FILE→FILE conform:
//   • the OUTPUT columns are fixed to Snelstart's template (exact header text +
//     order, verified against the templates in the repo root);
//   • each template column is filled from the matching source column, resolved
//     by normalised header name (+ a few friendly aliases);
//   • unmatched template columns stay blank; unmatched source columns are
//     reported so nothing is silently dropped.
//
// PURE: no Supabase / S3 / env / IO. The route loads the workbook + writes the
// buffer. `RelationKind` picks which template (36-col leverancier / 46-col klant).

import ExcelJS from "exceljs";
import { cellToString } from "@/lib/counterparty-import";

export const RELATION_MAX_BYTES = 5 * 1024 * 1024;
/** How many leading rows to scan when locating the header row. */
const HEADER_SCAN_ROWS = 15;

export type RelationKind = "leverancier" | "klant";

// Exact Snelstart template headers (order + literal text, trailing spaces and
// all) taken verbatim from the accepted import templates. Do NOT tidy these —
// Snelstart matches columns by their exact header string.
const LEVERANCIER_HEADERS: readonly string[] = [
  "RelatieCode", "Naam", "ContactPersoon", "Adres", "PostCode", "Plaats", "LandId",
  "CorrespondentieAdresContactperson", "CorrespondentieAdres ", "CorrespondentieAdresPostcode",
  "CorrespondentieAdresPlaats", "CorrespondentieAdresLandID", "Telefoon", "MobieleTelefoon",
  "Fax", "Email", "BtwNummer", "Factuurkorting ", "Krediettermijn ", "Bankrekeningnummer",
  "Iban", "Bic", "NaamRekeninghouder", "PlaatsRekeninghouder", "Bankieren", "Memo",
  "KvkNummer", "CreditCardNummer", "WebsiteUrl", "Debiteurenummer", "OfferteAanvraagEmailen",
  "OfferteAanvraagEmailAdres", "OfferteAanvraagCcEmailAdres", "BestellingEmailen",
  "BestellingEmailAdres", "BestellingCcEmailAdres",
];

const KLANT_HEADERS: readonly string[] = [
  "RelatieCode", "Naam", "ContactPersoon", "Adres", "PostCode", "Plaats", "LandId",
  "CorrespondentieAdresContactperson", "CorrespondentieAdres ", "CorrespondentieAdresPostcode",
  "CorrespondentieAdresPlaats", "CorrespondentieAdresLandID", "FactuurRelatieID", "Telefoon",
  "MobieleTelefoon", "Fax", "Email", "BtwNummer", "Factuurkorting ", "Krediettermijn ",
  "Bankrekeningnummer", "Iban", "Bic", "NaamRekeninghouder", "PlaatsRekeninghouder",
  "Bankieren", "Incasseren", "Aanmanen", "KlantKortinggroepId", "Memo", "KvkNummer",
  "CreditCardNummer", "WebsiteUrl", "OfferteEmailen", "OfferteEmailAdres", "OfferteCcEmailAdres",
  "BevestigingEmailen", "BevestigingEmailAdres", "BevestigingCcEmailAdres", "ElektronischFactureren",
  "FactuurEmailAdres", "FactuurCcEmailAdres", "UblBestandAlsBijlage", "AanmaningEmailen",
  "AanmaningEmailAdres", "AanmaningCcEmailAdres",
];

export const RELATION_TEMPLATES: Record<RelationKind, { label: string; headers: readonly string[] }> = {
  leverancier: { label: "Leveranciers", headers: LEVERANCIER_HEADERS },
  klant:       { label: "Klanten", headers: KLANT_HEADERS },
};

// Friendly aliases for a handful of columns, so a source using common
// English/Dutch spellings still maps onto the canonical template column. The
// KEY is the normalised template header; the values are extra normalised source
// headers that should resolve to it. Every template header always matches
// itself (normalised), so a source already in Snelstart shape is a passthrough.
const EXTRA_ALIASES: Record<string, string[]> = {
  relatiecode: ["relatie", "code", "klantnummer", "klantnr", "klantcode", "leveranciernummer", "leveranciernr", "snelstartcode", "customercode", "customernumber", "debiteurnummer", "crediteurnummer", "nummer"],
  naam: ["name", "bedrijf", "company", "klant", "klantnaam", "leverancier", "leveranciernaam", "relatienaam", "afnemer"],
  contactpersoon: ["contact", "contactperson", "contactpersoon"],
  adres: ["address", "straat", "straatnaam"],
  postcode: ["zip", "zipcode", "postalcode"],
  plaats: ["city", "stad", "woonplaats"],
  telefoon: ["phone", "tel", "telefoonnummer"],
  mobieletelefoon: ["mobiel", "mobile", "mobielnummer", "gsm", "mobieletelefoon"],
  email: ["mail", "emailadres", "emailaddress"],
  btwnummer: ["btw", "vat", "vatnumber", "btwnr"],
  iban: ["bankaccount", "bankrekening"],
  kvknummer: ["kvk", "kvknr"],
  bic: ["swift"],
  memo: ["notes", "opmerking", "opmerkingen", "note"],
  krediettermijn: ["betaaltermijnindagen", "betaaltermijn", "betalingstermijn", "termijn"],
  // Correspondentieadres block — source drops the "Adres" infix.
  correspondentieadrescontactperson: ["correspondentiecontactpersoon", "correspondentiecontact", "corcontactpersoon"],
  correspondentieadrespostcode: ["correspondentiepostcode", "corpostcode"],
  correspondentieadresplaats: ["correspondentieplaats", "corplaats"],
  // Snelstart splits invoice e-mail into a main + CC address.
  factuuremailadres: ["factuuremail", "factuurmail"],
  factuurccemailadres: ["factuuremailcc", "factuurmailcc", "factuurccemail"],
};

function normHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_.\-/()]/g, "");
}

/** True when a normalised source header should fill the given template column. */
function headerMatches(templateNorm: string, sourceNorm: string): boolean {
  if (!sourceNorm) return false;
  if (sourceNorm === templateNorm) return true;
  return (EXTRA_ALIASES[templateNorm] ?? []).includes(sourceNorm);
}

/** Flatten a source cell to a primitive suitable for writing straight into the
 *  output (preserves numbers / booleans / dates; flattens rich text + formulas). */
function outValue(value: ExcelJS.CellValue): ExcelJS.CellValue {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if ("result" in value) return outValue((value as { result: ExcelJS.CellValue }).result);
    const s = cellToString(value);
    return s || null;
  }
  const s = String(value).trim();
  return s || null;
}

export interface RelationConvertSummary {
  kind: RelationKind;
  label: string;
  sheetName: string;
  headerRow: number;
  templateColumns: number;
  totalDataRows: number;
  imported: number;
  /** Template columns that resolved to a source column. */
  mappedColumns: string[];
  /** Template columns that got at least one non-empty value. */
  filledColumns: string[];
  /** Template columns with no matching source column (left blank). */
  unmappedColumns: string[];
  /** Source headers that didn't map onto any template column (ignored). */
  unmatchedSourceColumns: string[];
}

export interface RelationConvertResult {
  headers: string[];
  /** One array per data row, aligned to `headers`. */
  rows: ExcelJS.CellValue[][];
  summary: RelationConvertSummary;
}

/** Thrown when the sheet has no recognisable header row → HTTP 400. */
export class RelationConvertFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelationConvertFormatError";
  }
}

/**
 * Reshape an external supplier/customer worksheet into Snelstart's exact
 * relation import template. Detects the header row, maps each template column to
 * a source column by header name, and copies the real data through.
 *
 * @throws RelationConvertFormatError when no header row (with a Naam column) is found.
 */
export function convertRelationSheet(sheet: ExcelJS.Worksheet, kind: RelationKind): RelationConvertResult {
  const headers = [...RELATION_TEMPLATES[kind].headers];
  const templateNorms = headers.map(normHeader);
  const naamIdx = templateNorms.indexOf("naam");

  // ── locate the header row: the row (within the scan window) that resolves the
  //    most template columns; require the Naam column to be among them.
  const lastScan = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
  let bestRow = 0;
  let bestMap: (number | undefined)[] = [];
  let bestScore = -1;
  for (let r = 1; r <= lastScan; r += 1) {
    const map: (number | undefined)[] = new Array(headers.length).fill(undefined);
    const usedCols = new Set<number>();
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const srcNorm = normHeader(cellToString(cell.value));
      if (!srcNorm || usedCols.has(col)) return;
      for (let t = 0; t < templateNorms.length; t += 1) {
        if (map[t] != null) continue;
        if (headerMatches(templateNorms[t], srcNorm)) { map[t] = col; usedCols.add(col); return; }
      }
    });
    const score = map.filter((c) => c != null).length;
    if (map[naamIdx] != null && score > bestScore) { bestScore = score; bestRow = r; bestMap = map; }
  }

  if (bestRow === 0) {
    throw new RelationConvertFormatError(
      `Could not find a ${RELATION_TEMPLATES[kind].label} header row (no "Naam" / name column). ` +
        `The file needs a header row with at least a Naam column.`,
    );
  }

  const map = bestMap;
  const mappedColumns = headers.filter((_, t) => map[t] != null);
  const unmappedColumns = headers.filter((_, t) => map[t] == null);

  // Which source headers went unused (reported so nothing silently disappears).
  const mappedSourceCols = new Set(map.filter((c): c is number => c != null));
  const unmatchedSourceColumns: string[] = [];
  sheet.getRow(bestRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const text = cellToString(cell.value);
    if (text && !mappedSourceCols.has(col)) unmatchedSourceColumns.push(text);
  });

  const filled = new Set<number>();
  const rows: ExcelJS.CellValue[][] = [];
  let totalDataRows = 0;
  for (let r = bestRow + 1; r <= sheet.rowCount; r += 1) {
    const srcRow = sheet.getRow(r);
    const out: ExcelJS.CellValue[] = new Array(headers.length).fill(null);
    let anyValue = false;
    for (let t = 0; t < headers.length; t += 1) {
      const col = map[t];
      if (col == null) continue;
      const v = outValue(srcRow.getCell(col).value);
      out[t] = v;
      if (v != null && v !== "") { anyValue = true; filled.add(t); }
    }
    // Skip rows with no Naam — Snelstart requires it and blank spacer rows are common.
    const naam = cellToString(out[naamIdx] as ExcelJS.CellValue);
    if (!naam) continue;
    if (!anyValue) continue;
    totalDataRows += 1;
    rows.push(out);
  }

  return {
    headers,
    rows,
    summary: {
      kind,
      label: RELATION_TEMPLATES[kind].label,
      sheetName: sheet.name,
      headerRow: bestRow,
      templateColumns: headers.length,
      totalDataRows,
      imported: rows.length,
      mappedColumns,
      filledColumns: headers.filter((_, t) => filled.has(t)),
      unmappedColumns,
      unmatchedSourceColumns,
    },
  };
}

/** Write the conformed rows into a single-sheet xlsx matching the template. */
export async function buildRelationTemplateBuffer(result: RelationConvertResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(result.headers);
  for (const row of result.rows) ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
