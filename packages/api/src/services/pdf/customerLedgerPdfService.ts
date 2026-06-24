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

const COLS: Col[] = [
  { label: 'Date', width: 58, align: 'left' },
  { label: 'Type', width: 64, align: 'left' },
  { label: 'Narration', width: 110, align: 'left' },
  { label: 'Delivered', width: 46, align: 'right' },
  { label: 'Amount', width: 70, align: 'right' },
  { label: 'Empties Coll.', width: 52, align: 'right' },
  { label: 'Pending Emp.', width: 52, align: 'right' },
  { label: 'Empties Cost', width: 64, align: 'right' },
  { label: 'Total Amount', width: 74, align: 'right' },
  { label: 'Received', width: 68, align: 'right' },
  { label: 'Due Amount', width: 70, align: 'right' },
  { label: 'Overdue', width: 60, align: 'right' },
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
// money + en-IN locale grouping fits in 12 chars even for crore figures),
// but the Type and Narration columns receive free text and need clamping.
// Indexed to match the COLS array order.
const COL_CHAR_CAP: number[] = [
  10, // Date
  12, // Type — handles "Opening Balance", "Credit Note", real cylinder names
  18, // Narration — fits "Invoice RSHD2627025053" exactly
  6,  // Delivered
  12, // Amount
  6,  // Empties Coll.
  6,  // Pending Emp.
  12, // Empties Cost
  14, // Total Amount
  12, // Received
  12, // Due Amount
  12, // Overdue
];

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const col of COLS) {
    doc.text(col.label, x + 3, y + 4, { width: col.width - 6, align: col.align });
    x += col.width;
  }
  doc.fillColor(THEME.TEXT);
  return ROW_HEIGHT + 2;
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
    const cells = [
      '',
      `Page ${pageNum} subtotal`,
      '',
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
      case 'opening': return 'Opening Balance';
      case 'payment': return 'Payment';
      case 'credit_note': return 'Credit Note';
      case 'debit_note': return 'Debit Note';
      case 'adjustment': return 'Adjustment';
      case 'invoice': return row.cylinderType || 'Invoice';
      default: return row.cylinderType === '' ? 'Payment' : (row.cylinderType || 'Invoice');
    }
  }

  // Customer-facing PDF: strip the " for order ORD-..." suffix from
  // invoiceService.ts:266 narrations so the column fits in a single line.
  // The admin in-app ledger keeps the full verbose narration; only the
  // customer-facing statement gets the short form.
  function shortNarration(raw: string): string {
    if (!raw) return '';
    const idx = raw.indexOf(' for order');
    return idx >= 0 ? raw.slice(0, idx) : raw;
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

    const narration = shortNarration(row.narration ?? '');
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
      y += 4; // gap above
      cells = [
        formatDate(row.orderDate),
        typeLabel(row),
        narration,
        '', '', '', '', '',
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
    num(totalCollected), num(Math.max(0, totalDelivered - totalCollected)),
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
  y += 18;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text('This is a computer generated statement.', MARGIN.left, y, { width: TABLE_WIDTH });

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
