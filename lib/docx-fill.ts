import JSZip from "jszip";

/**
 * .docx templating: replace `{{placeholder}}` tokens with a client's data.
 *
 * This is the fill path for templates whose source document has no AcroForm
 * fields (see migration 014). A .docx is a zip of XML parts; the text lives in
 * `<w:t>` elements inside `<w:r>` runs. The one hard problem is that Word splits
 * a typed placeholder across runs at will — spellcheck state, a stray format
 * change, or just editing history turns `{{client_name}}` into
 * `<w:t>{{clie</w:t> … <w:t>nt_name}}</w:t>`. So every operation here works on
 * the run text JOINED per paragraph, and writes back at run level.
 *
 * Formatting is preserved: rather than collapsing a whole paragraph into one
 * run (the usual shortcut, which flattens bold/italic elsewhere in the line),
 * only the runs a placeholder actually overlaps are rewritten. The replacement
 * value lands in the run where the placeholder STARTED, so it inherits exactly
 * the formatting the placeholder was typed in.
 */

/** `{{name}}` / `{{ name }}`. Names are the same identifiers used as PDF field names. */
const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** The XML parts whose text is user-visible. Headers/footers matter — a letterhead
 *  template puts the company name there, not in the body. */
function textParts(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((p) =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(p),
  );
}

type Run = {
  /** Offset of the full `<w:t …>…</w:t>` element in the part XML. */
  tagStart: number;
  tagEnd: number;
  /** The `<w:t …>` opening tag, verbatim. */
  openTag: string;
  text: string;
  /** Index of the paragraph this run belongs to. */
  segment: number;
};

const T_ELEMENT_RE = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/**
 * Collect every `<w:t>` run in a part, tagged with the paragraph it sits in.
 *
 * Paragraphs are delimited by counting `</w:p>` closers rather than matching
 * `<w:p>…</w:p>` pairs: paragraphs nest (a text box inside a run inside a
 * paragraph), and a non-greedy pair match would mis-associate the outer
 * paragraph's later runs. Counting closers can only ever split a paragraph into
 * two groups, which costs nothing here — grouping exists solely so a placeholder
 * is reassembled from adjacent runs, never so runs are merged.
 */
function collectRuns(xml: string): Run[] {
  const closers: number[] = [];
  for (let i = xml.indexOf("</w:p>"); i !== -1; i = xml.indexOf("</w:p>", i + 1)) closers.push(i);

  const runs: Run[] = [];
  let seg = 0;
  T_ELEMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = T_ELEMENT_RE.exec(xml))) {
    while (seg < closers.length && closers[seg] < m.index) seg++;
    runs.push({
      tagStart: m.index,
      tagEnd: m.index + m[0].length,
      openTag: `<w:t${m[1] ?? ""}>`,
      text: m[2],
      segment: seg,
    });
  }
  return runs;
}

function groupBySegment(runs: Run[]): Run[][] {
  const groups = new Map<number, Run[]>();
  for (const r of runs) {
    const g = groups.get(r.segment);
    if (g) g.push(r);
    else groups.set(r.segment, [r]);
  }
  return [...groups.values()];
}

/** `<w:t>` bodies are XML text: they carry entities, not raw markup. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Render a value into `<w:t>` body XML. A newline inside a client field (a
 * multi-line address) becomes a real line break rather than a lost character;
 * that means closing and reopening the run's text element around a `<w:br/>`,
 * which is legal inside the parent `<w:r>`.
 */
function valueToXml(value: string, openTag: string): string {
  const preserving = openTag.includes('xml:space="preserve"')
    ? openTag
    : openTag.replace(/^<w:t/, '<w:t xml:space="preserve"');
  return value
    .split(/\r?\n/)
    .map(encodeXml)
    .join(`</w:t><w:br/>${preserving}`);
}

/** Ensure an edited run keeps its leading/trailing spaces (Word trims otherwise). */
function preserveSpace(openTag: string): string {
  return openTag.includes('xml:space="preserve"')
    ? openTag
    : openTag.replace(/^<w:t/, '<w:t xml:space="preserve"');
}

/** Every `{{placeholder}}` name in a part, in document order (duplicates included). */
function partPlaceholders(xml: string): string[] {
  const names: string[] = [];
  for (const group of groupBySegment(collectRuns(xml))) {
    const joined = decodeXml(group.map((r) => r.text).join(""));
    if (!joined.includes("{{")) continue;
    PLACEHOLDER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_RE.exec(joined))) names.push(m[1]);
  }
  return names;
}

/**
 * Rewrite one part, replacing each placeholder with `resolve(name)`. Returns the
 * new XML (unchanged when the part has no placeholders, so untouched parts are
 * re-zipped byte-identical).
 */
function fillPart(xml: string, resolve: (name: string) => string): string {
  // Every edit is a splice over the ORIGINAL part offsets, so they are collected
  // first and applied last, in descending order.
  const edits: Array<{ start: number; end: number; replacement: string }> = [];

  for (const group of groupBySegment(collectRuns(xml))) {
    const decoded = group.map((r) => decodeXml(r.text));
    const joined = decoded.join("");
    if (!joined.includes("{{")) continue;

    // Joined-offset → run boundaries.
    const starts: number[] = [];
    let acc = 0;
    for (const t of decoded) { starts.push(acc); acc += t.length; }

    PLACEHOLDER_RE.lastIndex = 0;
    const matches: Array<{ s: number; e: number; name: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_RE.exec(joined))) {
      matches.push({ s: m.index, e: m.index + m[0].length, name: m[1] });
    }
    if (matches.length === 0) continue;

    // Working copies, edited right-to-left so earlier offsets stay valid.
    const next = [...decoded];
    for (let k = matches.length - 1; k >= 0; k--) {
      const { s, e, name } = matches[k];
      const value = resolve(name);
      let placed = false;
      for (let i = 0; i < next.length; i++) {
        const runStart = starts[i];
        const runEnd = runStart + decoded[i].length;
        if (runEnd <= s || runStart >= e) continue;      // no overlap
        const ls = Math.max(s, runStart) - runStart;
        const le = Math.min(e, runEnd) - runStart;
        // The first overlapping run receives the value (and therefore the
        // placeholder's own formatting); the rest just lose their fragment.
        next[i] = next[i].slice(0, ls) + (placed ? "" : value) + next[i].slice(le);
        placed = true;
      }
    }

    group.forEach((run, i) => {
      if (next[i] === decoded[i]) return;
      const open = preserveSpace(run.openTag);
      edits.push({
        start: run.tagStart,
        end: run.tagEnd,
        replacement: `${open}${valueToXml(next[i], open)}</w:t>`,
      });
    });
  }

  if (edits.length === 0) return xml;
  edits.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const ed of edits) out = out.slice(0, ed.start) + ed.replacement + out.slice(ed.end);
  return out;
}

async function loadDocx(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer);
}

/**
 * Enumerate the distinct `{{placeholder}}` names in a .docx, in document order.
 * This is the docx counterpart of `discoverTemplateFields` — the names it
 * returns feed the same `guessFieldMapping` / review UI / `sanitizeFieldMapping`
 * pipeline, so a docx template stores exactly the same `field_mapping` shape as
 * a PDF one. An empty result means the document has no placeholders and can only
 * be a `static` template.
 */
export async function discoverDocxPlaceholders(buffer: Buffer): Promise<string[]> {
  const zip = await loadDocx(buffer);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of textParts(zip)) {
    const xml = await zip.file(part)!.async("string");
    for (const name of partPlaceholders(xml)) {
      if (!seen.has(name)) { seen.add(name); names.push(name); }
    }
  }
  return names;
}

/**
 * Fill a .docx template with a client's data and return the new .docx.
 *
 * `fieldMapping` is `{placeholderName: clientColumn}` — the same generic shape
 * `fillTemplate` uses for PDF form fields. A placeholder that is unmapped, or
 * whose column is null on this client, is replaced with an EMPTY string rather
 * than left as `{{…}}`: an unfilled blank is the same outcome the PDF path
 * produces for an unmapped field, and shipping a client a document with visible
 * template syntax in it is not.
 */
export async function fillDocxTemplate(
  buffer: Buffer,
  fieldMapping: Record<string, string>,
  clientData: Record<string, unknown>,
): Promise<Buffer> {
  const zip = await loadDocx(buffer);

  const resolve = (name: string): string => {
    const column = fieldMapping[name];
    if (!column) return "";
    const value = clientData[column];
    return value === null || value === undefined ? "" : String(value);
  };

  for (const part of textParts(zip)) {
    const xml = await zip.file(part)!.async("string");
    const filled = fillPart(xml, resolve);
    if (filled !== xml) zip.file(part, filled);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
