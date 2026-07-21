/**
 * Customer Ledger / Statement PDF Service (WI-092)
 *
 * Generates a customer statement PDF using pdfkit. The legacy system was a
 * browser print-to-PDF; this renders a proper document server-side with the
 * same letterhead style as the invoice PDF.
 *
 * Landscape A4 — the statement has 11 columns and does not fit portrait.
 */

import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { getCustomerLedger } from '../paymentService.js';
import { getGroupLedger } from '../customerGroupPortalService.js';
import { formatMoney, formatDate } from './pdfLayoutUtils.js';

// A4 landscape
const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#e5e7eb',
  ZEBRA: '#f8fafc',
};
const TYPO = { H1: 18, H2: 11, BODY: 8, LABEL: 8, CAPTION: 7 };

interface Col {
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
}

// INVESTIGATION-JUL09 followup — the previous widths summed to 788pt but
// the usable table area on landscape A4 with 40pt margins is 762pt. The
// 26pt overflow squeezed every cell into ellipsis. Rebalanced widths sum
// to exactly 762pt AND money columns are wide enough for lakh-level values
// ("Rs. 1,01,600.00" = 15 chars) which was the second wave of truncation.
// Q3 (2026-07-09) — Narration widened from 92→108pt so empties-return rows
// like "Empties: 50× 19 KG" (18 chars) render in full instead of ellipsing
// mid-word. 16pt reclaimed by trimming Type (54→50), Amount (72→68),
// Emp Cost (74→70) and Received (72→68). Money cols cap slightly (lakh
// figures 15→14 chars) — the practical range on real invoices is much
// smaller than the cap and this trade unlocks 25% more narration space.
const COLS: Col[] = [
  { label: 'Date', width: 64, align: 'left' },
  { label: 'Type', width: 50, align: 'left' },
  { label: 'Narration', width: 108, align: 'left' },
  { label: 'Del F', width: 30, align: 'right' },
  { label: 'Amount', width: 68, align: 'right' },
  { label: 'Emp C', width: 34, align: 'right' },
  { label: 'Pend E', width: 34, align: 'right' },
  { label: 'Emp Cost', width: 70, align: 'right' },
  { label: 'Total Amt', width: 84, align: 'right' },
  { label: 'Received', width: 68, align: 'right' },
  { label: 'Due Amt', width: 76, align: 'right' },
  { label: 'Overdue', width: 76, align: 'right' },
];

const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);
const ROW_HEIGHT = 16;

function num(n: number): string {
  return Number(n || 0).toLocaleString('en-IN');
}

// Truncate text so it always fits its cell width — pdfkit's default
// `text(...)` wraps onto a second line when the string is longer than
// `options.width`, which collides with the next row's content (visible on
// long test-fixture cylinder type names like
// "WI4-TEST-1781334799052"). One line per cell, ellipsised when needed.
function fitCell(s: string, maxChars: number): string {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)) + '…';
}

// Per-column character caps. Numeric columns rarely overflow (formatted
// money + en-IN locale grouping fits in 13 chars for lakh figures), but
// the Type and Narration columns receive free text and need clamping.
// Indexed to match the COLS array order — rebalanced alongside the width
// change above so text no longer ellipsises at typical Indian scale.
const COL_CHAR_CAP: number[] = [
  11, // Date       — "07-Jul-2026" (11)
  11, // Type       — "Adjustment" (10) fits; Q3 "Empties" (7) fits.
  20, // Narration  — Q3 (2026-07-09): "Empties: 50× 19 KG" (18) with 2-char
      //              buffer. Invoice numbers (14) + "Page N subtotal" (15)
      //              also fit comfortably.
  4,  // Del F      — 0-999
  14, // Amount     — "Rs. 9,99,999.00" (15) truncates 1 char; smaller
      //              figures (up to Rs 9,99,999) still fit fully.
  4,  // Emp C      — 0-999
  4,  // Pend E     — 0-999
  14, // Emp Cost   — same as Amount
  16, // Total Amt  — "Rs. 99,99,999.00" (16) crore-scale cumulative running total
  14, // Received   — same as Amount
  16, // Due Amt    — matches Total Amt
  15, // Overdue    — "Rs. 9,99,999.00"
];

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const col of COLS) {
    // lineBreak:false + ellipsis:true forces the header onto ONE line even
    // if a bold label like "Emp C" or "Pend E" would overflow the column
    // width (which pdfkit otherwise wraps onto row 2 and pushes data rows
    // down). Column widths are already picked wide enough for the labels.
    doc.text(col.label, x + 3, y + 4, {
      width: col.width - 6,
      align: col.align,
      lineBreak: false,
      ellipsis: true,
    });
    x += col.width;
  }
  doc.fillColor(THEME.TEXT);
  return ROW_HEIGHT + 2;
}

/**
 * Period Summary block (2026-07-19 / expanded 2026-07-20) — renders
 * a 4- or 5-tile band above the entries table so the reader gets the
 * "one-liner" for the period without hunting through multi-page rows.
 *
 *   4-tile (customer ledger PDF): Debited · Received · Net Outstanding · Overdue
 *   5-tile (group ledger PDF):    Opening · Debited (period) · Received (period) · Closing · Overdue
 *
 * The 5-tile variant reconciles to the visible rows even when the
 * group has pre-range entries (see paymentService periodDebited /
 * periodReceived accumulators). Identity: Opening + Debited (period)
 * − Received (period) === Closing. Overdue is a subset of Closing.
 *
 * Net outstanding / Closing uses the distinct primary fill so the
 * "how much do I owe now" number reads loudest. When overdue is
 * zero, that tile is muted rather than removed — a fixed tile count
 * keeps the layout stable across statements.
 */
interface PeriodSummary {
  debited: number;
  received: number;
  netOutstanding: number;
  overdue: number;
  tableWidth: number;
  // 2026-07-20 — optional. When present, render 5-tile layout with
  // Opening as the first tile and switch labels to "(period)". Absent
  // → keeps the legacy 4-tile shape for the individual customer PDF.
  opening?: number;
}
function drawPeriodSummary(
  doc: PDFKit.PDFDocument,
  startY: number,
  s: PeriodSummary,
): number {
  const BLOCK_H = 42;
  const GAP = 6;
  const showOpening = s.opening !== undefined;
  const tileCount = showOpening ? 5 : 4;
  const tileW = Math.floor((s.tableWidth - GAP * (tileCount - 1)) / tileCount);

  const tiles: Array<{ label: string; value: string; fill: string; textColor: string }> = [];
  if (showOpening) {
    tiles.push({
      label: 'Opening Balance',
      value: formatMoney(s.opening ?? 0),
      fill: THEME.ZEBRA,
      textColor: THEME.TEXT,
    });
  }
  tiles.push(
    { label: 'Debited (period)', value: formatMoney(s.debited), fill: THEME.ZEBRA, textColor: THEME.TEXT },
    { label: 'Received (period)', value: formatMoney(s.received), fill: THEME.ZEBRA, textColor: THEME.TEXT },
    { label: showOpening ? 'Closing Balance' : 'Net Outstanding', value: formatMoney(s.netOutstanding), fill: THEME.PRIMARY, textColor: '#ffffff' },
    { label: 'Overdue', value: formatMoney(s.overdue), fill: s.overdue > 0 ? '#dc2626' : THEME.ZEBRA, textColor: s.overdue > 0 ? '#ffffff' : THEME.MUTED },
  );

  let x = MARGIN.left;
  for (const t of tiles) {
    doc.rect(x, startY, tileW, BLOCK_H).fill(t.fill);
    doc.fillColor(t.textColor).font('Helvetica').fontSize(TYPO.CAPTION);
    doc.text(t.label.toUpperCase(), x + 8, startY + 6, { width: tileW - 16, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(TYPO.H2);
    doc.text(t.value, x + 8, startY + 20, {
      width: tileW - 16,
      align: 'left',
      lineBreak: false,
      ellipsis: true,
    });
    x += tileW + GAP;
  }
  doc.fillColor(THEME.TEXT);
  return startY + BLOCK_H + 10;
}

function drawRow(
  doc: PDFKit.PDFDocument,
  y: number,
  cells: string[],
  opts: { bold?: boolean; zebra?: boolean } = {},
): number {
  if (opts.zebra) {
    doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  }
  doc.fillColor(THEME.TEXT).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
  let x = MARGIN.left;
  for (let i = 0; i < COLS.length; i++) {
    // lineBreak:false forces single-line rendering inside the cell width
    // (pdfkit otherwise wraps onto a second line that overlaps the next
    // row). fitCell ellipsises the source text so the visible content
    // matches what was actually rendered.
    const text = fitCell(cells[i] ?? '', COL_CHAR_CAP[i] ?? 999);
    doc.text(text, x + 3, y + 4, {
      width: COLS[i].width - 6,
      align: COLS[i].align,
      lineBreak: false,
      ellipsis: true,
    });
    x += COLS[i].width;
  }
  return ROW_HEIGHT;
}

export async function generateCustomerLedgerPdf(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<Buffer> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: {
      customerName: true, businessName: true, gstin: true,
      phone: true, creditPeriodDays: true,
    },
  });
  if (!customer) throw new Error('Customer not found');

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
      // Phase 3 (2026-06-12): payment details for the "Pay To" block
      // emitted under the letterhead. Block renders only when
      // bankAccountNumber AND ifscCode are non-empty.
      bankName: true, bankAccountNumber: true, bankBranchName: true,
      ifscCode: true, upiId: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  const ledger = await getCustomerLedger(distributorId, customerId, range);

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  const rightEdge = PAGE_WIDTH - MARGIN.right;
  let y = MARGIN.top;

  // ── Header: distributor letterhead ──
  const sellerName = distributor.businessName || distributor.legalName;
  const sellerAddr = [distributor.address, distributor.city, distributor.state, distributor.pincode]
    .filter(Boolean).join(', ') || '—';

  doc.font('Helvetica-Bold').fontSize(Math.round(TYPO.H2 * 1.5)).fillColor(THEME.PRIMARY);
  doc.text(sellerName, MARGIN.left, y, { width: 400 });
  let leftY = y + 18;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(sellerAddr, MARGIN.left, leftY, { width: 400 }); leftY += 11;
  doc.text(`GSTIN: ${distributor.gstin || '—'}   Phone: ${distributor.phone || '—'}`, MARGIN.left, leftY, { width: 400 });
  leftY += 11;

  // Phase 3 → 9-issues Issue 7 (2026-06-12): the Pay To block USED to
  // live here below the letterhead, left-aligned. Suneel asked for it
  // right-aligned beside the customer name/details block instead, with
  // the account holder name (auto-filled from distributor.businessName)
  // as the first line. Render happens below — see the matching block
  // after the customer details at the line marked
  // "Pay To block (9-issues Issue 7)".

  // Title (right)
  doc.font('Helvetica-Bold').fontSize(TYPO.H1).fillColor(THEME.PRIMARY);
  const title = 'Customer Statement';
  doc.text(title, rightEdge - 250, y, { width: 250, align: 'right' });

  y = Math.max(leftY, y + 36) + 4;
  doc.moveTo(MARGIN.left, y).lineTo(rightEdge, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 10;

  // ── Customer details ──
  const custName = customer.businessName || customer.customerName;
  // Capture the Y where the customer block starts — the Pay To block
  // renders right-aligned starting at the same Y so the two blocks
  // sit side-by-side (9-issues Issue 7).
  const customerBlockStartY = y;
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.TEXT);
  doc.text(custName, MARGIN.left, y); y += 14;
  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.MUTED);
  const gstinDisplay = customer.gstin && customer.gstin !== 'URP' ? customer.gstin : '—';
  doc.text(
    `GSTIN: ${gstinDisplay}    Phone: ${customer.phone || '—'}    Credit Period: ${customer.creditPeriodDays} days`,
    MARGIN.left, y,
  );
  y += 14;

  // ── Pay To block (9-issues Issue 7) ──
  // Right-aligned beside the customer details block, starting at the
  // same Y so the two blocks visually balance. Account holder name
  // (auto-filled from distributor.businessName) is the first line so
  // the customer can confirm WHO they're paying. Renders only when
  // bank account + IFSC are both set — UPI line is appended only when
  // upiId is also set. Same gating as the prior Phase 3 block.
  if (distributor.bankAccountNumber && distributor.ifscCode) {
    const payToWidth = 250;
    const payToX = rightEdge - payToWidth;
    let payToY = customerBlockStartY;
    doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.PRIMARY);
    doc.text('Pay To:', payToX, payToY, { width: payToWidth, align: 'right' });
    payToY += 11;
    doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.TEXT);
    doc.text(distributor.businessName || distributor.legalName || '—', payToX, payToY, {
      width: payToWidth, align: 'right',
    });
    payToY += 11;
    doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
    const branchSuffix = distributor.bankBranchName ? `, ${distributor.bankBranchName}` : '';
    const bankLine = `${distributor.bankName ?? '—'}${branchSuffix}`;
    doc.text(bankLine, payToX, payToY, { width: payToWidth, align: 'right' });
    payToY += 11;
    doc.text(`A/C: ${distributor.bankAccountNumber}`, payToX, payToY, {
      width: payToWidth, align: 'right',
    });
    payToY += 11;
    const lastLine = distributor.upiId
      ? `IFSC: ${distributor.ifscCode}   UPI: ${distributor.upiId}`
      : `IFSC: ${distributor.ifscCode}`;
    doc.text(lastLine, payToX, payToY, { width: payToWidth, align: 'right' });
    payToY += 11;
    // Push the main cursor down if the Pay To block ended below the
    // current y so the table headers don't overlap.
    y = Math.max(y, payToY);
  }

  // Period
  if (range?.from || range?.to) {
    doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.TEXT);
    doc.text(
      `Period: ${range?.from ? formatDate(range.from) : 'Beginning'} to ${range?.to ? formatDate(range.to) : formatDate(new Date())}`,
      MARGIN.left, y,
    );
    y += 14;
  }

  // Indicative-cost note
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(
    'Empty cylinder costs are indicative only. Charges apply only for missing cylinders.',
    MARGIN.left, y,
  );
  y += 16;

  // ── Table ──
  y += drawTableHeader(doc, y);

  let totalDelivered = 0;
  let totalCollected = 0;
  // 2026-07-21 — cumulative closing empties held by customer at end of
  // period = (opening seeded empties) + (fulls delivered in period)
  //          − (empties collected in period). We accumulate OB rows'
  // pendingEmptyCyls into totalOpeningPending during the render loop
  // and combine into the Total row's Pend E column. Previously that
  // cell showed (delivered − collected) = period net, which surfaced
  // as "1" even when the customer physically held ~13 empties — the
  // period net is not what a mini-op reseller reasons about.
  let totalOpeningPending = 0;
  let zebra = false;

  // Per-page subtotal state. Resets after each page break; emitted as a
  // dedicated bold row before the page advances so a multi-page statement
  // shows the operator how much activity fell on each page. The single-
  // page case never sees a subtotal row — the grand Total row covers it.
  let pageNum = 1;
  let pageDelivered = 0;
  let pageCollected = 0;
  let pageAmount = 0;
  let pageEmptyCost = 0;
  let pageReceived = 0;
  // Cumulative running balance at the end of the last data row drawn —
  // used as the "Total / Due" cumulative values on the page subtotal row
  // so the reader sees where the running balance stood at page end.
  let lastTotalAmount = 0;
  let lastDueAmount = 0;
  let pageHasData = false;

  function emitPageSubtotal(): void {
    if (!pageHasData) return; // nothing to summarise — skip empty page
    // Label goes in Narration (92pt, 16-char cap) — Type (56pt, 12-char) would
    // truncate "Page N subtotal" to "Page 1 subt…".
    const cells = [
      '',
      '',
      `Page ${pageNum} subtotal`,
      pageDelivered ? num(pageDelivered) : '',
      pageAmount ? formatMoney(pageAmount) : '',
      pageCollected ? num(pageCollected) : '',
      '',
      pageEmptyCost ? formatMoney(pageEmptyCost) : '',
      formatMoney(lastTotalAmount),
      pageReceived ? formatMoney(pageReceived) : '',
      formatMoney(lastDueAmount),
      '',
    ];
    // Light divider above the subtotal so it's clearly bounded.
    doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y)
      .strokeColor(THEME.BORDER).lineWidth(0.5).stroke();
    y += drawRow(doc, y + 1, cells, { bold: true });
    // Reset per-page state for the next page (cumulative values do NOT
    // reset — they carry across pages so the next page's subtotal still
    // shows the live running total).
    pageDelivered = 0;
    pageCollected = 0;
    pageAmount = 0;
    pageEmptyCost = 0;
    pageReceived = 0;
    pageHasData = false;
  }

  // Customer-facing PDF — the Type column shows the cylinder type name
  // for invoice rows ("19 KG", "425 KG"), "Payment" for credits,
  // "Opening Balance" for the b/f row. Mirrors the legacy WI-092 PDF that
  // customers are already used to.
  function typeLabel(row: typeof ledger.rows[number]): string {
    switch (row.kind) {
      // 2026-07-21 opening-state seed: OB rows now carry the cylinder
      // type name in `cylinderType` when the customer had seeded
      // empties (one OB row per seeded type). Fall back to blank
      // when there are no empties (money-only OB) — Narration
      // column still shows "Opening Balance b/f" so context is clear.
      case 'opening': return row.cylinderType || '';
      case 'payment': return 'Payment';
      case 'credit_note': return 'Credit Note';
      case 'debit_note': return 'Debit Note';
      case 'adjustment': return 'Adjustment';
      // Q3 (2026-07-09) — 7-char label so it fits inside the Type column
      // cap of 11. The count + cyl type lives in Narration.
      case 'empties_return': return 'Empties';
      case 'invoice': return row.cylinderType || 'Invoice';
      default: return row.cylinderType === '' ? 'Payment' : (row.cylinderType || 'Invoice');
    }
  }

  // Customer-facing PDF: compact narration so it fits the column cleanly.
  //   • Invoice IVGS2627028008 for order OSHD…  →  IVGS2627028008
  //   • Payment received #ref-abcd               →  Payment
  //   • Credit Note CNGS… / Debit Note DNGS…     →  CNGS… / DNGS…
  // The word "Invoice"/"Payment received" is redundant with the Type
  // column so the Narration cell only needs the identifying reference.
  function shortNarration(raw: string, kind: string): string {
    if (!raw) return '';
    // Strip " for order …" tail from invoiceService.ts:266 narrations.
    let s = raw;
    const orderIdx = s.indexOf(' for order');
    if (orderIdx >= 0) s = s.slice(0, orderIdx);
    // Invoice rows: drop the "Invoice " prefix so the invoice number is
    // the entire cell content. Similar for credit / debit notes.
    if (kind === 'invoice') return s.replace(/^Invoice\s+/i, '');
    if (kind === 'credit_note') return s.replace(/^Credit Note\s+/i, '');
    if (kind === 'debit_note') return s.replace(/^Debit Note\s+/i, '');
    // Payment rows: the Type column already says "Payment"; drop the
    // "#ref-…" tail so the Narration cell is empty (cleaner alignment).
    if (kind === 'payment') return '';
    return s;
  }

  for (const row of ledger.rows) {
    // page break — reserve room for the b/f row's extra padding + separator
    // (12px) AND for the page-subtotal row (ROW_HEIGHT + 4) so neither gets
    // clipped at the page foot.
    const baseNeeded = row.kind === 'opening' ? ROW_HEIGHT + 12 : ROW_HEIGHT;
    const needed = baseNeeded + ROW_HEIGHT + 4;
    if (y + needed > PAGE_HEIGHT - MARGIN.bottom - 30) {
      emitPageSubtotal();
      doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
      pageNum += 1;
      y = MARGIN.top;
      y += drawTableHeader(doc, y);
      zebra = false;
    }

    const narration = shortNarration(row.narration ?? '', row.kind ?? '');
    let cells: string[];

    if (row.kind === 'opening') {
      // Carry-forward row — blank Delivered/Amount, only the Total and Due
      // columns carry the carry-forward amount.
      //
      // 2026-06-11: previously this row drew flush against the table
      // header above and the first invoice row below, with no separator
      // — Suneel saw it visually merging with adjacent rows. We now
      // bold the b/f row, draw it with 4px breathing room above,
      // and finish with a thin divider + 4px gap below to mark the
      // carry-forward break.
      //
      // 2026-07-21 opening-state seed: Pend E cell renders the
      // seeded empties count (just the number — the OB context is
      // clear from the Narration column's "Opening Balance b/f").
      y += 4; // gap above
      totalOpeningPending += row.pendingEmptyCyls || 0;
      const pendE = row.pendingEmptyCyls > 0 ? String(row.pendingEmptyCyls) : '';
      // 2026-07-21 — surface the OB empties liability (qty × empty
      // cylinder price) so the reseller reads the ₹ value they're
      // carrying alongside the empties count. Blank when 0 (money-only
      // OB row or unpriced type).
      const empCost = (row.emptyCylsCost || 0) > 0 ? formatMoney(row.emptyCylsCost) : '';
      cells = [
        formatDate(row.orderDate),
        typeLabel(row),
        narration,
        '', '', '',
        pendE,
        empCost,
        formatMoney(row.totalAmount),
        '',
        formatMoney(row.dueAmount),
        '',
      ];
      y += drawRow(doc, y, cells, { bold: true });
      // Thin separator line + small gap before the in-period rows begin
      doc.moveTo(MARGIN.left, y + 1)
        .lineTo(MARGIN.left + TABLE_WIDTH, y + 1)
        .strokeColor(THEME.PRIMARY).lineWidth(0.5).stroke();
      y += 6;
      zebra = false; // first in-period row starts un-zebraed for clarity
      continue;
    } else if (row.kind === 'payment' || row.kind === 'credit_note') {
      cells = [
        formatDate(row.orderDate),
        typeLabel(row),
        narration,
        '-', '', '', '', '',
        formatMoney(row.totalAmount),
        formatMoney(row.receivedAmount),
        formatMoney(row.dueAmount),
        '',
      ];
    } else if (row.kind === 'empties_return') {
      // Q3 (2026-07-09) — stock-only row. Narration ("Empties: 50× 19 KG")
      // is the whole payload; all money cells render as "-" so it reads
      // as a non-money event. Total / Due carry forward unchanged (the
      // running balance is untouched by this row — see the emit in
      // paymentService.getCustomerLedger which does not touch the
      // cumulative accumulators).
      cells = [
        formatDate(row.orderDate),
        typeLabel(row),
        narration,
        '-', '-', '-', '-', '-',
        formatMoney(row.totalAmount),
        '-',
        formatMoney(row.dueAmount),
        '-',
      ];
    } else {
      // invoice / debit_note / adjustment — render full detail
      if (row.fullCylsDelivered > 0) totalDelivered += row.fullCylsDelivered;
      if (row.emptyCylsCollected > 0) totalCollected += row.emptyCylsCollected;
      cells = [
        formatDate(row.orderDate),
        typeLabel(row),
        narration,
        row.fullCylsDelivered ? num(row.fullCylsDelivered) : '',
        formatMoney(row.amount),
        row.emptyCylsCollected ? num(row.emptyCylsCollected) : '',
        row.pendingEmptyCyls ? num(row.pendingEmptyCyls) : '',
        row.emptyCylsCost ? formatMoney(row.emptyCylsCost) : '',
        formatMoney(row.totalAmount),
        formatMoney(row.receivedAmount),
        formatMoney(row.dueAmount),
        formatMoney(row.overDueAmount),
      ];
    }
    y += drawRow(doc, y, cells, { zebra });
    zebra = !zebra;

    // Accumulate per-page state AFTER drawing — keeps the page-break
    // pre-check above accurate. lastTotalAmount / lastDueAmount track the
    // cumulative running balance at the end of the row just drawn so the
    // page-subtotal row can show where the running figures stood at page
    // end (NOT a sum of cumulative values, which would be meaningless).
    pageHasData = true;
    if (row.fullCylsDelivered > 0) pageDelivered += row.fullCylsDelivered;
    if (row.emptyCylsCollected > 0) pageCollected += row.emptyCylsCollected;
    if (row.amount > 0) pageAmount += row.amount;
    if (row.emptyCylsCost > 0) pageEmptyCost += row.emptyCylsCost;
    if (row.receivedAmount > 0) pageReceived += row.receivedAmount;
    lastTotalAmount = row.totalAmount;
    lastDueAmount = row.dueAmount;
  }

  // ── Final-page subtotal (only when multi-page) ──
  // On a single-page statement the grand "Total" row covers everything;
  // showing a page-1 subtotal AND a grand total would be redundant. On
  // a multi-page statement, the last page also deserves a subtotal so
  // every page has a footer summary.
  if (pageNum > 1) {
    emitPageSubtotal();
  }

  // ── Summary / Closing Balance row ──
  if (y + ROW_HEIGHT + 4 > PAGE_HEIGHT - MARGIN.bottom - 20) {
    // If we're already multi-page and the summary doesn't fit, flush any
    // unflushed page state. (pageHasData is normally false here because
    // the final-page subtotal above already emitted, but a summary-only
    // page break can still happen on a single-page case — pageNum guard
    // prevents a spurious "Page 1 subtotal" row in that case.)
    if (pageNum > 1) emitPageSubtotal();
    doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
    pageNum += 1;
    y = MARGIN.top;
    y += drawTableHeader(doc, y);
  }
  doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  const s = ledger.summary;
  const summaryCells = [
    'Total', '', '',
    num(totalDelivered), formatMoney(s.totalAmount),
    num(totalCollected), num(Math.max(0, totalOpeningPending + totalDelivered - totalCollected)),
    formatMoney(s.emptyCylsCost), formatMoney(s.totalAmount),
    formatMoney(s.receivedAmount), formatMoney(s.dueAmount), formatMoney(s.overdueAmount),
  ];
  y += drawRow(doc, y + 1, summaryCells, { bold: true });

  // Final "Closing Balance" line so the reader sees the carry-forward figure
  // explicitly, matching the format Suneel confirmed.
  y += 4;
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.PRIMARY);
  doc.text(
    `Closing Balance: ${formatMoney(s.dueAmount)} Dr`,
    MARGIN.left + TABLE_WIDTH - 250,
    y,
    { width: 250, align: 'right' },
  );
  doc.fillColor(THEME.TEXT);
  y += 16;

  // ── Footer ──
  // 2026-07-19: self-authorising disclaimer aligned with invoice /
  // credit / debit PDF footers so no rubber-stamp is expected.
  y += 18;
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(`This is a ${sellerName}-authorised, auto-generated statement.`, MARGIN.left, y, { width: TABLE_WIDTH, align: 'center' });
  y += 12;
  doc.text('No signature or stamp is required to validate this document.', MARGIN.left, y, { width: TABLE_WIDTH, align: 'center' });

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}

// ─── Feature A (2026-07-15): group consolidated ledger PDF ─────────────
//
// Chronological merged view across all group member customers.
//
// 2026-07-19 refresh: the original 6-column layout (Date | Type |
// Narration | Amount | Balance | Property) diverged from the single-
// customer PDF and made cross-referencing a specific property's row
// against the customer's own statement painful. Customer HQ readers
// asked for parity — same columns, same visual language, plus one
// Property column identifying which member the row belongs to.
//
// Layout now mirrors the individual PDF: 13 columns totalling 762pt
// on landscape A4. Property inserted at index 1 (right after Date) so
// the customer identifier reads front-of-eye. The remaining 12 columns
// keep the same order as the individual PDF; per-column widths are
// tightened proportionally to free 86pt for Property.
//
//   Individual (12): Date 64 | Type 50 | Narration 108 | DelF 30 |
//     Amount 68 | EmpC 34 | PendE 34 | EmpCost 70 | TotalAmt 84 |
//     Received 68 | DueAmt 76 | Overdue 76  = 762pt
//   Group (13):     Date 64 | Property 86 | Type 46 | Narration 78 |
//     DelF 26 | Amount 62 | EmpC 30 | PendE 30 | EmpCost 62 |
//     TotalAmt 76 | Received 62 | DueAmt 70 | Overdue 70  = 762pt

const GROUP_COLS: Col[] = [
  { label: 'Date', width: 64, align: 'left' },
  { label: 'Property', width: 86, align: 'left' },
  { label: 'Type', width: 46, align: 'left' },
  { label: 'Narration', width: 78, align: 'left' },
  { label: 'Del F', width: 26, align: 'right' },
  { label: 'Amount', width: 62, align: 'right' },
  { label: 'Emp C', width: 30, align: 'right' },
  { label: 'Pend E', width: 30, align: 'right' },
  { label: 'Emp Cost', width: 62, align: 'right' },
  { label: 'Total Amt', width: 76, align: 'right' },
  { label: 'Received', width: 62, align: 'right' },
  { label: 'Due Amt', width: 70, align: 'right' },
  { label: 'Overdue', width: 70, align: 'right' },
];
const GROUP_TABLE_WIDTH = GROUP_COLS.reduce((s, c) => s + c.width, 0);
// Per-column character caps. Property (86pt) needs the widest cap —
// hotel names like "Royal Kitchen & Caterers" (25 chars) should fit,
// longer ones ellipsise. Amount/Received caps drop slightly from the
// individual PDF (14→13) — the crore-scale ceiling still fits, only
// the pathological "Rs. 99,99,999.00" (16) truncates by one char.
const GROUP_COL_CHAR_CAP: number[] = [
  11, // Date         — "07-Jul-2026"
  16, // Property     — hotel/business names, ellipsised for longer
  9,  // Type         — "Empties" (7), "Payment" (7) fit
  14, // Narration    — tighter than individual (20) to make room for Property
  4,  // Del F        — 0-999
  13, // Amount       — "Rs. 9,99,999.00" (15) truncates 2 chars, most fit
  4,  // Emp C
  4,  // Pend E
  12, // Emp Cost
  14, // Total Amt    — cumulative running balance
  14, // Received     — 2026-07-20 bumped 12→14 so "Rs. 12,852.00" (13 chars)
      //                stops truncating to "Rs. 12,852.…" on payment rows
  13, // Due Amt
  13, // Overdue
];

// Sanity check — 762pt landscape budget MUST be respected. If a future
// column-width edit drifts, throw at import time rather than ship a
// PDF with a silent overflow into the right margin.
if (GROUP_TABLE_WIDTH !== TABLE_WIDTH) {
  throw new Error(
    `GROUP_TABLE_WIDTH (${GROUP_TABLE_WIDTH}) must equal individual TABLE_WIDTH (${TABLE_WIDTH})`,
  );
}

/**
 * Chronologically-merged group ledger PDF. Layout mirrors the single-
 * customer PDF's letterhead pattern; the table is deliberately simpler
 * (6 columns) because the HQ persona reads for reconciliation, not
 * per-cylinder delivery detail.
 */
export async function generateGroupLedgerPdf(
  distributorId: string,
  visibleCustomerIds: string[],
  groupName: string,
  range?: { from?: string; to?: string; customerId?: string },
  // 2026-07-20: per-membership alias map. Passed through to
  // getGroupLedger so the Property column shows the alias when set —
  // consistent with the mobile/web ledger table and the property
  // picker. See DisplayNameMap contract in customerGroupPortalService.
  displayNames?: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  const ledger = await getGroupLedger(
    distributorId,
    visibleCustomerIds,
    {
      from: range?.from,
      to: range?.to,
      customerId: range?.customerId,
    },
    displayNames,
  );

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  const rightEdge = PAGE_WIDTH - MARGIN.right;
  let y = MARGIN.top;

  // ── Header: distributor letterhead ──
  const sellerName = distributor.businessName || distributor.legalName;
  const sellerAddr = [distributor.address, distributor.city, distributor.state, distributor.pincode]
    .filter(Boolean).join(', ') || '—';

  doc.font('Helvetica-Bold').fontSize(Math.round(TYPO.H2 * 1.5)).fillColor(THEME.PRIMARY);
  doc.text(sellerName, MARGIN.left, y, { width: 400 });
  let leftY = y + 18;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(sellerAddr, MARGIN.left, leftY, { width: 400 }); leftY += 11;
  doc.text(`GSTIN: ${distributor.gstin || '—'}   Phone: ${distributor.phone || '—'}`, MARGIN.left, leftY, { width: 400 });
  leftY += 11;

  doc.font('Helvetica-Bold').fontSize(TYPO.H1).fillColor(THEME.PRIMARY);
  doc.text('Group Statement', rightEdge - 250, y, { width: 250, align: 'right' });

  y = Math.max(leftY, y + 36) + 4;
  doc.moveTo(MARGIN.left, y).lineTo(rightEdge, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 10;

  // ── Group + range block ──
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.TEXT);
  doc.text(groupName, MARGIN.left, y); y += 14;
  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.MUTED);
  const rangeLabel = range?.from || range?.to
    ? `Period: ${range?.from ?? '—'} to ${range?.to ?? '—'}`
    : 'Period: all time';
  doc.text(rangeLabel, MARGIN.left, y);
  const memberCount = new Set(ledger.rows.map((r) => r.customerId)).size;
  doc.text(`Properties: ${memberCount}`, MARGIN.left + 250, y);
  y += 20;

  // 2026-07-20 — group overdue now comes straight from
  // ledger.totals.overdue (getGroupLedger sums summary.overdueAmount
  // across every member's processLedgerEntries call). Removed the
  // ad-hoc last-row-per-customer scan.
  const groupOverdue = ledger.totals.overdue;

  // ── Period Summary block (2026-07-20) — 5 tiles ──
  // Passes `opening` → drawPeriodSummary switches to 5-tile layout:
  // Opening · Debited (period) · Received (period) · Closing · Overdue.
  // Identity: opening + debited − received === closing. This
  // reconciles to the visible rows even when the group has pre-range
  // entries (see paymentService periodDebited / periodReceived).
  y = drawPeriodSummary(doc, y, {
    opening: ledger.totals.openingBalance,
    debited: ledger.totals.periodDebited,
    received: ledger.totals.periodReceived,
    netOutstanding: ledger.totals.closingBalance,
    overdue: ledger.totals.overdue,
    tableWidth: GROUP_TABLE_WIDTH,
  });

  // Indicative-cost note — matches the individual PDF so readers see
  // consistent boilerplate above the entries table.
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(
    'Empty cylinder costs are indicative only. Charges apply only for missing cylinders.',
    MARGIN.left, y,
  );
  y += 16;

  // ── Table header ──
  const drawGroupHeader = (yy: number): number => {
    let x = MARGIN.left;
    doc.rect(MARGIN.left, yy, GROUP_TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
    for (const c of GROUP_COLS) {
      doc.text(c.label, x + 3, yy + 4, {
        width: c.width - 6,
        align: c.align,
        lineBreak: false,
        ellipsis: true,
      });
      x += c.width;
    }
    doc.fillColor(THEME.TEXT);
    return ROW_HEIGHT + 2;
  };

  const drawGroupRow = (
    yy: number,
    cells: string[],
    opts: { bold?: boolean; zebra?: boolean } = {},
  ): number => {
    if (opts.zebra) {
      doc.rect(MARGIN.left, yy, GROUP_TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
    }
    doc.fillColor(THEME.TEXT).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
    let x = MARGIN.left;
    for (let i = 0; i < GROUP_COLS.length; i++) {
      const text = fitCell(cells[i] ?? '', GROUP_COL_CHAR_CAP[i] ?? 999);
      doc.text(text, x + 3, yy + 4, {
        width: GROUP_COLS[i].width - 6,
        align: GROUP_COLS[i].align,
        lineBreak: false,
        ellipsis: true,
      });
      x += GROUP_COLS[i].width;
    }
    return ROW_HEIGHT;
  };

  // Type/narration helpers — mirror the individual PDF so a hotel HQ
  // reader sees the same labels ("Payment", "Empties", "19 KG") that
  // the underlying customer statement uses.
  function groupTypeLabel(row: typeof ledger.rows[number]): string {
    switch (row.kind) {
      // 2026-07-21: group PDF surfaces cylinder type name on OB rows
      // when the customer had seeded empties (per-type emit). Blank
      // fallback when it's a money-only OB row.
      case 'opening': return row.cylinderType || '';
      case 'payment': return 'Payment';
      case 'credit_note': return 'Credit';
      case 'debit_note': return 'Debit';
      case 'adjustment': return 'Adj';
      case 'empties_return': return 'Empties';
      case 'invoice': return row.cylinderType || 'Invoice';
      default: return row.cylinderType === '' ? 'Payment' : (row.cylinderType || 'Invoice');
    }
  }
  function groupShortNarration(raw: string | null, kind: string | null): string {
    if (!raw) return '';
    let s = raw;
    const orderIdx = s.indexOf(' for order');
    if (orderIdx >= 0) s = s.slice(0, orderIdx);
    if (kind === 'invoice') return s.replace(/^Invoice\s+/i, '');
    if (kind === 'credit_note') return s.replace(/^Credit Note\s+/i, '');
    if (kind === 'debit_note') return s.replace(/^Debit Note\s+/i, '');
    if (kind === 'payment') return '';
    return s;
  }

  y += drawGroupHeader(y);

  // ── Rows ──
  let zebra = false;
  let totalDelivered = 0;
  let totalCollected = 0;
  // 2026-07-21 — group PDF mirrors the individual PDF: Total row Pend E
  // = OB seeded + delivered − collected (cumulative closing pending),
  // not (delivered − collected). Reason enumerated at the individual
  // PDF's totalOpeningPending declaration above.
  let totalOpeningPending = 0;
  for (const row of ledger.rows) {
    // Page break reservation matches the individual PDF: leave room
    // for one row plus a small footer buffer so nothing clips at the
    // page foot.
    const baseNeeded = row.kind === 'opening' ? ROW_HEIGHT + 12 : ROW_HEIGHT;
    if (y + baseNeeded + ROW_HEIGHT + 4 > PAGE_HEIGHT - MARGIN.bottom - 30) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
      y = MARGIN.top;
      y += drawGroupHeader(y);
      zebra = false;
    }

    const property = row.customerName;
    const type = groupTypeLabel(row);
    const narration = groupShortNarration(row.narration, row.kind);
    let cells: string[];

    if (row.kind === 'opening') {
      y += 4;
      // 2026-07-21 opening-state seed: group PDF surfaces the seeded
      // empties in Pend E column just like the individual PDF. Just
      // the number — no "b/f" suffix (context is clear from Narration).
      totalOpeningPending += row.pendingEmptyCyls || 0;
      const pendE = row.pendingEmptyCyls > 0 ? String(row.pendingEmptyCyls) : '';
      // 2026-07-21 — Emp Cost carries per-type OB empty liability; see
      // the identical block on the individual PDF above.
      const empCost = (row.emptyCylsCost || 0) > 0 ? formatMoney(row.emptyCylsCost) : '';
      cells = [
        formatDate(new Date(row.orderDate)),
        property, type, narration,
        '', '', '',
        pendE,
        empCost,
        formatMoney(row.totalAmount),
        '',
        formatMoney(row.dueAmount),
        '',
      ];
      y += drawGroupRow(y, cells, { bold: true });
      doc.moveTo(MARGIN.left, y + 1)
        .lineTo(MARGIN.left + GROUP_TABLE_WIDTH, y + 1)
        .strokeColor(THEME.PRIMARY).lineWidth(0.5).stroke();
      y += 6;
      zebra = false;
      continue;
    } else if (row.kind === 'payment' || row.kind === 'credit_note') {
      cells = [
        formatDate(new Date(row.orderDate)),
        property, type, narration,
        '-', '', '', '', '',
        formatMoney(row.totalAmount),
        formatMoney(row.receivedAmount),
        formatMoney(row.dueAmount),
        '',
      ];
    } else if (row.kind === 'empties_return') {
      cells = [
        formatDate(new Date(row.orderDate)),
        property, type, narration,
        '-', '-', '-', '-', '-',
        formatMoney(row.totalAmount),
        '-',
        formatMoney(row.dueAmount),
        '-',
      ];
    } else {
      // invoice / debit_note / adjustment — full detail
      if (row.fullCylsDelivered > 0) totalDelivered += row.fullCylsDelivered;
      if (row.emptyCylsCollected > 0) totalCollected += row.emptyCylsCollected;
      cells = [
        formatDate(new Date(row.orderDate)),
        property, type, narration,
        row.fullCylsDelivered ? num(row.fullCylsDelivered) : '0',
        formatMoney(row.amount),
        // 2026-07-20 — always show 0 for empties collected (blank was
        // ambiguous with the "no data" case); dash for empty-cost when
        // zero so the money column reads consistently.
        num(row.emptyCylsCollected ?? 0),
        num(row.pendingEmptyCyls ?? 0),
        row.emptyCylsCost > 0 ? formatMoney(row.emptyCylsCost) : '-',
        formatMoney(row.totalAmount),
        formatMoney(row.receivedAmount),
        formatMoney(row.dueAmount),
        formatMoney(row.overDueAmount ?? 0),
      ];
    }
    y += drawGroupRow(y, cells, { zebra });
    zebra = !zebra;
  }

  // ── Group totals row ──
  if (y + ROW_HEIGHT + 4 > PAGE_HEIGHT - MARGIN.bottom - 30) {
    doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
    y = MARGIN.top;
    y += drawGroupHeader(y);
  }
  doc.moveTo(MARGIN.left, y)
    .lineTo(MARGIN.left + GROUP_TABLE_WIDTH, y)
    .strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  const t = ledger.totals;
  const totalsCells = [
    'Total', '', '', '',
    num(totalDelivered), formatMoney(t.totalDebited),
    num(totalCollected), num(Math.max(0, totalOpeningPending + totalDelivered - totalCollected)),
    '', formatMoney(t.totalDebited),
    formatMoney(t.totalReceived), formatMoney(t.netOutstanding),
    formatMoney(groupOverdue),
  ];
  y += drawGroupRow(y + 1, totalsCells, { bold: true });

  // Closing Balance line — matches the individual PDF's format.
  y += 4;
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.PRIMARY);
  doc.text(
    `Group Closing Balance: ${formatMoney(t.netOutstanding)} Dr`,
    MARGIN.left + GROUP_TABLE_WIDTH - 300,
    y,
    { width: 300, align: 'right' },
  );
  doc.fillColor(THEME.TEXT);
  y += 16;

  // ── Footer ──
  y += 12;
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(`This is a ${sellerName}-authorised, auto-generated group statement.`, MARGIN.left, y, { width: GROUP_TABLE_WIDTH, align: 'center' });
  y += 12;
  doc.text('No signature or stamp is required to validate this document.', MARGIN.left, y, { width: GROUP_TABLE_WIDTH, align: 'center' });

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
