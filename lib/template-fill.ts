import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import { discoverDocxPlaceholders } from "@/lib/docx-fill";

/** Max size for an uploaded template file (mirrors the raw-convert upload cap). */
export const TEMPLATE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * How a template is filled. Stored on `document_templates.kind` (migration 014).
 *
 *  • `pdf_form`         — AcroForm PDF; `field_mapping` keys are PDF field names.
 *  • `docx_placeholder` — .docx with `{{token}}` text; keys are placeholder names.
 *  • `static`           — no fill path at all; the document is only ever
 *                         downloaded blank. This is what a text-based PDF with no
 *                         form fields becomes (see `detectTemplateFormat`), and
 *                         it is a legitimate template, not a failed upload.
 */
export const TEMPLATE_KINDS = ["pdf_form", "docx_placeholder", "static"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export function isTemplateKind(value: unknown): value is TemplateKind {
  return typeof value === "string" && (TEMPLATE_KINDS as readonly string[]).includes(value);
}

/** Upload formats we accept. Only `pdf` and `docx` can be filled; `xlsx` is
 *  always `static`. */
export type TemplateFormat = "pdf" | "docx" | "xlsx";

export const TEMPLATE_FORMAT_MIME: Record<TemplateFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** `accept` attribute for the upload input, kept next to the formats it mirrors. */
export const TEMPLATE_ACCEPT = ".pdf,.docx,.xlsx," + Object.values(TEMPLATE_FORMAT_MIME).join(",");

/**
 * Identify an uploaded template from its BYTES, never from its filename or the
 * browser-supplied content type — both are trivially wrong or spoofed.
 *
 * PDF is the `%PDF-` signature (searched in the first KB, since a small amount
 * of leading junk before the header is legal and real files have it). .docx and
 * .xlsx are both zips, so they are told apart by the part that defines them.
 * Anything else returns null and is rejected at the route.
 */
export async function detectTemplateFormat(buffer: Buffer): Promise<TemplateFormat | null> {
  if (buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) return "pdf";
  // Local file header of a non-empty zip. OOXML always has entries.
  if (buffer.subarray(0, 4).toString("latin1") !== "PK\u0003\u0004") return null;

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return null;
  }
  if (zip.file("word/document.xml")) return "docx";
  if (zip.file("xl/workbook.xml")) return "xlsx";
  return null;
}

/**
 * Decide a template's fill mode and enumerate whatever it can fill.
 *
 * The rule that replaces the old "no form fields ⇒ reject": a document is
 * `static` whenever it has nothing to fill. That covers a flat PDF, a .docx with
 * no placeholders and every .xlsx — all perfectly good templates to download
 * blank. Only a genuinely unreadable or unsupported file is an error, and that
 * is signalled by throwing.
 */
export async function inspectTemplate(
  buffer: Buffer,
  format: TemplateFormat,
): Promise<{ kind: TemplateKind; fields: string[] }> {
  if (format === "xlsx") return { kind: "static", fields: [] };

  if (format === "docx") {
    const fields = await discoverDocxPlaceholders(buffer);
    return fields.length > 0
      ? { kind: "docx_placeholder", fields }
      : { kind: "static", fields: [] };
  }

  const fields = await discoverTemplateFields(buffer);
  return fields.length > 0 ? { kind: "pdf_form", fields } : { kind: "static", fields: [] };
}

/** File extension of a stored template, from its S3 key. Templates are no longer
 *  all PDFs, so the download/fill routes must not assume one. */
export function templateExtension(s3Key: string | null | undefined): string {
  return (s3Key?.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] || "pdf").toLowerCase();
}

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
 * Enumerate the AcroForm field names in an uploaded template PDF. Throws only if
 * the PDF can't be parsed (caller returns a 400). An empty array is NOT an
 * error: pdf-lib fabricates an empty AcroForm for a flat PDF, so `[]` simply
 * means "no fillable fields" and `inspectTemplate` files it as `static`.
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
 * Extra rule for AUTHORED names — the `{{placeholder}}` tokens someone typed
 * into a .docx themselves, as opposed to a field name a government form
 * generator chose. The no-IBAN rule above exists because `_IBAN` on a
 * Belastingdienst form regularly means somebody else's account; a placeholder a
 * human wrote as `{{iban}}` in their own contract means the client's IBAN and
 * nothing else, so it is safe to auto-map there and only there.
 */
const AUTHORED_GUESS_RULES: Array<[RegExp, FillableClientColumn]> = [
  [/iban|rekeningnummer/i, "iban"],
];

/**
 * Best-effort automatic mapping: field name → clients column, by keyword.
 * Fields with no confident match are simply left out of the mapping (they render
 * blank on fill) — this is the fully-automatic path, so there's no manual step.
 *
 * `authoredNames` opts in to the rules that are only safe when the names were
 * written by us rather than by a form generator (see AUTHORED_GUESS_RULES).
 */
export function guessFieldMapping(
  fieldNames: string[],
  opts?: { authoredNames?: boolean },
): Record<string, FillableClientColumn> {
  const rules = opts?.authoredNames
    ? [...AUTHORED_GUESS_RULES, ...FIELD_GUESS_RULES]
    : FIELD_GUESS_RULES;
  const mapping: Record<string, FillableClientColumn> = {};
  for (const field of fieldNames) {
    for (const [re, col] of rules) {
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
