/**
 * Driver Statement PDF Service (INVESTIGATION-JUL09 followup)
 *
 * Generates a per-driver statement showing every delivered invoice in the
 * requested date range, with status buckets (Paid / Partial / Pending /
 * Overdue) so the ops team can hand this to a driver or to accounts and
 * see at a glance what's collected vs outstanding.
 *
 * Mirrors the customerLedgerPdfService layout math — landscape A4, 762pt
 * table, same letterhead pattern — but the row set comes from the driver's
 * invoices rather than a single customer's ledger.
 */

import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { deliveryPerformanceStatement } from '../reportsService.js';
import { formatMoney, formatDate } from './pdfLayoutUtils.js';

// A4 landscape — same as the customer statement so both PDFs read the same way.
const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#e5e7eb',
  ZEBRA: '#f8fafc',
  OVERDUE_BG: '#fef2f2',
  PAID_BG: '#f0fdf4',
};
const TYPO = { H1: 18, H2: 11, BODY: 8, LABEL: 8, CAPTION: 7 };

interface Col {
  key: string;
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
  charCap: number;
}

// Widths sum to 762pt — the usable landscape-A4 table area with 40pt margins.
// Money columns sized for lakh values ("Rs. 9,99,999.00" = 15 chars) — same
// discipline as the customer statement PDF after the JUL09 layout fix.
const COLS: Col[] = [
  { key: 'date',            label: 'Date',        width: 64, align: 'left',   charCap: 11 },
  { key: 'invoiceNumber',   label: 'Invoice #',   width: 96, align: 'left',   charCap: 15 },
  { key: 'customerName',    label: 'Customer',    width: 124, align: 'left',  charCap: 22 },
  { key: 'cylinders',       label: 'Cylinders',   width: 100, align: 'left',  charCap: 18 },
  { key: 'fullsDelivered',  label: 'F Del',       width: 32, align: 'right',  charCap: 6 },
  { key: 'emptiesCollected',label: 'E Coll',      width: 34, align: 'right',  charCap: 6 },
  { key: 'pendingEmpties',  label: 'E Pend',      width: 34, align: 'right',  charCap: 6 },
  { key: 'amount',          label: 'Amount',      width: 82, align: 'right',  charCap: 17 },
  { key: 'creditDays',      label: 'Cr Days',     width: 40, align: 'right',  charCap: 4 },
  { key: 'status',          label: 'Status',      width: 62, align: 'center', charCap: 10 },
  { key: 'overdueAmount',   label: 'Balance Due', width: 82, align: 'right',  charCap: 17 },
];

const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);
const ROW_HEIGHT = 16;
const num = (n: number): string => Number(n || 0).toLocaleString('en-IN');

function fitCell(s: string, maxChars: number): string {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)) + '…';
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const col of COLS) {
    doc.text(col.label, x + 3, y + 4, {
      width: col.width - 6, align: col.align, lineBreak: false, ellipsis: true,
    });
    x += col.width;
  }
  doc.fillColor(THEME.TEXT);
  return ROW_HEIGHT + 2;
}

function drawRow(
  doc: PDFKit.PDFDocument,
  y: number,
  cells: Record<string, string>,
  opts: { bold?: boolean; zebra?: boolean; highlight?: 'overdue' | 'paid' | 'none' } = {},
): number {
  const bg = opts.highlight === 'overdue' ? THEME.OVERDUE_BG
           : opts.highlight === 'paid' ? THEME.PAID_BG
           : opts.zebra ? THEME.ZEBRA : null;
  if (bg) doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(bg);
  doc.fillColor(THEME.TEXT).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
  let x = MARGIN.left;
  for (const col of COLS) {
    const raw = cells[col.key] ?? '';
    const text = fitCell(String(raw), col.charCap);
    doc.text(text, x + 3, y + 4, {
      width: col.width - 6, align: col.align, lineBreak: false, ellipsis: true,
    });
    x += col.width;
  }
  return ROW_HEIGHT;
}

export interface DriverStatementRange {
  from?: string;
  to?: string;
  statusFilter?: 'all' | 'paid' | 'partial' | 'pending' | 'overdue';
}

export async function generateDriverStatementPdf(
  distributorId: string,
  driverId: string,
  range?: DriverStatementRange,
): Promise<Buffer> {
  const driver = await prisma.driver.findFirst({
    where: { id: driverId, distributorId, deletedAt: null },
    select: { driverName: true, phone: true },
  });
  if (!driver) throw new Error('Driver not found');

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  // Compute the date range the same way the JSON service does — default
  // wide-open so a "download PDF with no filter" call still returns the
  // driver's full history.
  const fromDate = range?.from ? new Date(`${range.from}T00:00:00.000Z`) : new Date('2000-01-01T00:00:00.000Z');
  const toDate = range?.to ? new Date(`${range.to}T23:59:59.999Z`) : new Date('2999-12-31T23:59:59.999Z');

  // Call the SAME service the modal reads so on-screen == PDF byte-for-byte.
  const stmt = await deliveryPerformanceStatement(
    distributorId, driverId, fromDate, toDate, range?.statusFilter ?? 'all',
  );
  const totals = stmt.totals ?? {};
  const kpiSums = (totals._kpiSums as { billed: number; collected: number; pending: number; overdue: number }) ?? {
    billed: 0, collected: 0, pending: 0, overdue: 0,
  };
  const kpiCounts = (totals._kpiCounts as { paid: number; partial: number; pending: number; overdue: number }) ?? {
    paid: 0, partial: 0, pending: 0, overdue: 0,
  };
  const totalsCollected = (totals._totalsCollected as number) ?? 0;

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

  // Title (right)
  doc.font('Helvetica-Bold').fontSize(TYPO.H1).fillColor(THEME.PRIMARY);
  doc.text('Driver Statement', rightEdge - 260, y, { width: 260, align: 'right' });

  y = Math.max(leftY, y + 36) + 4;
  doc.moveTo(MARGIN.left, y).lineTo(rightEdge, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 10;

  // ── Driver details ──
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.TEXT);
  doc.text(driver.driverName, MARGIN.left, y); y += 14;
  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.MUTED);
  doc.text(`Phone: ${driver.phone || '—'}`, MARGIN.left, y); y += 14;

  // Period line
  const periodText = `Period: ${range?.from ? formatDate(range.from) : 'Beginning'} to ${range?.to ? formatDate(range.to) : formatDate(new Date())}`;
  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.TEXT);
  doc.text(periodText, MARGIN.left, y); y += 14;

  // Status-filter caption if not 'all'
  if (range?.statusFilter && range.statusFilter !== 'all') {
    doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
    doc.text(`Filter: ${range.statusFilter.toUpperCase()} invoices only`, MARGIN.left, y); y += 12;
  }

  // ── KPI summary strip ──
  y += 4;
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.PRIMARY);
  doc.text('Summary', MARGIN.left, y); y += 12;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.TEXT);
  const kpiParts = [
    `Invoices: ${stmt.rows.length}`,
    `Billed: ${formatMoney(kpiSums.billed)}`,
    `Collected: ${formatMoney(kpiSums.collected)}`,
    `Pending: ${formatMoney(kpiSums.pending)}`,
    `Overdue: ${formatMoney(kpiSums.overdue)}`,
  ];
  doc.text(kpiParts.join('   ·   '), MARGIN.left, y); y += 12;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(
    `Buckets: Paid ${kpiCounts.paid} · Partial ${kpiCounts.partial} · Pending ${kpiCounts.pending} · Overdue ${kpiCounts.overdue}`,
    MARGIN.left, y,
  );
  y += 16;

  // ── Table ──
  y += drawTableHeader(doc, y);

  let zebra = false;
  let pageNum = 1;
  let pageAmount = 0;
  let pageOverdue = 0;
  let pageFulls = 0;
  let pageEmpties = 0;

  function emitPageSubtotal(): void {
    if (pageAmount === 0 && pageFulls === 0) return;
    doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y)
      .strokeColor(THEME.BORDER).lineWidth(0.5).stroke();
    y += drawRow(doc, y + 1, {
      date: '',
      invoiceNumber: '',
      customerName: `Page ${pageNum} subtotal`,
      cylinders: '',
      fullsDelivered: pageFulls ? num(pageFulls) : '',
      emptiesCollected: pageEmpties ? num(pageEmpties) : '',
      pendingEmpties: '',
      amount: pageAmount ? formatMoney(pageAmount) : '',
      creditDays: '',
      status: '',
      overdueAmount: pageOverdue ? formatMoney(pageOverdue) : '',
    }, { bold: true });
    pageAmount = 0; pageOverdue = 0; pageFulls = 0; pageEmpties = 0;
  }

  if (stmt.rows.length === 0) {
    doc.fillColor(THEME.MUTED).font('Helvetica-Oblique').fontSize(TYPO.BODY);
    doc.text('No invoices match the selected filter.', MARGIN.left + 4, y + 4);
    y += ROW_HEIGHT;
  }

  for (const row of stmt.rows) {
    // Page-break check — reserve room for the page-subtotal row + grand total
    // row + "Total Collected" line + generated-statement note. If we run
    // too close to the bottom, addPage before drawing the next data row so
    // the footer doesn't spill onto a mostly-empty extra page.
    const needed = ROW_HEIGHT + ROW_HEIGHT + 4;
    const footerReserve = ROW_HEIGHT + 12 + 16 + 12; // grand total + collected + note + margin
    if (y + needed + footerReserve > PAGE_HEIGHT - MARGIN.bottom) {
      emitPageSubtotal();
      doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
      pageNum += 1;
      y = MARGIN.top;
      y += drawTableHeader(doc, y);
      zebra = false;
    }

    const status = String(row.status ?? '');
    const overdueAmt = row.overdueAmount === '' ? 0 : Number(row.overdueAmount);
    const highlight =
      status === 'Overdue' ? 'overdue'
      : status === 'Paid' ? 'paid'
      : (zebra ? 'none' : 'none') as 'overdue' | 'paid' | 'none';

    y += drawRow(doc, y, {
      date: formatDate(String(row.date)),
      invoiceNumber: String(row.invoiceNumber ?? ''),
      customerName: String(row.customerName ?? ''),
      cylinders: String(row.cylinders ?? ''),
      fullsDelivered: row.fullsDelivered ? num(Number(row.fullsDelivered)) : '',
      emptiesCollected: row.emptiesCollected ? num(Number(row.emptiesCollected)) : '',
      pendingEmpties: row.pendingEmpties ? num(Number(row.pendingEmpties)) : '',
      amount: formatMoney(Number(row.amount)),
      creditDays: String(row.creditDays ?? ''),
      status,
      overdueAmount: overdueAmt ? formatMoney(overdueAmt) : '',
    }, { zebra, highlight });
    zebra = !zebra;

    pageAmount += Number(row.amount);
    pageOverdue += overdueAmt;
    pageFulls += Number(row.fullsDelivered);
    pageEmpties += Number(row.emptiesCollected);
  }

  emitPageSubtotal();

  // ── Grand total row ──
  doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y)
    .strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 2;
  y += drawRow(doc, y, {
    date: 'TOTAL',
    invoiceNumber: `${stmt.rows.length} invoice${stmt.rows.length === 1 ? '' : 's'}`,
    customerName: '',
    cylinders: '',
    fullsDelivered: totals.fullsDelivered != null ? num(Number(totals.fullsDelivered)) : '',
    emptiesCollected: totals.emptiesCollected != null ? num(Number(totals.emptiesCollected)) : '',
    pendingEmpties: '',
    amount: formatMoney(Number(totals.amount ?? 0)),
    creditDays: '',
    status: '',
    overdueAmount: formatMoney(Number(totals.overdueAmount ?? 0)),
  }, { bold: true });

  // ── Footer note ──
  y += 12;
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.PRIMARY);
  doc.text(`Total Collected: ${formatMoney(totalsCollected)}`, MARGIN.left, y, {
    width: TABLE_WIDTH, align: 'right',
  });
  y += 16;
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text('This is a computer generated statement.', MARGIN.left, y);

  doc.end();
  return await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}
