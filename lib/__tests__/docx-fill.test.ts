/**
 * @vitest-environment node
 *
 * Node, not the repo-default jsdom: pdf-lib type-checks its input against the
 * Uint8Array of its own realm, and a Node Buffer handed in from under jsdom
 * fails that check. Nothing here touches the DOM.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { discoverDocxPlaceholders, fillDocxTemplate } from "@/lib/docx-fill";
import { detectTemplateFormat, inspectTemplate, templateExtension } from "@/lib/template-fill";

/**
 * Build a .docx around raw `word/document.xml` body XML. The runs are written
 * out by hand precisely so a placeholder can be SPLIT across them — that is what
 * Word actually produces, and it is the case a naive string replace fails on.
 */
async function makeDocx(
  bodyXml: string,
  extraParts: Record<string, string> = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  );
  for (const [name, xml] of Object.entries(extraParts)) zip.file(name, xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Runs, in order, from a filled document — `<w:t>` bodies only. */
async function runTexts(buffer: Buffer, part = "word/document.xml"): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file(part)!.async("string");
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
}

async function partXml(buffer: Buffer, part = "word/document.xml"): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file(part)!.async("string");
}

const p = (...runs: string[]) => `<w:p>${runs.map((r) => `<w:r>${r}</w:r>`).join("")}</w:p>`;
const t = (text: string) => `<w:t>${text}</w:t>`;

describe("discoverDocxPlaceholders", () => {
  it("finds a placeholder Word has split across three runs", async () => {
    // The exact shape Word emits after an edit: `{{client_name}}` shattered by
    // rsid boundaries. A per-run regex sees none of these fragments.
    const docx = await makeDocx(p(t("Opdrachtgever: {{cli"), t("ent_"), t("name}} te Rotterdam")));
    expect(await discoverDocxPlaceholders(docx)).toEqual(["client_name"]);
  });

  it("reads placeholders out of headers and footers, not just the body", async () => {
    const docx = await makeDocx(p(t("{{name}}")), {
      "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p(t("{{kvk_number}}"))}</w:hdr>`,
      "word/footer1.xml": `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p(t("{{email}}"))}</w:ftr>`,
    });
    expect((await discoverDocxPlaceholders(docx)).sort()).toEqual(["email", "kvk_number", "name"]);
  });

  it("dedupes repeated placeholders and tolerates inner spacing", async () => {
    const docx = await makeDocx(p(t("{{name}}")) + p(t("{{ name }}")) + p(t("{{iban}}")));
    expect(await discoverDocxPlaceholders(docx)).toEqual(["name", "iban"]);
  });

  it("returns nothing for a document with no placeholders", async () => {
    const docx = await makeDocx(p(t("A plain contract with ______ blanks.")));
    expect(await discoverDocxPlaceholders(docx)).toEqual([]);
  });
});

describe("fillDocxTemplate", () => {
  it("fills a split placeholder and leaves the surrounding text intact", async () => {
    const docx = await makeDocx(p(t("Opdrachtgever: {{cli"), t("ent_"), t("name}} te Rotterdam")));
    const out = await fillDocxTemplate(docx, { client_name: "name" }, { name: "Oranje B.V." });
    expect((await runTexts(out)).join("")).toBe("Opdrachtgever: Oranje B.V. te Rotterdam");
  });

  it("puts the value in the run the placeholder STARTED in, so its formatting is kept", async () => {
    // The bold run is where `{{` begins; the value must land there rather than
    // in a merged, formatting-flattened paragraph.
    const body = `<w:p><w:r><w:rPr><w:b/></w:rPr>${t("{{name")}</w:r><w:r>${t("}} plain tail")}</w:r></w:p>`;
    const docx = await makeDocx(body);
    const out = await fillDocxTemplate(docx, { name: "name" }, { name: "Oranje B.V." });
    const xml = await partXml(out);
    // Still two runs, the first still bold, and the value sits inside it.
    expect(xml.match(/<w:r>/g)?.length).toBe(2);
    expect(/<w:b\/><\/w:rPr><w:t[^>]*>Oranje B\.V\.<\/w:t>/.test(xml)).toBe(true);
    expect((await runTexts(out)).join("")).toBe("Oranje B.V. plain tail");
  });

  it("does not touch runs in other paragraphs", async () => {
    const docx = await makeDocx(p(t("Artikel 1")) + p(t("{{name}}")) + p(t("Artikel 2")));
    const out = await fillDocxTemplate(docx, { name: "name" }, { name: "Oranje B.V." });
    expect(await runTexts(out)).toEqual(["Artikel 1", "Oranje B.V.", "Artikel 2"]);
  });

  it("blanks an unmapped placeholder rather than shipping {{…}} to the client", async () => {
    const docx = await makeDocx(p(t("Nummer: {{some_unmapped}}.")));
    const out = await fillDocxTemplate(docx, {}, { name: "Oranje B.V." });
    const text = (await runTexts(out)).join("");
    expect(text).toBe("Nummer: .");
    expect(text).not.toContain("{{");
  });

  it("blanks a mapped placeholder whose client column is null", async () => {
    const docx = await makeDocx(p(t("IBAN: {{iban}}.")));
    const out = await fillDocxTemplate(docx, { iban: "iban" }, { iban: null });
    expect((await runTexts(out)).join("")).toBe("IBAN: .");
  });

  it("XML-escapes the value so an & or < in client data can't corrupt the document", async () => {
    const docx = await makeDocx(p(t("{{name}}")));
    const out = await fillDocxTemplate(docx, { name: "name" }, { name: "Jansen & Zn <BV>" });
    const xml = await partXml(out);
    expect(xml).toContain("Jansen &amp; Zn &lt;BV&gt;");
    // Still parseable as the same shape — the raw characters never got in.
    expect(xml).not.toContain("Zn <BV>");
    expect(await JSZip.loadAsync(out)).toBeTruthy();
  });

  it("fills more than one placeholder in the same paragraph", async () => {
    const docx = await makeDocx(p(t("{{name}} — {{city}} — {{name}}")));
    const out = await fillDocxTemplate(
      docx,
      { name: "name", city: "city" },
      { name: "Oranje B.V.", city: "Rotterdam" },
    );
    expect((await runTexts(out)).join("")).toBe("Oranje B.V. — Rotterdam — Oranje B.V.");
  });

  it("keeps leading/trailing spaces by marking edited runs xml:space=preserve", async () => {
    const docx = await makeDocx(p(t("{{name}} ")));
    const out = await fillDocxTemplate(docx, { name: "name" }, { name: "Oranje B.V." });
    expect(await partXml(out)).toContain('xml:space="preserve"');
  });

  it("turns a newline in a client field into a real line break", async () => {
    const docx = await makeDocx(p(t("{{address}}")));
    const out = await fillDocxTemplate(docx, { address: "address" }, { address: "Straat 1\n3011 AA" });
    const xml = await partXml(out);
    expect(xml).toContain("<w:br/>");
    expect(await runTexts(out)).toEqual(["Straat 1", "3011 AA"]);
  });

  it("fills headers and footers too", async () => {
    const docx = await makeDocx(p(t("body")), {
      "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p(t("{{name}}"))}</w:hdr>`,
    });
    const out = await fillDocxTemplate(docx, { name: "name" }, { name: "Oranje B.V." });
    expect(await runTexts(out, "word/header1.xml")).toEqual(["Oranje B.V."]);
  });

  it("returns a document with no placeholders untouched", async () => {
    const docx = await makeDocx(p(t("Niets in te vullen.")));
    const out = await fillDocxTemplate(docx, { name: "name" }, { name: "Oranje B.V." });
    expect(await runTexts(out)).toEqual(["Niets in te vullen."]);
  });
});

describe("detectTemplateFormat", () => {
  it("identifies a PDF by its signature", async () => {
    const pdf = Buffer.from(await (await PDFDocument.create()).save());
    expect(await detectTemplateFormat(pdf)).toBe("pdf");
  });

  it("tells docx and xlsx apart by the part that defines them", async () => {
    expect(await detectTemplateFormat(await makeDocx(p(t("x"))))).toBe("docx");

    const xlsx = new JSZip();
    xlsx.file("xl/workbook.xml", "<workbook/>");
    xlsx.file("[Content_Types].xml", "<Types/>");
    expect(
      await detectTemplateFormat(await xlsx.generateAsync({ type: "nodebuffer" })),
    ).toBe("xlsx");
  });

  it("rejects a zip that is neither, and arbitrary bytes", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    expect(await detectTemplateFormat(await zip.generateAsync({ type: "nodebuffer" }))).toBeNull();
    expect(await detectTemplateFormat(Buffer.from("not a document at all"))).toBeNull();
  });
});

describe("inspectTemplate", () => {
  it("files a text-based PDF with NO form fields as `static` instead of failing", async () => {
    // This is the Managementovereenkomst case: real selectable text, printed
    // underscores instead of form fields. pdf-lib fabricates an empty AcroForm
    // for it, so field discovery legitimately returns [] — that is a
    // download-blank template, not a broken upload.
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]).drawText("gevestigd te ____________________", { x: 40, y: 700, size: 10 });
    const pdf = Buffer.from(await doc.save());

    expect(await detectTemplateFormat(pdf)).toBe("pdf");
    expect(await inspectTemplate(pdf, "pdf")).toEqual({ kind: "static", fields: [] });
  });

  it("files a PDF with form fields as `pdf_form`", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    doc.getForm().createTextField("company_naam").addToPage(page, { x: 40, y: 700, width: 200, height: 20 });
    const pdf = Buffer.from(await doc.save());

    expect(await inspectTemplate(pdf, "pdf")).toEqual({ kind: "pdf_form", fields: ["company_naam"] });
  });

  it("files a docx with placeholders as `docx_placeholder` and one without as `static`", async () => {
    expect(await inspectTemplate(await makeDocx(p(t("{{name}}"))), "docx")).toEqual({
      kind: "docx_placeholder",
      fields: ["name"],
    });
    expect(await inspectTemplate(await makeDocx(p(t("no tokens"))), "docx")).toEqual({
      kind: "static",
      fields: [],
    });
  });

  it("always files an xlsx as `static` — a spreadsheet is never client-filled", async () => {
    expect(await inspectTemplate(Buffer.from(""), "xlsx")).toEqual({ kind: "static", fields: [] });
  });
});

describe("templateExtension", () => {
  it("reads the extension off the stored key instead of assuming .pdf", () => {
    expect(templateExtension("templates/abc.docx")).toBe("docx");
    expect(templateExtension("templates/abc.xlsx")).toBe("xlsx");
    expect(templateExtension("templates/abc.PDF")).toBe("pdf");
    expect(templateExtension(null)).toBe("pdf");
  });
});
