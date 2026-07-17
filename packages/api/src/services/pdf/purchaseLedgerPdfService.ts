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
import { formatDate } from './pdfLayoutUtils.js';
import type { Prisma } from '@prisma/client';

const PAGE_WIDTH = 595;
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

// Portrait A4 usable width = 595 - 40 - 40 = 515pt
const COLS: Col[] = [
  { label: 'Date', width: 66, align: 'left' },
  { label: 'Purchase #', width: 90, align: 'left' },
  { label: 'Source Distributor', width: 130, align: 'left' },
  { label: 'Cylinder Type', width: 105, align: 'left' },
  { label: 'Fulls Received', width: 62, align: 'right' },
  { label: 'Empties Given', width: 62, align: 'right' },
];

const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);
const ROW_HEIGHT = 16;

const COL_CHAR_CAP: number[] = [11, 16, 24, 20, 8, 8];

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

  const entries = await prisma.purchaseEntry.findMany({
    where,
    select: {
      id: true,
      purchaseNumber: true,
      purchaseDate: true,
      sourceDistributorName: true,
      items: {
        select: {
          id: true,
          cylinderTypeId: true,
          fullsReceived: true,
          emptiesGivenOut: true,
          cylinderType: { select: { typeName: true } },
        },
      },
    },
    orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
  });

  // Flatten to (entry × item) rows, applying cylinderTypeId filter here so
  // filtering at the SQL level (which requires a `some:` clause on items)
  // wouldn't correctly hide items of OTHER types on entries that match.
  type FlatRow = {
    date: string;
    purchaseNumber: string;
    sourceDistributorName: string;
    cylinderType: string;
    fulls: number;
    empties: number;
  };
  const rows: FlatRow[] = [];
  for (const entry of entries) {
    for (const item of entry.items) {
      if (filters.cylinderTypeId && item.cylinderTypeId !== filters.cylinderTypeId) continue;
      rows.push({
        date: entry.purchaseDate,
        purchaseNumber: entry.purchaseNumber,
        sourceDistributorName: entry.sourceDistributorName ?? '—',
        cylinderType: item.cylinderType?.typeName ?? '—',
        fulls: item.fullsReceived,
        empties: item.emptiesGivenOut,
      });
    }
  }

  const totals = rows.reduce(
    (acc, r) => {
      acc.fulls += r.fulls;
      acc.empties += r.empties;
      return acc;
    },
    { fulls: 0, empties: 0 },
  );

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

  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: MARGIN.left });
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
      y += drawRow(
        doc,
        y,
        [
          formatDate(r.date),
          r.purchaseNumber,
          r.sourceDistributorName,
          r.cylinderType,
          String(r.fulls),
          String(r.empties),
        ],
        { zebra: i % 2 === 1 },
      );
    }
  }

  // ── Totals row ──
  if (rows.length > 0) {
    if (y + ROW_HEIGHT + 4 > BOTTOM) {
      doc.addPage();
      y = MARGIN.top;
    }
    y += 2;
    doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y).strokeColor(THEME.BORDER).lineWidth(0.5).stroke();
    y += 2;
    drawRow(
      doc,
      y,
      ['', '', '', 'Total', String(totals.fulls), String(totals.empties)],
      { bold: true },
    );
    y += ROW_HEIGHT;
  }

  // ── Footer ──
  y += 12;
  doc.font('Helvetica').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED);
  doc.text(
    `Generated ${formatDate(new Date())} · ${rows.length} line${rows.length === 1 ? '' : 's'}`,
    MARGIN.left, y, { width: TABLE_WIDTH, align: 'right' },
  );

  doc.end();
  return new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}
