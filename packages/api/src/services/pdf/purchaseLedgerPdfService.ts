/**
 * Mini-Operator (2026-07-17) — Purchase Ledger PDF.
 *
 * Renders every PurchaseEntry line for the caller's tenant within the
 * requested window, optionally narrowed by source distributor and/or
 * cylinder type. One row per (entry × item). Portrait A4 — 6 columns.
 *
 * Columns: Date | Purchase # | Source Distributor | Cylinder Type |
 *          Fulls Received | Empties Given Out
 *
 * PurchaseEntry stores quantities only (no unit price), so this is a
 * movement register — not a value ledger.
 */
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { formatDate, formatMoney } from './pdfLayoutUtils.js';
import type { Prisma } from '@prisma/client';

// A4 landscape — needed once we added Unit Price + Amount + Notes columns.
const PAGE_WIDTH = 842;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#e5e7eb',
  ZEBRA: '#f8fafc',
};
const TYPO = { H1: 18, H2: 11, BODY: 8, LABEL: 8, CAPTION: 7 };

interface Col {
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
}

// Landscape A4 usable width = 842 - 40 - 40 = 762pt (matches customer ledger).
// Money columns need width for lakh-scale figures (₹9,99,999.00 = 15 chars).
const COLS: Col[] = [
  { label: 'Date', width: 60, align: 'left' },
  { label: 'Purchase #', width: 82, align: 'left' },
  { label: 'Source Distributor', width: 130, align: 'left' },
  { label: 'Cylinder Type', width: 100, align: 'left' },
  { label: 'Fulls', width: 46, align: 'right' },
  { label: 'Empties', width: 52, align: 'right' },
  { label: 'Unit Price', width: 88, align: 'right' },
  { label: 'Amount', width: 100, align: 'right' },
  { label: 'Notes', width: 104, align: 'left' },
];

const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);
const ROW_HEIGHT = 16;

const COL_CHAR_CAP: number[] = [11, 14, 24, 18, 6, 6, 14, 15, 20];

function fitCell(s: string, maxChars: number): string {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)) + '…';
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const col of COLS) {
    doc.text(col.label, x + 3, y + 4, {
      width: col.width - 6,
      align: col.align,
      lineBreak: false,
      ellipsis: true,
    });
    x += col.width;
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
  if (opts.zebra) {
    doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  }
  doc.fillColor(THEME.TEXT).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
  let x = MARGIN.left;
  for (let i = 0; i < COLS.length; i++) {
    const text = fitCell(cells[i] ?? '', COL_CHAR_CAP[i] ?? 999);
    doc.text(text, x + 3, y + 4, {
      width: COLS[i].width - 6,
      align: COLS[i].align,
      lineBreak: false,
      ellipsis: true,
    });
    x += COLS[i].width;
  }
  return ROW_HEIGHT;
}

export interface PurchaseLedgerFilters {
  from?: string;
  to?: string;
  sourceDistributorId?: string;
  cylinderTypeId?: string;
}

export async function generatePurchaseLedgerPdf(
  distributorId: string,
  filters: PurchaseLedgerFilters,
): Promise<Buffer> {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true, legalName: true, gstin: true,
      address: true, city: true, state: true, pincode: true, phone: true,
    },
  });
  if (!distributor) throw new Error('Distributor not found');

  const where: Prisma.PurchaseEntryWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (filters.from || filters.to) {
    where.purchaseDate = {};
    if (filters.from) (where.purchaseDate as { gte?: string }).gte = filters.from;
    if (filters.to) (where.purchaseDate as { lte?: string }).lte = filters.to;
  }
  if (filters.sourceDistributorId) {
    where.sourceDistributorId = filters.sourceDistributorId;
  }

  // Payment filter mirrors the purchase filter (distributor + date +
  // sourceDistributorId). Cylinder-type filter doesn't apply to payments,
  // so payments are omitted when a cylinder-type filter is active — the
  // resulting PDF is a stock-and-money ledger scoped to that type.
  const paymentWhere: Prisma.PurchasePaymentWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (filters.from || filters.to) {
    paymentWhere.transactionDate = {};
    if (filters.from) (paymentWhere.transactionDate as { gte?: string }).gte = filters.from;
    if (filters.to) (paymentWhere.transactionDate as { lte?: string }).lte = filters.to;
  }
  if (filters.sourceDistributorId) {
    paymentWhere.sourceDistributorId = filters.sourceDistributorId;
  }

  const [entries, payments] = await Promise.all([
    prisma.purchaseEntry.findMany({
      where,
      select: {
        id: true,
        purchaseNumber: true,
        purchaseDate: true,
        sourceDistributorName: true,
        notes: true,
        items: {
          select: {
            id: true,
            cylinderTypeId: true,
            fullsReceived: true,
            emptiesGivenOut: true,
            unitPrice: true,
            cylinderType: { select: { typeName: true } },
          },
        },
      },
      orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
    }),
    // Mini-Operator 2026-07-19: include supplier payments in the same
    // ledger so a downloaded PDF for Bhargavi shows both goods received
    // AND money paid (previously only purchases were rendered, causing
    // "I made a payment but it's not on the ledger" confusion). Payments
    // are skipped when a cylinder-type filter is active — payments don't
    // have a cylinder type, so including them would clutter a filtered
    // stock-scoped view.
    filters.cylinderTypeId
      ? Promise.resolve([])
      : prisma.purchasePayment.findMany({
          where: paymentWhere,
          select: {
            id: true,
            transactionDate: true,
            sourceDistributorName: true,
            amount: true,
            paymentMethod: true,
            referenceNumber: true,
            notes: true,
            createdAt: true,
          },
          orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
        }),
  ]);

  // Flatten to (entry × item) rows, applying cylinderTypeId filter here so
  // filtering at the SQL level (which requires a `some:` clause on items)
  // wouldn't correctly hide items of OTHER types on entries that match.
  type FlatRow = {
    kind: 'purchase' | 'payment';
    date: string;
    purchaseNumber: string;
    sourceDistributorName: string;
    cylinderType: string;
    fulls: number;
    empties: number;
    unitPrice: number;
    amount: number;
    notes: string;
  };
  const rows: FlatRow[] = [];
  for (const entry of entries) {
    for (const item of entry.items) {
      if (filters.cylinderTypeId && item.cylinderTypeId !== filters.cylinderTypeId) continue;
      const unitPrice = Number(item.unitPrice ?? 0);
      const amount = item.fullsReceived * unitPrice;
      rows.push({
        kind: 'purchase',
        date: entry.purchaseDate,
        purchaseNumber: entry.purchaseNumber,
        sourceDistributorName: entry.sourceDistributorName ?? '—',
        cylinderType: item.cylinderType?.typeName ?? '—',
        fulls: item.fullsReceived,
        empties: item.emptiesGivenOut,
        unitPrice,
        amount,
        notes: entry.notes ?? '',
      });
    }
  }
  // Interleave payment rows in chronological order. Kind stored so the
  // renderer can style credits distinctly + so totals can split cleanly
  // into purchases vs payments.
  for (const p of payments) {
    const method = String(p.paymentMethod).replace(/_/g, ' ');
    const ref = p.referenceNumber ? ` · ref ${p.referenceNumber}` : '';
    rows.push({
      kind: 'payment',
      date: p.transactionDate,
      purchaseNumber: '', // payments have no purchase number
      sourceDistributorName: p.sourceDistributorName ?? '—',
      cylinderType: `PAYMENT (${method})`,
      fulls: 0,
      empties: 0,
      unitPrice: 0,
      amount: Number(p.amount ?? 0),
      notes: p.notes ? `${p.notes}${ref}` : `Payment${ref}`,
    });
  }
  // Global sort keeps things chronological even after the purchase +
  // payment interleave.
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    // Same-day: purchases before payments so the balance walks
    // debit-then-credit.
    if (a.kind !== b.kind) return a.kind === 'purchase' ? -1 : 1;
    return 0;
  });

  const totals = rows.reduce(
    (acc, r) => {
      if (r.kind === 'purchase') {
        acc.fulls += r.fulls;
        acc.empties += r.empties;
        acc.purchased += r.amount;
      } else {
        acc.paid += r.amount;
      }
      return acc;
    },
    { fulls: 0, empties: 0, purchased: 0, paid: 0 },
  );
  const netOwed = totals.purchased - totals.paid;

  // Filter label lookups (best-effort; falls back to "—" if the id was
  // deleted between listing and the ledger call).
  let sourceDistributorLabel: string | null = null;
  if (filters.sourceDistributorId) {
    const src = await prisma.sourceDistributor.findFirst({
      where: { id: filters.sourceDistributorId, distributorId, deletedAt: null },
      select: { name: true },
    });
    sourceDistributorLabel = src?.name ?? null;
  }
  let cylinderTypeLabel: string | null = null;
  if (filters.cylinderTypeId) {
    const ct = await prisma.cylinderType.findFirst({
      where: { id: filters.cylinderTypeId, distributorId },
      select: { typeName: true },
    });
    cylinderTypeLabel = ct?.typeName ?? null;
  }

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN.left });
  const buffers: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  const rightEdge = PAGE_WIDTH - MARGIN.right;
  let y = MARGIN.top;

  // ── Header letterhead ──
  const sellerName = distributor.businessName || distributor.legalName;
  const sellerAddr = [distributor.address, distributor.city, distributor.state, distributor.pincode]
    .filter(Boolean).join(', ') || '—';

  doc.font('Helvetica-Bold').fontSize(Math.round(TYPO.H2 * 1.5)).fillColor(THEME.PRIMARY);
  doc.text(sellerName, MARGIN.left, y, { width: 340 });
  let leftY = y + 18;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(sellerAddr, MARGIN.left, leftY, { width: 340 }); leftY += 11;
  doc.text(`GSTIN: ${distributor.gstin || '—'}   Phone: ${distributor.phone || '—'}`, MARGIN.left, leftY, { width: 340 });
  leftY += 11;

  doc.font('Helvetica-Bold').fontSize(TYPO.H1).fillColor(THEME.PRIMARY);
  doc.text('Purchase Ledger', rightEdge - 200, y, { width: 200, align: 'right' });

  y = Math.max(leftY, y + 36) + 4;
  doc.moveTo(MARGIN.left, y).lineTo(rightEdge, y).strokeColor(THEME.PRIMARY).lineWidth(1).stroke();
  y += 10;

  // ── Filter summary ──
  doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.TEXT);
  const filterLines: string[] = [];
  filterLines.push(
    `Period: ${filters.from ? formatDate(filters.from) : 'Beginning'} to ${filters.to ? formatDate(filters.to) : formatDate(new Date())}`,
  );
  if (sourceDistributorLabel) filterLines.push(`Source Distributor: ${sourceDistributorLabel}`);
  if (cylinderTypeLabel) filterLines.push(`Cylinder Type: ${cylinderTypeLabel}`);
  for (const line of filterLines) {
    doc.text(line, MARGIN.left, y);
    y += 12;
  }
  y += 6;

  // ── Table ──
  y += drawTableHeader(doc, y);

  const BOTTOM = doc.page.height - MARGIN.bottom - 40;
  if (rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(TYPO.BODY).fillColor(THEME.MUTED);
    doc.text('No purchase entries in this period.', MARGIN.left, y + 8, {
      width: TABLE_WIDTH,
      align: 'center',
    });
    y += ROW_HEIGHT + 16;
  } else {
    for (let i = 0; i < rows.length; i++) {
      if (y + ROW_HEIGHT > BOTTOM) {
        doc.addPage();
        y = MARGIN.top;
        y += drawTableHeader(doc, y);
      }
      const r = rows[i];
      const isPayment = r.kind === 'payment';
      y += drawRow(
        doc,
        y,
        [
          formatDate(r.date),
          r.purchaseNumber,
          r.sourceDistributorName,
          r.cylinderType,
          isPayment ? '—' : String(r.fulls),
          isPayment ? '—' : String(r.empties),
          !isPayment && r.unitPrice > 0 ? formatMoney(r.unitPrice) : '—',
          // Payment amounts get a "− " prefix so at-a-glance the
          // downloaded ledger reads like a debit/credit statement.
          r.amount > 0
            ? (isPayment ? `− ${formatMoney(r.amount)}` : formatMoney(r.amount))
            : '—',
          r.notes,
        ],
        { zebra: i % 2 === 1 },
      );
    }
  }

  // ── Totals + Net Owed summary ──
  if (rows.length > 0) {
    if (y + ROW_HEIGHT * 3 + 8 > BOTTOM) {
      doc.addPage();
      y = MARGIN.top;
    }
    y += 2;
    doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y).strokeColor(THEME.BORDER).lineWidth(0.5).stroke();
    y += 2;
    // Purchase totals (fulls, empties, purchased amount).
    drawRow(
      doc,
      y,
      [
        '',
        '',
        '',
        'Total Purchased',
        String(totals.fulls),
        String(totals.empties),
        '',
        formatMoney(totals.purchased),
        '',
      ],
      { bold: true },
    );
    y += ROW_HEIGHT;
    // Total Paid row (only rendered when there is at least one payment
    // — otherwise the ledger is stock-only and the Net Owed row would
    // just duplicate Total Purchased).
    if (totals.paid > 0) {
      drawRow(
        doc,
        y,
        [
          '',
          '',
          '',
          'Total Paid',
          '',
          '',
          '',
          `− ${formatMoney(totals.paid)}`,
          '',
        ],
        { bold: true, zebra: true },
      );
      y += ROW_HEIGHT;
      drawRow(
        doc,
        y,
        [
          '',
          '',
          '',
          'Net Owed',
          '',
          '',
          '',
          formatMoney(netOwed),
          '',
        ],
        { bold: true },
      );
      y += ROW_HEIGHT;
    }
  }

  // ── Footer ──
  y += 12;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  const purchaseCount = rows.filter((r) => r.kind === 'purchase').length;
  const paymentCount = rows.filter((r) => r.kind === 'payment').length;
  const lineSummary = paymentCount > 0
    ? `${purchaseCount} purchase line${purchaseCount === 1 ? '' : 's'} · ${paymentCount} payment${paymentCount === 1 ? '' : 's'}`
    : `${purchaseCount} line${purchaseCount === 1 ? '' : 's'}`;
  doc.text(
    `Generated ${formatDate(new Date())} · ${lineSummary}`,
    MARGIN.left, y, { width: TABLE_WIDTH, align: 'right' },
  );

  doc.end();
  return new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}
