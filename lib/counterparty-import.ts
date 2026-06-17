// Generic Excel (.xlsx) parser for counterparty imports (suppliers / customers).
//
// Extracted so the customers import can reuse it without duplicating the
// workbook-parsing logic. The existing suppliers import (app/api/clients/[id]/
// suppliers/bulk/route.ts) intentionally keeps its own inline copy for now —
// migrating it onto this lib is a tracked follow-up, not this change.
//
// The parser is counterparty-agnostic: callers pass the field→header aliases.

import ExcelJS from "exceljs";

export const MAX_IMPORT_ROWS = 1000;

export type CounterpartyField =
  | "name"
  | "relatie_code"
  | "address"
  | "postcode"
  | "city"
  | "kvk"
  | "btw_number"
  | "iban"
  | "email"
  | "phone"
  | "payment_days";

export type ColumnAliases = Record<CounterpartyField, readonly string[]>;

/**
 * Header aliases shared by both supplier and customer sheets, plus
 * customer-flavoured spellings (klant / customer / afnemer / klantnummer …).
 * Match is normalised (lowercased, punctuation/whitespace stripped) so
 * "Relatie Code", "RelatieCode", "Klant nr" all hit the right field.
 */
export const CUSTOMER_COLUMN_ALIASES: ColumnAliases = {
  name:         ["name", "naam", "bedrijf", "company", "customer", "klant", "klantnaam", "afnemer", "customername"],
  relatie_code: ["relatiecode", "relatie", "code", "snelstartcode", "klantcode", "klantnummer", "klantnr", "customercode", "customernumber"],
  address:      ["address", "adres", "straat"],
  postcode:     ["postcode", "zip", "zipcode", "postalcode"],
  city:         ["city", "plaats", "stad"],
  kvk:          ["kvk", "kvknumber", "kvknr"],
  btw_number:   ["btw", "btwnumber", "btwnr", "vatnumber", "vat"],
  iban:         ["iban", "bankaccount", "bank"],
  email:        ["email", "emailaddress", "mail"],
  phone:        ["phone", "telefoon", "tel", "mobile"],
  payment_days: ["paymentdays", "betalingstermijn", "termijn", "days"],
};

export interface ParsedRow {
  rowNum: number;
  name: string | null;
  relatie_code: string | null;
  address?: string | null;
  postcode?: string | null;
  city?: string | null;
  kvk?: string | null;
  btw_number?: string | null;
  iban?: string | null;
  email?: string | null;
  phone?: string | null;
  payment_days?: number | null;
}

export interface RowError {
  row: number;
  reason: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: RowError[];
  headerMap: Partial<Record<CounterpartyField, number>>;
}

function normaliseHeader(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[\s_.\-/]/g, "");
}

export function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  // Rich text / formula / hyperlink shapes
  if (typeof value === "object") {
    if ("text" in value && typeof (value as { text: unknown }).text === "string") return ((value as { text: string }).text).trim();
    if ("result" in value) return cellToString((value as { result: ExcelJS.CellValue }).result);
    if ("richText" in value && Array.isArray((value as { richText: { text: string }[] }).richText)) {
      return (value as { richText: { text: string }[] }).richText.map((r) => r.text).join("").trim();
    }
  }
  return String(value).trim();
}

export function parseCounterpartyWorkbook(workbook: ExcelJS.Workbook, aliases: ColumnAliases): ParseResult {
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], errors: [{ row: 0, reason: "Workbook has no sheets" }], headerMap: {} };

  // Build header → column-index map from row 1
  const headerMap: Partial<Record<CounterpartyField, number>> = {};
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const norm = normaliseHeader(cellToString(cell.value));
    if (!norm) return;
    for (const [field, fieldAliases] of Object.entries(aliases) as [CounterpartyField, readonly string[]][]) {
      if (headerMap[field] != null) continue;
      if (fieldAliases.includes(norm)) {
        headerMap[field] = colNumber;
        return;
      }
    }
  });

  const errors: RowError[] = [];
  if (headerMap.name == null) {
    errors.push({ row: 1, reason: "No 'Name' / 'Naam' column found in the first row" });
    return { rows: [], errors, headerMap };
  }

  const rows: ParsedRow[] = [];
  const lastRow = Math.min(sheet.rowCount, MAX_IMPORT_ROWS + 1); // +1 for header
  for (let r = 2; r <= lastRow; r += 1) {
    const xr = sheet.getRow(r);
    const name = cellToString(xr.getCell(headerMap.name!).value);
    if (!name) continue; // skip blank rows entirely

    const parsed: ParsedRow = { rowNum: r, name, relatie_code: null };
    for (const [field, col] of Object.entries(headerMap) as [CounterpartyField, number][]) {
      if (field === "name" || col == null) continue;
      const v = cellToString(xr.getCell(col).value);
      if (field === "payment_days") {
        const n = Number(v);
        parsed.payment_days = Number.isFinite(n) ? Math.max(0, Math.min(365, Math.round(n))) : null;
      } else {
        (parsed as unknown as Record<string, unknown>)[field] = v || null;
      }
    }
    rows.push(parsed);
  }

  if (sheet.rowCount > MAX_IMPORT_ROWS + 1) {
    errors.push({ row: MAX_IMPORT_ROWS + 2, reason: `File has more than ${MAX_IMPORT_ROWS} rows; only the first ${MAX_IMPORT_ROWS} were imported.` });
  }
  return { rows, errors, headerMap };
}
