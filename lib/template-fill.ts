import { PDFDocument } from "pdf-lib";

/** Max size for an uploaded template PDF (mirrors the raw-convert upload cap). */
export const TEMPLATE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Client columns an uploaded template can be auto-mapped to. Each MUST be a real
 * column on the `clients` table (see migrations 001 + 003 + 010) — the fill route
 * selects `*` from `clients` and `fillTemplate` reads these keys off the row.
 */
export const FILLABLE_CLIENT_COLUMNS = [
  "name", "iban", "address", "postcode", "city",
  "phone_number", "email", "btw_number", "kvk_number", "rsin",
] as const;

export type FillableClientColumn = (typeof FILLABLE_CLIENT_COLUMNS)[number];

// Human labels for the columns, shown in the upload review UI.
export const CLIENT_COLUMN_LABELS: Record<FillableClientColumn, string> = {
  name: "Company name",
  iban: "IBAN",
  address: "Address",
  postcode: "Postcode",
  city: "City",
  phone_number: "Phone",
  email: "Email",
  btw_number: "BTW number",
  kvk_number: "KVK number",
  rsin: "RSIN / fiscaal nummer",
};

// Keyword → column, first match wins. Matches on the PDF FIELD NAME (not the
// visible label), so it leans on the Belastingdienst `_TOKEN` suffixes.
const FIELD_GUESS_RULES: Array<[RegExp, FillableClientColumn]> = [
  // NOTE: there is deliberately NO iban rule. On these forms an `_IBAN`-named box
  // is often NOT the client's own IBAN — form 2's `2.1_IBAN.*` is a g-rekening
  // (blocked account) and form 3's `1e.1_IBAN.*` is an old bank account.
  // Auto-guessing "iban" filled a government form with the wrong account once
  // already, so IBAN-token fields default to UNMAPPED and the human picks the
  // target in the review step. (The Opgaaf template's real IBAN box is filled via
  // its explicit seeded field_mapping, not this auto-guess, so it is unaffected.)
  [/kvk|kamer van koophandel/i, "kvk_number"],
  // RSIN / fiscaal nummer. `_RFN` (another company's RSIN) and `_BSN` (a person's
  // number) deliberately do NOT match, so they never fill from the client's RSIN.
  [/_rsin|_rfb/i, "rsin"],
  [/btw|omzetbelasting|vat/i, "btw_number"],
  [/_em\b|e-?mail/i, "email"],          // `_EM` is the Belastingdienst e-mail token
  [/tel|phone|telefoon/i, "phone_number"],
  [/_pc\b|postcode/i, "postcode"],      // `_PC` is the postcode token
  [/plaats|woonplaats|city|stad/i, "city"],
  [/straat|adres|address|huisnummer/i, "address"],
  [/naam|name|bedrijf|onderneming|company/i, "name"],
];

/**
 * Enumerate the AcroForm field names in an uploaded template PDF. Throws if the
 * PDF can't be parsed or has no fillable form fields (caller returns a 400).
 */
export async function discoverTemplateFields(pdfBuffer: Buffer): Promise<string[]> {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const form = pdfDoc.getForm();
  return form.getFields().map((f) => f.getName());
}

/**
 * Sanitize a (possibly user-edited or tampered) field mapping before it is
 * stored. Keeps an entry ONLY when the PDF field really exists in the uploaded
 * PDF (`availableFields`) AND the target is a real clients column from
 * FILLABLE_CLIENT_COLUMNS. Anything else — unknown field, unknown/renamed
 * column, non-string value — is silently dropped so a bad mapping can never be
 * persisted. This runs regardless of who produced the mapping (auto-guess or a
 * human editing the dropdowns), so it's the single server-side safety gate.
 */
export function sanitizeFieldMapping(
  posted: Record<string, unknown>,
  availableFields: Iterable<string>,
): Record<string, FillableClientColumn> {
  const fieldSet = availableFields instanceof Set ? availableFields : new Set(availableFields);
  const allowed = new Set<string>(FILLABLE_CLIENT_COLUMNS);
  const mapping: Record<string, FillableClientColumn> = {};
  for (const [field, col] of Object.entries(posted)) {
    if (fieldSet.has(field) && typeof col === "string" && allowed.has(col)) {
      mapping[field] = col as FillableClientColumn;
    }
  }
  return mapping;
}

/**
 * Best-effort automatic mapping: PDF field name → clients column, by keyword.
 * Fields with no confident match are simply left out of the mapping (they render
 * blank on fill) — this is the fully-automatic path, so there's no manual step.
 */
export function guessFieldMapping(fieldNames: string[]): Record<string, FillableClientColumn> {
  const mapping: Record<string, FillableClientColumn> = {};
  for (const field of fieldNames) {
    for (const [re, col] of FIELD_GUESS_RULES) {
      if (re.test(field)) { mapping[field] = col; break; }
    }
  }
  return mapping;
}

/**
 * Fill a fillable AcroForm PDF template with a client's data.
 *
 * Generic by design: `fieldMapping` maps each PDF form-field name to a column
 * name on the source data object (e.g. a `clients` row) —
 * `{ "1.0_IBAN.0": "iban", "4.0": "name" }`. No per-template logic lives here,
 * so a new template is just a new mapping + a new PDF.
 *
 * Each field is filled defensively: if the form doesn't have that field, or the
 * mapped value is null/undefined, or the widget is a non-text field, we log a
 * warning and continue rather than throwing — one bad mapping entry must never
 * abort the whole fill. After all fields are set the form is flattened so the
 * result is a static, non-editable PDF.
 */
export async function fillTemplate(
  templatePdfBuffer: Buffer,
  fieldMapping: Record<string, string>,
  clientData: Record<string, unknown>,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(templatePdfBuffer);
  const form = pdfDoc.getForm();

  for (const [pdfField, clientColumn] of Object.entries(fieldMapping)) {
    const value = clientData[clientColumn];
    if (value === null || value === undefined) continue;

    try {
      // getTextField throws if the field is absent or is a different widget
      // type (checkbox/radio/etc.) — caught below and skipped.
      const field = form.getTextField(pdfField);
      field.setText(String(value));
    } catch (err) {
      console.warn(
        `[template-fill] Skipped field "${pdfField}" (column "${clientColumn}"): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  form.flatten();
  return Buffer.from(await pdfDoc.save());
}
