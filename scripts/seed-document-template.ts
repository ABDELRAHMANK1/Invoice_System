/**
 * Seed the Belastingdienst "Opgaaf Rekeningnummer Ondernemers" IBAN-change form
 * into document_templates: upload the blank fillable PDF to S3 under a
 * `templates/` prefix and insert the row with its confirmed field_mapping.
 *
 * Run with real Supabase + S3 env loaded:
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/seed-document-template.ts
 *
 * Idempotent-ish: if a template with the same name already exists it is updated
 * in place (s3_key + field_mapping) rather than duplicated.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { uploadBuffer } from "@/lib/storage";

const TEMPLATE_NAME = "Opgaaf Rekeningnummer Ondernemers";
const TEMPLATE_DESCRIPTION =
  "Belastingdienst — doorgeven of wijzigen van een rekeningnummer (IBAN) voor ondernemers.";
const SOURCE_PDF = path.join(
  process.cwd(),
  "templates/source/wijziging_rekeningnummer_voor_ondernemers_ca411z11fol (4).pdf",
);

// Confirmed mapping: PDF AcroForm field name → clients column. Only fields with
// a real matching clients column are mapped (see the field inspection). IBAN
// has two overlapping widgets for one value, so both point at `iban`.
//
// Deliberately NOT mapped:
//  • 2.1_BRF (Bsn/RSIN), 3._LH.* (loonheffingennummer) — no such clients column.
//  • 3.0–3.3 (checkboxes) — per-submission choice, not client master data.
//  • 4.2_PC (postcode), 4.4 (contactpersoon), 4.5 (functie) — no such column.
//  • 5.x (dates) — filled by hand at signing time.
//  • 3._OB.1 (omzetbelastingnummer) — the box is maxLength=9 and stored
//    btw_number values are the full "NL…B0n" (14 chars). A generic value→field
//    map can't split into the 9-digit main + 2-digit suffix the form wants, so
//    it's left unmapped rather than silently skipped on every client.
// Note: 4.6_TEL is maxLength=10; formatted phones (e.g. "+31 6 …") exceed it and
// are gracefully skipped by fillTemplate — a compact ≤10-char phone fills fine.
const FIELD_MAPPING: Record<string, string> = {
  // 1a Uw IBAN. There are TWO overlapping fields here: 1.0_IBAN.0 (plain,
  // left-aligned) and 1.0_IBAN.1 (comb, one char per printed box). Filling both
  // overlays crammed text on top of the boxed text and renders garbled, so we
  // map ONLY the comb field — it drops each character into its own printed vakje.
  "1.0_IBAN.1": "iban",        // 1a Uw IBAN (comb field — aligns to the boxes)
  "1.1": "name",               // 1b Op naam van
  "2.0": "name",               // 2a Naam bedrijf
  "4.0": "name",               // 4 Naam bedrijf
  "4.1": "address",            // 4 Straat en huisnummer
  "4.3": "city",               // 4 Plaats
  "4.6_TEL": "phone_number",   // 4 Telefoon (maxLength=10 — see note above)
};

async function main() {
  const pdf = readFileSync(SOURCE_PDF);
  const s3Key = "templates/opgaaf_rekeningnummer_ondernemers.pdf";

  await uploadBuffer({ key: s3Key, body: pdf, contentType: "application/pdf" });
  console.log(`Uploaded template PDF → s3 key: ${s3Key}`);

  const { data: existing } = await supabaseAdmin
    .from("document_templates")
    .select("id")
    .eq("name", TEMPLATE_NAME)
    .maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin
      .from("document_templates")
      .update({ description: TEMPLATE_DESCRIPTION, s3_key: s3Key, field_mapping: FIELD_MAPPING })
      .eq("id", existing.id);
    if (error) throw error;
    console.log(`Updated existing template row: ${existing.id}`);
  } else {
    const { data, error } = await supabaseAdmin
      .from("document_templates")
      .insert({ name: TEMPLATE_NAME, description: TEMPLATE_DESCRIPTION, s3_key: s3Key, field_mapping: FIELD_MAPPING })
      .select("id")
      .single();
    if (error) throw error;
    console.log(`Inserted template row: ${data.id}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
