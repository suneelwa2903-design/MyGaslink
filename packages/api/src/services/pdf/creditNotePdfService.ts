/**
 * Credit Note PDF Service (TypeScript)
 *
 * Generates credit note PDFs using pdfkit.
 * Same layout style as invoice PDFs: header, Bill From/To, CRN details, footer.
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prisma } from '../../lib/prisma.js';
import { toNum } from '../../utils/decimal.js';
import {
  formatMoney, formatDate, formatIrnForDisplay,
  drawBox, drawTextBlock,
} from './pdfLayoutUtils.js';

// ─── Layout Constants ───────────────────────────────────────────────────────

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
    PILL_SUCCESS: '#059669',
  },
  TYPO: { H1: 18, H2: 11, BODY: 9, LABEL: 8, CAPTION: 8 },
};

// ─── Drawing Helpers ────────────────────────────────────────────────────────

function drawPill(doc: PDFKit.PDFDocument, x: number, y: number, text: string, color: string): void {
  doc.fontSize(LAYOUT.TYPO.CAPTION).font('Helvetica');
  const w = doc.widthOfString(text) + 10;
  doc.roundedRect(x, y, w, 14, 2).fill(color);
  doc.fillColor('#fff').font('Helvetica-Bold').text(text, x + 5, y + 2, { width: w - 10 });
  doc.fillColor(LAYOUT.THEME.TEXT);
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  sellerName: string,
  creditNoteNumber: string,
  startY: number,
): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  let cursorY = startY;

  // Company name
  doc.fontSize(Math.round(F.H2 * 1.5)).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text(sellerName, leftX, cursorY, { width: 300 });
  const companyY = cursorY + 18;

  // Right side: Credit Note title
  doc.fontSize(F.H1).fillColor(T.PRIMARY).font('Helvetica-Bold');
  const titleText = 'Credit Note';
  const titleW = doc.widthOfString(titleText);
  doc.text(titleText, rightMargin - titleW, cursorY, { width: titleW });

  // Document number
  let rightY = cursorY + F.H1 + 6;
  doc.fontSize(F.BODY).fillColor(T.MUTED).font('Helvetica');
  const docNoText = `No: ${creditNoteNumber || '\u2014'}`;
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

  // Bill From
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Bill From', leftX + pad, titleY);
  let fromY = contentStart;
  fromY += drawTextBlock(doc, leftX + pad, fromY, columnWidth - pad * 2, seller.name, F.BODY, { bold: true }) + gap;
  fromY += drawTextBlock(doc, leftX + pad, fromY, columnWidth - pad * 2, seller.address, F.BODY, { color: T.MUTED }) + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`GSTIN: ${seller.gstin || '\u2014'}`, leftX + pad, fromY, { width: columnWidth - pad * 2 }); fromY += 12;
  doc.text(`Phone: ${seller.phone || '\u2014'}`, leftX + pad, fromY, { width: columnWidth - pad * 2 }); fromY += 12;
  const billFromH = fromY - startY + pad;

  // Bill To
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('Bill To', rightX + pad, titleY);
  let toY = contentStart;
  toY += drawTextBlock(doc, rightX + pad, toY, columnWidth - pad * 2, buyer.name, F.BODY, { bold: true }) + gap;
  toY += drawTextBlock(doc, rightX + pad, toY, columnWidth - pad * 2, buyer.address, F.BODY, { color: T.MUTED }) + 8;
  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text(`GSTIN: ${buyer.gstin || '\u2014'}`, rightX + pad, toY, { width: columnWidth - pad * 2 }); toY += 12;
  doc.text(`Phone: ${buyer.phone || '\u2014'}`, rightX + pad, toY, { width: columnWidth - pad * 2 }); toY += 12;
  const billToH = toY - startY + pad;

  return Math.max(billFromH, billToH);
}

async function drawCrnDetailsBox(
  doc: PDFKit.PDFDocument,
  data: { irn?: string | null; ackNo?: string | null; ackDate?: Date | null; signedQr?: string | null; irnStatus?: string },
  startY: number,
): Promise<number> {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const pad = LAYOUT.CARD_PADDING;
  const qrSize = 90;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;

  const boxY = startY;
  let cy = boxY + pad;
  const textWidth = fullWidth - pad * 2 - qrSize - 16;

  if (data.irnStatus === 'success' || data.irnStatus === 'SUCCESS') {
    drawPill(doc, leftX + fullWidth - pad - 70, cy - 2, 'SUCCESS', T.PILL_SUCCESS);
  }
  doc.fontSize(F.H2).fillColor(T.PRIMARY).font('Helvetica-Bold');
  doc.text('CRN Details - IRN', leftX + pad, cy, { width: textWidth });
  cy += 16;

  doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
  doc.text('IRN:', leftX + pad, cy, { width: textWidth }); cy += 12;
  doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
  const irnFormatted = formatIrnForDisplay(data.irn);
  for (const line of irnFormatted.split('\n')) {
    if (line.trim()) {
      doc.text(line.trim(), leftX + pad, cy, { width: textWidth });
      cy += F.BODY + 4;
    }
  }
  cy += 10;

  if (data.ackNo) {
    doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
    doc.text('Ack No:', leftX + pad, cy, { width: textWidth }); cy += 12;
    doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
    doc.text(String(data.ackNo), leftX + pad, cy, { width: textWidth }); cy += 14;
  }
  if (data.ackDate) {
    doc.fontSize(F.LABEL).fillColor(T.MUTED).font('Helvetica');
    doc.text('Ack Date:', leftX + pad, cy, { width: textWidth }); cy += 12;
    doc.fontSize(F.BODY).fillColor(T.TEXT).font('Helvetica');
    doc.text(formatDate(data.ackDate), leftX + pad, cy, { width: textWidth }); cy += 14;
  }

  if (data.signedQr) {
    try {
      const qrX = leftX + fullWidth - pad - qrSize;
      const qrY = boxY + pad + 16;
      const qrPng = await QRCode.toBuffer(data.signedQr, { type: 'png', width: qrSize, margin: 1 });
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

  const boxH = cy - boxY;
  drawBox(doc, leftX, boxY, fullWidth, boxH, T.PRIMARY);
  return boxH + 10;
}

function drawFooter(doc: PDFKit.PDFDocument, startY: number): number {
  const T = LAYOUT.THEME;
  const F = LAYOUT.TYPO;
  const leftX = LAYOUT.MARGIN.left;
  const rightMargin = A4_WIDTH - LAYOUT.MARGIN.right;
  const fullWidth = rightMargin - leftX;
  let cursorY = startY;

  doc.fontSize(F.CAPTION).fillColor(T.MUTED).font('Helvetica');
  doc.text('This is a computer generated credit note.', leftX, cursorY, { width: fullWidth });
  cursorY += 14;

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

export async function generateCreditNotePdf(creditNoteId: string, distributorId: string): Promise<Buffer> {
  const creditNote = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, invoice: { distributorId } },
    include: {
      invoice: {
        include: {
          distributor: true,
          customer: true,
        },
      },
    },
  });

  if (!creditNote) throw new Error('Credit note not found');

  const inv = creditNote.invoice;
  const dist = inv.distributor;
  const cust = inv.customer;

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

  const doc = new PDFDocument({ margin: LAYOUT.MARGIN.left, size: 'A4' });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  let y = LAYOUT.MARGIN.top;

  // Header
  const cnNumber = creditNote.creditNoteNumber || `CN-${creditNote.id.slice(0, 8)}`;
  const headerH = drawHeader(doc, seller.name, cnNumber, y);
  y += headerH + LAYOUT.SECTION_GAP;

  // Parties
  const partiesH = drawParties(doc, seller, buyer, y);
  y += partiesH + LAYOUT.SECTION_GAP;

  // Reference Invoice
  doc.fontSize(LAYOUT.TYPO.LABEL).fillColor(LAYOUT.THEME.MUTED).font('Helvetica');
  doc.text('Reference Invoice', LAYOUT.MARGIN.left, y); y += 12;
  doc.fontSize(LAYOUT.TYPO.BODY).fillColor(LAYOUT.THEME.TEXT).font('Helvetica');
  doc.text(inv.invoiceNumber || '\u2014', LAYOUT.MARGIN.left, y, { width: 500 }); y += 20;

  // Reason
  doc.fontSize(LAYOUT.TYPO.H2).fillColor(LAYOUT.THEME.PRIMARY).font('Helvetica-Bold');
  doc.text('Reason', LAYOUT.MARGIN.left, y); y += 12;
  doc.fontSize(LAYOUT.TYPO.BODY).fillColor(LAYOUT.THEME.TEXT).font('Helvetica');
  doc.text((creditNote.reason || '\u2014').slice(0, 200), LAYOUT.MARGIN.left, y, { width: 500 }); y += 24;

  // Amount
  doc.fontSize(LAYOUT.TYPO.H2).fillColor(LAYOUT.THEME.PRIMARY).font('Helvetica-Bold');
  doc.text(`Amount: ${formatMoney(toNum(creditNote.totalAmount))}`, LAYOUT.MARGIN.left, y); y += 24;

  // WI-056: CRN Details box — sourced from gst_documents.
  //
  // Pre-WI-056 this section read phantom columns off the CreditNote row
  // (`irn` / `ackNo` / `signedQrCode`) that never existed. processCreditNoteGst
  // actually writes the IRN to a `gst_documents` row with docType=CRN and
  // invoiceId=cn.invoice. Look that up instead so the CN PDF renders the
  // real IRN block + QR code when the credit note went through NIC.
  const crnDoc = await prisma.gstDocument.findFirst({
    where: {
      invoiceId: inv.id,
      docType: 'CRN',
      isLatest: true,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (crnDoc && (crnDoc.irn || crnDoc.ackNo || crnDoc.signedQr)) {
    const crnH = await drawCrnDetailsBox(doc, {
      irn: crnDoc.irn,
      ackNo: crnDoc.ackNo,
      ackDate: crnDoc.ackDate,
      signedQr: crnDoc.signedQr,
      irnStatus: crnDoc.irnStatus,
    }, y);
    y += crnH;
  } else {
    // No usable CRN row OR a row exists but IRN failed at NIC. Drop a
    // short status line on the PDF so the recipient (finance / customer)
    // doesn't think the credit note is already on the GST portal when it
    // isn't. Two distinct states:
    //
    //   no row OR irnStatus='not_attempted'  → grey "e-Invoice: Pending"
    //   irnStatus='failed'                   → red "e-Invoice: Failed —
    //                                                retry from Billing page"
    //
    // A successful IRN renders the full CRN block above and never reaches
    // this branch.
    const failed =
      crnDoc?.irnStatus === 'failed';
    const label = failed
      ? 'e-Invoice: Failed — retry from Billing page'
      : 'e-Invoice: Pending';
    const color = failed ? '#dc2626' : LAYOUT.THEME.MUTED;
    doc.fontSize(LAYOUT.TYPO.LABEL).fillColor(color).font('Helvetica-Bold');
    doc.text(label, LAYOUT.MARGIN.left, y, {
      width: A4_WIDTH - LAYOUT.MARGIN.left - LAYOUT.MARGIN.right,
    });
    y += 16;
    doc.fillColor(LAYOUT.THEME.TEXT).font('Helvetica');
  }

  // Footer at bottom of page
  const footerY = A4_HEIGHT - LAYOUT.MARGIN.bottom - 50;
  if (y < footerY) y = footerY;
  drawFooter(doc, y);

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
