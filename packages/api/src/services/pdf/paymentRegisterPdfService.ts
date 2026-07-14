/**
 * Payment Register PDF Service (2026-07-14)
 *
 * Prints the Payments tab as a landscape A4 register — one row per payment,
 * covering the same columns you see on-screen: Payment Date, Customer,
 * Amount, Method, Reference, Invoice #, Issue Date, Allocated, Unallocated,
 * Status, Notes.
 *
 * For bulk payments (allocations.length > 1) the Invoice # column shows
 * "N invoices" and the Issue Date column shows "Various" — matches the
 * web display convention.
 *
 * Layout math patterned after driverStatementPdfService — landscape A4
 * with 40pt margins, table width sums to 762pt.
 */
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import * as paymentService from '../paymentService.js';
import { formatMoney, formatDate } from './pdfLayoutUtils.js';

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
  key: string;
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
  charCap: number;
}

// Widths sum to 762pt (landscape A4 usable table area with 40pt margins).
const COLS: Col[] = [
  { key: 'paymentDate',   label: 'Payment Date', width: 62,  align: 'left',   charCap: 11 },
  { key: 'customerName',  label: 'Customer',     width: 130, align: 'left',   charCap: 24 },
  { key: 'amount',        label: 'Amount',       width: 72,  align: 'right',  charCap: 14 },
  { key: 'method',        label: 'Method',       width: 60,  align: 'left',   charCap: 10 },
  { key: 'reference',     label: 'Ref',          width: 60,  align: 'left',   charCap: 10 },
  { key: 'invoiceNumber', label: 'Invoice #',    width: 90,  align: 'left',   charCap: 15 },
  { key: 'issueDate',     label: 'Issue Date',   width: 62,  align: 'left',   charCap: 11 },
  { key: 'allocated',     label: 'Allocated',    width: 68,  align: 'right',  charCap: 13 },
  { key: 'unallocated',   label: 'Unalloc',      width: 60,  align: 'right',  charCap: 11 },
  { key: 'status',        label: 'Status',       width: 56,  align: 'center', charCap: 10 },
  { key: 'notes',         label: 'Notes',        width: 42,  align: 'left',   charCap: 8 },
];

const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0); // 762
const ROW_HEIGHT = 16;

function fitCell(s: string, maxChars: number): string {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)) + '…';
}

function drawHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const c of COLS) {
    doc.text(c.label, x + 3, y + 4, {
      width: c.width - 6,
      align: c.align,
      lineBreak: false,
      ellipsis: true,
    });
    x += c.width;
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
  doc
    .fillColor(THEME.TEXT)
    .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(TYPO.BODY);
  let x = MARGIN.left;
  for (let i = 0; i < COLS.length; i++) {
    const c = COLS[i];
    doc.text(fitCell(cells[i] ?? '', c.charCap), x + 3, y + 4, {
      width: c.width - 6,
      align: c.align,
      lineBreak: false,
      ellipsis: true,
    });
    x += c.width;
  }
  return ROW_HEIGHT;
}

export interface PaymentRegisterFilters {
  paymentMethod?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export async function generatePaymentRegisterPdf(
  distributorId: string,
  filters: PaymentRegisterFilters,
): Promise<Buffer> {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  // Load ALL payments matching the filters (unpaginated — this is a bulk export).
  const { data: payments } = await paymentService.listPayments(distributorId, {
    ...filters,
    page: 1,
    pageSize: 10_000,
    sortBy: 'transactionDate',
    sortOrder: 'desc',
  });

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  const rightEdge = PAGE_WIDTH - MARGIN.right;
  let y = MARGIN.top;

  // Header
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
  doc.text('Payment Register', rightEdge - 250, y, { width: 250, align: 'right' });

  y = Math.max(leftY, y + 36) + 4;
  doc.moveTo(MARGIN.left, y).lineTo(rightEdge, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 10;

  // Period / filter caption
  if (filters.dateFrom || filters.dateTo || filters.paymentMethod || filters.search) {
    doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.TEXT);
    const parts: string[] = [];
    if (filters.dateFrom || filters.dateTo) {
      parts.push(`Period: ${filters.dateFrom ? formatDate(filters.dateFrom) : 'Beginning'} to ${filters.dateTo ? formatDate(filters.dateTo) : formatDate(new Date())}`);
    }
    if (filters.paymentMethod) parts.push(`Method: ${filters.paymentMethod}`);
    if (filters.search) parts.push(`Search: "${filters.search}"`);
    doc.text(parts.join('   ·   '), MARGIN.left, y);
    y += 14;
  }

  y += drawHeader(doc, y);

  let totalAmount = 0;
  let totalAllocated = 0;
  let totalUnallocated = 0;
  let zebra = false;
  for (const p of payments) {
    if (y + ROW_HEIGHT * 2 > PAGE_HEIGHT - MARGIN.bottom - 20) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
      y = MARGIN.top;
      y += drawHeader(doc, y);
      zebra = false;
    }
    const allocs = p.allocations ?? [];
    let invoiceCell = '-';
    let issueDateCell = '-';
    if (allocs.length === 1) {
      const a = allocs[0] as { invoiceNumber?: string; invoice?: { issueDate?: Date | string } };
      invoiceCell = a.invoiceNumber ?? '-';
      const iso = a.invoice?.issueDate;
      if (iso) issueDateCell = formatDate(iso);
    } else if (allocs.length > 1) {
      invoiceCell = `${allocs.length} invoices`;
      issueDateCell = 'Various';
    }
    const cells = [
      formatDate(p.transactionDate),
      (p as { customer?: { customerName?: string } }).customer?.customerName
        ?? (p as { customerName?: string }).customerName
        ?? '—',
      formatMoney(Number(p.amount ?? 0)),
      String((p as { paymentMethod?: string }).paymentMethod ?? '').replace(/_/g, ' '),
      (p as { referenceNumber?: string | null }).referenceNumber ?? '-',
      invoiceCell,
      issueDateCell,
      formatMoney(Number((p as { allocatedAmount?: number }).allocatedAmount ?? 0)),
      formatMoney(Number((p as { unallocatedAmount?: number }).unallocatedAmount ?? 0)),
      String((p as { allocationStatus?: string }).allocationStatus ?? '').replace(/_/g, ' '),
      (p as { notes?: string | null }).notes ?? '',
    ];
    y += drawRow(doc, y, cells, { zebra });
    zebra = !zebra;
    totalAmount += Number(p.amount ?? 0);
    totalAllocated += Number((p as { allocatedAmount?: number }).allocatedAmount ?? 0);
    totalUnallocated += Number((p as { unallocatedAmount?: number }).unallocatedAmount ?? 0);
  }

  // Totals row
  doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  const totalsRow = [
    'TOTAL',
    '',
    formatMoney(totalAmount),
    '',
    '',
    '',
    '',
    formatMoney(totalAllocated),
    formatMoney(totalUnallocated),
    '',
    '',
  ];
  y += drawRow(doc, y + 1, totalsRow, { bold: true });

  y += 18;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text('This is a computer generated statement.', MARGIN.left, y, { width: TABLE_WIDTH });

  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
