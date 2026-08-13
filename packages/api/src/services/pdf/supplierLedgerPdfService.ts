/**
 * F8 Supplier Ledger (2026-08-06) — Confidence-format supplier statement PDF.
 *
 * Portrait A4, 8-column ledger style modelled after the Confidence Petroleum
 * sample statement. Interleaves Opening (b/f) / Invoice / Payment / Credit
 * Note rows chronologically with a running Dr/Cr balance.
 *
 * Columns:
 *   Date | Type | Doc No | Narration | Debit | Credit | Balance | Dr/Cr
 *
 * The existing landscape purchaseLedgerPdfService.ts stays untouched — some
 * tenants prefer that per-line movement register format. Both are exposed
 * on the Purchases page drill-down for a given supplier.
 *
 * Uses the getSupplierLedger reader (v2 — with charges + CN rows folded in)
 * so the PDF and the on-screen ledger view read from a single source of
 * truth.
 */
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { getPdfAccentColor, setPdfAccent, currentPdfAccent } from './pdfTheme.js';
import { getSupplierLedger, type SupplierLedgerRow } from '../purchasePaymentService.js';
import { formatDate, formatMoney } from './pdfLayoutUtils.js';

// A4 portrait usable width = 595 - 36 - 36 = 523pt.
const PAGE_WIDTH = 595;
const MARGIN = { left: 36, right: 36, top: 40, bottom: 40 };

const THEME = {
  get PRIMARY() { return currentPdfAccent(); },
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#d1d5db',
  ZEBRA: '#f8fafc',
};
const TYPO = { H1: 14, H2: 10, BODY: 8, LABEL: 8, CAPTION: 7 };

interface Col {
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
}

// 523pt total. Widths tuned so Rs. 12,12,640.00 fits in Debit/Credit/Balance
// without ellipsis; Narration takes the leftover slack.
const COLS: Col[] = [
  { label: 'Date', width: 52, align: 'left' },
  { label: 'Type', width: 46, align: 'left' },
  { label: 'Doc No', width: 68, align: 'left' },
  { label: 'Narration', width: 133, align: 'left' },
  { label: 'Debit', width: 60, align: 'right' },
  { label: 'Credit', width: 60, align: 'right' },
  { label: 'Balance', width: 64, align: 'right' },
  { label: 'Dr/Cr', width: 40, align: 'center' },
];

function typeLabel(kind: SupplierLedgerRow['kind']): string {
  // F8v2-FIX (2026-08-06) — plain-language labels (Suneel: "use incoming
  // and outgoing" instead of internal ERV enum name). Kept in sync with
  // CorporationLedgerPage's KIND_LABELS map so PDF + on-screen match.
  switch (kind) {
    case 'purchase':
      return 'Incoming';
    case 'payment':
      return 'Payment';
    case 'credit_note':
      return 'Credit Note';
    case 'debit_note':
      return 'Debit Note';
    case 'deposit':
      return 'Deposit';
    case 'erv_empties':
      return 'Outgoing';
    case 'erv_defective':
      return 'Outgoing (Def.)';
    default:
      return '—';
  }
}

function balanceLabel(runningBalance: number): 'Dr' | 'Cr' {
  // F8 v2 (2026-08-06) — Confidence-PDF convention: distributor owes
  // OMC → Dr (they're the debtor in OMC's book). Positive `balance`
  // from getSupplierLedger means we owe → Dr. Matches the reference
  // statement Suneel shared + on-screen Corporation Ledger table.
  return runningBalance > 0.005 ? 'Dr' : 'Cr';
}

export interface SupplierLedgerPdfFilters {
  from?: string;
  to?: string;
}

export async function generateSupplierLedgerPdf(
  distributorId: string,
  sourceDistributorId: string,
  filters: SupplierLedgerPdfFilters = {},
): Promise<Buffer> {
  setPdfAccent(await getPdfAccentColor(distributorId ?? ''));
  const [distributor, ledger] = await Promise.all([
    prisma.distributor.findUnique({
      where: { id: distributorId },
      select: {
        businessName: true,
        legalName: true,
        gstin: true,
        address: true,
        city: true,
        state: true,
        pincode: true,
        phone: true,
        email: true,
      },
    }),
    getSupplierLedger(distributorId, sourceDistributorId, filters),
  ]);

  if (!distributor) throw new Error('Distributor not found');

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: MARGIN,
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const usableWidth = PAGE_WIDTH - MARGIN.left - MARGIN.right;

  // ─── Header ──────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(TYPO.H1).fillColor(THEME.PRIMARY);
  doc.text(distributor.businessName, MARGIN.left, MARGIN.top, { width: usableWidth, align: 'center' });
  doc.moveDown(0.2);

  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.MUTED);
  const addressLine = [
    distributor.address,
    distributor.city,
    distributor.state,
    distributor.pincode,
  ]
    .filter(Boolean)
    .join(', ');
  if (addressLine) {
    doc.text(addressLine, MARGIN.left, doc.y, { width: usableWidth, align: 'center' });
  }
  const contactLine = [
    distributor.gstin ? `GSTIN: ${distributor.gstin}` : null,
    distributor.phone ? `Ph: ${distributor.phone}` : null,
    distributor.email,
  ]
    .filter(Boolean)
    .join(' · ');
  if (contactLine) {
    doc.text(contactLine, MARGIN.left, doc.y, { width: usableWidth, align: 'center' });
  }

  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(TYPO.H1 - 2).fillColor(THEME.TEXT);
  doc.text('Supplier Statement of Account', MARGIN.left, doc.y, { width: usableWidth, align: 'center' });

  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.TEXT);
  doc.text(`Supplier: ${ledger.source.name}`, MARGIN.left, doc.y);
  const range =
    filters.from || filters.to
      ? `Period: ${filters.from ?? 'Beginning'} to ${filters.to ?? 'Today'}`
      : 'Period: All-time';
  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.MUTED);
  doc.text(range, MARGIN.left, doc.y);

  doc.moveDown(0.6);

  // ─── Table header ────────────────────────────────────────────────────
  const drawHeader = () => {
    const startY = doc.y;
    doc.rect(MARGIN.left, startY, usableWidth, 18).fill(THEME.PRIMARY);
    doc.font('Helvetica-Bold').fontSize(TYPO.LABEL).fillColor('#ffffff');
    let x = MARGIN.left + 4;
    for (const c of COLS) {
      doc.text(c.label, x, startY + 5, { width: c.width - 8, align: c.align });
      x += c.width;
    }
    doc.y = startY + 18;
    doc.moveTo(MARGIN.left, doc.y).lineTo(PAGE_WIDTH - MARGIN.right, doc.y).stroke(THEME.BORDER);
  };
  drawHeader();

  // ─── Rows ────────────────────────────────────────────────────────────
  const drawRow = (row: SupplierLedgerRow, index: number) => {
    // Zebra stripe.
    const rowHeight = 16;
    if (index % 2 === 1) {
      doc.rect(MARGIN.left, doc.y, usableWidth, rowHeight).fill(THEME.ZEBRA);
    }
    doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.TEXT);
    let x = MARGIN.left + 4;
    const y = doc.y + 4;

    const docNo = row.supplierDocumentNumber ?? row.documentNumber ?? '—';
    const values: Array<{ text: string; col: Col }> = [
      { text: formatDate(row.entryDate), col: COLS[0] },
      { text: typeLabel(row.kind), col: COLS[1] },
      { text: docNo, col: COLS[2] },
      { text: row.narration, col: COLS[3] },
      { text: row.debit > 0 ? formatMoney(row.debit) : '—', col: COLS[4] },
      { text: row.credit > 0 ? formatMoney(row.credit) : '—', col: COLS[5] },
      { text: formatMoney(Math.abs(row.balance)), col: COLS[6] },
      { text: balanceLabel(row.balance), col: COLS[7] },
    ];
    for (const v of values) {
      doc.text(v.text, x, y, {
        width: v.col.width - 8,
        align: v.col.align,
        ellipsis: true,
        lineBreak: false,
      });
      x += v.col.width;
    }
    doc.y += rowHeight;
    doc.moveTo(MARGIN.left, doc.y).lineTo(PAGE_WIDTH - MARGIN.right, doc.y).stroke(THEME.BORDER);
  };

  if (ledger.rows.length === 0) {
    doc.font('Helvetica').fontSize(TYPO.BODY).fillColor(THEME.MUTED);
    doc.text('No transactions in the selected period.', MARGIN.left, doc.y + 8, {
      width: usableWidth,
      align: 'center',
    });
  } else {
    ledger.rows.forEach((row, i) => {
      // Page-break guard: if we're within 24pt of the bottom, add a page +
      // redraw the header before continuing.
      if (doc.y > 780) {
        doc.addPage();
        doc.y = MARGIN.top;
        drawHeader();
      }
      drawRow(row, i);
    });
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.TEXT);
  const finalBalance = ledger.rows.length > 0 ? ledger.rows[ledger.rows.length - 1].balance : 0;
  const summaryLines = [
    `Total Purchased:      ${formatMoney(ledger.summary.totalPurchased)}`,
    `Total Payments Made:  ${formatMoney(ledger.summary.totalPaid)}`,
    `Total Credit Notes:   ${formatMoney(ledger.summary.totalCreditNotes)}`,
    `Closing Balance:      ${formatMoney(Math.abs(finalBalance))}  ${balanceLabel(finalBalance)}`,
  ];
  for (const line of summaryLines) {
    doc.text(line, MARGIN.left, doc.y, { width: usableWidth, align: 'right' });
  }

  // Footer note.
  doc.moveDown(0.4);
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(
    'Dr = amount payable by us to the supplier; Cr = amount receivable from the supplier (advance / over-payment).',
    MARGIN.left,
    doc.y,
    { width: usableWidth, align: 'center' },
  );

  doc.end();
  return done;
}
