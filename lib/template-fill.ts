import { PDFDocument } from "pdf-lib";

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
