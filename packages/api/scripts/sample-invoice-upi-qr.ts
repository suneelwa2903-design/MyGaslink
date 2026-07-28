/**
 * Sample: how the UPI QR looks on the invoice header.
 *
 * Uses the exact same URL format + QR generation the production PDF
 * service does (packages/api/src/services/pdf/invoicePdfService.ts:1160),
 * just wrapped in a mock header so you can see the actual visual output
 * without touching any distributor's UPI ID in the DB.
 *
 * Run:  pnpm --filter @gaslink/api exec tsx scripts/sample-invoice-upi-qr.ts
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// ─── Sample data (edit these to try different scenarios) ────────────────────
const seller = {
  businessName: 'Bhargava Gas Agency',
  legalName: 'Bhargava Gas Agency',
  address: 'Plot 42, Industrial Estate, Kondapur, Telangana - 500084',
  phone: '+91 98765 43210',
  email: 'sales@bhargavagas.example',
  gstin: '36AAAAB1234C1Z5',
  // Suneel's UPI ID
  upiId: '8939736309-2@ybl',
};

const invoice = {
  invoiceNumber: 'INV-2026-12345',
  invoiceDate: '2026-07-28',
  dueDate: '2026-08-11',
  grandTotal: 15678.50,          // the QR pre-fills this amount in the payer's UPI app
};

// ─── PDF constants (match the prod invoice PDF layout) ──────────────────────
const PAGE_WIDTH = 595;
const MARGIN = { left: 40, right: 40, top: 40 };
const USABLE = PAGE_WIDTH - MARGIN.left - MARGIN.right;

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#d1d5db',
};

async function render(mode: 'amount_prefilled' | 'amount_free' = 'amount_prefilled'): Promise<Buffer> {
  // ── Build the UPI intent URL exactly like the production service does ────
  const payee = encodeURIComponent(seller.businessName);
  const note = encodeURIComponent(`Invoice ${invoice.invoiceNumber}`);
  const upiUrl = mode === 'amount_prefilled'
    ? `upi://pay?pa=${encodeURIComponent(seller.upiId)}` +
      `&pn=${payee}` +
      `&am=${invoice.grandTotal.toFixed(2)}` +
      `&cu=INR` +
      `&tn=${note}`
    // Amount-free variant (production default as of 2026-07-28): customer
    // types the amount themselves. `tn` still carries the invoice number
    // so the seller's UPI notification identifies which invoice was paid
    // — reconciliation still works even though the amount is user-entered.
    : `upi://pay?pa=${encodeURIComponent(seller.upiId)}` +
      `&pn=${payee}` +
      `&cu=INR` +
      `&tn=${note}`;

  console.log(`── Mode: ${mode} ──`);
  console.log('UPI intent URL encoded into the QR:');
  console.log(`  ${upiUrl}`);
  console.log('');
  if (mode === 'amount_prefilled') {
    console.log('Payer sees in GPay / PhonePe / Paytm:');
    console.log(`  Payee     : ${seller.businessName}`);
    console.log(`  UPI ID    : ${seller.upiId}`);
    console.log(`  Amount    : Rs. ${invoice.grandTotal.toFixed(2)}  (pre-filled, editable)`);
    console.log(`  Note      : Invoice ${invoice.invoiceNumber}`);
  } else {
    console.log('Payer sees in GPay / PhonePe / Paytm:');
    console.log(`  Payee     : ${seller.businessName}`);
    console.log(`  UPI ID    : ${seller.upiId}`);
    console.log(`  Amount    : (empty — customer types any amount)`);
    console.log(`  Note      : Invoice ${invoice.invoiceNumber}  (preserved so seller can reconcile)`);
  }
  console.log('');

  const upiQrPng = await QRCode.toBuffer(upiUrl, { type: 'png', width: 240, margin: 1 });

  // ── PDF ──────────────────────────────────────────────────────────────────
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.addPage({ size: 'A4', margin: 0 });
  let y = MARGIN.top;

  // ── HEADER — matches production invoicePdfService.ts drawHeader ─────────
  // Left column: business name + address block
  const leftColW = 240;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(THEME.PRIMARY)
    .text(seller.legalName, MARGIN.left, y, { width: leftColW });
  doc.font('Helvetica').fontSize(8).fillColor(THEME.MUTED)
    .text(seller.address, MARGIN.left, y + 24, { width: leftColW })
    .text(`Phone: ${seller.phone}`, MARGIN.left, y + 36, { width: leftColW })
    .text(`GSTIN: ${seller.gstin}`, MARGIN.left, y + 48, { width: leftColW });

  // Center: UPI QR — top-centered, this is what mini-op #6 c8a0776 shipped
  const qrSize = 72;
  const qrX = MARGIN.left + (USABLE - qrSize) / 2;
  const qrY = y + 4;
  doc.image(upiQrPng, qrX, qrY, { fit: [qrSize, qrSize] });
  doc.font('Helvetica').fontSize(6).fillColor(THEME.MUTED)
    .text(mode === 'amount_prefilled' ? 'Scan to pay this invoice' : 'Scan to pay any amount',
      qrX - 30, qrY + qrSize + 3, { width: qrSize + 60, align: 'center' });

  // Right: TAX INVOICE title + invoice #, dates
  const rightColW = 180;
  const rightX = MARGIN.left + USABLE - rightColW;
  doc.font('Helvetica-Bold').fontSize(16).fillColor(THEME.PRIMARY)
    .text('TAX INVOICE', rightX, y, { width: rightColW, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(THEME.TEXT)
    .text(`Invoice #: ${invoice.invoiceNumber}`, rightX, y + 24, { width: rightColW, align: 'right' })
    .text(`Date: ${invoice.invoiceDate}`, rightX, y + 36, { width: rightColW, align: 'right' })
    .text(`Due: ${invoice.dueDate}`, rightX, y + 48, { width: rightColW, align: 'right' });

  y = qrY + qrSize + 24;
  doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + USABLE, y)
    .strokeColor(THEME.BORDER).lineWidth(0.5).stroke();
  y += 14;

  // ── Rest of the invoice (mock, just so the QR isn't floating alone) ─────
  doc.font('Helvetica-Bold').fontSize(10).fillColor(THEME.PRIMARY)
    .text('Bill To', MARGIN.left, y);
  doc.font('Helvetica').fontSize(9).fillColor(THEME.TEXT)
    .text('Royal Kitchen Restaurant', MARGIN.left, y + 14)
    .text('Shop 12, Banjara Hills Rd No. 1', MARGIN.left, y + 26)
    .text('Hyderabad, Telangana - 500034', MARGIN.left, y + 38);
  y += 60;

  // Line items table
  doc.rect(MARGIN.left, y, USABLE, 20).fill('#e0ecf7');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(THEME.PRIMARY);
  doc.text('Item', MARGIN.left + 8, y + 6, { width: 280 });
  doc.text('Qty', MARGIN.left + 300, y + 6, { width: 40, align: 'right' });
  doc.text('Rate', MARGIN.left + 350, y + 6, { width: 70, align: 'right' });
  doc.text('Amount', MARGIN.left + 435, y + 6, { width: 80, align: 'right' });
  y += 22;

  const rows = [
    { name: '19 KG Commercial Cylinder', qty: 6, rate: 2150.00 },
    { name: '47.5 KG Commercial Cylinder', qty: 1, rate: 5400.00 },
  ];
  doc.font('Helvetica').fontSize(9).fillColor(THEME.TEXT);
  for (const r of rows) {
    const amt = r.qty * r.rate;
    doc.text(r.name, MARGIN.left + 8, y + 4, { width: 280 });
    doc.text(String(r.qty), MARGIN.left + 300, y + 4, { width: 40, align: 'right' });
    doc.text(r.rate.toFixed(2), MARGIN.left + 350, y + 4, { width: 70, align: 'right' });
    doc.text(amt.toFixed(2), MARGIN.left + 435, y + 4, { width: 80, align: 'right' });
    y += 18;
  }

  // Grand total
  y += 6;
  doc.rect(MARGIN.left + USABLE - 200, y, 200, 26).fill(THEME.PRIMARY);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
    .text('GRAND TOTAL', MARGIN.left + USABLE - 200 + 10, y + 8, { width: 110, align: 'left' })
    .text(`Rs. ${invoice.grandTotal.toFixed(2)}`, MARGIN.left + USABLE - 200 + 120, y + 8, { width: 70, align: 'right' });
  y += 36;

  // Callout under the total: "To pay, scan the QR at the top of this invoice"
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(THEME.MUTED)
    .text(
      `To pay this invoice, scan the QR at the top of this page or send Rs. ${invoice.grandTotal.toFixed(2)} to UPI: ${seller.upiId}`,
      MARGIN.left, y, { width: USABLE, align: 'center' },
    );

  doc.end();
  return done;
}

const OUT_DIR = 'C:/Users/HP/AppData/Local/Temp/claude/C--Projects-Re-New-Gaslink/cb465259-91cb-4798-88b7-bed9b208e5b0/scratchpad';

Promise.all([
  render('amount_prefilled').then((buf) => writeFile(path.join(OUT_DIR, 'sample-invoice-upi-qr-prefilled.pdf'), buf)),
  render('amount_free').then((buf) => writeFile(path.join(OUT_DIR, 'sample-invoice-upi-qr-any-amount.pdf'), buf)),
])
  .then(() => console.log('Wrote both variants to scratchpad.'))
  .catch((err) => { console.error(err); process.exit(1); });
