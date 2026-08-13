/**
 * Deposit Voucher PDF — Change L (2026-07-31).
 *
 * One PDF per deposit event (charged or refunded), shareable to the
 * customer as proof-of-deposit or proof-of-refund. Modeled loosely on
 * the Indane "Subscription Voucher" the operator sent as reference:
 *   - Distributor letterhead (same shape as customer ledger PDF)
 *   - Voucher title ("Cylinder Deposit Voucher" or "Refund Voucher")
 *   - Voucher No + Date (right block)
 *   - Customer block (name, phone, GSTIN, address)
 *   - Cylinder detail table: Type | Qty | Rate | Amount
 *   - Amount in words
 *   - Terms / notes block
 *   - Signature block (Received By left, Customer Signature right)
 *   - Optional UPI scan-to-pay QR (same intent format as ledger PDF)
 *
 * Portrait A4 — the voucher is a compact single-page document, not a
 * data-heavy statement, so portrait reads better than landscape.
 *
 * Consumed by GET /api/payments/deposits/:ledgerEntryId/voucher.pdf
 * (see routes/payments.ts). RBAC gate at route layer.
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prisma } from '../../lib/prisma.js';
import { getPdfAccentColor, setPdfAccent, currentPdfAccent } from './pdfTheme.js';
import { toNum } from '../../utils/decimal.js';
import { formatMoney, formatDate } from './pdfLayoutUtils.js';

const PAGE_WIDTH = 595; // A4 portrait width in pt
const PAGE_HEIGHT = 842;
const MARGIN = { top: 50, left: 40, right: 40 };
const RIGHT_EDGE = PAGE_WIDTH - MARGIN.right;
const CONTENT_W = RIGHT_EDGE - MARGIN.left;

// Change L v2 (2026-07-31): palette LIFTED VERBATIM from invoicePdfService.ts
// LAYOUT.THEME so vouchers, invoices, and the customer ledger PDF all look
// like they came from the same office. Any future palette change should be
// made in ONE place and propagated to all three PDF services.
const THEME = {
  get PRIMARY() { return currentPdfAccent(); },
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#e5e7eb',
  ZEBRA: '#f8fafc',
  PAPER: '#ffffff',
};

// Change L v2 (2026-07-31): typography also aligned to invoice PDF's
// LAYOUT.TYPO. H1=18/H2=11/BODY=9/CAPTION=8 gives us the same visual
// hierarchy so the two documents read as a set. Deposit voucher uses
// BODY at 10 (not 9) for the customer + line table because the doc is
// single-page portrait — one point wider makes the printed voucher more
// readable when a customer signs it in poor light.
const TYPO = {
  H1: 18,
  H2: 11,
  H2_TITLE: 14,
  BODY: 10,
  CAPTION: 8,
  META: 9,
};

/**
 * Small Indian-numbering amount-in-words helper. Handles 0 to ~99.99 crore
 * which covers every plausible deposit amount. No external dependency —
 * we only need the "Rupees N Only" phrasing.
 */
function amountInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - rupees) * 100);
  const rupeesWords = numToIndianWords(rupees);
  const paiseWords = paise > 0 ? ` and ${numToIndianWords(paise)} Paise` : '';
  return `Rupees ${rupeesWords}${paiseWords} Only`;
}

function numToIndianWords(n: number): string {
  if (n === 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const twoDigit = (x: number): string => {
    if (x < 20) return ones[x];
    return `${tens[Math.floor(x / 10)]}${x % 10 > 0 ? ' ' + ones[x % 10] : ''}`;
  };
  const threeDigit = (x: number): string => {
    const h = Math.floor(x / 100);
    const rest = x % 100;
    return `${h > 0 ? ones[h] + ' Hundred' : ''}${h > 0 && rest > 0 ? ' ' : ''}${rest > 0 ? twoDigit(rest) : ''}`;
  };
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  if (crore > 0) parts.push(`${twoDigit(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigit(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigit(thousand)} Thousand`);
  if (rest > 0) parts.push(threeDigit(rest));
  return parts.join(' ').trim();
}

export async function generateDepositVoucherPdf(
  distributorId: string,
  ledgerEntryId: string,
): Promise<Buffer> {
  setPdfAccent(await getPdfAccentColor(distributorId ?? ''));
  // 1. Load the ledger entry + related bits.
  //
  // Change L v2 (2026-07-31): also pull voucherNumber — the sequential
  // V<CODE><FY><SEQ> allocation persisted at write-time (see
  // paymentService.tryAllocateVoucherNumber). Legacy rows before this
  // change have voucherNumber=null; we fall back to DEP-<uuid-prefix>
  // so pre-v2 PDFs stay openable.
  const entry = await prisma.customerLedgerEntry.findFirst({
    where: {
      id: ledgerEntryId,
      distributorId,
      entryType: { in: ['deposit_charged', 'deposit_refunded'] },
    },
    select: {
      id: true,
      entryType: true,
      entryDate: true,
      amountDelta: true,
      qtyDelta: true,
      voucherNumber: true,
      customer: {
        select: {
          customerName: true, businessName: true, gstin: true, phone: true,
          billingAddressLine1: true, billingAddressLine2: true,
          billingCity: true, billingState: true, billingPincode: true,
        },
      },
      cylinderType: { select: { typeName: true } },
    },
  });
  if (!entry) throw new Error('Deposit ledger entry not found');
  if (!entry.customer) throw new Error('Customer linked to entry not found');

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
      bankName: true, bankAccountNumber: true, bankBranchName: true,
      ifscCode: true, upiId: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  // 2. Prepare data.
  const isRefund = entry.entryType === 'deposit_refunded';
  const qty = entry.qtyDelta ?? 0;
  const amount = toNum(entry.amountDelta);
  const cylTypeName = entry.cylinderType?.typeName ?? '—';
  const unitRate = qty > 0 ? amount / qty : 0;
  // Change L v2 (2026-07-31): prefer the sequential voucherNumber. Fall
  // back to DEP-<uuid-prefix> only for legacy rows created before the
  // Change L v2 migration.
  const voucherNo = entry.voucherNumber ?? `DEP-${entry.id.slice(0, 8).toUpperCase()}`;
  const eventDate = formatDate(entry.entryDate);

  const sellerName = distributor.businessName || distributor.legalName;
  const sellerAddr = [distributor.address, distributor.city, distributor.state, distributor.pincode]
    .filter(Boolean).join(', ') || '—';

  const custName = entry.customer.businessName || entry.customer.customerName;
  const custAddr = [
    entry.customer.billingAddressLine1,
    entry.customer.billingAddressLine2,
    entry.customer.billingCity,
    entry.customer.billingState,
    entry.customer.billingPincode,
  ].filter(Boolean).join(', ') || '—';

  // 3. Optional UPI QR — same intent format ledger PDF uses (mini-op #6 v2).
  let upiQrPng: Buffer | undefined;
  if (distributor.upiId && !isRefund) {
    // Only for CHARGE events (customer might scan to pay). Refund
    // vouchers have no "please pay" affordance.
    try {
      const payee = encodeURIComponent(sellerName);
      const note = encodeURIComponent(`Deposit ${voucherNo}`);
      const upiUrl =
        `upi://pay?pa=${encodeURIComponent(distributor.upiId)}` +
        `&pn=${payee}&cu=INR&tn=${note}`;
      upiQrPng = await QRCode.toBuffer(upiUrl, { type: 'png', width: 100, margin: 1 });
    } catch {
      upiQrPng = undefined;
    }
  }

  // 4. Render.
  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: MARGIN.left });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  let y = MARGIN.top;

  // ── Header (distributor letterhead — left) + Voucher meta (right) ──
  //
  // Change L v2 (2026-07-31): left+right blocks are drawn independently
  // and then `y` is advanced to max(leftY, rightY) + spacer, so a long
  // seller name or address on either side can never bleed into the
  // customer block below.
  const rightBlockW = 220;
  const leftBlockW = CONTENT_W - rightBlockW - 20;

  doc.font('Helvetica-Bold').fontSize(TYPO.H1).fillColor(THEME.PRIMARY);
  const nameH = doc.heightOfString(sellerName, { width: leftBlockW });
  doc.text(sellerName, MARGIN.left, y, { width: leftBlockW });
  let leftY = y + nameH + 4;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  const addrH = doc.heightOfString(sellerAddr, { width: leftBlockW });
  doc.text(sellerAddr, MARGIN.left, leftY, { width: leftBlockW });
  leftY += addrH + 2;
  doc.text(
    `GSTIN: ${distributor.gstin || '—'}   Phone: ${distributor.phone || '—'}`,
    MARGIN.left, leftY, { width: leftBlockW },
  );
  leftY += 12;

  // Right — voucher label + no + date
  const rightX = RIGHT_EDGE - rightBlockW;
  doc.font('Helvetica-Bold').fontSize(TYPO.H2_TITLE).fillColor(THEME.PRIMARY);
  doc.text(
    isRefund ? 'Deposit Refund Voucher' : 'Cylinder Deposit Voucher',
    rightX, y, { width: rightBlockW, align: 'right' },
  );
  // Change L v2 fix (2026-07-31 v3): PDFKit's `continued: true` with
  // right-align renders both segments right-anchored to the SAME edge,
  // so label and value overlap. Draw voucher-no as a single bold string
  // instead — the whole meta block reads as one right-aligned column.
  doc.font('Helvetica-Bold').fontSize(TYPO.META).fillColor(THEME.TEXT);
  doc.text(`Voucher No: ${voucherNo}`, rightX, y + 22, {
    width: rightBlockW,
    align: 'right',
  });
  doc.font('Helvetica').fontSize(TYPO.META).fillColor(THEME.MUTED);
  doc.text(`Date: ${eventDate}`, rightX, y + 36, { width: rightBlockW, align: 'right' });

  y = Math.max(leftY, y + 52) + 6;
  doc.moveTo(MARGIN.left, y).lineTo(RIGHT_EDGE, y)
    .strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 14;

  // ── Customer block ──
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.PRIMARY);
  doc.text('Bill To', MARGIN.left, y); y += 14;
  doc.font('Helvetica-Bold').fontSize(TYPO.BODY + 1).fillColor(THEME.TEXT);
  const custNameH = doc.heightOfString(custName, { width: CONTENT_W });
  doc.text(custName, MARGIN.left, y, { width: CONTENT_W }); y += custNameH + 2;
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED);
  const custAddrH = doc.heightOfString(custAddr, { width: CONTENT_W });
  doc.text(custAddr, MARGIN.left, y, { width: CONTENT_W }); y += custAddrH + 2;
  doc.text(
    `Phone: ${entry.customer.phone || '—'}    GSTIN: ${entry.customer.gstin || '—'}`,
    MARGIN.left, y, { width: CONTENT_W },
  );
  y += 22;

  // ── Deposit detail table ──
  const cols = [
    { label: 'Cylinder Type', width: 220, align: 'left' as const },
    { label: 'Qty',           width: 60,  align: 'right' as const },
    { label: 'Rate (Rs.)',    width: 100, align: 'right' as const },
    { label: 'Amount (Rs.)',  width: 135, align: 'right' as const },
  ];
  // Header row — same style as invoicePdfService.drawTableHeader
  const headerH = 22;
  doc.rect(MARGIN.left, y, CONTENT_W, headerH).fill(THEME.PRIMARY);
  doc.fillColor(THEME.PAPER).font('Helvetica-Bold').fontSize(TYPO.CAPTION + 1);
  {
    let hx = MARGIN.left;
    for (const c of cols) {
      doc.text(c.label, hx + 6, y + 7, { width: c.width - 12, align: c.align });
      hx += c.width;
    }
  }
  y += headerH;
  // Data row — zebra-shaded (invoice PDF's ZEBRA background for even rows)
  const rowH = 26;
  doc.rect(MARGIN.left, y, CONTENT_W, rowH).fillAndStroke(THEME.PAPER, THEME.BORDER);
  doc.fillColor(THEME.TEXT).font('Helvetica').fontSize(TYPO.BODY);
  {
    let dx = MARGIN.left;
    doc.text(cylTypeName, dx + 6, y + 8, { width: cols[0].width - 12, align: cols[0].align }); dx += cols[0].width;
    doc.text(String(qty), dx + 6, y + 8, { width: cols[1].width - 12, align: cols[1].align }); dx += cols[1].width;
    doc.text(formatMoney(unitRate), dx + 6, y + 8, { width: cols[2].width - 12, align: cols[2].align }); dx += cols[2].width;
    doc.text(formatMoney(amount), dx + 6, y + 8, { width: cols[3].width - 12, align: cols[3].align });
  }
  y += rowH;
  // Totals row — ZEBRA shade + subtle top border to separate from data
  doc.rect(MARGIN.left, y, CONTENT_W, rowH).fillAndStroke(THEME.ZEBRA, THEME.BORDER);
  doc.fillColor(THEME.TEXT).font('Helvetica-Bold').fontSize(TYPO.BODY);
  {
    const totalLabelX = MARGIN.left + cols[0].width + cols[1].width + cols[2].width - 40;
    doc.text('Total', totalLabelX, y + 8, { width: 40, align: 'right' });
    doc.text(
      formatMoney(amount),
      MARGIN.left + cols[0].width + cols[1].width + cols[2].width + 6,
      y + 8,
      { width: cols[3].width - 12, align: 'right' },
    );
  }
  y += rowH + 14;

  // Amount in words
  //
  // Change L v2 fix (2026-07-31 v3): same PDFKit continued-text pitfall
  // as the voucher-no block — a `continued: true` regular label followed
  // by a bold text() at the same y was overlaying the two strings.
  // Draw as one bold string so the value never collides with the label.
  doc.font('Helvetica-Bold').fontSize(TYPO.BODY).fillColor(THEME.TEXT);
  const wordsLine = `Amount in words: ${amountInWords(amount)}`;
  const wordsH = doc.heightOfString(wordsLine, { width: CONTENT_W });
  doc.text(wordsLine, MARGIN.left, y, { width: CONTENT_W });
  y += wordsH + 20;

  // ── Terms / notes ──
  //
  // Change L v2 (2026-07-31): each line's height is measured with
  // heightOfString and y advances by that + a fixed gap, so multi-line
  // terms (T&C #3 for charge often wraps) don't overlap the next term
  // OR the signature block below. Previous version hard-coded +14 per
  // line and the wrap silently overshot into the signature line.
  doc.font('Helvetica-Bold').fontSize(TYPO.META).fillColor(THEME.PRIMARY);
  doc.text('Terms & Conditions', MARGIN.left, y); y += 14;
  const termsFont = 'Helvetica';
  const termsSize = TYPO.META;
  doc.font(termsFont).fontSize(termsSize).fillColor(THEME.MUTED);
  const terms = isRefund
    ? [
        `1. This voucher acknowledges the refund of Rs. ${formatMoney(amount).replace(/^Rs\.\s*/, '')} against the return of ${qty} × ${cylTypeName} cylinder(s) previously held on deposit.`,
        `2. Cylinders returned have been inspected and accepted in usable condition by ${sellerName}.`,
        `3. This voucher supersedes any deposit receipt(s) previously issued for the refunded cylinders.`,
      ]
    : [
        `1. This voucher acknowledges receipt of Rs. ${formatMoney(amount).replace(/^Rs\.\s*/, '')} as refundable cylinder deposit for ${qty} × ${cylTypeName} cylinder(s).`,
        `2. Deposit is refundable on return of the same quantity of empty cylinders in good, refillable condition, subject to inspection.`,
        `3. Cylinders remain the property of ${sellerName}. Damaged, lost, or diverted cylinders will forfeit the deposit for that unit.`,
        `4. Present this voucher (or reference the Voucher No.) when requesting refund. Retain for records.`,
      ];
  for (const t of terms) {
    const th = doc.heightOfString(t, { width: CONTENT_W });
    doc.text(t, MARGIN.left, y, { width: CONTENT_W });
    y += th + 4;
  }
  y += 8;

  // ── UPI QR (charge only, if configured) ──
  if (upiQrPng) {
    doc.font('Helvetica-Bold').fontSize(TYPO.META).fillColor(THEME.PRIMARY);
    doc.text('Scan to pay via UPI', MARGIN.left, y); y += 14;
    doc.image(upiQrPng, MARGIN.left, y, { fit: [88, 88] });
    // Bank details next to QR
    if (distributor.bankAccountNumber && distributor.ifscCode) {
      const bx = MARGIN.left + 100;
      let by = y + 2;
      doc.font('Helvetica-Bold').fontSize(TYPO.META).fillColor(THEME.TEXT);
      doc.text(distributor.businessName || distributor.legalName, bx, by); by += 13;
      doc.font('Helvetica').fontSize(TYPO.META).fillColor(THEME.MUTED);
      const branchSuffix = distributor.bankBranchName ? `, ${distributor.bankBranchName}` : '';
      doc.text(`Bank: ${distributor.bankName ?? '—'}${branchSuffix}`, bx, by); by += 12;
      doc.text(`A/C: ${distributor.bankAccountNumber}`, bx, by); by += 12;
      doc.text(
        `IFSC: ${distributor.ifscCode}${distributor.upiId ? '   UPI: ' + distributor.upiId : ''}`,
        bx, by,
      );
    }
    y += 100;
  }

  // ── Signature block ──
  //
  // Change L v2 (2026-07-31): anchored to a fixed offset from the page
  // bottom so it can't collide with the terms block regardless of how
  // many lines those wrap into. y-clamp ensures we don't jump BACKWARDS
  // if the terms block pushed us past that anchor (though on a normal
  // deposit event with 3-4 terms + optional QR we always still have room).
  const sigAnchorY = PAGE_HEIGHT - MARGIN.top - 80;
  y = Math.max(y + 6, sigAnchorY);
  const sigW = (CONTENT_W - 40) / 2;
  doc.strokeColor(THEME.TEXT).lineWidth(0.75);
  doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + sigW, y).stroke();
  doc.moveTo(RIGHT_EDGE - sigW, y).lineTo(RIGHT_EDGE, y).stroke();
  y += 5;
  doc.font('Helvetica-Bold').fontSize(TYPO.META).fillColor(THEME.TEXT);
  doc.text('Received / Issued By', MARGIN.left, y, { width: sigW, align: 'center' });
  doc.text('Customer Signature', RIGHT_EDGE - sigW, y, { width: sigW, align: 'center' });
  y += 13;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(`for ${sellerName}`, MARGIN.left, y, { width: sigW, align: 'center' });

  // Footer — auto-generated notice
  const footerY = PAGE_HEIGHT - MARGIN.top + 10;
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(
    `This is a ${sellerName}-authorised, auto-generated voucher. Voucher No. ${voucherNo} is unique and traceable.`,
    MARGIN.left, footerY - 20, { width: CONTENT_W, align: 'center' },
  );

  doc.end();
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}
