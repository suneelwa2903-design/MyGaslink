/**
 * Invoice PDF Service (TypeScript)
 *
 * Generates GST-compliant invoice PDFs using pdfkit.
 * Layout: crisp, minimal, dynamic positioning (Option A style).
 * Prices in the database are GST-INCLUSIVE.
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prisma } from '../../lib/prisma.js';
import {
  formatMoney, formatDate, formatIrnForDisplay, numberToWords,
  round2, drawBox, drawTableHeader, drawTextBlock, drawPageNumber,
} from './pdfLayoutUtils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface InvoiceForPdf {
  id: string;
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date;
  totalAmount: number;
  status: string;
  irnStatus: string;
  ewbStatus: string;
  irn: string | null;
  ackNo: string | null;
  ackDate: Date | null;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
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
  customer: {
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    phone: string;
    email: string | null;
    billingAddressLine1: string | null;
    billingAddressLine2: string | null;
    billingCity: string | null;
    billingState: string | null;
    billingPincode: string | null;
    creditPeriodDays: number;
  } | null;
  items: Array<{
    id: string;
    description: string;
    hsnCode: string;
    quantity: number;
    unitPrice: number;
    discountPerUnit: number;
    gstRate: number;
    totalPrice: number;
    cylinderType: { typeName: string } | null;
  }>;
  gstDocuments: Array<{
    gstDocNo: string | null;
    irn: string | null;
    irnStatus: string;
    ackNo: string | null;
    ackDate: Date | null;
    signedQr: string | null;
    ewbNo: string | null;
    ewbStatus: string;
    ewbDate: Date | null;
    ewbValidTill: Date | null;
    isLatest: boolean;
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
    PILL_SUCCESS: '#059669',
    PILL_FAILED: '#dc2626',
    PILL_WARN: '#d97706',
  },
  TYPO: { H1: 18, H2: 11, BODY: 9, LABEL: 8, CAPTION: 8 },
};

const COL_DEFS = [
  { label: '#', width: 25, align: 'center' },
  { label: 'Item', width: 220, align: 'left' },
  { label: 'Qty', width: 35, align: 'center' },
  { label: 'Rate', width: 65, align: 'right' },
  { label: 'GST (total)', width: 90, align: 'right' },
  { label: 'Amount', width: 80, align: 'right' },
];

// ─── State Code Helpers ─────────────────────────────────────────────────────

function getStateCodeFromGSTIN(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  return gstin.substring(0, 2);
}

function determineIntraState(
  sellerGstin: string | null | undefined,
  buyerGstin: string | null | undefined,
  sellerState: string | null | undefined,
  buyerState: string | null | undefined,
): boolean {
  const sellerCode = getStateCodeFromGSTIN(sellerGstin);
  const buyerCode = getStateCodeFromGSTIN(buyerGstin);
  if (sellerCode && buyerCode) return sellerCode === buyerCode;
  const ss = (sellerState ?? '').trim().toUpperCase();
  const bs = (buyerState ?? '').trim().toUpperCase();
  return ss.length > 0 && bs.length > 0 && ss === bs;
}

// ─── Computed Item Row ──────────────────────────────────────────────────────

interface ComputedItem {
  name: string;
  hsn: string;
  gstRate: number;
  quantity: number;
  unitPriceInclusive: number;
  discount: number;
  baseRate: number;
  taxableAmount: number;
  gstAmount: number;
  totalPrice: number;
}

function computeItems(
  items: InvoiceForPdf['items'],
): { computed: ComputedItem[]; totalTaxable: number; totalGst: number; totalInclusive: number } {
  let totalTaxable = 0;
  let totalGst = 0;
  let totalInclusive = 0;

  const computed = items.map((item) => {
    const gstRate = item.gstRate || 18;
    const qty = item.quantity || 0;
    const up = item.unitPrice || 0;
    const discount = item.discountPerUnit || 0;
    const grossInclusive = round2(up * qty);
    const discountAmt = round2(discount * qty);
    const afterDiscount = round2(grossInclusive - discountAmt);
    const taxable = round2(afterDiscount / (1 + gstRate / 100));
    const gstAmt = round2(afterDiscount - taxable);
    const baseRate = round2(up / (1 + gstRate / 100));

    totalTaxable = round2(totalTaxable + taxable);
    totalGst = round2(totalGst + gstAmt);
    totalInclusive = round2(totalInclusive + afterDiscount);

    return {
      name: item.cylinderType?.typeName || item.description || 'Item',
      hsn: item.hsnCode || '27111900',
      gstRate,
      quantity: qty,
      unitPriceInclusive: up,
      discount,
      baseRate,
      taxableAmount: taxable,
      gstAmount: gstAmt,
      totalPrice: item.totalPrice || afterDiscount,
    };
  });

  return { computed, totalTaxable, totalGst, totalInclusive };
}

// ─── Drawing Sections ───────────────────────────────────────────────────────

function drawPill(doc: PDFKit.PDFDocument, x: number, y: number, text: string, fillColor: string): void {
  doc.fontSize(LAYOUT.TYPO.CAPTION).font('Helvetica');
  const w = doc.widthOfString(text) + 12;
  const h = 14;
  doc.roundedRect(x, y, w, h, 4).fill(fillColor);
  doc.fillColor(LAYOUT.THEME.PAPER).text(text, x + 6, y + 2, { width: w - 12 });
  doc.fillColor(LAYOUT.THEME.TEXT);
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  seller: { name: string; gstin: string | null },
  meta: { gstDocNo: string; invoiceDate: string; dueDate: string; paymentTerms: string },
  startY: number,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  let cursorY = startY;

  // Company name
  doc.fontSize(Math.round(F.H2 * 1.5)).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text(seller.name, leftX, cursorY, { width: 300 });
  let companyY = cursorY + 18;
  if (seller.gstin) {
    doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
    doc.text(`GSTIN: ${seller.gstin}`, leftX, companyY, { width: 300 });
    companyY += 12;
  }

  // Right side: Tax Invoice title
  doc.fontSize(F.H1).fillColor(T.PRIMARY).font('Helvetica-Bold');
  const titleText = 'Tax Invoice';
  const titleW = doc.widthOfString(titleText);
  doc.text(titleText, rightMargin - titleW, cursorY, { width: titleW });

  // GST Doc No below title
  let rightY = cursorY + F.H1 + 6;
  doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
  const docNoText = `GST Doc No: ${meta.gstDocNo}`;
  const docNoW = doc.widthOfString(docNoText);
  doc.text(docNoText, rightMargin - docNoW, rightY, { width: docNoW + 10 });
  rightY += 14;

  // Divider line
  const bottomY = Math.max(companyY, rightY);
  const lineY = bottomY + 4;
  doc.moveTo(leftX, lineY).lineTo(rightMargin, lineY)
    .strokeColor(T.PRIMARY).lineWidth(LAYOUT.BORDER_WIDTH).stroke();

  // Meta row: Invoice Date | Due Date | Payment Terms
  const metaY = lineY + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`Invoice Date: ${meta.invoiceDate}`, leftX, metaY, { width: 150 });
  doc.text(`Due Date: ${meta.dueDate}`, leftX + 170, metaY, { width: 150 });
  const ptText = `Payment Terms: ${meta.paymentTerms}`;
  const ptW = doc.widthOfString(ptText);
  doc.text(ptText, rightMargin - ptW, metaY, { width: ptW + 10 });

  return metaY + 14 - startY;
}

function drawParties(
  doc: PDFKit.PDFDocument,
  seller: { name: string; gstin: string | null; phone: string | null; address: string },
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
  const columnWidth = (fullWidth - gap) / 2;
  const rightX = leftX + columnWidth + gap;
  const titleY = startY + 8;
  const contentStart = titleY + 20;

  // Bill From
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Bill From', leftX + pad, titleY);
  let fromY = contentStart;
  fromY += drawTextBlock(doc, leftX + pad, fromY, columnWidth - pad * 2, seller.name, F.BODY, { bold: true }) + gap;
  doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
  fromY += drawTextBlock(doc, leftX + pad, fromY, columnWidth - pad * 2, seller.address, F.BODY, { color: T.MUTED }) + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`GSTIN: ${seller.gstin || '\u2014'}`, leftX + pad, fromY, { width: columnWidth - pad * 2 });
  fromY += 12;
  doc.text(`Phone: ${seller.phone || '\u2014'}`, leftX + pad, fromY, { width: columnWidth - pad * 2 });
  fromY += 12;
  const billFromH = fromY - startY + pad;

  // Bill To
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Bill To', rightX + pad, titleY);
  let toY = contentStart;
  toY += drawTextBlock(doc, rightX + pad, toY, columnWidth - pad * 2, buyer.name, F.BODY, { bold: true }) + gap;
  doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
  toY += drawTextBlock(doc, rightX + pad, toY, columnWidth - pad * 2, buyer.address, F.BODY, { color: T.MUTED }) + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`GSTIN: ${buyer.gstin || '\u2014'}`, rightX + pad, toY, { width: columnWidth - pad * 2 });
  toY += 12;
  doc.text(`Phone: ${buyer.phone || '\u2014'}`, rightX + pad, toY, { width: columnWidth - pad * 2 });
  toY += 12;
  const billToH = toY - startY + pad;

  return Math.max(billFromH, billToH);
}

function drawItemsTable(
  doc: PDFKit.PDFDocument,
  items: ComputedItem[],
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
    const item = items[idx];
    const needsBreakdown = item.gstAmount > 0;
    const rowH = needsBreakdown ? LAYOUT.TABLE_ROW_HEIGHT + 16 : LAYOUT.TABLE_ROW_HEIGHT;

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

    // Column positions
    let cx = tableX;
    // #
    doc.text(String(idx + 1), cx + 5, cursorY + 5, { width: COL_DEFS[0].width - 10, align: 'center' });
    cx += COL_DEFS[0].width;
    // Item name + subtext
    doc.font('Helvetica-Bold');
    doc.text(item.name, cx + 5, cursorY + 5, { width: COL_DEFS[1].width - 10 });
    doc.font('Helvetica').fontSize(F.CAPTION).fillColor(T.MUTED);
    doc.text(`HSN: ${item.hsn} | GST: ${item.gstRate}%`, cx + 5, cursorY + 14, { width: COL_DEFS[1].width - 10 });
    cx += COL_DEFS[1].width;
    // Qty
    doc.fontSize(F.BODY).fillColor(T.TEXT);
    doc.text(String(item.quantity), cx + 5, cursorY + 5, { width: COL_DEFS[2].width - 10, align: 'center' });
    cx += COL_DEFS[2].width;
    // Rate (base, excl. GST)
    doc.text(formatMoney(item.baseRate), cx + 5, cursorY + 5, { width: COL_DEFS[3].width - 10, align: 'right' });
    cx += COL_DEFS[3].width;
    // GST amount
    doc.text(formatMoney(item.gstAmount), cx + 5, cursorY + 5, { width: COL_DEFS[4].width - 10, align: 'right' });

    // GST breakdown (CGST/SGST or IGST)
    if (needsBreakdown) {
      const brkFontSize = F.CAPTION - 2;
      doc.fontSize(brkFontSize).fillColor(T.MUTED).font('Helvetica-Oblique');
      let by = cursorY + 20;
      if (isIntraState) {
        const half = round2(item.gstAmount / 2);
        doc.text(`(CGST ${item.gstRate / 2}%: ${formatMoney(half).replace('Rs. ', '')}`, cx + 5, by, { width: COL_DEFS[4].width - 10, align: 'right' });
        by += 8;
        doc.text(`SGST ${item.gstRate / 2}%: ${formatMoney(half).replace('Rs. ', '')})`, cx + 5, by, { width: COL_DEFS[4].width - 10, align: 'right' });
      } else {
        doc.text(`(IGST ${item.gstRate}%: ${formatMoney(item.gstAmount).replace('Rs. ', '')})`, cx + 5, by, { width: COL_DEFS[4].width - 10, align: 'right' });
      }
    }

    cx += COL_DEFS[4].width;
    // Amount (inclusive)
    doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
    doc.text(formatMoney(item.totalPrice), cx + 5, cursorY + 5, { width: COL_DEFS[5].width - 10, align: 'right' });

    cursorY += rowH;
  }

  return cursorY - startY;
}

function drawTotals(
  doc: PDFKit.PDFDocument,
  items: ComputedItem[],
  cgst: number, sgst: number, igst: number,
  grandTotal: number,
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

  // Compute totals
  let totalRate = 0;
  for (const item of items) {
    totalRate = round2(totalRate + item.baseRate * item.quantity);
  }
  const totalGst = round2(grandTotal - totalRate);

  const rateColX = tableX + COL_DEFS[0].width + COL_DEFS[1].width + COL_DEFS[2].width + 5;
  const gstColX = rateColX + COL_DEFS[3].width;
  const amountColX = gstColX + COL_DEFS[4].width;
  const labelX = tableX + COL_DEFS[0].width + COL_DEFS[1].width + 5;

  // Subtotal row
  doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
  doc.text('Subtotal:', labelX, cursorY, { width: 60 });
  doc.text(formatMoney(totalRate), rateColX, cursorY, { align: 'right', width: COL_DEFS[3].width - 10 });
  doc.text(formatMoney(totalGst), gstColX, cursorY, { align: 'right', width: COL_DEFS[4].width - 10 });
  doc.text(formatMoney(grandTotal), amountColX, cursorY, { align: 'right', width: COL_DEFS[5].width - 10 });
  cursorY += LAYOUT.LINE_GAP + 8;

  // Separator
  doc.moveTo(tableX, cursorY).lineTo(tableX + tableWidth, cursorY)
    .strokeColor(T.PRIMARY).lineWidth(LAYOUT.BORDER_WIDTH).stroke();
  cursorY += 14;

  // Grand Total
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Grand Total:', labelX, cursorY, { width: 200 });
  doc.fontSize(F.H2 + 1);
  doc.text(formatMoney(grandTotal), amountColX, cursorY, { align: 'right', width: COL_DEFS[5].width - 10 });
  cursorY += F.H2 + 11;

  // Amount in words
  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text(`Amount in words: ${numberToWords(grandTotal)}`, tableX + 5, cursorY, { width: tableWidth - 10 });
  cursorY += 14;

  return cursorY - startY;
}

async function drawComplianceSection(
  doc: PDFKit.PDFDocument,
  gstDoc: InvoiceForPdf['gstDocuments'][0] | null,
  invoice: { irn: string | null; ackNo: string | null; ackDate: Date | null; irnStatus: string },
  startY: number,
): Promise<number> {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const pad = LAYOUT.CARD_PADDING;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;
  const qrSize = 95;

  const irn = gstDoc?.irn || invoice.irn;
  const ackNo = gstDoc?.ackNo || invoice.ackNo;
  const ackDate = gstDoc?.ackDate || invoice.ackDate;
  const signedQr = gstDoc?.signedQr;
  const ewbNo = gstDoc?.ewbNo;
  const irnStatusVal = gstDoc?.irnStatus || invoice.irnStatus;

  const hasIrn = !!irn;
  const hasEwb = !!ewbNo;
  if (!hasIrn && !hasEwb) return 0;

  let cursorY = startY;
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('e-Documents', leftX, cursorY, { width: fullWidth });
  cursorY += 16;

  const cardGap = 12;
  const cardsStartY = cursorY;

  // Calculate card widths
  let irnCardWidth = fullWidth;
  let ewbCardWidth = fullWidth;
  let irnCardX = leftX;
  let ewbCardX = leftX;
  if (hasIrn && hasEwb) {
    const avail = fullWidth - cardGap;
    irnCardWidth = avail / 2;
    ewbCardWidth = avail / 2;
    ewbCardX = leftX + irnCardWidth + cardGap;
  }

  let irnH = 0;
  let ewbH = 0;

  // IRN card
  if (hasIrn) {
    let cy = cardsStartY + pad;
    const textWidth = irnCardWidth - pad * 2 - (signedQr ? qrSize + 16 : 0);

    doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
    doc.text('e-Invoice (IRN)', irnCardX + pad, cy, { width: textWidth });
    const statusText = irnStatusVal === 'success' || irnStatusVal === 'SUCCESS' ? 'SUCCESS' : 'PENDING';
    const statusColor = statusText === 'SUCCESS' ? T.PILL_SUCCESS : T.PILL_FAILED;
    drawPill(doc, irnCardX + irnCardWidth - pad - 70, cy - 2, statusText, statusColor);
    cy += 16;

    // IRN value
    doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
    doc.text('IRN:', irnCardX + pad, cy, { width: textWidth });
    cy += 12;
    const irnFormatted = formatIrnForDisplay(irn);
    doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
    for (const line of irnFormatted.split('\n')) {
      if (line.trim()) {
        doc.text(line.trim(), irnCardX + pad, cy, { width: textWidth });
        cy += F.BODY + 4;
      }
    }
    cy += 8;

    // Ack No
    if (ackNo) {
      doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
      doc.text('Ack No:', irnCardX + pad, cy, { width: textWidth }); cy += 12;
      doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
      doc.text(String(ackNo), irnCardX + pad, cy, { width: textWidth }); cy += 14;
    }
    // Ack Date
    if (ackDate) {
      doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
      doc.text('Ack Date:', irnCardX + pad, cy, { width: textWidth }); cy += 12;
      doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
      doc.text(formatDate(ackDate), irnCardX + pad, cy, { width: textWidth }); cy += 14;
    }

    // QR code
    if (signedQr) {
      try {
        const qrX = irnCardX + irnCardWidth - pad - qrSize;
        const qrY = cardsStartY + pad + 16;
        const qrPng = await QRCode.toBuffer(signedQr, { type: 'png', width: qrSize, margin: 1 });
        doc.image(qrPng, qrX, qrY, { fit: [qrSize, qrSize] });
        doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
        doc.text('Scan to verify on GST Portal.', qrX, qrY + qrSize + 4, { width: qrSize, align: 'center' });
        cy = Math.max(cy, qrY + qrSize + 18) + pad;
      } catch {
        cy += pad;
      }
    } else {
      cy += pad;
    }

    irnH = cy - cardsStartY;
    drawBox(doc, irnCardX, cardsStartY, irnCardWidth, irnH, T.PRIMARY);
  }

  // EWB card
  if (hasEwb) {
    let cy = cardsStartY + pad;
    const ewbTextW = ewbCardWidth - pad * 2;

    doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
    doc.text('E-Waybill (EWB)', ewbCardX + pad, cy, { width: ewbTextW });
    // Pill reflects the actual ewbStatus instead of always reading SUCCESS.
    // Without this, a cancelled or failed EWB still prints with a green
    // SUCCESS chip, which is misleading on the invoice copy.
    const ewbStatusVal = gstDoc?.ewbStatus;
    const ewbPillText = ewbStatusVal === 'active' ? 'SUCCESS'
      : ewbStatusVal === 'failed' ? 'FAILED'
      : ewbStatusVal === 'cancelled' ? 'CANCELLED'
      : 'PENDING';
    const ewbPillColor = ewbStatusVal === 'active' ? T.PILL_SUCCESS
      : ewbStatusVal === 'failed' ? T.PILL_FAILED
      : T.PILL_WARN;
    drawPill(doc, ewbCardX + ewbCardWidth - pad - 72, cy - 2, ewbPillText, ewbPillColor);
    cy += 14;

    doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
    doc.text(`EWB No: ${ewbNo}`, ewbCardX + pad, cy, { width: ewbTextW }); cy += F.BODY + 6;
    if (gstDoc?.ewbDate) {
      doc.text(`EWB Date: ${formatDate(gstDoc.ewbDate)}`, ewbCardX + pad, cy, { width: ewbTextW }); cy += F.BODY + 6;
    }
    if (gstDoc?.ewbValidTill) {
      doc.text(`Valid Till: ${formatDate(gstDoc.ewbValidTill)}`, ewbCardX + pad, cy, { width: ewbTextW }); cy += F.BODY + 6;
    }
    cy += pad;

    ewbH = cy - cardsStartY;
    drawBox(doc, ewbCardX, cardsStartY, ewbCardWidth, ewbH, T.PRIMARY);
  }

  const maxCardH = Math.max(irnH, ewbH);
  return maxCardH + 16 + (cardsStartY - startY);
}

function drawFooter(doc: PDFKit.PDFDocument, sellerName: string, startY: number): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;
  let cursorY = startY;

  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text('This is a computer generated invoice.', leftX, cursorY, { width: fullWidth });
  cursorY += 14;

  // Authorized signatory line
  const sigW = 150;
  const sigX = rightMargin - sigW;
  doc.moveTo(sigX, cursorY).lineTo(rightMargin, cursorY)
    .strokeColor(T.BORDER).lineWidth(LAYOUT.BORDER_WIDTH).stroke();
  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text('Authorized Signatory', sigX, cursorY + 4, { width: sigW, align: 'center' });
  cursorY += 20;

  return cursorY - startY;
}

// ─── Main Generator ─────────────────────────────────────────────────────────

export async function generateInvoicePdf(invoiceId: string, distributorId: string): Promise<Buffer> {
  // Fetch invoice with all required relations
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, distributorId, deletedAt: null },
    include: {
      distributor: true,
      customer: true,
      items: { include: { cylinderType: true } },
      gstDocuments: {
        where: { isLatest: true, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  }) as unknown as InvoiceForPdf | null;

  if (!invoice) throw new Error('Invoice not found');

  const dist = invoice.distributor;
  const cust = invoice.customer;
  const gstDoc = invoice.gstDocuments?.[0] ?? null;

  // Build seller/buyer data
  const sellerAddr = [dist.address, dist.city, dist.state, dist.pincode].filter(Boolean).join(', ') || '\u2014';
  const seller = { name: dist.businessName || dist.legalName, gstin: dist.gstin, phone: dist.phone, address: sellerAddr };

  const buyerAddr = cust
    ? [cust.billingAddressLine1, cust.billingAddressLine2, cust.billingCity, cust.billingState, cust.billingPincode].filter(Boolean).join(', ') || '\u2014'
    : '\u2014';
  const buyer = {
    name: cust?.businessName || cust?.customerName || 'Customer',
    gstin: cust?.gstin && cust.gstin !== 'URP' ? cust.gstin : null,
    phone: cust?.phone || null,
    address: buyerAddr,
  };

  // Determine intra-state
  const isIntraState = determineIntraState(dist.gstin, buyer.gstin, dist.state, cust?.billingState);

  // GST Doc No
  const gstDocNo = gstDoc?.gstDocNo || invoice.invoiceNumber;

  // Dates
  const invoiceDate = formatDate(invoice.issueDate);
  const dueDate = formatDate(invoice.dueDate);
  const creditDays = cust?.creditPeriodDays ?? 30;
  const paymentTerms = `Net ${creditDays}`;
  const meta = { gstDocNo, invoiceDate, dueDate, paymentTerms };

  // Compute items
  const { computed: computedItems } = computeItems(invoice.items);

  // Use stored GST values if available, otherwise from computation
  const storedCgst = invoice.cgstValue || 0;
  const storedSgst = invoice.sgstValue || 0;
  const storedIgst = invoice.igstValue || 0;
  const grandTotal = invoice.totalAmount || 0;

  // Create PDF document
  const doc = new PDFDocument({ margin: LAYOUT.MARGIN.left, size: 'A4' });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  let cursorY = LAYOUT.MARGIN.top;

  // Header
  const headerH = drawHeader(doc, seller, meta, cursorY);
  cursorY += headerH + LAYOUT.SECTION_GAP;

  // Parties
  const partiesH = drawParties(doc, seller, buyer, cursorY);
  cursorY += partiesH + LAYOUT.SECTION_GAP - 10;

  // Items table
  const tableStartY = cursorY;
  const tableH = drawItemsTable(doc, computedItems, cursorY, isIntraState);
  cursorY = tableStartY + tableH;

  // Totals
  const totalsH = drawTotals(doc, computedItems, storedCgst, storedSgst, storedIgst, grandTotal, cursorY, isIntraState);
  const tableEndY = cursorY + totalsH;

  // Draw border around table + totals
  drawBox(doc, LAYOUT.MARGIN.left, tableStartY, A4_WIDTH - LAYOUT.MARGIN.left - LAYOUT.MARGIN.right, tableEndY - tableStartY, LAYOUT.THEME.PRIMARY);
  cursorY = tableEndY + LAYOUT.SECTION_GAP;

  // Compliance section (IRN + EWB)
  const compH = await drawComplianceSection(doc, gstDoc, invoice, cursorY);
  cursorY += compH;
  if (compH > 0) cursorY += LAYOUT.SECTION_GAP;

  // Footer — ensure it fits, else add page
  const footerNeeded = 50;
  if (cursorY + footerNeeded > A4_HEIGHT - LAYOUT.MARGIN.bottom) {
    doc.addPage();
    cursorY = LAYOUT.MARGIN.top;
  }
  drawFooter(doc, seller.name, cursorY);

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
