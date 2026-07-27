/**
 * Quotation PDF — rate-card style sample generator.
 *
 * Layout follows real-world LPG rate quotes (Pokarna, APL Apollo, Pennar):
 * per-unit rates only, NO quantity, NO subtotals, NO grand total. The
 * quote establishes the RATE; specific orders come later.
 *
 * Two modes supported (mixable inside one quote):
 *   - per_cylinder — compact table row per product
 *   - per_kg       — expanded card with 3-row rate breakdown
 *
 * Run:  pnpm --filter @gaslink/api exec tsx scripts/sample-quotation-pdf.ts
 */
import PDFDocument from 'pdfkit';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Seller {
  businessName: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  gstin: string;
}
interface Recipient {
  name: string;
  contactPerson?: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  email: string;
  phone: string;
  gstin?: string;
}
interface Signatory { name: string; designation: string }
interface AppLinks {
  playStore: string;
  appStore: string;
}
interface Meta {
  number: string;
  date: string;
  validUntil: string;
  creditTerms: string;
}

interface PerCylinderItem {
  name: string;
  hsn: string;
  unitPrice: number;        // basic (pre-GST)
  discountPerUnit: number;  // per unit, pre-GST
}
interface PerKgItem {
  name: string;
  hsn: string;
  cylinderCapacityKg: number;  // for label display only
  basicPricePerKg: number;     // pre-GST
  discountPerKg: number;       // per KG, pre-GST
}

type MixedItem =
  | { kind: 'per_cylinder'; data: PerCylinderItem }
  | { kind: 'per_kg'; data: PerKgItem };

type QuotationData = {
  seller: Seller;
  recipient: Recipient;
  meta: Meta;
  subject: string;
  coverText: string;
  footerNotes: string;
  terms: string[];
  signatory: Signatory;
  appLinks: AppLinks;
  gstRate: number;   // 0.05 or 0.18 — whole quote
} & (
  | { mode: 'per_cylinder'; items: PerCylinderItem[] }
  | { mode: 'per_kg'; items: PerKgItem[] }
  | { mode: 'mixed'; items: MixedItem[] }
);

// ─── PDF constants ───────────────────────────────────────────────────────────

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };
const USABLE = PAGE_WIDTH - MARGIN.left - MARGIN.right;

const THEME = {
  PRIMARY: '#0a3d62',
  ACCENT: '#1e4a76',
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

function formatMoney(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  return `Rs. ${safe.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

// ─── Renderer ────────────────────────────────────────────────────────────────

async function render(data: QuotationData): Promise<Buffer> {
  // Two QR codes — one per store, so a scan lands directly on the target.
  const playQrDataUrl = await QRCode.toDataURL(data.appLinks.playStore, { margin: 1, width: 128 });
  const appQrDataUrl = await QRCode.toDataURL(data.appLinks.appStore, { margin: 1, width: 128 });
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
    .text(data.seller.businessName.toUpperCase(), 0, 14, { width: PAGE_WIDTH, align: 'center' });
  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor('#c8dcee')
    .text(`${data.seller.address}, ${data.seller.city}, ${data.seller.state} - ${data.seller.pincode}`,
      0, 40, { width: PAGE_WIDTH, align: 'center' });
  doc.text(`Phone ${data.seller.phone}  ·  ${data.seller.email}  ·  GSTIN ${data.seller.gstin}`,
    0, 52, { width: PAGE_WIDTH, align: 'center' });
  y = bandHeight + 18;

  // ── LEFT: Quotation To  //  RIGHT: Meta ────────────────────────────────
  const gutter = 14;
  const leftWidth = 300;
  const rightWidth = USABLE - leftWidth - gutter;
  const leftBoxHeight = 118;

  // LEFT
  doc.roundedRect(MARGIN.left, y, leftWidth, leftBoxHeight, 4)
    .strokeColor(THEME.BORDER).lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text('QUOTATION TO', MARGIN.left + 12, y + 10, { characterSpacing: 1 });
  doc.font('Helvetica-Bold').fontSize(TYPO.H3).fillColor(THEME.TEXT)
    .text(data.recipient.name, MARGIN.left + 12, y + 22, { width: leftWidth - 24 });
  if (data.recipient.contactPerson) {
    doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
      .text(`Attn: ${data.recipient.contactPerson}`, MARGIN.left + 12, y + 36, { width: leftWidth - 24 });
  }
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED)
    .text(data.recipient.address, MARGIN.left + 12, y + 50, { width: leftWidth - 24 })
    .text(`${data.recipient.city}, ${data.recipient.state} - ${data.recipient.pincode}`,
      MARGIN.left + 12, y + 62, { width: leftWidth - 24 });

  // Column-aligned key-value rows — email + phone + GSTIN cleanly separated
  const labelX = MARGIN.left + 12;
  const valueX = MARGIN.left + 60;
  const valueWidth = leftWidth - 72;
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text('Email', labelX, y + 78)
    .text('Phone', labelX, y + 90);
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
    .text(data.recipient.email, valueX, y + 77, { width: valueWidth, lineBreak: false, ellipsis: true })
    .text(data.recipient.phone, valueX, y + 89, { width: valueWidth, lineBreak: false });
  if (data.recipient.gstin) {
    doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
      .text('GSTIN', labelX, y + 102);
    doc.font('Helvetica-Bold').fontSize(TYPO.BODY).fillColor(THEME.PRIMARY)
      .text(data.recipient.gstin, valueX, y + 101, { width: valueWidth, lineBreak: false });
  }

  // RIGHT
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
  metaRow('Quote #', data.meta.number, 0, { emphasis: true });
  metaRow('Date', formatDate(data.meta.date), 24);
  metaRow('Valid until', formatDate(data.meta.validUntil), 48);
  metaRow('Credit terms', data.meta.creditTerms, 72);

  y += leftBoxHeight + 16;

  // ── SUBJECT (full width) ────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text('SUBJECT', MARGIN.left, y, { characterSpacing: 1 });
  y += 12;
  doc.font('Helvetica-Bold').fontSize(TYPO.LEAD).fillColor(THEME.SUBJECT_ACCENT);
  const subjHeight = doc.heightOfString(data.subject, { width: USABLE, lineGap: 2 });
  doc.text(data.subject, MARGIN.left, y, { width: USABLE, lineGap: 2 });
  y += subjHeight + 14;

  // ── COVER TEXT (full width) ─────────────────────────────────────────────
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT);
  const coverHeight = doc.heightOfString(data.coverText, { width: USABLE, lineGap: 2.5 });
  doc.text(data.coverText, MARGIN.left, y, { width: USABLE, align: 'left', lineGap: 2.5 });
  y += coverHeight + 14;

  // ── RATE CARDS / TABLE ──────────────────────────────────────────────────
  if (data.mode === 'per_cylinder') {
    y = drawPerCylinderTable(doc, y, data.items, data.gstRate);
  } else if (data.mode === 'per_kg') {
    for (const item of data.items) {
      y = drawPerKgCard(doc, y, item, data.gstRate);
      y += 10;
    }
  } else {
    let i = 0;
    while (i < data.items.length) {
      if (data.items[i].kind === 'per_cylinder') {
        const run: PerCylinderItem[] = [];
        while (i < data.items.length && data.items[i].kind === 'per_cylinder') {
          run.push(data.items[i].data as PerCylinderItem);
          i += 1;
        }
        y = drawPerCylinderTable(doc, y, run, data.gstRate);
        y += 12;
      } else {
        y = drawPerKgCard(doc, y, data.items[i].data as PerKgItem, data.gstRate);
        y += 10;
        i += 1;
      }
    }
  }

  // ── FOOTER NOTES (italic) ───────────────────────────────────────────────
  if (data.footerNotes) {
    y += 6;
    doc.font('Helvetica-Oblique').fontSize(TYPO.BODY).fillColor(THEME.MUTED);
    const notesH = doc.heightOfString(data.footerNotes, { width: USABLE, lineGap: 1.5 });
    doc.text(data.footerNotes, MARGIN.left, y, { width: USABLE, lineGap: 1.5 });
    y += notesH + 14;
  }

  // ── Break to page 2 if needed for T&C + app + signature ────────────────
  const remainingHeight = data.terms.reduce((sum, t) => sum + doc.heightOfString(`${t}`, { width: USABLE - 20, lineGap: 1 }) + 2, 0);
  const bottomEstimate = 20 + remainingHeight + 130 + 30;
  if (y + bottomEstimate > PAGE_HEIGHT - MARGIN.bottom) {
    doc.addPage({ size: 'A4', margin: 0 });
    y = MARGIN.top;
  }

  // ── TERMS & CONDITIONS ──────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(TYPO.H3).fillColor(THEME.PRIMARY)
    .text('Terms & Conditions', MARGIN.left, y);
  y += 14;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.TEXT);
  data.terms.forEach((t, idx) => {
    const line = `${idx + 1}.  ${t}`;
    const h = doc.heightOfString(line, { width: USABLE - 10, lineGap: 1 });
    doc.text(line, MARGIN.left, y, { width: USABLE - 10, lineGap: 1 });
    y += h + 2;
  });
  y += 12;

  // ── APP DOWNLOAD SECTION ────────────────────────────────────────────────
  y = drawAppSection(doc, y, data.appLinks, playQrPng, appQrPng);
  y += 10;

  // ── SIGNATURE BLOCK ─────────────────────────────────────────────────────
  const sigBoxX = MARGIN.left + USABLE - 220;
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED)
    .text(`For ${data.seller.businessName}`, sigBoxX, y, { width: 220, align: 'left' });
  const sigLineY = y + 40;
  doc.moveTo(sigBoxX, sigLineY).lineTo(sigBoxX + 200, sigLineY)
    .strokeColor(THEME.BORDER).lineWidth(0.6).stroke();
  doc.font('Helvetica-Bold').fontSize(TYPO.BODY).fillColor(THEME.TEXT)
    .text(data.signatory.name, sigBoxX, sigLineY + 4, { width: 220 });
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text(data.signatory.designation, sigBoxX, sigLineY + 18, { width: 220 });

  // ── PAGE FOOTER ─────────────────────────────────────────────────────────
  const footerY = PAGE_HEIGHT - 26;
  doc.moveTo(MARGIN.left, footerY - 8).lineTo(MARGIN.left + USABLE, footerY - 8)
    .strokeColor(THEME.SOFT_BORDER).lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text(`${data.meta.number}  ·  ${data.seller.businessName}  ·  Thank you for the opportunity`,
      MARGIN.left, footerY, { width: USABLE - 60, align: 'left' });
  doc.text('Page 1', MARGIN.left + USABLE - 40, footerY, { width: 40, align: 'right' });

  doc.end();
  return done;
}

// ─── Per-cylinder table (rate card style) ───────────────────────────────────

function drawPerCylinderTable(
  doc: PDFKit.PDFDocument, y: number,
  items: PerCylinderItem[], gstRate: number,
): number {
  interface Col { label: string; width: number; align: 'left'|'right'|'center' }
  const gstLabel = `Incl. GST @ ${(gstRate * 100).toFixed(0)}%`;
  const cols: Col[] = [
    { label: '#',           width: 24,  align: 'center' },
    { label: 'Item',        width: 210, align: 'left' },
    { label: 'HSN',         width: 60,  align: 'center' },
    { label: 'Rate',        width: 70,  align: 'right' },
    { label: 'Discount',    width: 70,  align: 'right' },
    { label: gstLabel,      width: 81,  align: 'right' },
  ];
  const tableW = cols.reduce((s, c) => s + c.width, 0);
  const rowH = 20;

  // Header
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, tableW, rowH).fill(THEME.HEADER_BAND);
  doc.font('Helvetica-Bold').fontSize(TYPO.LABEL).fillColor(THEME.PRIMARY);
  for (const col of cols) {
    doc.text(col.label, x + 6, y + 6, { width: col.width - 12, align: col.align, lineBreak: false });
    x += col.width;
  }
  y += rowH;

  // Rows
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT);
  items.forEach((item, idx) => {
    const netBasic = item.unitPrice - item.discountPerUnit;
    const inclGst = netBasic * (1 + gstRate);

    if (idx % 2 === 1) doc.rect(MARGIN.left, y, tableW, rowH).fill(THEME.ZEBRA);
    doc.fillColor(THEME.TEXT).font('Helvetica').fontSize(TYPO.BODY);
    x = MARGIN.left;
    const cells = [
      String(idx + 1),
      item.name,
      item.hsn,
      formatMoney(item.unitPrice),
      formatMoney(item.discountPerUnit),
      formatMoney(inclGst),
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

// ─── Per-KG card (rate card style, single-column, no overlap) ──────────────

function drawPerKgCard(
  doc: PDFKit.PDFDocument, y: number, item: PerKgItem, gstRate: number,
): number {
  const cardW = USABLE;   // 515
  const cardH = 118;
  const pad = 14;

  doc.roundedRect(MARGIN.left, y, cardW, cardH, 4)
    .fillAndStroke(THEME.ZEBRA, THEME.BORDER);

  // ── Header stripe (item name LEFT, HSN RIGHT — 30px gap guaranteed) ────
  doc.rect(MARGIN.left, y, cardW, 26).fill(THEME.CARD_HEAD);

  // HSN in a 110px right-hand column; item name gets the rest minus a 30px buffer.
  const hsnW = 110;
  const hsnX = MARGIN.left + cardW - pad - hsnW;   // right-aligned block
  const nameX = MARGIN.left + pad;
  const nameW = hsnX - nameX - 30;                  // 30px hard buffer

  doc.font('Helvetica-Bold').fontSize(TYPO.LEAD).fillColor(THEME.PRIMARY)
    .text(item.name, nameX, y + 8,
      { width: nameW, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED)
    .text(`HSN ${item.hsn}`, hsnX, y + 9,
      { width: hsnW, align: 'right', lineBreak: false });

  // ── Body — 2 columns, non-overlapping ──────────────────────────────────
  const rspPerKg = item.basicPricePerKg * (1 + gstRate);
  const netBasic = item.basicPricePerKg - item.discountPerKg;
  const priceInclGst = netBasic * (1 + gstRate);
  const gstPct = (gstRate * 100).toFixed(0);

  const bodyY = y + 36;
  const rowH = 22;
  const valueColW = 130;
  const valueXBody = MARGIN.left + cardW - pad - valueColW;
  const labelXBody = MARGIN.left + pad + 6;
  const labelWBody = valueXBody - labelXBody - 20;   // 20px hard buffer

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

  kvRow(
    `Rate per KG   (RSP ${formatMoney(rspPerKg)})`,
    formatMoney(item.basicPricePerKg),
    0,
  );
  kvRow('Discount per KG', `- ${formatMoney(item.discountPerKg)}`, 1);
  kvRow(`Price per KG (incl. GST @ ${gstPct}%)`, formatMoney(priceInclGst), 2, { bold: true });

  return y + cardH;
}

// ─── App download section — two QRs + clickable links + benefits ────────────

function drawAppSection(
  doc: PDFKit.PDFDocument, y: number, links: AppLinks,
  playQr: Buffer, appQr: Buffer,
): number {
  const boxW = USABLE;   // 515
  const boxH = 130;
  const pad = 14;

  doc.roundedRect(MARGIN.left, y, boxW, boxH, 4)
    .fillAndStroke('#f8fafc', THEME.BORDER);

  // ── QR GROUP on the RIGHT (fixed geometry, guaranteed 20px gap) ────────
  const qrSize = 66;
  const qrGap = 20;
  const qrPairW = qrSize * 2 + qrGap;                 // 152
  const qrGroupX = MARGIN.left + boxW - pad - qrPairW; // right-aligned inside box
  const qrY = y + pad;
  const androidQrX = qrGroupX;                        // left QR
  const iosQrX = qrGroupX + qrSize + qrGap;           // right QR

  // ── LEFT column: title + benefits — bounded so it can't overlap the QR block
  const leftColX = MARGIN.left + pad;
  const leftColW = qrGroupX - leftColX - 20;          // 20px hard buffer before QRs

  // Title
  doc.font('Helvetica-Bold').fontSize(TYPO.H3).fillColor(THEME.PRIMARY)
    .text('Order faster from the mygaslink mobile app', leftColX, y + pad,
      { width: leftColW, lineBreak: true });

  // Benefits
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

  // ── QR IMAGES ──────────────────────────────────────────────────────────
  doc.image(playQr, androidQrX, qrY, { width: qrSize, height: qrSize });
  doc.image(appQr,  iosQrX,     qrY, { width: qrSize, height: qrSize });

  // Labels below QRs
  doc.font('Helvetica-Bold').fontSize(TYPO.CAPTION).fillColor(THEME.TEXT)
    .text('Android', androidQrX, qrY + qrSize + 4,
      { width: qrSize, align: 'center', lineBreak: false });
  doc.text('iOS', iosQrX, qrY + qrSize + 4,
    { width: qrSize, align: 'center', lineBreak: false });

  // Clickable store links
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.LINK)
    .text('Play Store', androidQrX, qrY + qrSize + 18,
      { width: qrSize, align: 'center', lineBreak: false, link: links.playStore, underline: true });
  doc.text('App Store', iosQrX, qrY + qrSize + 18,
    { width: qrSize, align: 'center', lineBreak: false, link: links.appStore, underline: true });

  return y + boxH;
}

// ─── Sample data ─────────────────────────────────────────────────────────────

const seller: Seller = {
  businessName: 'Bhargava Gas Agency',
  address: 'Plot 42, Industrial Estate',
  city: 'Kondapur',
  state: 'Telangana',
  pincode: '500084',
  phone: '+91 98765 43210',
  email: 'sales@bhargavagas.example',
  gstin: '36AAAAB1234C1Z5',
};

const signatory: Signatory = { name: 'M. Bhargava', designation: 'Proprietor' };

const appLinks: AppLinks = {
  playStore: 'https://play.google.com/store/apps/details?id=com.mygaslink.app',
  appStore: 'https://apps.apple.com/in/app/mygaslink/id6783034856',
};

const termsBase = [
  'Prices are valid until the date shown above; beyond that a fresh quote will be issued.',
  'Statutory taxes as applicable are included where shown; changes in government levies apply automatically.',
  'Delivery within 24 working hours of confirmed order, subject to cylinder availability at the depot.',
  'A refundable security deposit is payable at first delivery for every new cylinder taken on rotation.',
  'Late payments beyond the agreed credit period attract 2% interest per month.',
  'Prices are subject to revision if statutory LPG rates are revised by the Government of India.',
  'Empty cylinders must be returned in undamaged condition; damages / shortages are chargeable at prevailing rates.',
];

// Sample 1 — Per-Cylinder (Royal Kitchen)
const perCylinderData: QuotationData = {
  seller,
  recipient: {
    name: 'Royal Kitchen Restaurant',
    contactPerson: 'Mr. Suresh Menon',
    address: 'Shop 12, Banjara Hills Rd No. 1',
    city: 'Hyderabad', state: 'Telangana', pincode: '500034',
    email: 'suresh@royalkitchen.example',
    phone: '+91 90000 12345',
    gstin: '36BBBBB1234D1Z9',
  },
  meta: {
    number: 'QUO-2026-047',
    date: '2026-07-27',
    validUntil: '2026-08-26',
    creditTerms: '15 days from date of invoice',
  },
  subject: 'Commercial LPG cylinder rate quote — Royal Kitchen restaurant chain',
  coverText:
    'Dear Mr. Menon,\n\n' +
    'Thank you for the opportunity. Following our discussion on 25-Jul, our per-cylinder rates for your commercial requirement are as below. All cylinders are HP-branded and delivered with valid statutory paperwork.\n\n' +
    'We are happy to extend a volume discount for a monthly draw of 30 cylinders or more. Please let us know if you would like a physical visit to your kitchen before finalising the arrangement.',
  footerNotes: 'Empty cylinders to be returned in undamaged condition. Delivery included within Hyderabad city limits.',
  terms: termsBase,
  signatory, appLinks,
  mode: 'per_cylinder',
  gstRate: 0.05,
  items: [
    { name: '19 KG Commercial Cylinder', hsn: '27111900', unitPrice: 2150, discountPerUnit: 50 },
    { name: '47.5 KG Commercial Cylinder', hsn: '27111900', unitPrice: 5400, discountPerUnit: 100 },
    { name: '14.2 KG Domestic Cylinder', hsn: '27111900', unitPrice: 1150, discountPerUnit: 20 },
  ],
};

// Sample 2 — Per-KG (APL Apollo industrial)
const perKgData: QuotationData = {
  seller,
  recipient: {
    name: 'APL Apollo Tubes Limited',
    contactPerson: 'Mr. Rajesh Kumar (Purchase)',
    address: 'Plot 4A, Sector 5, Auto Nagar',
    city: 'Hyderabad', state: 'Telangana', pincode: '500070',
    email: 'purchase.hyd@aplapollo.example',
    phone: '+91 40 2345 6789',
    gstin: '36CCCCC1234E1Z8',
  },
  meta: {
    number: 'QUO-2026-048',
    date: '2026-07-27',
    validUntil: '2026-08-26',
    creditTerms: '30 days from date of invoice',
  },
  subject: 'Industrial LPG per-KG rate quote — 425 KG cylinders for factory heating',
  coverText:
    'Dear Mr. Kumar,\n\n' +
    'Further to your enquiry, our per-KG rate for 425 KG commercial LPG cylinders is as below. The RSP shown in brackets is the GST-inclusive market reference for the same rate.\n\n' +
    'We currently supply the same grade to Pokarna and Pennar Industries — happy to arrange a plant visit if useful.',
  footerNotes: 'Delivery included within 50 km of the Kondapur depot. Cylinders returned in usable condition; damages chargeable at market rates.',
  terms: termsBase,
  signatory, appLinks,
  mode: 'per_kg',
  gstRate: 0.18,
  items: [
    { name: '425 KG Commercial Cylinder', hsn: '27111900', cylinderCapacityKg: 425, basicPricePerKg: 62.67, discountPerKg: 24.80 },
    { name: '47.5 KG Commercial Cylinder', hsn: '27111900', cylinderCapacityKg: 47.5, basicPricePerKg: 88.20, discountPerKg: 15.00 },
  ],
};

// Sample 3 — MIXED (per-cyl + per-KG in one quote)
const mixedData: QuotationData = {
  seller,
  recipient: {
    name: 'Pennar Industries Ltd — Isnapur Plant',
    contactPerson: 'Ms. Divya Iyer (Procurement)',
    address: 'Survey No. 79, Isnapur Village, Patancheru',
    city: 'Sangareddy', state: 'Telangana', pincode: '502307',
    email: 'divya.iyer@pennar.example',
    phone: '+91 40 6789 1122',
    gstin: '36DDDDD1234F1Z1',
  },
  meta: {
    number: 'QUO-2026-049',
    date: '2026-07-27',
    validUntil: '2026-08-26',
    creditTerms: '45 days from date of invoice',
  },
  subject: 'LPG rate quote — 425 KG industrial (per-KG) + 19 KG cafeteria (per-cylinder)',
  coverText:
    'Dear Ms. Iyer,\n\n' +
    'Following our factory visit last week, please find the combined rate offer for your two consumption points. The 425 KG cylinders (factory boiler) are quoted on per-KG basis in line with your current arrangement with Pennar-Beti. The 19 KG cylinders for the cafeteria are quoted per-cylinder given the fixed monthly draw.\n\n' +
    'We can commit to synchronised deliveries — one truck twice a week covering both requirements.',
  footerNotes: 'Combined delivery included. Empty exchange verified at plant gate.',
  terms: termsBase,
  signatory, appLinks,
  mode: 'mixed',
  gstRate: 0.18,
  items: [
    { kind: 'per_kg', data: {
      name: '425 KG Commercial Cylinder', hsn: '27111900',
      cylinderCapacityKg: 425, basicPricePerKg: 62.67, discountPerKg: 24.80,
    }},
    { kind: 'per_cylinder', data: {
      name: '19 KG Commercial Cylinder — Cafeteria',
      hsn: '27111900', unitPrice: 2150, discountPerUnit: 100,
    }},
    { kind: 'per_cylinder', data: {
      name: '47.5 KG Commercial Cylinder — Backup',
      hsn: '27111900', unitPrice: 5400, discountPerUnit: 200,
    }},
  ],
};

// ─── Run ─────────────────────────────────────────────────────────────────────

const OUT_DIR = 'C:/Users/HP/AppData/Local/Temp/claude/C--Projects-Re-New-Gaslink/cb465259-91cb-4798-88b7-bed9b208e5b0/scratchpad';

Promise.all([
  render(perCylinderData).then((buf) => writeFile(path.join(OUT_DIR, 'quotation-per-cylinder.pdf'), buf)),
  render(perKgData).then((buf) => writeFile(path.join(OUT_DIR, 'quotation-per-kg.pdf'), buf)),
  render(mixedData).then((buf) => writeFile(path.join(OUT_DIR, 'quotation-mixed.pdf'), buf)),
]).then(() => {
  console.log('Wrote 3 sample PDFs to scratchpad.');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
