/**
 * Billing Invoice PDF Service
 *
 * Generates GST-compliant PDF invoices FROM GasLink TO distributors
 * for their SaaS subscription charges.
 * Layout follows the same crisp, minimal style as invoicePdfService.
 * Prices in BillingCycle items are GST-EXCLUSIVE.
 */

import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import {
  formatMoney, formatDate, numberToWords, round2,
  drawBox, drawTableHeader, drawTextBlock, drawPageNumber,
} from './pdfLayoutUtils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface BillingCycleForPdf {
  id: string;
  distributorId: string;
  periodStartDate: Date;
  periodEndDate: Date;
  dueDate: Date | null;
  totalAmountExclGst: number;
  totalGstAmount: number;
  totalAmountInclGst: number;
  distributor: {
    businessName: string;
    legalName: string;
    gstin: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    phone: string | null;
    email: string | null;
  };
  items: Array<{
    id: string;
    itemType: string;
    description: string;
    hsnCode: string | null;
    quantity: number;
    unitPriceExclGst: number;
    gstRate: number;
    lineGstAmount: number;
    lineTotalInclGst: number;
    createdAt: Date;
  }>;
}

// ─── Layout Constants ───────────────────────────────────────────────────────

const A4_WIDTH = 595;
const A4_HEIGHT = 842;

const LAYOUT = {
  MARGIN: { left: 40, right: 40, top: 50, bottom: 50 },
  SECTION_GAP: 16,
  CARD_PADDING: 14,
  TABLE_ROW_HEIGHT: 24,
  BORDER_WIDTH: 1,
  LINE_GAP: 12,
  THEME: {
    PRIMARY: '#0a3d62',
    TEXT: '#111827',
    MUTED: '#6b7280',
    BORDER: '#e5e7eb',
    ZEBRA: '#f8fafc',
    PAPER: '#ffffff',
  },
  TYPO: { H1: 18, H2: 11, BODY: 9, LABEL: 8, CAPTION: 8 },
};

const GASLINK_SAC = '998314';

const COL_DEFS = [
  { label: '#', width: 25, align: 'center' },
  { label: 'Description', width: 175, align: 'left' },
  { label: 'HSN/SAC', width: 55, align: 'center' },
  { label: 'Qty', width: 30, align: 'center' },
  { label: 'Unit Price', width: 65, align: 'right' },
  { label: 'GST %', width: 40, align: 'right' },
  { label: 'GST Amt', width: 60, align: 'right' },
  { label: 'Total', width: 65, align: 'right' },
];

// ─── GasLink Company Details ────────────────────────────────────────────────

const GASLINK = {
  name: 'Re-New GasLink',
  tagline: 'SaaS Platform for LPG Distribution Management',
  gstin: 'PENDING REGISTRATION',
  sac: `SAC: ${GASLINK_SAC} - Online Software Services`,
  state: 'telangana',
  email: 'support@mygaslink.com',
  website: 'www.mygaslink.com',
};

// ─── State Comparison ───────────────────────────────────────────────────────

function determineIntraState(
  sellerState: string | null | undefined,
  buyerGstin: string | null | undefined,
  buyerState: string | null | undefined,
): boolean {
  // Compare GSTIN state codes if buyer has GSTIN
  // GasLink GSTIN is pending, so fall back to state name comparison
  const ss = (sellerState ?? '').trim().toLowerCase();
  const bs = (buyerState ?? '').trim().toLowerCase();
  if (ss.length > 0 && bs.length > 0) return ss === bs;
  return false;
}

// ─── Drawing Sections ───────────────────────────────────────────────────────

function drawHeader(
  doc: PDFKit.PDFDocument,
  meta: { invoiceNum: string; invoiceDate: string; period: string; dueDate: string },
  startY: number,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  let cursorY = startY;

  // Company name
  doc.fontSize(Math.round(F.H2 * 1.5)).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text(GASLINK.name, leftX, cursorY, { width: 300 });
  cursorY += 18;
  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text(GASLINK.tagline, leftX, cursorY, { width: 300 });
  cursorY += 12;
  doc.text(`GSTIN: ${GASLINK.gstin}`, leftX, cursorY, { width: 300 });
  cursorY += 12;
  doc.text(GASLINK.sac, leftX, cursorY, { width: 300 });
  const companyBottomY = cursorY + 12;

  // Right side: Subscription Invoice title
  doc.fontSize(F.H1).fillColor(T.PRIMARY).font('Helvetica-Bold');
  const titleText = 'Subscription Invoice';
  const titleW = doc.widthOfString(titleText);
  doc.text(titleText, rightMargin - titleW, startY, { width: titleW });

  // Invoice number below title
  let rightY = startY + F.H1 + 6;
  doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
  const invNoText = `Invoice No: ${meta.invoiceNum}`;
  const invNoW = doc.widthOfString(invNoText);
  doc.text(invNoText, rightMargin - invNoW, rightY, { width: invNoW + 10 });
  rightY += 14;

  // Divider line
  const bottomY = Math.max(companyBottomY, rightY);
  const lineY = bottomY + 4;
  doc.moveTo(leftX, lineY).lineTo(rightMargin, lineY)
    .strokeColor(T.PRIMARY).lineWidth(LAYOUT.BORDER_WIDTH).stroke();

  // Meta row: Invoice Date | Period | Due Date
  const metaY = lineY + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`Invoice Date: ${meta.invoiceDate}`, leftX, metaY, { width: 150 });
  doc.text(`Period: ${meta.period}`, leftX + 160, metaY, { width: 180 });
  const dueText = `Due Date: ${meta.dueDate}`;
  const dueW = doc.widthOfString(dueText);
  doc.text(dueText, rightMargin - dueW, metaY, { width: dueW + 10 });

  return metaY + 14 - startY;
}

function drawBillTo(
  doc: PDFKit.PDFDocument,
  buyer: { name: string; gstin: string | null; phone: string | null; address: string },
  startY: number,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const pad = LAYOUT.CARD_PADDING + 4;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;
  const gap = 6;

  let cursorY = startY + 8;
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Bill To', leftX + pad, cursorY);
  cursorY += 20;

  cursorY += drawTextBlock(doc, leftX + pad, cursorY, fullWidth - pad * 2, buyer.name, F.BODY, { bold: true }) + gap;
  doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
  cursorY += drawTextBlock(doc, leftX + pad, cursorY, fullWidth - pad * 2, buyer.address, F.BODY, { color: T.MUTED }) + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`GSTIN: ${buyer.gstin || '\u2014'}`, leftX + pad, cursorY, { width: fullWidth - pad * 2 });
  cursorY += 12;
  if (buyer.phone) {
    doc.text(`Phone: ${buyer.phone}`, leftX + pad, cursorY, { width: fullWidth - pad * 2 });
    cursorY += 12;
  }
  cursorY += pad;

  const boxH = cursorY - startY;
  drawBox(doc, leftX, startY, fullWidth, boxH, T.PRIMARY);
  return boxH;
}

function drawItemsTable(
  doc: PDFKit.PDFDocument,
  items: BillingCycleForPdf['items'],
  startY: number,
  isIntraState: boolean,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const tableX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const tableWidth = rightMargin - tableX;
  let cursorY = startY;

  const headerH = drawTableHeader(doc, tableX, cursorY, COL_DEFS, T.PRIMARY, tableWidth);
  cursorY += headerH;

  if (items.length === 0) {
    doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
    doc.text('No items', tableX + 30, cursorY + 5);
    cursorY += LAYOUT.TABLE_ROW_HEIGHT;
  }

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]!;
    const rowH = LAYOUT.TABLE_ROW_HEIGHT;

    // Zebra stripe
    if (idx % 2 === 0) {
      doc.rect(tableX, cursorY - 2, tableWidth, rowH).fill(T.ZEBRA);
    }

    // Check page overflow
    if (cursorY + rowH > A4_HEIGHT - LAYOUT.MARGIN.bottom - 200) {
      doc.addPage();
      cursorY = LAYOUT.MARGIN.top;
    }

    doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');

    let cx = tableX;
    // #
    doc.text(String(idx + 1), cx + 5, cursorY + 5, { width: COL_DEFS[0]!.width - 10, align: 'center' });
    cx += COL_DEFS[0]!.width;
    // Description
    doc.font('Helvetica-Bold');
    doc.text(item.description, cx + 5, cursorY + 5, { width: COL_DEFS[1]!.width - 10 });
    doc.font('Helvetica');
    cx += COL_DEFS[1]!.width;
    // HSN/SAC
    doc.text(item.hsnCode || GASLINK_SAC, cx + 5, cursorY + 5, { width: COL_DEFS[2]!.width - 10, align: 'center' });
    cx += COL_DEFS[2]!.width;
    // Qty
    doc.text(String(item.quantity), cx + 5, cursorY + 5, { width: COL_DEFS[3]!.width - 10, align: 'center' });
    cx += COL_DEFS[3]!.width;
    // Unit Price (excl GST)
    doc.text(formatMoney(item.unitPriceExclGst), cx + 5, cursorY + 5, { width: COL_DEFS[4]!.width - 10, align: 'right' });
    cx += COL_DEFS[4]!.width;
    // GST %
    doc.text(`${item.gstRate}%`, cx + 5, cursorY + 5, { width: COL_DEFS[5]!.width - 10, align: 'right' });
    cx += COL_DEFS[5]!.width;
    // GST Amt
    doc.text(formatMoney(item.lineGstAmount), cx + 5, cursorY + 5, { width: COL_DEFS[6]!.width - 10, align: 'right' });
    cx += COL_DEFS[6]!.width;
    // Total (incl GST)
    doc.text(formatMoney(item.lineTotalInclGst), cx + 5, cursorY + 5, { width: COL_DEFS[7]!.width - 10, align: 'right' });

    cursorY += rowH;
  }

  return cursorY - startY;
}

function drawTotals(
  doc: PDFKit.PDFDocument,
  cycle: BillingCycleForPdf,
  startY: number,
  isIntraState: boolean,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const tableX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const tableWidth = rightMargin - tableX;
  let cursorY = startY + 5;

  // Separator
  doc.moveTo(tableX, cursorY).lineTo(tableX + tableWidth, cursorY)
    .strokeColor(T.PRIMARY).lineWidth(LAYOUT.BORDER_WIDTH).stroke();
  cursorY += 10;

  const labelX = tableX + 300;
  const valueX = tableX + tableWidth - 75;
  const valueW = 70;

  // Subtotal (excl. GST)
  doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
  doc.text('Subtotal (excl. GST):', labelX, cursorY, { width: 120 });
  doc.text(formatMoney(cycle.totalAmountExclGst), valueX, cursorY, { width: valueW, align: 'right' });
  cursorY += LAYOUT.LINE_GAP + 4;

  // GST breakdown
  if (isIntraState) {
    const halfGst = round2(cycle.totalGstAmount / 2);
    doc.text('CGST (9%):', labelX, cursorY, { width: 120 });
    doc.text(formatMoney(halfGst), valueX, cursorY, { width: valueW, align: 'right' });
    cursorY += LAYOUT.LINE_GAP + 2;
    doc.text('SGST (9%):', labelX, cursorY, { width: 120 });
    doc.text(formatMoney(halfGst), valueX, cursorY, { width: valueW, align: 'right' });
  } else {
    doc.text('IGST (18%):', labelX, cursorY, { width: 120 });
    doc.text(formatMoney(cycle.totalGstAmount), valueX, cursorY, { width: valueW, align: 'right' });
  }
  cursorY += LAYOUT.LINE_GAP + 8;

  // Separator
  doc.moveTo(labelX, cursorY).lineTo(tableX + tableWidth, cursorY)
    .strokeColor(T.PRIMARY).lineWidth(LAYOUT.BORDER_WIDTH).stroke();
  cursorY += 8;

  // Grand Total
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Grand Total:', labelX, cursorY, { width: 120 });
  doc.fontSize(F.H2 + 1);
  doc.text(formatMoney(cycle.totalAmountInclGst), valueX, cursorY, { width: valueW, align: 'right' });
  cursorY += F.H2 + 11;

  // Amount in words
  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text(`Amount in words: ${numberToWords(cycle.totalAmountInclGst)}`, tableX + 5, cursorY, { width: tableWidth - 10 });
  cursorY += 14;

  return cursorY - startY;
}

function drawPaymentSection(
  doc: PDFKit.PDFDocument,
  startY: number,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;
  const pad = LAYOUT.CARD_PADDING;
  let cursorY = startY;

  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Payment Terms', leftX + pad, cursorY + 8);
  cursorY += 26;

  doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
  doc.text('Payment due within 7 days of invoice date.', leftX + pad, cursorY, { width: fullWidth - pad * 2 });
  cursorY += 14;
  doc.text('Bank details will be shared separately.', leftX + pad, cursorY, { width: fullWidth - pad * 2 });
  cursorY += 14 + pad;

  const boxH = cursorY - startY;
  drawBox(doc, leftX, startY, fullWidth, boxH, T.PRIMARY);
  return boxH;
}

function drawFooter(doc: PDFKit.PDFDocument, startY: number): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;
  let cursorY = startY;

  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text('This is a computer-generated invoice. No signature required.', leftX, cursorY, { width: fullWidth, align: 'center' });
  cursorY += 14;
  doc.text(`${GASLINK.name} | ${GASLINK.email} | ${GASLINK.website}`, leftX, cursorY, { width: fullWidth, align: 'center' });
  cursorY += 14;

  return cursorY - startY;
}

// ─── Main Generator ─────────────────────────────────────────────────────────

export async function generateBillingInvoicePdf(billingCycleId: string, distributorId?: string): Promise<Buffer> {
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: billingCycleId },
    include: {
      distributor: true,
      items: { orderBy: { createdAt: 'asc' } },
    },
  }) as unknown as BillingCycleForPdf | null;

  if (!cycle) throw new Error('Billing cycle not found');
  if (distributorId && cycle.distributorId !== distributorId) throw new Error('Billing cycle not found');

  const dist = cycle.distributor;

  // Build invoice number: GLB-{YYYYMM}-{sequence}
  const yyyy = cycle.periodStartDate.getFullYear();
  const mm = String(cycle.periodStartDate.getMonth() + 1).padStart(2, '0');
  const seq = cycle.id.slice(-6).toUpperCase();
  const invoiceNum = `GLB-${yyyy}${mm}-${seq}`;

  // Build buyer data
  const buyerAddr = [dist.address, dist.city, dist.state, dist.pincode].filter(Boolean).join(', ') || '\u2014';
  const buyer = {
    name: dist.businessName || dist.legalName,
    gstin: dist.gstin,
    phone: dist.phone,
    address: buyerAddr,
  };

  // Determine intra-state (GasLink is in Telangana)
  const isIntraState = determineIntraState(GASLINK.state, dist.gstin, dist.state);

  // Dates
  const invoiceDate = formatDate(new Date());
  const period = `${formatDate(cycle.periodStartDate)} to ${formatDate(cycle.periodEndDate)}`;
  const dueDate = formatDate(cycle.dueDate);
  const meta = { invoiceNum, invoiceDate, period, dueDate };

  // Create PDF document
  const doc = new PDFDocument({ margin: LAYOUT.MARGIN.left, size: 'A4' });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  let cursorY = LAYOUT.MARGIN.top;

  // Header
  const headerH = drawHeader(doc, meta, cursorY);
  cursorY += headerH + LAYOUT.SECTION_GAP;

  // Bill To
  const billToH = drawBillTo(doc, buyer, cursorY);
  cursorY += billToH + LAYOUT.SECTION_GAP;

  // Items table
  const tableStartY = cursorY;
  const tableH = drawItemsTable(doc, cycle.items, cursorY, isIntraState);
  cursorY = tableStartY + tableH;

  // Totals
  const totalsH = drawTotals(doc, cycle, cursorY, isIntraState);
  const tableEndY = cursorY + totalsH;

  // Draw border around table + totals
  drawBox(doc, LAYOUT.MARGIN.left, tableStartY, A4_WIDTH - LAYOUT.MARGIN.left - LAYOUT.MARGIN.right, tableEndY - tableStartY, LAYOUT.THEME.PRIMARY);
  cursorY = tableEndY + LAYOUT.SECTION_GAP;

  // Payment section — ensure it fits, else add page
  const paymentNeeded = 80;
  if (cursorY + paymentNeeded > A4_HEIGHT - LAYOUT.MARGIN.bottom - 40) {
    doc.addPage();
    cursorY = LAYOUT.MARGIN.top;
  }
  const paymentH = drawPaymentSection(doc, cursorY);
  cursorY += paymentH + LAYOUT.SECTION_GAP;

  // Footer — ensure it fits, else add page
  const footerNeeded = 40;
  if (cursorY + footerNeeded > A4_HEIGHT - LAYOUT.MARGIN.bottom) {
    doc.addPage();
    cursorY = LAYOUT.MARGIN.top;
  }
  drawFooter(doc, cursorY);

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
