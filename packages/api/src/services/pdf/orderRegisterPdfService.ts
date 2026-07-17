/**
 * Order Register PDF Service (2026-07-17)
 *
 * Prints the Orders page as a landscape A4 register — one row per order,
 * honoring the same filter set the on-screen table uses (status,
 * customerId, driverId, dateFrom, dateTo, search). Patterned after
 * paymentRegisterPdfService for layout math + header/theme reuse.
 *
 * Columns (widths sum to 762pt — landscape A4 with 40pt margins):
 *   Order Date | Order # | Customer | Status | Driver | Fulls | ₹ Total | Notes
 */
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import * as orderService from '../orderService.js';
import { formatMoney, formatDate } from './pdfLayoutUtils.js';

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
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

const COLS: Col[] = [
  { key: 'deliveryDate', label: 'Delivery Date', width: 70,  align: 'left',   charCap: 12 },
  { key: 'orderNumber',  label: 'Order #',       width: 110, align: 'left',   charCap: 18 },
  { key: 'customerName', label: 'Customer',      width: 180, align: 'left',   charCap: 34 },
  { key: 'status',       label: 'Status',        width: 78,  align: 'left',   charCap: 14 },
  { key: 'driverName',   label: 'Driver',        width: 100, align: 'left',   charCap: 18 },
  { key: 'fullsDelivered', label: 'Fulls',       width: 42,  align: 'right',  charCap: 6  },
  { key: 'totalAmount',  label: 'Total',         width: 72,  align: 'right',  charCap: 14 },
  { key: 'notes',        label: 'Notes',         width: 110, align: 'left',   charCap: 22 },
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
  if (opts.zebra) doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  doc.fillColor(THEME.TEXT).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
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

export interface OrderRegisterFilters {
  status?: string;
  customerId?: string;
  driverId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export async function generateOrderRegisterPdf(
  distributorId: string,
  filters: OrderRegisterFilters,
): Promise<Buffer> {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  const { data: orders } = await orderService.listOrders(distributorId, {
    ...filters,
    page: 1,
    pageSize: 10_000,
    sortBy: 'deliveryDate',
    sortOrder: 'desc',
  });

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  const rightEdge = PAGE_WIDTH - MARGIN.right;
  let y = MARGIN.top;

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
  doc.text('Order Register', rightEdge - 250, y, { width: 250, align: 'right' });

  y = Math.max(leftY, y + 36) + 4;
  doc.moveTo(MARGIN.left, y).lineTo(rightEdge, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 10;

  if (filters.dateFrom || filters.dateTo || filters.status || filters.search) {
    doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.TEXT);
    const parts: string[] = [];
    if (filters.dateFrom || filters.dateTo) {
      parts.push(`Period: ${filters.dateFrom ? formatDate(filters.dateFrom) : 'Beginning'} to ${filters.dateTo ? formatDate(filters.dateTo) : formatDate(new Date())}`);
    }
    if (filters.status) parts.push(`Status: ${filters.status.replace(/_/g, ' ')}`);
    if (filters.search) parts.push(`Search: "${filters.search}"`);
    doc.text(parts.join('   ·   '), MARGIN.left, y);
    y += 14;
  }

  y += drawHeader(doc, y);

  let totalOrders = 0;
  let totalFulls = 0;
  let totalMoney = 0;
  let zebra = false;
  for (const o of orders) {
    if (y + ROW_HEIGHT * 2 > PAGE_HEIGHT - MARGIN.bottom - 20) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
      y = MARGIN.top;
      y += drawHeader(doc, y);
      zebra = false;
    }
    const items = (o as { items?: { quantity?: number; deliveredQuantity?: number | null }[] }).items ?? [];
    const fulls = items.reduce((s, it) => s + Number(it.deliveredQuantity ?? it.quantity ?? 0), 0);
    const cells = [
      o.deliveryDate ? formatDate(o.deliveryDate as Date) : '—',
      String((o as { orderNumber?: string }).orderNumber ?? ''),
      (o as { customer?: { customerName?: string } }).customer?.customerName ?? '—',
      String((o as { status?: string }).status ?? '').replace(/_/g, ' '),
      (o as { driver?: { driverName?: string } }).driver?.driverName ?? '—',
      String(fulls),
      formatMoney(Number((o as { totalAmount?: unknown }).totalAmount ?? 0)),
      (o as { specialInstructions?: string | null }).specialInstructions ?? '',
    ];
    y += drawRow(doc, y, cells, { zebra });
    zebra = !zebra;
    totalOrders += 1;
    totalFulls += fulls;
    totalMoney += Number((o as { totalAmount?: unknown }).totalAmount ?? 0);
  }

  doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  const totalsRow = [
    'TOTAL',
    String(totalOrders),
    '',
    '',
    '',
    String(totalFulls),
    formatMoney(totalMoney),
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
