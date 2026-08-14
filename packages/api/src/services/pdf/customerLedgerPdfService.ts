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
import QRCode from 'qrcode';
import { prisma } from '../../lib/prisma.js';
import { getPdfAccentColor, setPdfAccent, currentPdfAccent } from './pdfTheme.js';
import { getCustomerLedger } from '../paymentService.js';
import { getGroupLedger } from '../customerGroupPortalService.js';
import { formatDate, formatMoney } from './pdfLayoutUtils.js';

// A4 landscape
const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };

const THEME = {
  get PRIMARY() { return currentPdfAccent(); },
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
// 2026-08-14 layout: compact money (no "Rs.", no commas, ≤2dp via ledgerMoney)
// + DD/MM/YY date (ledgerDate) free up space vs the old "Rs. 99,99,999.00"
// budget, which flows to Narration (100→190pt). Headers use FULL words
// ("Delivered Fulls", "Collected Empties", "Pending Empties", "Pending Empties
// Cost", "Total Amount", "Due Amount") and wrap to 2 lines — column widths are
// sized so each label fits in ≤2 lines at caption bold (see drawTableHeader,
// header height bumped to two lines). Money columns: Amount / Pending Empties
// Cost / Received hold the "9999999.99" (10-char) data ceiling; Total Amount /
// Due Amount / Overdue are CUMULATIVE running balances at 62pt so a >1-crore
// account ("12345678.99") still renders in full. TABLE_WIDTH stays 762pt.
const COLS: Col[] = [
  { label: 'Date', width: 44, align: 'left' },
  { label: 'Type', width: 62, align: 'left' },
  { label: 'Narration', width: 186, align: 'left' },
  { label: 'Delivered Fulls', width: 40, align: 'right' },
  { label: 'Amount', width: 54, align: 'right' },
  { label: 'Collected Empties', width: 40, align: 'right' },
  { label: 'Pending Empties', width: 38, align: 'right' },
  { label: 'Pending Empties Cost', width: 58, align: 'right' },
  { label: 'Total Amount', width: 62, align: 'right' },
  { label: 'Received', width: 54, align: 'right' },
  { label: 'Due Amount', width: 62, align: 'right' },
  { label: 'Overdue', width: 62, align: 'right' },
];

const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);
const ROW_HEIGHT = 16;

function num(n: number): string {
  return Number(n || 0).toLocaleString('en-IN');
}

// ── 2026-08-14 statement layout: ledger-local money + date formatters ──
// Deliberately NOT the shared ledgerMoney()/ledgerDate() — those keep
// the "Rs. 25,300.00" + dd/MM/yyyy form for GST invoices / credit notes, which
// have legal formatting expectations. The customer statement (and the group
// statement) use these compact forms only.

// Compact money: no "Rs." prefix, no thousands separators. Whole numbers show
// no decimals ("25300"); fractional amounts show up to 2 dp with a trailing
// zero trimmed ("3500.5", "3500.55"). Matches the customer-requested column
// budget (max "9999999.99").
function ledgerMoney(value: number | null | undefined): string {
  const n = Number(value);
  const safe = value == null || Number.isNaN(n) ? 0 : n;
  const rounded = Math.round(safe * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  const s = rounded.toFixed(2);
  return s.endsWith('0') ? s.slice(0, -1) : s;
}

// 2026-08-14 — the Closing Balance line keeps "Rs." + thousands grouping but
// drops the ".00" on whole amounts ("Rs. 25,300 Dr"), per Suneel. Distinct from
// the TABLE cells (compact ledgerMoney, no "Rs.") and from OTHER off-table
// figures such as "Deposits Held" / the deposit breakdown, which stay on the
// usual formatMoney "Rs. 25,300.00" form.
function ledgerRs(value: number | null | undefined): string {
  const n = Number(value);
  const safe = value == null || Number.isNaN(n) ? 0 : n;
  const rounded = Math.round(safe * 100) / 100;
  const grouped = rounded.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `Rs. ${grouped}`;
}

// Date column: DD/MM/YY (8 chars, e.g. "14/08/26"). Deliberately 2-digit year
// — a customer-facing, width-constrained display choice that diverges from the
// app-wide dd/MM/yyyy standard (the "Period:" sub-header still uses the full
// year via formatDate). TZ-safe: a bare YYYY-MM-DD string is parsed directly,
// never through new Date(str), so it can't roll a day across the UTC/IST
// boundary — same rule as pdfLayoutUtils.ddmmyyyy.
function ledgerDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  let y: number, m: number, day: number;
  if (typeof d === 'string') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (iso) { y = Number(iso[1]); m = Number(iso[2]); day = Number(iso[3]); }
    else {
      const dt = new Date(d);
      if (Number.isNaN(dt.getTime())) return '—';
      y = dt.getFullYear(); m = dt.getMonth() + 1; day = dt.getDate();
    }
  } else {
    if (Number.isNaN(d.getTime())) return '—';
    y = d.getFullYear(); m = d.getMonth() + 1; day = d.getDate();
  }
  return `${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}/${String(y).slice(-2)}`;
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
  8,  // Date          — "14/08/26" (8) via ledgerDate
  12, // Type          — "47.5 metal" (10); ceiling 12 chars
  38, // Narration     — 190pt col ~ 38 chars; long narrations no longer ellipsise
  3,  // Del Full      — 0-999
  10, // Amount        — compact "9999999.99" (10) ceiling; typical 4-6 chars
  3,  // Coll Emp      — 0-999
  3,  // Pend E        — 0-999
  10, // Pend Emp Cost — compact money ceiling (10)
  12, // Total Amt     — cumulative; growable 62pt col holds >1cr "12345678.99" (11)
  10, // Received      — compact money ceiling (10)
  12, // Due Amt       — cumulative; matches Total Amt
  12, // Overdue       — cumulative; matches Total Amt
];

// 2026-08-14 — header height fits TWO caption lines so narrow columns whose
// labels can't fit on one line ("Del Full", "Coll Emp", "Pend Emp Cost") wrap
// cleanly instead of ellipsising or colliding with row 1. Wide-enough labels
// still render on a single line (pdfkit only wraps when the text exceeds the
// column width). ellipsis:true is retained as a safety net for a single word
// longer than its column.
const HEADER_HEIGHT = 27;

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, HEADER_HEIGHT).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const col of COLS) {
    doc.text(col.label, x + 3, y + 4, {
      width: col.width - 6,
      align: col.align,
      lineBreak: true,
      ellipsis: true,
    });
    x += col.width;
  }
  doc.fillColor(THEME.TEXT);
  return HEADER_HEIGHT;
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

  // Period-summary tiles sit ABOVE the entries table, so per Suneel (2026-08-14)
  // they use the usual "Rs. 25,300.00" formatMoney form, not the table's
  // compact ledgerMoney.
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
  opts: { bold?: boolean; zebra?: boolean; cancelled?: boolean } = {},
): number {
  // 2026-07-23 Mini-op delivered-cancel: cancelled ledger rows carry a
  // "Cancelled:" narration prefix and a NEGATIVE amount (reversal).
  // Renderer paints them with:
  //   - Light-gray row background (distinguishes from active debits)
  //   - Red text on the money columns (Amount + Due Amt cells)
  //   - Bold face for the narration to emphasise the cancel event
  // Cell contents come from the caller unchanged; visual treatment is
  // pure PDF styling. Detection happens at the emit site by inspecting
  // the row's narration + kind before calling drawRow.
  if (opts.cancelled) {
    doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill('#f1f5f9');
  } else if (opts.zebra) {
    doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  }
  doc.fillColor(THEME.TEXT).font(opts.bold || opts.cancelled ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
  let x = MARGIN.left;
  for (let i = 0; i < COLS.length; i++) {
    // lineBreak:false forces single-line rendering inside the cell width
    // (pdfkit otherwise wraps onto a second line that overlaps the next
    // row). fitCell ellipsises the source text so the visible content
    // matches what was actually rendered.
    const text = fitCell(cells[i] ?? '', COL_CHAR_CAP[i] ?? 999);
    // Money columns (Amount=idx 4, Total Amt=8, Received=9, Due Amt=10)
    // render in red for cancelled rows so the negative delta reads at
    // a glance.
    const isMoneyCol = i === 4 || i === 8 || i === 9 || i === 10;
    if (opts.cancelled && isMoneyCol) {
      doc.fillColor('#dc2626');
    } else {
      doc.fillColor(THEME.TEXT);
    }
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
  setPdfAccent(await getPdfAccentColor(distributorId ?? ''));
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
      // 2026-07-28 — mini-op tenants get cancelled-order pairs hidden from
      // their customer statements (both the original invoice_entry and its
      // paired 'adjustment' reversal). Regular distributors keep the full
      // audit trail on the statement so their accountants can see the
      // reversal. DB rows are unchanged — this is a render-time filter only.
      accountType: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  // 2026-08-14 — hide cancelled-order pairs on EVERY customer statement, not
  // just mini-op. The original 2026-07-28 design kept them visible for regular
  // distributors "so accountants can see the reversal", but in practice that
  // (a) surfaced the double-count / fake-"Received" engine bug to customers and
  // (b) confused customers who never placed the cancelled (wrong-customer)
  // order. The audit trail now lives in the dedicated cancelled-orders report
  // and the in-app operator ledger tab (which reads raw CustomerLedgerEntry
  // rows and still shows every cancellation). The filter drops ONLY the
  // invoice_entry for a cancelled invoice + its paired 'Cancelled:' adjustment;
  // any real credit_note / payment row against that invoice still renders — so
  // a cancellation that had a CN raised keeps its money trail visible.
  const ledger = await getCustomerLedger(distributorId, customerId, range, {
    hideCancelledInvoices: true,
  });

  // Change M (2026-07-31 v9): scan-to-pay UPI QR — same intent format
  // invoicePdfService uses (mini-op #6 v2 — amount-free so customer
  // can pay any partial amount, `tn` note carries the customer id for
  // reconciliation). Silently skipped when distributor has no UPI ID.
  let upiQrPng: Buffer | undefined;
  if (distributor.upiId) {
    try {
      const payee = encodeURIComponent(distributor.businessName || distributor.legalName || '');
      const note = encodeURIComponent(`Statement ${customer.customerName}`);
      const upiUrl =
        `upi://pay?pa=${encodeURIComponent(distributor.upiId)}` +
        `&pn=${payee}` +
        `&cu=INR` +
        `&tn=${note}`;
      upiQrPng = await QRCode.toBuffer(upiUrl, { type: 'png', width: 100, margin: 1 });
    } catch {
      upiQrPng = undefined;
    }
  }

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

  // Change M (2026-07-31 v9; centered on page 2026-08-14): scan-to-pay UPI QR,
  // centered on the PAGE (between the left letterhead and the right title).
  // Only renders when upiId is configured — legacy statements without UPI keep
  // the original two-column header untouched.
  if (upiQrPng) {
    const qrSize = 70;
    const qrX = (PAGE_WIDTH - qrSize) / 2;
    doc.image(upiQrPng, qrX, y, { fit: [qrSize, qrSize] });
    doc.font('Helvetica').fontSize(TYPO.CAPTION - 1).fillColor(THEME.MUTED);
    doc.text('Scan to pay', qrX - 10, y + qrSize + 2, {
      width: qrSize + 20, align: 'center',
    });
  }

  y = Math.max(leftY, y + 36) + 4;
  // If QR rendered, its bottom-of-caption sits at y + 70 + ~12 = 82;
  // push the divider down if we haven't already crossed that.
  if (upiQrPng) y = Math.max(y, MARGIN.top + 84);
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
      pageAmount ? ledgerMoney(pageAmount) : '',
      pageCollected ? num(pageCollected) : '',
      '',
      pageEmptyCost ? ledgerMoney(pageEmptyCost) : '',
      ledgerMoney(lastTotalAmount),
      pageReceived ? ledgerMoney(pageReceived) : '',
      ledgerMoney(lastDueAmount),
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
      // F1 (2026-08-06) — 9-char label fits inside the Type column cap.
      // "Def Ret" reads as "Defective Return" — narration carries the
      // full context ("Defective: 1× 19 KG from INV-XXX (pending CN)").
      case 'defective_collected': return 'Def Ret';
      // Deposit ledger (2026-07-31 v3): Type column stays as an event
      // label ("Deposit" / "Refund") — same treatment as Payment /
      // Empties / Adjustment rows. The cylinder type appears in the
      // Narration column ("2 × 19 KG @ Rs. 1950.00") so readers see the
      // event kind at a glance without confusing it with an invoice-
      // type-per-row layout.
      case 'deposit_charged': return 'Deposit';
      case 'deposit_refunded': return 'Refund';
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
    // Payment rows: 2026-07-31 v2 — DO show the method + ref. Pre-fix
    // this was blank, which made mixed deposit+invoice payments look
    // like anonymous debits. Strip only the "Payment received via "
    // prefix so the cell reads "cash (Ref: TXN123)" or just "cash".
    if (kind === 'payment') return s.replace(/^Payment received via\s+/i, '');
    // 2026-07-31 v3 — Deposit rows: Type column already shows the
    // cylinder type name, so the "Deposit received: " / "Deposit
    // refunded: " prefix eats useful chars in the narrow Narration
    // column. Strip it for BOTH new-format ("2 × 19 KG") and legacy
    // rows ("Deposit received: 2 × 19 KG @ ₹1950.00") so the narration
    // renders compactly regardless of when the row was written.
    if (kind === 'deposit_charged') return s.replace(/^Deposit received:\s*/i, '');
    if (kind === 'deposit_refunded') return s.replace(/^Deposit refunded:\s*/i, '');
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
      // v10 (Change N): "-" fallback instead of empty string.
      const empCost = (row.emptyCylsCost || 0) > 0 ? ledgerMoney(row.emptyCylsCost) : '-';
      const pendEDash = pendE || '-';
      cells = [
        ledgerDate(row.orderDate),
        typeLabel(row),
        narration,
        '-', '-', '-',
        pendEDash,
        empCost,
        ledgerMoney(row.totalAmount),
        '-',
        ledgerMoney(row.dueAmount),
        '-',
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
        ledgerDate(row.orderDate),
        typeLabel(row),
        narration,
        // v10 (Change N): "-" in every non-applicable cell for
        // payment/credit_note rows so no cell reads as accidentally
        // blank (was: mix of "-" and empty strings).
        '-', '-', '-', '-', '-',
        ledgerMoney(row.totalAmount),
        ledgerMoney(row.receivedAmount),
        ledgerMoney(row.dueAmount),
        '-',
      ];
    } else if (row.kind === 'empties_return') {
      // Q3 (2026-07-09) — stock-only row. Narration ("Empties: 50× 19 KG")
      // is the whole payload; money cells render as "-" so it reads as a
      // non-money event. Total / Due carry forward unchanged.
      //
      // 2026-07-27 — Fix 1. Emp C now shows the returned qty (populated by
      // paymentService.getCustomerLedger's Fix 1 path) and Pend E shows
      // the running counter AFTER this row's decrement. Also feed the
      // qty into totalCollected so the Total row's Pend E formula
      // (openingSeeded + delivered − collected) subtracts standalone
      // returns — before this fix the Total over-reported by the
      // returned qty on every statement that had a standalone return.
      //
      // 2026-07-31 v5 (Change F) — per-type Pend E + per-type Emp Cost,
      // matching the invoice/deposit row treatment. The row now also
      // populates the Emp Cost cell (was hardcoded '-' before).
      if (row.emptyCylsCollected > 0) totalCollected += row.emptyCylsCollected;
      cells = [
        ledgerDate(row.orderDate),
        typeLabel(row),
        narration,
        '-', '-',
        row.emptyCylsCollected > 0 ? num(row.emptyCylsCollected) : '-',
        row.pendingEmptyCyls > 0 ? num(row.pendingEmptyCyls) : '-',
        (row.emptyCylsCost ?? 0) > 0 ? ledgerMoney(row.emptyCylsCost) : '-',
        ledgerMoney(row.totalAmount),
        '-',
        ledgerMoney(row.dueAmount),
        '-',
      ];
    } else if (row.kind === 'defective_collected') {
      // F1 (2026-08-06) — physical-only defective full pickup row.
      // Narration carries context ("Defective: 1× 19 KG from INV-XXX
      // (pending CN)"). Del Full renders as a NEGATIVE quantity so the
      // reader sees "1 full went back" — Suneel spec (2026-08-06):
      // "shouldn't [it] be deducted from fulls?". Money side (Amount)
      // stays "-" because the actual money lands as a separate
      // credit_note row when Raise CN fires. Coll Emp / Pend E stay "-"
      // because defective fulls are a different category from empties
      // owed — they don't feed the pending-empties counter. Total /
      // Due carry forward unchanged from the previous row.
      // Parse the qty out of the narration ("Defective: N× ...").
      const defQty = (() => {
        const m = /^Defective:\s*(\d+)/.exec(narration);
        return m ? parseInt(m[1], 10) : 0;
      })();
      // F1-FIX-7 (2026-08-06): defective deduction must flow into the
      // Del Full subtotal too — otherwise Page/Total subtotals over-report
      // by the defective qty. Subtract from totalDelivered so the sum
      // reflects "fulls that stayed with customer this period".
      if (defQty > 0) totalDelivered -= defQty;
      cells = [
        ledgerDate(row.orderDate),
        typeLabel(row),
        narration,
        defQty > 0 ? `-${defQty}` : '-',
        '-', '-', '-', '-',
        ledgerMoney(row.totalAmount),
        '-',
        ledgerMoney(row.dueAmount),
        '-',
      ];
    } else {
      // invoice / debit_note / adjustment / deposit_charged /
      // deposit_refunded — render full detail. Special-case handling
      // for the Total-row accumulators:
      //   - deposit_refunded: emptyCylsCollected shows the qty (cylinder
      //     came back to depot, informational) but MUST NOT feed into
      //     renderer.totalCollected. The service's per-type Emp Cost
      //     calc deliberately excludes refunds (2026-07-31 v3 accounting:
      //     refund reduces deposit-held, not refill-pending). Including
      //     it here would make Pend E and Emp Cost disagree on the Total
      //     row (bug caught 2026-07-31 v4 — Maruthi Pend E=11 vs
      //     Emp Cost=45,750-implied-13 mismatch).
      //   - deposit_charged: both service and renderer count it, so it
      //     stays in totalCollected — no change.
      if (row.fullCylsDelivered > 0) totalDelivered += row.fullCylsDelivered;
      if (row.emptyCylsCollected > 0 && row.kind !== 'deposit_refunded') {
        totalCollected += row.emptyCylsCollected;
      }
      cells = [
        ledgerDate(row.orderDate),
        typeLabel(row),
        narration,
        // 2026-07-31 v10 (Change N): show "-" instead of empty string
        // when a numeric column is zero/absent — keeps every cell
        // visually populated so no reader misreads a blank as "not
        // applicable to this row".
        row.fullCylsDelivered ? num(row.fullCylsDelivered) : '-',
        ledgerMoney(row.amount),
        row.emptyCylsCollected ? num(row.emptyCylsCollected) : '-',
        row.pendingEmptyCyls ? num(row.pendingEmptyCyls) : '-',
        row.emptyCylsCost ? ledgerMoney(row.emptyCylsCost) : '-',
        ledgerMoney(row.totalAmount),
        ledgerMoney(row.receivedAmount),
        ledgerMoney(row.dueAmount),
        ledgerMoney(row.overDueAmount),
      ];
    }
    // 2026-07-23 — cancelled-row visual treatment. Detect via the
    // "Cancelled:" narration prefix set by orderService.cancelOrder's
    // reversal ledger emit. Applies to individual customer PDF.
    const isCancelled = (row.narration ?? '').startsWith('Cancelled:');
    y += drawRow(doc, y, cells, { zebra, cancelled: isCancelled });
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
    num(totalDelivered), ledgerMoney(s.totalAmount),
    num(totalCollected), num(Math.max(0, totalOpeningPending + totalDelivered - totalCollected)),
    ledgerMoney(s.emptyCylsCost), ledgerMoney(s.totalAmount),
    ledgerMoney(s.receivedAmount), ledgerMoney(s.dueAmount), ledgerMoney(s.overdueAmount),
  ];
  y += drawRow(doc, y + 1, summaryCells, { bold: true });

  // v12 (2026-07-31): Closing Balance (right) and Deposits Held (left)
  // render on the SAME row so the reader sees both money-side summary
  // figures at a glance. Per-cylinder-type breakdown lines render
  // below Deposits Held on the left column, still left-aligned.
  y += 4;
  const summaryRowY = y;
  const halfWidth = TABLE_WIDTH / 2 - 8;

  // Right — Closing Balance (unchanged position).
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.PRIMARY);
  doc.text(
    `Closing Balance: ${ledgerRs(s.dueAmount)} Dr`,
    MARGIN.left + TABLE_WIDTH - 250,
    summaryRowY,
    { width: 250, align: 'right' },
  );

  // Left — Deposits Held + per-type breakdown. Only rendered when
  // customer has any refundable deposit with us. Skipped entirely
  // otherwise — zero visual change for customers who don't use the feature.
  const breakdown = s.depositBreakdown ?? [];
  const totalDeposit = breakdown.reduce((sum, b) => sum + b.amount, 0);
  let leftBlockY = summaryRowY;
  if (breakdown.length > 0 && totalDeposit > 0.005) {
    doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.PRIMARY);
    doc.text(
      `Deposits Held: ${formatMoney(totalDeposit)}`,
      MARGIN.left, summaryRowY,
      { width: halfWidth, align: 'left' },
    );
    leftBlockY += 14;
    // Per-type breakdown — left-aligned under "Deposits Held". Reads:
    //   19.2KG METAL: 30 × Rs. 1,950.00 = Rs. 58,500.00
    doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
    for (const b of breakdown) {
      if (b.amount <= 0.005) continue;
      const unitPrice = b.qty > 0 ? b.amount / b.qty : 0;
      const line = `${b.cylinderTypeName || 'Cylinder'}: ${b.qty} × ${formatMoney(unitPrice)} = ${formatMoney(b.amount)}`;
      doc.text(line, MARGIN.left, leftBlockY, { width: halfWidth, align: 'left' });
      leftBlockY += 11;
    }
    doc.fillColor(THEME.TEXT);
  }

  // Cursor advance — push past whichever block is taller so the footer
  // clears both.
  doc.fillColor(THEME.TEXT);
  y = Math.max(summaryRowY + 16, leftBlockY + 4);

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

// 2026-08-14 layout: same compact money (ledgerMoney) + DD/MM/YY (ledgerDate)
// as the individual table. Property (member name) keeps 70pt; the freed money
// space goes to Narration (150pt here vs 220 individual — the Property column
// is the difference). Total Amt / Due Amt / Overdue stay growable at 62pt for
// >1-crore cumulative balances. Sum stays 762pt (enforced below).
const GROUP_COLS: Col[] = [
  { label: 'Date', width: 44, align: 'left' },
  { label: 'Property', width: 70, align: 'left' },
  { label: 'Type', width: 62, align: 'left' },
  { label: 'Narration', width: 116, align: 'left' },
  { label: 'Delivered Fulls', width: 40, align: 'right' },
  { label: 'Amount', width: 54, align: 'right' },
  { label: 'Collected Empties', width: 40, align: 'right' },
  { label: 'Pending Empties', width: 38, align: 'right' },
  { label: 'Pending Empties Cost', width: 58, align: 'right' },
  { label: 'Total Amount', width: 62, align: 'right' },
  { label: 'Received', width: 54, align: 'right' },
  { label: 'Due Amount', width: 62, align: 'right' },
  { label: 'Overdue', width: 62, align: 'right' },
];
const GROUP_TABLE_WIDTH = GROUP_COLS.reduce((s, c) => s + c.width, 0);
const GROUP_COL_CHAR_CAP: number[] = [
  8,  // Date                 — "14/08/26" via ledgerDate
  14, // Property             — member/hotel name; longer ellipsise
  12, // Type                 — "47.5 metal" (10)
  24, // Narration            — 120pt col ~ 24 chars
  3,  // Delivered Fulls      — 0-999
  10, // Amount               — compact "9999999.99" (10)
  3,  // Collected Empties    — 0-999
  3,  // Pending Empties      — 0-999
  10, // Pending Empties Cost — compact money (10)
  12, // Total Amount         — cumulative; growable, >1cr fits
  10, // Received             — compact money (10)
  12, // Due Amount           — cumulative; growable
  12, // Overdue              — cumulative; growable
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
  setPdfAccent(await getPdfAccentColor(distributorId ?? ''));
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
      // 2026-08-14 — cancelled-row suppression, now applied to EVERY account
      // type on the consolidated group statement (was mini-op-only). Matches
      // the individual statement PDF above; see that call site's comment for
      // the full rationale. accountType retained for other letterhead logic.
      accountType: true,
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
    { hideCancelledInvoices: true },
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
    // 2026-08-14 — taller header (HEADER_HEIGHT) + lineBreak:true so narrow
    // labels ("Del Full", "Coll Emp", "Pend Emp Cost") wrap to 2 lines instead
    // of ellipsising; wide-enough labels stay single-line. Mirrors
    // drawTableHeader for the individual PDF.
    doc.rect(MARGIN.left, yy, GROUP_TABLE_WIDTH, HEADER_HEIGHT).fill(THEME.PRIMARY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
    for (const c of GROUP_COLS) {
      doc.text(c.label, x + 3, yy + 4, {
        width: c.width - 6,
        align: c.align,
        lineBreak: true,
        ellipsis: true,
      });
      x += c.width;
    }
    doc.fillColor(THEME.TEXT);
    return HEADER_HEIGHT;
  };

  const drawGroupRow = (
    yy: number,
    cells: string[],
    opts: { bold?: boolean; zebra?: boolean; cancelled?: boolean } = {},
  ): number => {
    // 2026-07-23 — mirror the individual PDF's cancelled-row treatment
    // so group HQ ledgers get the same visual affordance.
    if (opts.cancelled) {
      doc.rect(MARGIN.left, yy, GROUP_TABLE_WIDTH, ROW_HEIGHT).fill('#f1f5f9');
    } else if (opts.zebra) {
      doc.rect(MARGIN.left, yy, GROUP_TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
    }
    doc.fillColor(THEME.TEXT).font(opts.bold || opts.cancelled ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
    let x = MARGIN.left;
    for (let i = 0; i < GROUP_COLS.length; i++) {
      const text = fitCell(cells[i] ?? '', GROUP_COL_CHAR_CAP[i] ?? 999);
      // Group PDF has an extra Property column at the start, so the
      // money-column indices shift by 1 compared to the individual PDF
      // (Amount=5, Total Amt=9, Received=10, Due Amt=11).
      const isMoneyCol = i === 5 || i === 9 || i === 10 || i === 11;
      if (opts.cancelled && isMoneyCol) {
        doc.fillColor('#dc2626');
      } else {
        doc.fillColor(THEME.TEXT);
      }
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
      // F1 (2026-08-06) — mirrors individual PDF label.
      case 'defective_collected': return 'Def Ret';
      // Deposit ledger (2026-07-31 v3) — event-label Type column
      // (matches individual PDF). Cylinder type lives in Narration.
      case 'deposit_charged': return 'Deposit';
      case 'deposit_refunded': return 'Refund';
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
    // 2026-07-31 v2 — see individual PDF shortNarration for rationale.
    if (kind === 'payment') return s.replace(/^Payment received via\s+/i, '');
    // 2026-07-31 v3 — see individual PDF shortNarration.
    if (kind === 'deposit_charged') return s.replace(/^Deposit received:\s*/i, '');
    if (kind === 'deposit_refunded') return s.replace(/^Deposit refunded:\s*/i, '');
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
      const pendE = row.pendingEmptyCyls > 0 ? String(row.pendingEmptyCyls) : '-';
      // 2026-07-21 — Emp Cost carries per-type OB empty liability; see
      // the identical block on the individual PDF above.
      // v10 (Change N): "-" fallback instead of empty string.
      const empCost = (row.emptyCylsCost || 0) > 0 ? ledgerMoney(row.emptyCylsCost) : '-';
      cells = [
        ledgerDate(new Date(row.orderDate)),
        property, type, narration,
        '-', '-', '-',
        pendE,
        empCost,
        ledgerMoney(row.totalAmount),
        '-',
        ledgerMoney(row.dueAmount),
        '-',
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
        ledgerDate(new Date(row.orderDate)),
        property, type, narration,
        '-', '-', '-', '-', '-',
        ledgerMoney(row.totalAmount),
        ledgerMoney(row.receivedAmount),
        ledgerMoney(row.dueAmount),
        '',
      ];
    } else if (row.kind === 'empties_return') {
      // 2026-07-27 — Fix 1 (group PDF). Mirror the individual PDF: feed
      // the returned qty into totalCollected so the group Total row's
      // Pend E rolls up correctly, and render Emp C / Pend E from the
      // row's populated values (was blank).
      // 2026-07-31 v5 (Change F) — per-type Pend E + Emp Cost, mirroring
      // individual PDF empties_return branch.
      if (row.emptyCylsCollected > 0) totalCollected += row.emptyCylsCollected;
      cells = [
        ledgerDate(new Date(row.orderDate)),
        property, type, narration,
        '-', '-',
        row.emptyCylsCollected > 0 ? num(row.emptyCylsCollected) : '-',
        row.pendingEmptyCyls > 0 ? num(row.pendingEmptyCyls) : '-',
        (row.emptyCylsCost ?? 0) > 0 ? ledgerMoney(row.emptyCylsCost) : '-',
        ledgerMoney(row.totalAmount),
        '-',
        ledgerMoney(row.dueAmount),
        '-',
      ];
    } else if (row.kind === 'defective_collected') {
      // F1 (2026-08-06) — group PDF mirror of individual PDF branch.
      // Del Full shows negative qty ("-N") so reader sees fulls went
      // back to depot. Money side (Amount) stays "-" because CN posts
      // separately when raised.
      const defQty = (() => {
        const m = /^Defective:\s*(\d+)/.exec(narration);
        return m ? parseInt(m[1], 10) : 0;
      })();
      // F1-FIX-7 (2026-08-06): defective deduction must flow into the
      // Del Full subtotal too — otherwise Page/Total subtotals over-report
      // by the defective qty. Subtract from totalDelivered so the sum
      // reflects "fulls that stayed with customer this period".
      if (defQty > 0) totalDelivered -= defQty;
      cells = [
        ledgerDate(new Date(row.orderDate)),
        property, type, narration,
        defQty > 0 ? `-${defQty}` : '-',
        '-', '-', '-', '-',
        ledgerMoney(row.totalAmount),
        '-',
        ledgerMoney(row.dueAmount),
        '-',
      ];
    } else {
      // invoice / debit_note / adjustment / deposit_charged /
      // deposit_refunded — full detail. See individual PDF for the
      // deposit_refunded totalCollected exclusion rationale (v4 fix).
      if (row.fullCylsDelivered > 0) totalDelivered += row.fullCylsDelivered;
      if (row.emptyCylsCollected > 0 && row.kind !== 'deposit_refunded') {
        totalCollected += row.emptyCylsCollected;
      }
      cells = [
        ledgerDate(new Date(row.orderDate)),
        property, type, narration,
        // v10 (Change N): "-" fallback everywhere (was "0" for delivered
        // and always-numeric for collected/pending). "0" reads as
        // meaningful zero; "-" reads as "not applicable to this row".
        row.fullCylsDelivered ? num(row.fullCylsDelivered) : '-',
        ledgerMoney(row.amount),
        row.emptyCylsCollected ? num(row.emptyCylsCollected) : '-',
        row.pendingEmptyCyls ? num(row.pendingEmptyCyls) : '-',
        row.emptyCylsCost > 0 ? ledgerMoney(row.emptyCylsCost) : '-',
        ledgerMoney(row.totalAmount),
        ledgerMoney(row.receivedAmount),
        ledgerMoney(row.dueAmount),
        ledgerMoney(row.overDueAmount ?? 0),
      ];
    }
    // 2026-07-23 — cancelled-row detection (same "Cancelled:" prefix).
    const isCancelledGroup = (row.narration ?? '').startsWith('Cancelled:');
    y += drawGroupRow(y, cells, { zebra, cancelled: isCancelledGroup });
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
    num(totalDelivered), ledgerMoney(t.totalDebited),
    num(totalCollected), num(Math.max(0, totalOpeningPending + totalDelivered - totalCollected)),
    '', ledgerMoney(t.totalDebited),
    ledgerMoney(t.totalReceived), ledgerMoney(t.netOutstanding),
    ledgerMoney(groupOverdue),
  ];
  y += drawGroupRow(y + 1, totalsCells, { bold: true });

  // Closing Balance line — matches the individual PDF's format.
  y += 4;
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.PRIMARY);
  doc.text(
    `Group Closing Balance: ${ledgerRs(t.netOutstanding)} Dr`,
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
