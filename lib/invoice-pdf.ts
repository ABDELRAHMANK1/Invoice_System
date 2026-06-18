// Server-side invoice PDF, built with pdfkit to mirror the reference
// "Akram Transport" layout:
//   • repeated top header — ISSUER top-right, BILL-TO under the bold "Factuur"
//     heading top-left
//   • page 1: Betaalgegevens box (left) + invoice metadata (right)
//   • items table: Omschrijving | Aantal | Prijs | Totaal
//   • running "Subtotaal" at the bottom of every continued page
//   • last page footer: BTW table (Btw % | Grondslag | Bedrag) + Totaal excl.
//     btw / Totaal btw / Te betalen
//   • "x / n" page numbers
//
// Empty/nullable fields are omitted (no blank "Btw-nr" rows, etc).
//
// The renderer is direction-AGNOSTIC: it only knows "issuer" (the party sending
// the invoice + collecting payment) and "billTo" (the party being charged). The
// caller resolves which real record fills each role:
//   • inkoop  → issuer = supplier, billTo = client
//   • verkoop → issuer = client,   billTo = customer
// "Klantnummer" is the counterparty's relatie_code (supplier for inkoop,
// customer for verkoop), so it is passed in explicitly via meta.klantnummer
// rather than re-derived here.

import PDFDocument from "pdfkit";
import type { InvoiceTotals } from "@/lib/billing";
import { formatNL } from "@/lib/billing";

export interface IssuerInfo {
  name: string;
  address?: string | null;
  postcode?: string | null;
  city?: string | null;
  kvk?: string | null;
  btw_number?: string | null;
  iban?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface BillToInfo {
  name: string;
  address?: string | null;
  postcode?: string | null;
  city?: string | null;
}

export interface InvoiceMeta {
  invoice_number: string;
  invoice_date?: string | null;    // Factuurdatum (YYYY-MM-DD)
  delivery_date?: string | null;   // Leverdatum
  order_reference?: string | null; // Orderreferentie (optional)
  description?: string | null;     // Omschrijving
  klantnummer?: string | null;     // counterparty relatie_code → "Klantnummer"
}

export interface BuildInvoicePdfParams {
  issuer: IssuerInfo;
  billTo: BillToInfo;
  meta: InvoiceMeta;
  totals: InvoiceTotals;
}

// ── geometry ──────────────────────────────────────────────────────────────
const PAGE_W = 595.28;
const MARGIN = 40;
const RIGHT = PAGE_W - MARGIN;          // 555.28
const RIGHT_COL_X = 330;                // left edge of the right-hand blocks

// items table columns (right-aligned numeric columns by their box [x, w])
const COL = {
  desc:   { x: MARGIN, w: 270 },
  aantal: { x: 300, w: 80 },
  prijs:  { x: 385, w: 80 },
  totaal: { x: 470, w: RIGHT - 470 },
};

const INK = "#111111";
const MUTED = "#555555";
const FAINT = "#8a8a8a";
const LINE = "#e3e3e3";
const HEAD_BG = "#f3f4f6";
const BOX_BG = "#f7f8fa";

const ROW_H = 20;
const ROW_BOTTOM_LIMIT = 770;           // start a new page past this y
const FOOTER_H = 120;

function euro(n: number) { return `€ ${formatNL(n)}`; }

function fmtDateNL(iso?: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso; // YYYY-MM-DD → DD-MM-YYYY
}

export function buildInvoicePdf(params: BuildInvoicePdfParams): Promise<Buffer> {
  const { issuer, billTo, meta, totals } = params;
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // ── repeated top header; returns the y where page content may begin ──
  function drawHeader(): number {
    // Right block — issuer
    let ry = 50;
    const rw = RIGHT - RIGHT_COL_X;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(issuer.name, RIGHT_COL_X, ry, { width: rw });
    ry = doc.y;
    doc.font("Helvetica").fontSize(9.5).fillColor(MUTED);
    if (issuer.address) { doc.text(issuer.address, RIGHT_COL_X, ry, { width: rw }); ry = doc.y; }
    const pc = [issuer.postcode, issuer.city].filter(Boolean).join(" ");
    if (pc) { doc.text(pc, RIGHT_COL_X, ry, { width: rw }); ry = doc.y; }
    if (issuer.phone) {
      doc.font("Helvetica-Bold").text("t", RIGHT_COL_X, ry, { continued: true }).font("Helvetica").text(`  ${issuer.phone}`);
      ry = doc.y;
    }
    if (issuer.email) {
      doc.font("Helvetica-Bold").text("e", RIGHT_COL_X, ry, { continued: true }).font("Helvetica").text(`  ${issuer.email}`);
      ry = doc.y;
    }
    // IBAN / Btw-nr / KvK label grid
    ry += 8;
    const grid: Array<[string, string | null | undefined]> = [
      ["IBAN", issuer.iban],
      ["Btw-nr", issuer.btw_number],
      ["KvK", issuer.kvk],
    ];
    for (const [label, value] of grid) {
      if (!value) continue;
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(label, RIGHT_COL_X, ry, { width: 50 });
      doc.font("Helvetica").fillColor(MUTED).text(value, RIGHT_COL_X + 55, ry, { width: rw - 55 });
      ry = doc.y;
    }
    const rightBottom = ry;

    // Left block — "Factuur" + bill-to
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(22).text("Factuur", MARGIN, 95);
    let ly = 132;
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(billTo.name, MARGIN, ly, { width: 260 });
    ly = doc.y;
    doc.font("Helvetica").fontSize(9.5).fillColor(MUTED);
    if (billTo.address) { doc.text(billTo.address, MARGIN, ly, { width: 260 }); ly = doc.y; }
    const cpc = [billTo.postcode, billTo.city].filter(Boolean).join(" ");
    if (cpc) { doc.text(cpc, MARGIN, ly, { width: 260 }); ly = doc.y; }

    return Math.max(rightBottom, ly) + 24;
  }

  // ── page-1 only: Betaalgegevens box (left) + metadata (right) ──
  function drawPaymentAndMeta(top: number): number {
    // Betaalgegevens box
    const boxX = MARGIN, boxW = 250;
    const rows: Array<[string, string]> = [
      ["Te betalen", euro(totals.total)],
      ["Naar IBAN", issuer.iban || ""],
      ["Op naam van", issuer.name],
      ["Omschrijving", meta.description || `Factuur ${meta.invoice_number}`],
    ].filter(([, v]) => v) as Array<[string, string]>;
    const boxH = 22 + rows.length * 18 + 8;
    doc.save().rect(boxX, top, boxW, boxH).fill(BOX_BG).restore();
    // header chip
    doc.save().rect(boxX + 10, top - 9, 96, 18).fill("#ffffff").restore();
    doc.lineWidth(0.5).strokeColor(LINE).rect(boxX + 10, top - 9, 96, 18).stroke();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("Betaalgegevens", boxX + 16, top - 5);
    let by = top + 16;
    for (const [label, value] of rows) {
      doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(label, boxX + 14, by, { width: 90 });
      doc.font("Helvetica-Bold").fillColor(INK).text(value, boxX + 110, by, { width: boxW - 120 });
      by += 18;
    }

    // metadata (right column)
    const mRows: Array<[string, string]> = [
      ["Factuurnummer", meta.invoice_number],
      ["Factuurdatum", fmtDateNL(meta.invoice_date)],
      ["Orderreferentie", meta.order_reference || ""],
      ["", ""],
      ["Klantnummer", meta.klantnummer || ""],
      ["Leverdatum", fmtDateNL(meta.delivery_date)],
    ];
    let my = top;
    for (const [label, value] of mRows) {
      if (label === "" && value === "") { my += 10; continue; }
      if (!value) continue;
      doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(label, RIGHT_COL_X, my, { width: 95 });
      doc.font("Helvetica-Bold").fillColor(INK).text(value, RIGHT_COL_X + 100, my, { width: RIGHT - RIGHT_COL_X - 100 });
      my += 17;
    }

    return Math.max(top + boxH, my) + 22;
  }

  function drawTableHeader(y: number): number {
    doc.save().rect(MARGIN - 4, y - 4, RIGHT - MARGIN + 8, 22).fill(HEAD_BG).restore();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK);
    doc.text("Omschrijving", COL.desc.x, y + 2, { width: COL.desc.w });
    doc.text("Aantal", COL.aantal.x, y + 2, { width: COL.aantal.w, align: "right" });
    doc.text("Prijs", COL.prijs.x, y + 2, { width: COL.prijs.w, align: "right" });
    doc.text("Totaal", COL.totaal.x, y + 2, { width: COL.totaal.w, align: "right" });
    return y + 26;
  }

  function drawItemRow(y: number, it: InvoiceTotals["items"][number]): number {
    doc.font("Helvetica").fontSize(9.5).fillColor(INK);
    doc.text(it.description || "", COL.desc.x, y, { width: COL.desc.w });
    const rowTop = y;
    doc.fillColor(MUTED);
    doc.text(formatNL(it.quantity), COL.aantal.x, rowTop, { width: COL.aantal.w, align: "right" });
    doc.text(formatNL(it.unit_price), COL.prijs.x, rowTop, { width: COL.prijs.w, align: "right" });
    doc.fillColor(INK).text(formatNL(it.line_total), COL.totaal.x, rowTop, { width: COL.totaal.w, align: "right" });
    return Math.max(doc.y, rowTop + ROW_H);
  }

  function drawRunningSubtotal(y: number, runningSubtotal: number) {
    doc.save().rect(MARGIN - 4, y, RIGHT - MARGIN + 8, 22).fill(BOX_BG).restore();
    doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text("Subtotaal", COL.aantal.x - 60, y + 5, { width: 120, align: "right" });
    doc.text("€", COL.prijs.x, y + 5, { width: COL.prijs.w, align: "right" });
    doc.font("Helvetica-Bold").fillColor(INK).text(formatNL(runningSubtotal), COL.totaal.x, y + 5, { width: COL.totaal.w, align: "right" });
  }

  function drawFooter(y: number) {
    // BTW table (left)
    const bx = MARGIN;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    doc.text("Btw %", bx, y, { width: 55 });
    doc.text("Grondslag", bx + 60, y, { width: 80 });
    doc.text("Bedrag", bx + 150, y, { width: 80 });
    doc.moveTo(bx, y + 14).lineTo(bx + 230, y + 14).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.fillColor(INK);
    doc.text(formatNL(totals.btw_rate), bx, y + 20, { width: 55 });
    doc.text(formatNL(totals.subtotal), bx + 60, y + 20, { width: 80 });
    doc.text(formatNL(totals.btw_amount), bx + 150, y + 20, { width: 80 });

    // Totals (right)
    const tLabelX = RIGHT_COL_X, tEuroX = 460, tValX = 500, tValW = RIGHT - 500;
    const line = (label: string, value: number, yy: number, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(bold ? INK : MUTED);
      doc.text(label, tLabelX, yy, { width: 120 });
      doc.text("€", tEuroX, yy, { width: 30, align: "right" });
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(INK);
      doc.text(formatNL(value), tValX, yy, { width: tValW, align: "right" });
    };
    line("Totaal excl. btw", totals.subtotal, y);
    line("Totaal btw", totals.btw_amount, y + 18);
    doc.moveTo(tLabelX, y + 38).lineTo(RIGHT, y + 38).lineWidth(0.5).strokeColor(LINE).stroke();
    line("Te betalen", totals.total, y + 44, true);
  }

  // ── compose ────────────────────────────────────────────────────────────
  let y = drawHeader();
  y = drawPaymentAndMeta(y);
  y = drawTableHeader(y);

  let running = 0;
  const items = totals.items;
  for (let i = 0; i < items.length; i++) {
    if (y + ROW_H > ROW_BOTTOM_LIMIT) {
      drawRunningSubtotal(y + 4, running);           // carry-forward on continued page
      doc.addPage();
      y = drawHeader();
      y = drawTableHeader(y);
    }
    y = drawItemRow(y, items[i]);
    running = Math.round((running + items[i].line_total) * 100) / 100;
  }

  // Footer on the last page (or a fresh page if it won't fit).
  if (y + 30 + FOOTER_H > 810) {
    doc.addPage();
    y = drawHeader();
  }
  drawFooter(Math.max(y + 30, 690));

  // Page numbers "x / n". Zero the bottom margin while stamping so writing into
  // the footer area doesn't trigger pdfkit's auto page-break (which would append
  // blank pages).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor(FAINT)
      .text(`${i + 1} / ${range.count}`, MARGIN, doc.page.height - 28, { width: RIGHT - MARGIN, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return done;
}
