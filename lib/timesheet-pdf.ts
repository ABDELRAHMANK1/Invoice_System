// Server-side monthly timesheet ("Urenlijst") PDF, built with pdfkit — the same
// technical approach as lib/invoice-pdf.ts (which is why pdfkit already sits in
// `serverExternalPackages`; no config change was needed for this renderer).
//
// It mirrors the reference Urenlijst, verified against the sample PDF:
//   • title "URENLIJST – <MAAND> <JAAR>"
//   • header block: Werknemer / Functie / Opdrachtgever, with a legend
//     (green = gewerkte dag, grey = weekend) on the right
//   • one row per CALENDAR day of the month, in order — worked days shaded
//     green, weekend rows shaded grey with "Weekend" in Bijzonderheden, and
//     everything else (unselected weekdays, public holidays) left blank
//   • totals row "TOTAAL <MAAND> <JAAR>" with the summed hours
//   • two blank signature blocks, werknemer + werkgever, deliberately NOT
//     pre-filled — they are signed by hand after printing
//
// Hours only: no rate, no amount, and the Overuren / Km-vergoeding columns are
// structural zeros the back office fills in by hand.

import PDFDocument from "pdfkit";
import { DUTCH_MONTHS, formatHoursNL } from "@/lib/workforce/domain";
import type { ScheduleDay, ScheduleTotals } from "@/lib/workforce/domain";

export interface TimesheetPdfParams {
  /** The client the employee is placed with — "Opdrachtgever". */
  client: { name: string };
  employee: { name: string; function_title?: string | null };
  period: { year: number; month: number };
  /** Every day of the month, in date order. */
  days: ScheduleDay[];
  totals: ScheduleTotals;
}

// ── geometry (A4 landscape) ───────────────────────────────────────────────
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 36;
const RIGHT = PAGE_W - MARGIN;

// Column widths in the reference's proportions, scaled to the full text width.
const COLUMNS: Array<{ key: string; label: string; w: number }> = [
  { key: "datum",     label: "Datum",           w: 67 },
  { key: "dag",       label: "Dag",             w: 78 },
  { key: "begin",     label: "Begintijd",       w: 67 },
  { key: "eind",      label: "Eindtijd",        w: 67 },
  { key: "pauze",     label: "Pauze (min)",     w: 67 },
  { key: "uren",      label: "Gewerkte uren",   w: 78 },
  { key: "overuren",  label: "Overuren",        w: 67 },
  { key: "km",        label: "Km vergoeding",   w: 78 },
  { key: "bijzonder", label: "Bijzonderheden",  w: 111 },
  { key: "handtek",   label: "Handtekening",    w: 90 },
];

const COL_X: number[] = (() => {
  const xs: number[] = [];
  let x = MARGIN;
  for (const c of COLUMNS) { xs.push(x); x += c.w; }
  return xs;
})();
const TABLE_W = COLUMNS.reduce((sum, c) => sum + c.w, 0);

const INK = "#111111";
const MUTED = "#555555";
const GRID = "#bfbfbf";
const HEAD_BG = "#1f4e79";      // table header — white text on dark blue
const TOTAL_BG = "#2e75b6";     // totals row
const WORKED_BG = "#e2efda";    // "Gewerkte dag"
const WEEKEND_BG = "#f2f2f2";   // "Weekend"

// Sized so a 31-day month plus the totals row and both signature blocks fit on
// ONE landscape page — a timesheet that breaks across pages is a worse document,
// so the row height is derived from the longest month, not the other way round.
const HEAD_H = 16;
const ROW_H = 10.1;
const TOTAL_H = 14;
const SIGNATURE_GAP = 18;
const SIGNATURE_H = 84;
const BOTTOM_LIMIT = PAGE_H - 20 - (TOTAL_H + SIGNATURE_GAP + SIGNATURE_H);

function fmtDateNL(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

export function buildTimesheetPdf(params: TimesheetPdfParams): Promise<Buffer> {
  const { client, employee, period, days, totals } = params;
  const monthNameForInfo = DUTCH_MONTHS[Math.min(Math.max(period.month, 1), 12) - 1];
  // Info dictionary. pdfkit defaults Producer AND Creator to "PDFKit", which
  // would ship the toolchain's name inside every file the client receives, so
  // both are overridden here. Everything written is about the DOCUMENT — no
  // Subject or Keywords, nothing about how it was produced.
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `Urenlijst ${monthNameForInfo} ${period.year}`,
      Author: client.name,
      Creator: client.name,
      Producer: client.name,
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const periodLabel = `${monthNameForInfo.toUpperCase()} ${period.year}`;

  function cell(text: string, colIndex: number, y: number, opts?: { bold?: boolean; color?: string; size?: number }) {
    const col = COLUMNS[colIndex];
    doc.font(opts?.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(opts?.size ?? 7.5)
      .fillColor(opts?.color ?? INK)
      .text(text, COL_X[colIndex] + 2, y, { width: col.w - 4, align: "center", lineBreak: false });
  }

  // ── title + header block; returns the y the table starts at ──
  function drawHeader(): number {
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK)
      .text(`URENLIJST – ${periodLabel}`, MARGIN, 30, { width: TABLE_W, align: "center" });

    const top = 56;
    const labelX = MARGIN;
    const valueX = MARGIN + 78;
    const valueW = 280;
    let y = top;

    const line = (label: string, value: string) => {
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(label, labelX, y, { width: 76, lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(value, valueX, y, { width: valueW, lineBreak: false });
      y += 11;
    };

    // Two identifying lines plus the job title. There is deliberately no
    // "Uitzendbureau" line: the sheet names the worker and the company the hours
    // were worked at, and nothing else.
    line("Werknemer:", employee.name);
    if (employee.function_title) line("Functie:", employee.function_title);
    line("Opdrachtgever:", client.name);

    // Legend
    const legendX = MARGIN + 430;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text("Legenda:", legendX, top, { lineBreak: false });
    const swatch = (color: string, label: string, ly: number) => {
      doc.save().rect(legendX + 60, ly - 1, 26, 8).fill(color).restore();
      doc.lineWidth(0.5).strokeColor(GRID).rect(legendX + 60, ly - 1, 26, 8).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(INK).text(label, legendX + 92, ly, { lineBreak: false });
    };
    swatch(WORKED_BG, "Gewerkte dag", top + 13);
    swatch(WEEKEND_BG, "Weekend", top + 25);

    return Math.max(y, top + 38) + 8;
  }

  function drawTableHead(y: number): number {
    doc.save().rect(MARGIN, y, TABLE_W, HEAD_H).fill(HEAD_BG).restore();
    COLUMNS.forEach((col, i) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff")
        .text(col.label, COL_X[i] + 2, y + 4.5, { width: col.w - 4, align: "center", lineBreak: false });
    });
    return y + HEAD_H;
  }

  function drawGrid(top: number, bottom: number) {
    doc.lineWidth(0.5).strokeColor(GRID);
    for (let i = 0; i <= COLUMNS.length; i++) {
      const x = i === COLUMNS.length ? MARGIN + TABLE_W : COL_X[i];
      doc.moveTo(x, top).lineTo(x, bottom).stroke();
    }
  }

  function drawDayRow(y: number, day: ScheduleDay) {
    const bg = day.kind === "worked" ? WORKED_BG : day.kind === "weekend" ? WEEKEND_BG : null;
    if (bg) doc.save().rect(MARGIN, y, TABLE_W, ROW_H).fill(bg).restore();
    doc.lineWidth(0.5).strokeColor(GRID)
      .moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + TABLE_W, y + ROW_H).stroke();

    const ty = y + 2.4;
    cell(fmtDateNL(day.date), 0, ty);
    cell(day.day_name, 1, ty);

    if (day.kind === "worked") {
      cell(day.start ?? "", 2, ty);
      cell(day.end ?? "", 3, ty);
      cell(String(day.break_minutes), 4, ty);
      cell(formatHoursNL(day.hours), 5, ty);
    } else if (day.kind === "weekend") {
      // Where the reference puts it: the time columns stay empty and "Weekend"
      // is written as the day's remark.
      cell("Weekend", 8, ty, { color: MUTED });
    }
    // Public holidays and unselected weekdays: date + day name only, by design.
  }

  function drawTotals(y: number) {
    doc.save().rect(MARGIN, y, TABLE_W, TOTAL_H).fill(TOTAL_BG).restore();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff")
      .text(`TOTAAL ${periodLabel}`, MARGIN + 4, y + 3.5, { width: COLUMNS[0].w + COLUMNS[1].w + COLUMNS[2].w, lineBreak: false });
    // Order: total hours, total worked days, overuren, km. The day count sits
    // between the hours and the two static columns, so from here on each total
    // carries its own unit rather than relying on the header above it.
    cell(formatHoursNL(totals.hours), 5, y + 3.5, { bold: true, color: "#ffffff", size: 8 });
    cell(`${totals.worked_days} dagen`, 6, y + 3.5, { bold: true, color: "#ffffff", size: 8 });
    cell(`${formatHoursNL(totals.overtime_hours)} overuren`, 7, y + 3.5, { bold: true, color: "#ffffff", size: 8 });
    cell(`${formatHoursNL(totals.km_allowance)} km`, 8, y + 3.5, { bold: true, color: "#ffffff", size: 8 });
    doc.lineWidth(0.5).strokeColor(GRID).rect(MARGIN, y, TABLE_W, TOTAL_H).stroke();
    return y + TOTAL_H;
  }

  /** Two blank blocks, signed by hand. Nothing here is pre-filled on purpose. */
  function drawSignatures(y: number) {
    const boxW = 250;
    const boxH = 54;
    const blocks: Array<[string, number]> = [
      ["Handtekening werknemer:", MARGIN],
      ["Handtekening werkgever:", MARGIN + boxW + 40],
    ];
    for (const [title, x] of blocks) {
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(title, x, y, { lineBreak: false });
      doc.lineWidth(0.5).strokeColor(GRID).rect(x, y + 14, boxW, boxH).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(MUTED);
      doc.text("Naam:", x + 8, y + boxH - 12, { lineBreak: false });
      doc.text("Datum:", x + 8, y + boxH + 2, { lineBreak: false });
      doc.moveTo(x + 46, y + boxH - 4).lineTo(x + boxW - 8, y + boxH - 4).stroke();
      doc.moveTo(x + 46, y + boxH + 10).lineTo(x + boxW - 8, y + boxH + 10).stroke();
    }
  }

  // ── compose ────────────────────────────────────────────────────────────
  let y = drawHeader();
  y = drawTableHead(y);
  let gridTop = y;

  for (const day of days) {
    // A calendar month fits on one landscape page; this is the safety valve, not
    // the normal path.
    if (y + ROW_H > BOTTOM_LIMIT) {
      drawGrid(gridTop, y);
      doc.addPage();
      y = drawHeader();
      y = drawTableHead(y);
      gridTop = y;
    }
    drawDayRow(y, day);
    y += ROW_H;
  }
  drawGrid(gridTop, y);
  y = drawTotals(y);
  drawSignatures(y + SIGNATURE_GAP);

  // Page numbers, only worth stamping when the month spilled over one page.
  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text(`${i + 1} / ${range.count}`, MARGIN, PAGE_H - 24, { width: RIGHT - MARGIN, align: "right", lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
  }

  doc.end();
  return done;
}
