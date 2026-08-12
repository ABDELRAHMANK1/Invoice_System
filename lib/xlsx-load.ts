// Tolerant .xlsx loader.
//
// Some exporters (.NET / Snelstart-style "Relaties" exports) produce a valid ZIP
// that ExcelJS still can't read, for two reasons:
//   1. The spreadsheetml namespace is declared with an element PREFIX — every
//      tag is written `<x:workbook>`, `<x:sheet>`, `<x:is><x:t>` etc. ExcelJS's
//      parsers only match UNPREFIXED element names, so the file parses to zero
//      worksheets and throws "Cannot read properties of undefined (reading
//      'sheets')".
//   2. Rows and cells omit the `r` (reference) attribute — `<row>` / `<c>`
//      instead of `<row r="1">` / `<c r="A1">`. ExcelJS's document reader
//      derives the row/column position from `r` and throws "Invalid row number
//      in model" when it's missing.
// Both surface to the user as "Could not read the file as a valid .xlsx workbook".
//
// `loadXlsxLenient` tries ExcelJS as-is first; only if that fails (or yields no
// sheets) does it rewrite the package — stripping the main-namespace prefix and
// synthesising the missing row/cell refs — and retry once. Other prefixes
// (r:, mc:, x14ac:, …) are left untouched. JSZip is already a dependency.

import ExcelJS from "exceljs";
import JSZip from "jszip";

const SML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip the prefix bound to the spreadsheetml main namespace from element tags,
 *  turning it into the default namespace. Leaves all other prefixes intact. */
function stripMainNsPrefix(xml: string): string {
  const decl = xml.match(new RegExp(`xmlns:([A-Za-z0-9_]+)="${escapeRe(SML_NS)}"`));
  if (!decl) return xml;
  const p = decl[1];
  // `<p:tag` / `</p:tag` → `<tag` / `</tag`
  let out = xml.replace(new RegExp(`(</?)${escapeRe(p)}:`, "g"), "$1");
  // `xmlns:p="…main"` → `xmlns="…main"`
  out = out.replace(new RegExp(`xmlns:${escapeRe(p)}=`, "g"), "xmlns=");
  return out;
}

/** 1-based column index → column letters (1→A, 27→AA). */
function colLetter(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Column letters → 1-based index (A→1, AA→27). */
function lettersToNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Synthesise missing `r` attributes on `<row>` / `<c>` in a worksheet's
 * (default-namespaced) XML. Rows without `r` are numbered sequentially; cells
 * without `r` get `<colLetter><rowNum>`. Existing `r` values are respected and
 * resync the counters. Only touches tags inside <sheetData>. `<col>` / `<cols>`
 * are not affected (the `\b` after `c` excludes them).
 */
function injectCellRefs(xml: string): string {
  const start = xml.indexOf("<sheetData");
  if (start === -1) return xml;
  const endTag = "</sheetData>";
  const end = xml.indexOf(endTag, start);
  if (end === -1) return xml;

  const before = xml.slice(0, start);
  const after = xml.slice(end);
  const body = xml.slice(start, end);

  let rowNum = 0;
  let colNum = 0;
  const fixed = body.replace(/<(row|c)\b([^>]*?)(\/?)>/g, (_m, tag: string, attrs: string, selfClose: string) => {
    if (tag === "row") {
      const rm = attrs.match(/\br="(\d+)"/);
      if (rm) rowNum = parseInt(rm[1], 10);
      else { rowNum += 1; attrs = ` r="${rowNum}"${attrs}`; }
      colNum = 0;
      return `<row${attrs}${selfClose}>`;
    }
    // cell
    const cm = attrs.match(/\br="([A-Z]+)\d+"/);
    if (cm) colNum = lettersToNum(cm[1]);
    else { colNum += 1; attrs = ` r="${colLetter(colNum)}${rowNum}"${attrs}`; }
    return `<c${attrs}${selfClose}>`;
  });

  return before + fixed + after;
}

export async function loadXlsxLenient(buffer: Buffer): Promise<ExcelJS.Workbook> {
  // 1) Try ExcelJS directly — the common case.
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    if (wb.worksheets.length > 0) return wb;
    // Zero sheets: on some ExcelJS versions the prefixed-namespace case doesn't
    // throw, it just yields nothing — fall through to the rewrite path.
  } catch {
    // fall through to the rewrite path
  }

  // 2) Rewrite the spreadsheet parts to the default namespace, then retry once.
  const zip = await JSZip.loadAsync(buffer);
  const rewrites: Promise<void>[] = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    if (!/^xl\/.*\.xml$/i.test(relPath)) return; // only the spreadsheet parts
    const isWorksheet = /^xl\/worksheets\/.*\.xml$/i.test(relPath);
    rewrites.push(
      entry.async("string").then((xml) => {
        let fixed = stripMainNsPrefix(xml);
        if (isWorksheet) fixed = injectCellRefs(fixed);
        if (fixed !== xml) zip.file(relPath, fixed);
      }),
    );
  });
  await Promise.all(rewrites);

  const rebuilt = await zip.generateAsync({ type: "nodebuffer" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(rebuilt as unknown as ArrayBuffer);
  return wb;
}
