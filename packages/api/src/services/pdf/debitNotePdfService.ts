/**
 * Debit Note PDF Service (WI-039).
 *
 * Mirror of creditNotePdfService.ts. We deliberately keep this as a
 * sibling file rather than refactoring the credit-note layout into a
 * shared "note" generator — the layouts will diverge as soon as DN
 * gets its own IRN/QR section (DebitNote table doesn't carry those
 * columns yet). Sharing layout primitives via pdfLayoutUtils.
 */

import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { toNum } from '../../utils/decimal.js';
import {
  formatMoney, drawBox, drawTextBlock,
} from './pdfLayoutUtils.js';

const A4_WIDTH = 595;
const A4_HEIGHT = 842;

const LAYOUT = {
  MARGIN: { left: 40, right: 40, top: 50, bottom: 50 },
  SECTION_GAP: 16,
  CARD_PADDING: 14,
  BORDER_WIDTH: 1,
  THEME: {
    PRIMARY: '#0a3d62',
    TEXT: '#111827',
    MUTED: '#6b7280',
    BORDER: '#e5e7eb',
    PAPER: '#ffffff',
  },
  TYPO: { H1: 18, H2: 11, BODY: 9, LABEL: 8, CAPTION: 8 },
};

function drawHeader(
  doc: PDFKit.PDFDocument,
  sellerName: string,
  debitNoteNumber: string,
  startY: number,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  let cursorY = startY;

  doc.fontSize(Math.round(F.H2 * 1.5)).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text(sellerName, leftX, cursorY, { width: 300 });
  const companyY = cursorY + 18;

  doc.fontSize(F.H1).fillColor(T.PRIMARY).font('Helvetica-Bold');
  const titleText = 'Debit Note';
  const titleW = doc.widthOfString(titleText);
  doc.text(titleText, rightMargin - titleW, cursorY, { width: titleW });

  let rightY = cursorY + F.H1 + 6;
  doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
  const docNoText = `No: ${debitNoteNumber || '—'}`;
  doc.text(docNoText, rightMargin - doc.widthOfString(docNoText), rightY, { width: 200 });
  rightY += 14;

  const bottomY = Math.max(companyY, rightY);
  const lineY = bottomY + 4;
  doc.moveTo(leftX, lineY).lineTo(rightMargin, lineY)
    .strokeColor(T.PRIMARY).lineWidth(LAYOUT.BORDER_WIDTH).stroke();

  return lineY + 4 - startY;
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

  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Bill From', leftX + pad, titleY);
  let fromY = contentStart;
  fromY += drawTextBlock(doc, leftX + pad, fromY, columnWidth - pad * 2, seller.name, F.BODY, { bold: true }) + gap;
  fromY += drawTextBlock(doc, leftX + pad, fromY, columnWidth - pad * 2, seller.address, F.BODY, { color: T.MUTED }) + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`GSTIN: ${seller.gstin || '—'}`, leftX + pad, fromY, { width: columnWidth - pad * 2 }); fromY += 12;
  doc.text(`Phone: ${seller.phone || '—'}`, leftX + pad, fromY, { width: columnWidth - pad * 2 }); fromY += 12;
  const billFromH = fromY - startY + pad;

  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Bill To', rightX + pad, titleY);
  let toY = contentStart;
  toY += drawTextBlock(doc, rightX + pad, toY, columnWidth - pad * 2, buyer.name, F.BODY, { bold: true }) + gap;
  toY += drawTextBlock(doc, rightX + pad, toY, columnWidth - pad * 2, buyer.address, F.BODY, { color: T.MUTED }) + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`GSTIN: ${buyer.gstin || '—'}`, rightX + pad, toY, { width: columnWidth - pad * 2 }); toY += 12;
  doc.text(`Phone: ${buyer.phone || '—'}`, rightX + pad, toY, { width: columnWidth - pad * 2 }); toY += 12;
  const billToH = toY - startY + pad;

  return Math.max(billFromH, billToH);
}

function drawFooter(doc: PDFKit.PDFDocument, startY: number): void {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;
  const boxH = 36;
  drawBox(doc, leftX, startY, fullWidth, boxH, T.BORDER);
  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text(
    'This is a computer-generated debit note and does not require a signature.',
    leftX + 10, startY + 12, { width: fullWidth - 20, align: 'center' },
  );
}

export async function generateDebitNotePdf(debitNoteId: string, distributorId: string): Promise<Buffer> {
  const debitNote = await prisma.debitNote.findFirst({
    where: { id: debitNoteId, invoice: { distributorId } },
    include: { invoice: { include: { distributor: true, customer: true } } },
  });
  if (!debitNote) throw new Error('Debit note not found');

  const inv = debitNote.invoice;
  const dist = inv.distributor;
  const cust = inv.customer;

  const sellerAddr = [dist.address, dist.city, dist.state, dist.pincode].filter(Boolean).join(', ') || '—';
  const seller = {
    name: dist.businessName || dist.legalName,
    gstin: dist.gstin,
    phone: dist.phone,
    address: sellerAddr,
  };

  const buyerAddr = cust
    ? [cust.billingAddressLine1, cust.billingAddressLine2, cust.billingCity, cust.billingState, cust.billingPincode].filter(Boolean).join(', ') || '—'
    : '—';
  const buyer = {
    name: cust?.businessName || cust?.customerName || 'Customer',
    gstin: cust?.gstin && cust.gstin !== 'URP' ? cust.gstin : null,
    phone: cust?.phone || null,
    address: buyerAddr,
  };

  const doc = new PDFDocument({ margin: LAYOUT.MARGIN.left, size: 'A4' });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  let y = LAYOUT.MARGIN.top;
  const dnNumber = debitNote.debitNoteNumber || `DN-${debitNote.id.slice(0, 8)}`;
  y += drawHeader(doc, seller.name, dnNumber, y) + LAYOUT.SECTION_GAP;
  y += drawParties(doc, seller, buyer, y) + LAYOUT.SECTION_GAP;

  doc.fontSize(LAYOUT.TYPO.LABEL).fillColor(LAYOUT.THEME.MUTED).font('Helvetica');
  doc.text('Reference Invoice', LAYOUT.MARGIN.left, y); y += 12;
  doc.fontSize(LAYOUT.TYPO.BODY).fillColor(LAYOUT.THEME.TEXT).font('Helvetica');
  doc.text(inv.invoiceNumber || '—', LAYOUT.MARGIN.left, y, { width: 500 }); y += 20;

  doc.fontSize(LAYOUT.TYPO.H2).fillColor(LAYOUT.THEME.PRIMARY).font('Helvetica-Bold');
  doc.text('Reason', LAYOUT.MARGIN.left, y); y += 12;
  doc.fontSize(LAYOUT.TYPO.BODY).fillColor(LAYOUT.THEME.TEXT).font('Helvetica');
  doc.text((debitNote.reason || '—').slice(0, 200), LAYOUT.MARGIN.left, y, { width: 500 }); y += 24;

  doc.fontSize(LAYOUT.TYPO.H2).fillColor(LAYOUT.THEME.PRIMARY).font('Helvetica-Bold');
  doc.text(`Amount: ${formatMoney(toNum(debitNote.totalAmount))}`, LAYOUT.MARGIN.left, y); y += 24;

  const footerY = A4_HEIGHT - LAYOUT.MARGIN.bottom - 50;
  if (y < footerY) y = footerY;
  drawFooter(doc, y);

  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
