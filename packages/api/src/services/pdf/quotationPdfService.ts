/**
 * Mini-op #7 (2026-07-27) — Quotation PDF service.
 *
 * Rate-card layout locked in during design (see scripts/sample-quotation-pdf.ts
 * commit history for the earlier iterations). Ported here to run against real
 * Quotation rows.
 *
 * Modes: per_cylinder + per_kg + mixed. Mixed clusters consecutive per-cyl
 * rows into a shared table, then drops to card layout for per-kg rows.
 *
 * NO quantity, NO subtotals, NO grand total — this is a RATE quote, not a
 * value quote. The Grand Total was the #1 thing the user asked to strip.
 *
 * App-download QR block encodes the actual Play Store + App Store URLs so
 * a scanner lands directly on the target — one QR per store.
 */
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import QRCode from 'qrcode';
import { toNum } from '../../utils/decimal.js';

// ─── PDF constants ───────────────────────────────────────────────────────────

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };
const USABLE = PAGE_WIDTH - MARGIN.left - MARGIN.right;

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#d1d5db',
  SOFT_BORDER: '#e5e7eb',
  ZEBRA: '#f8fafc',
  HEADER_BAND: '#e0ecf7',
  CARD_HEAD: '#f1f5f9',
  SUBJECT_ACCENT: '#0a3d62',
  LINK: '#0369a1',
};

const TYPO = { H2: 15, H3: 11, LEAD: 10, BODY: 9, LABEL: 8, CAPTION: 7 };

// Production app URLs — a distributor override would live on
// DistributorSetting later. Hardcoded for v1.
const APP_LINKS = {
  playStore: 'https://play.google.com/store/apps/details?id=com.mygaslink.app',
  appStore: 'https://apps.apple.com/in/app/mygaslink/id6783034856',
};

function formatMoney(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  return `Rs. ${safe.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(dt.getDate()).padStart(2,'0')}-${months[dt.getMonth()]}-${dt.getFullYear()}`;
}

// ─── Renderer ────────────────────────────────────────────────────────────────

export async function generateQuotationPdf(
  distributorId: string, quotationId: string,
): Promise<Buffer> {
  const [distributor, quotation] = await Promise.all([
    prisma.distributor.findUnique({
      where: { id: distributorId },
      select: {
        businessName: true, legalName: true, address: true, city: true,
        state: true, pincode: true, phone: true, email: true, gstin: true,
      },
    }),
    prisma.quotation.findFirst({
      where: { id: quotationId, distributorId, deletedAt: null },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    }),
  ]);
  if (!distributor) throw new Error('Distributor not found');
  if (!quotation) throw new Error('Quotation not found');

  const seller = {
    businessName: distributor.legalName ?? distributor.businessName,
    address: distributor.address ?? '',
    city: distributor.city ?? '',
    state: distributor.state ?? '',
    pincode: distributor.pincode ?? '',
    phone: distributor.phone ?? '',
    email: distributor.email ?? '',
    gstin: distributor.gstin ?? '',
  };

  const terms = Array.isArray(quotation.terms) ? (quotation.terms as string[]) : [];
  const gstRate = toNum(quotation.gstRate);

  const playQrDataUrl = await QRCode.toDataURL(APP_LINKS.playStore, { margin: 1, width: 128 });
  const appQrDataUrl = await QRCode.toDataURL(APP_LINKS.appStore, { margin: 1, width: 128 });
  const playQrPng = Buffer.from(playQrDataUrl.split(',')[1], 'base64');
  const appQrPng = Buffer.from(appQrDataUrl.split(',')[1], 'base64');

  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.addPage({ size: 'A4', margin: 0 });
  let y = 0;

  // ── LETTERHEAD ──────────────────────────────────────────────────────────
  const bandHeight = 68;
  doc.rect(0, 0, PAGE_WIDTH, bandHeight).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
    .text(seller.businessName.toUpperCase(), 0, 14, { width: PAGE_WIDTH, align: 'center' });

  const addrLine = [seller.address, seller.city, seller.state && seller.pincode ? `${seller.state} - ${seller.pincode}` : seller.state ?? seller.pincode]
    .filter(Boolean).join(', ');
  const contactLine = [
    seller.phone ? `Phone ${seller.phone}` : null,
    seller.email,
    seller.gstin ? `GSTIN ${seller.gstin}` : null,
  ].filter(Boolean).join('  ·  ');

  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor('#c8dcee')
    .text(addrLine || '—', 0, 40, { width: PAGE_WIDTH, align: 'center' });
  doc.text(contactLine || '—', 0, 52, { width: PAGE_WIDTH, align: 'center' });
  y = bandHeight + 18;

  // ── LEFT: Quotation To  //  RIGHT: Meta ────────────────────────────────
  const gutter = 14;
  const leftWidth = 300;
  const rightWidth = USABLE - leftWidth - gutter;
  const leftBoxHeight = 118;

  doc.roundedRect(MARGIN.left, y, leftWidth, leftBoxHeight, 4)
    .strokeColor(THEME.BORDER).lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text('QUOTATION TO', MARGIN.left + 12, y + 10, { characterSpacing: 1 });
  doc.font('Helvetica-Bold').fontSize(TYPO.H3).fillColor(THEME.TEXT)
    .text(quotation.recipientName, MARGIN.left + 12, y + 22, { width: leftWidth - 24 });
  if (quotation.recipientContactPerson) {
    doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
      .text(`Attn: ${quotation.recipientContactPerson}`, MARGIN.left + 12, y + 36, { width: leftWidth - 24 });
  }
  if (quotation.recipientAddress) {
    doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED)
      .text(quotation.recipientAddress, MARGIN.left + 12, y + 50, { width: leftWidth - 24 });
  }
  const recipientCityLine = [
    quotation.recipientCity,
    quotation.recipientState && quotation.recipientPincode
      ? `${quotation.recipientState} - ${quotation.recipientPincode}`
      : quotation.recipientState ?? quotation.recipientPincode ?? '',
  ].filter(Boolean).join(', ');
  if (recipientCityLine) {
    doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED)
      .text(recipientCityLine, MARGIN.left + 12, y + 62, { width: leftWidth - 24 });
  }

  const labelX = MARGIN.left + 12;
  const valueX = MARGIN.left + 60;
  const valueWidth = leftWidth - 72;
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text('Email', labelX, y + 78);
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
    .text(quotation.recipientEmail, valueX, y + 77, { width: valueWidth, lineBreak: false, ellipsis: true });
  if (quotation.recipientPhone) {
    doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
      .text('Phone', labelX, y + 90);
    doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
      .text(quotation.recipientPhone, valueX, y + 89, { width: valueWidth, lineBreak: false });
  }
  if (quotation.recipientGstin) {
    doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
      .text('GSTIN', labelX, y + 102);
    doc.font('Helvetica-Bold').fontSize(TYPO.BODY).fillColor(THEME.PRIMARY)
      .text(quotation.recipientGstin, valueX, y + 101, { width: valueWidth, lineBreak: false });
  }

  const rightX = MARGIN.left + leftWidth + gutter;
  doc.roundedRect(rightX, y, rightWidth, leftBoxHeight, 4)
    .strokeColor(THEME.BORDER).lineWidth(0.8).stroke();
  const metaRow = (label: string, value: string, offset: number, opts: { emphasis?: boolean } = {}) => {
    doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
      .text(label.toUpperCase(), rightX + 12, y + 12 + offset, { characterSpacing: 1 });
    doc.font(opts.emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY)
      .fillColor(opts.emphasis ? THEME.PRIMARY : THEME.TEXT)
      .text(value, rightX + 12, y + 24 + offset, { width: rightWidth - 24 });
  };
  metaRow('Quote #', quotation.quotationNumber, 0, { emphasis: true });
  metaRow('Date', formatDate(quotation.quotationDate), 24);
  metaRow('Valid until', formatDate(quotation.validUntil), 48);
  metaRow('Credit terms', quotation.creditTerms, 72);

  y += leftBoxHeight + 16;

  // ── SUBJECT ─────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text('SUBJECT', MARGIN.left, y, { characterSpacing: 1 });
  y += 12;
  doc.font('Helvetica-Bold').fontSize(TYPO.LEAD).fillColor(THEME.SUBJECT_ACCENT);
  const subjHeight = doc.heightOfString(quotation.subject, { width: USABLE, lineGap: 2 });
  doc.text(quotation.subject, MARGIN.left, y, { width: USABLE, lineGap: 2 });
  y += subjHeight + 14;

  // ── COVER TEXT ──────────────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT);
  const coverHeight = doc.heightOfString(quotation.coverText, { width: USABLE, lineGap: 2.5 });
  doc.text(quotation.coverText, MARGIN.left, y, { width: USABLE, align: 'left', lineGap: 2.5 });
  y += coverHeight + 14;

  // ── ITEMS ───────────────────────────────────────────────────────────────
  type Item = typeof quotation.items[number];
  const items = quotation.items;
  const perCyl = (it: Item) => it.kind === 'per_cylinder';

  let i = 0;
  while (i < items.length) {
    if (perCyl(items[i])) {
      const run: Item[] = [];
      while (i < items.length && perCyl(items[i])) { run.push(items[i]); i += 1; }
      y = drawPerCylinderTable(doc, y, run, gstRate);
      y += 12;
    } else {
      y = drawPerKgCard(doc, y, items[i], gstRate);
      y += 10;
      i += 1;
    }
  }

  // ── FOOTER NOTES ────────────────────────────────────────────────────────
  if (quotation.footerNotes) {
    y += 6;
    doc.font('Helvetica-Oblique').fontSize(TYPO.BODY).fillColor(THEME.MUTED);
    const notesH = doc.heightOfString(quotation.footerNotes, { width: USABLE, lineGap: 1.5 });
    doc.text(quotation.footerNotes, MARGIN.left, y, { width: USABLE, lineGap: 1.5 });
    y += notesH + 14;
  }

  // ── PAGE BREAK IF NEEDED ────────────────────────────────────────────────
  const termsHeight = terms.reduce(
    (sum, t) => sum + doc.heightOfString(`${t}`, { width: USABLE - 20, lineGap: 1 }) + 2, 0,
  );
  if (y + 20 + termsHeight + 140 + 30 > PAGE_HEIGHT - MARGIN.bottom) {
    doc.addPage({ size: 'A4', margin: 0 });
    y = MARGIN.top;
  }

  // ── TERMS & CONDITIONS ──────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(TYPO.H3).fillColor(THEME.PRIMARY)
    .text('Terms & Conditions', MARGIN.left, y);
  y += 14;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.TEXT);
  terms.forEach((t, idx) => {
    const line = `${idx + 1}.  ${t}`;
    const h = doc.heightOfString(line, { width: USABLE - 10, lineGap: 1 });
    doc.text(line, MARGIN.left, y, { width: USABLE - 10, lineGap: 1 });
    y += h + 2;
  });
  y += 12;

  // ── APP + SIGNATURE ─────────────────────────────────────────────────────
  y = drawAppSection(doc, y, playQrPng, appQrPng);
  y += 10;

  const sigBoxX = MARGIN.left + USABLE - 220;
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED)
    .text(`For ${seller.businessName}`, sigBoxX, y, { width: 220, align: 'left' });
  const sigLineY = y + 40;
  doc.moveTo(sigBoxX, sigLineY).lineTo(sigBoxX + 200, sigLineY)
    .strokeColor(THEME.BORDER).lineWidth(0.6).stroke();
  doc.font('Helvetica-Bold').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
    .text('Authorized Signatory', sigBoxX, sigLineY + 4, { width: 220 });

  // ── FOOTER ──────────────────────────────────────────────────────────────
  const footerY = PAGE_HEIGHT - 26;
  doc.moveTo(MARGIN.left, footerY - 8).lineTo(MARGIN.left + USABLE, footerY - 8)
    .strokeColor(THEME.SOFT_BORDER).lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text(`${quotation.quotationNumber}  ·  ${seller.businessName}  ·  Thank you for the opportunity`,
      MARGIN.left, footerY, { width: USABLE - 60, align: 'left' });
  doc.text('Page 1', MARGIN.left + USABLE - 40, footerY, { width: 40, align: 'right' });

  doc.end();
  return done;
}

// ─── Per-cylinder table (rate card) ─────────────────────────────────────────

function drawPerCylinderTable(
  doc: PDFKit.PDFDocument, y: number,
  items: Array<{ itemName: string; hsnCode: string; priceInclGst: unknown; discountInclGst: unknown }>,
  _gstRate: number,
): number {
  // All three price columns are GST-INCLUSIVE. Final Rate = Rate − Discount.
  interface Col { label: string; width: number; align: 'left'|'right'|'center' }
  const cols: Col[] = [
    { label: '#',                width: 24,  align: 'center' },
    { label: 'Item',             width: 200, align: 'left' },
    { label: 'HSN',              width: 60,  align: 'center' },
    { label: 'Rate (incl GST)',  width: 80,  align: 'right' },
    { label: 'Discount',         width: 66,  align: 'right' },
    { label: 'Final (incl GST)', width: 85,  align: 'right' },
  ];
  const tableW = cols.reduce((s, c) => s + c.width, 0);
  const rowH = 20;

  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, tableW, rowH).fill(THEME.HEADER_BAND);
  doc.font('Helvetica-Bold').fontSize(TYPO.LABEL).fillColor(THEME.PRIMARY);
  for (const col of cols) {
    doc.text(col.label, x + 6, y + 6, { width: col.width - 12, align: col.align, lineBreak: false });
    x += col.width;
  }
  y += rowH;

  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT);
  items.forEach((item, idx) => {
    const priceInclGst = toNum(item.priceInclGst);
    const discountInclGst = toNum(item.discountInclGst);
    const finalInclGst = priceInclGst - discountInclGst;

    if (idx % 2 === 1) doc.rect(MARGIN.left, y, tableW, rowH).fill(THEME.ZEBRA);
    doc.fillColor(THEME.TEXT).font('Helvetica').fontSize(TYPO.BODY);
    x = MARGIN.left;
    const cells = [
      String(idx + 1), item.itemName, item.hsnCode,
      formatMoney(priceInclGst), formatMoney(discountInclGst), formatMoney(finalInclGst),
    ];
    for (let i = 0; i < cols.length; i++) {
      doc.text(cells[i], x + 6, y + 6, { width: cols[i].width - 12, align: cols[i].align, lineBreak: false });
      x += cols[i].width;
    }
    y += rowH;
  });

  doc.rect(MARGIN.left, y - (items.length * rowH) - rowH, tableW, (items.length + 1) * rowH)
    .strokeColor(THEME.SOFT_BORDER).lineWidth(0.5).stroke();

  return y;
}

// ─── Per-KG card (rate card, single column) ────────────────────────────────

function drawPerKgCard(
  doc: PDFKit.PDFDocument, y: number,
  item: { itemName: string; hsnCode: string; pricePerKgInclGst: unknown; discountPerKgInclGst: unknown },
  gstRate: number,
): number {
  const cardW = USABLE;
  // 2026-07-29 — grew by one row to accommodate the excl-GST final rate.
  // Previously 118 (3 rows); now 140 (4 rows).
  const cardH = 140;
  const pad = 14;

  doc.roundedRect(MARGIN.left, y, cardW, cardH, 4)
    .fillAndStroke(THEME.ZEBRA, THEME.BORDER);
  doc.rect(MARGIN.left, y, cardW, 26).fill(THEME.CARD_HEAD);

  const hsnW = 110;
  const hsnX = MARGIN.left + cardW - pad - hsnW;
  const nameX = MARGIN.left + pad;
  const nameW = hsnX - nameX - 30;

  doc.font('Helvetica-Bold').fontSize(TYPO.LEAD).fillColor(THEME.PRIMARY)
    .text(item.itemName, nameX, y + 8, { width: nameW, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED)
    .text(`HSN ${item.hsnCode}`, hsnX, y + 9,
      { width: hsnW, align: 'right', lineBreak: false });

  // v2: user enters GST-INCLUSIVE per-KG rate + discount. The excl-GST
  // (pre-GST) values are derived so the reader sees both sides of the tax
  // — asked-for change on 2026-07-29 after "Basic Rs. X" was ambiguous.
  const pricePerKgInclGst = toNum(item.pricePerKgInclGst);
  const discountPerKgInclGst = toNum(item.discountPerKgInclGst);
  const pricePerKgExclGst = pricePerKgInclGst / (1 + gstRate);
  const discountPerKgExclGst = discountPerKgInclGst / (1 + gstRate);
  const finalInclGst = pricePerKgInclGst - discountPerKgInclGst;
  const finalExclGst = pricePerKgExclGst - discountPerKgExclGst;
  const gstPct = (gstRate * 100).toFixed(0);

  const bodyY = y + 36;
  const rowH = 22;
  const valueColW = 130;
  const valueXBody = MARGIN.left + cardW - pad - valueColW;
  const labelXBody = MARGIN.left + pad + 6;
  const labelWBody = valueXBody - labelXBody - 20;

  const kvRow = (label: string, value: string, i: number, opts: { bold?: boolean } = {}) => {
    const yy = bodyY + i * rowH;
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
      .text(label, labelXBody, yy,
        { width: labelWBody, align: 'left', lineBreak: false, ellipsis: true });
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY)
      .fillColor(opts.bold ? THEME.PRIMARY : THEME.TEXT)
      .text(value, valueXBody, yy,
        { width: valueColW, align: 'right', lineBreak: false });
  };

  // 2026-07-29 — relabelled "Basic Rs. X" → "excl GST Rs. X" so the
  // reader can tell at a glance which side of the tax each figure sits on.
  // Added a Final rate (excl GST) line under the incl-GST bold total.
  kvRow(
    `Rate per KG (incl. GST @ ${gstPct}%)   (excl GST ${formatMoney(pricePerKgExclGst)})`,
    formatMoney(pricePerKgInclGst),
    0,
  );
  kvRow(
    `Discount per KG   (excl GST - ${formatMoney(discountPerKgExclGst)})`,
    `- ${formatMoney(discountPerKgInclGst)}`,
    1,
  );
  kvRow('Final rate per KG (incl. GST)', formatMoney(finalInclGst), 2, { bold: true });
  kvRow('Final rate per KG (excl. GST)', formatMoney(finalExclGst), 3, { bold: true });

  return y + cardH;
}

// ─── App download section ──────────────────────────────────────────────────

function drawAppSection(
  doc: PDFKit.PDFDocument, y: number, playQr: Buffer, appQr: Buffer,
): number {
  const boxW = USABLE;
  const boxH = 130;
  const pad = 14;

  doc.roundedRect(MARGIN.left, y, boxW, boxH, 4)
    .fillAndStroke('#f8fafc', THEME.BORDER);

  const qrSize = 66;
  const qrGap = 20;
  const qrPairW = qrSize * 2 + qrGap;
  const qrGroupX = MARGIN.left + boxW - pad - qrPairW;
  const qrY = y + pad;
  const androidQrX = qrGroupX;
  const iosQrX = qrGroupX + qrSize + qrGap;

  const leftColX = MARGIN.left + pad;
  const leftColW = qrGroupX - leftColX - 20;

  doc.font('Helvetica-Bold').fontSize(TYPO.H3).fillColor(THEME.PRIMARY)
    .text('Order faster from the mygaslink mobile app', leftColX, y + pad,
      { width: leftColW, lineBreak: true });

  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.TEXT);
  const benefits = [
    '·  Place orders 24 × 7 — no phone calls',
    '·  Track deliveries live on the map',
    '·  View ledgers with running balance',
    '·  Download GST invoices instantly',
  ];
  benefits.forEach((b, i) => {
    doc.text(b, leftColX, y + pad + 22 + i * 12,
      { width: leftColW, lineBreak: false, ellipsis: true });
  });

  doc.image(playQr, androidQrX, qrY, { width: qrSize, height: qrSize });
  doc.image(appQr,  iosQrX,     qrY, { width: qrSize, height: qrSize });

  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.TEXT)
    .text('Android', androidQrX, qrY + qrSize + 4,
      { width: qrSize, align: 'center', lineBreak: false });
  doc.text('iOS', iosQrX, qrY + qrSize + 4,
    { width: qrSize, align: 'center', lineBreak: false });

  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.LINK)
    .text('Play Store', androidQrX, qrY + qrSize + 18,
      { width: qrSize, align: 'center', lineBreak: false, link: APP_LINKS.playStore, underline: true });
  doc.text('App Store', iosQrX, qrY + qrSize + 18,
    { width: qrSize, align: 'center', lineBreak: false, link: APP_LINKS.appStore, underline: true });

  return y + boxH;
}
