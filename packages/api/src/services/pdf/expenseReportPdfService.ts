/**
 * Mini-op #5 v2 (2026-07-27 evening) — Expense Report PDF.
 *
 * Three scopes off one endpoint:
 *   - CONSOLIDATED (no categoryId, no headerId): rows grouped by header,
 *     then per-leaf subtotal within, header total, grand total.
 *   - HEADER: rows in one header only (all leaves), per-leaf subtotal +
 *     header total.
 *   - LEAF (categoryId): flat table for one leaf.
 *
 * Portrait A4. Reads live category names via join — renames are reflected
 * immediately without a report-side migration. Footer disclaimer keeps
 * the "not audited / consult CA" position (see CLAUDE.md GAAP note).
 */
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { formatDate, formatMoney } from './pdfLayoutUtils.js';
import type { Prisma } from '@prisma/client';
import { toNum } from '../../utils/decimal.js';

const PAGE_WIDTH = 595;
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };
const USABLE = PAGE_WIDTH - MARGIN.left - MARGIN.right;

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#e5e7eb',
  ZEBRA: '#f8fafc',
  HEADER_BAND: '#dbeafe',
  ACCENT: '#1e4a76',
};
const TYPO = { H1: 18, H2: 12, BODY: 8, LABEL: 8, CAPTION: 7 };

interface Col { label: string; width: number; align: 'left' | 'right' | 'center' }

const COLS: Col[] = [
  { label: 'Date',        width: 62,  align: 'left'  },
  { label: 'Category',    width: 100, align: 'left'  },
  { label: 'Description', width: 130, align: 'left'  },
  { label: 'Vendor',      width: 82,  align: 'left'  },
  { label: 'Vehicle',     width: 45,  align: 'left'  },
  { label: 'Driver',      width: 45,  align: 'left'  },
  { label: 'Amount',      width: 51,  align: 'right' },
];
const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);
const ROW_HEIGHT = 15;
const COL_CHAR_CAP: number[] = [10, 18, 24, 15, 8, 8, 10];

function fitCell(s: string, maxChars: number): string {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)) + '…';
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  businessName: string,
  reportTitle: string,
  from: string | null,
  to: string | null,
): number {
  let y = MARGIN.top;
  doc.font('Helvetica-Bold').fontSize(TYPO.H1).fillColor(THEME.PRIMARY)
    .text(businessName, MARGIN.left, y, { width: USABLE, align: 'center' });
  y += 22;
  doc.font('Helvetica-Bold').fontSize(TYPO.H2).fillColor(THEME.TEXT)
    .text(reportTitle, MARGIN.left, y, { width: USABLE, align: 'center' });
  y += 16;
  if (from || to) {
    doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.MUTED)
      .text(`Period: ${from ?? 'earliest'}  →  ${to ?? 'today'}`, MARGIN.left, y, { width: USABLE, align: 'center' });
    y += 14;
  }
  return y + 4;
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const col of COLS) {
    doc.text(col.label, x + 3, y + 4, { width: col.width - 6, align: col.align, lineBreak: false, ellipsis: true });
    x += col.width;
  }
  doc.fillColor(THEME.TEXT);
  return ROW_HEIGHT + 2;
}

function drawRow(
  doc: PDFKit.PDFDocument, y: number, cells: string[],
  opts: { bold?: boolean; zebra?: boolean } = {},
): number {
  if (opts.zebra) doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  doc.fillColor(THEME.TEXT).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
  let x = MARGIN.left;
  for (let i = 0; i < COLS.length; i++) {
    doc.text(fitCell(cells[i] ?? '', COL_CHAR_CAP[i] ?? 999), x + 3, y + 4, {
      width: COLS[i].width - 6, align: COLS[i].align, lineBreak: false, ellipsis: true,
    });
    x += COLS[i].width;
  }
  return ROW_HEIGHT;
}

function drawHeaderBand(doc: PDFKit.PDFDocument, y: number, headerName: string): number {
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.HEADER_BAND);
  doc.fillColor(THEME.PRIMARY).font('Helvetica-Bold').fontSize(TYPO.BODY);
  doc.text(headerName.toUpperCase(), MARGIN.left + 6, y + 4, {
    width: TABLE_WIDTH - 12, align: 'left', lineBreak: false, ellipsis: true,
  });
  doc.fillColor(THEME.TEXT);
  return ROW_HEIGHT + 2;
}

function drawSubtotalRow(
  doc: PDFKit.PDFDocument, y: number,
  label: string, amount: number,
  opts: { emphasise?: boolean } = {},
): number {
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  doc.strokeColor(THEME.BORDER).lineWidth(0.5).moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y).stroke();
  doc.fillColor(opts.emphasise ? THEME.PRIMARY : THEME.ACCENT).font('Helvetica-Bold').fontSize(TYPO.BODY);
  const amountCol = COLS[COLS.length - 1];
  const amountX = MARGIN.left + TABLE_WIDTH - amountCol.width;
  doc.text(label, MARGIN.left + 3, y + 4, {
    width: TABLE_WIDTH - amountCol.width - 6, align: 'right', lineBreak: false,
  });
  doc.text(formatMoney(amount), amountX + 3, y + 4, {
    width: amountCol.width - 6, align: 'right', lineBreak: false,
  });
  doc.fillColor(THEME.TEXT);
  return ROW_HEIGHT;
}

function drawFooter(doc: PDFKit.PDFDocument, page: number): void {
  const y = 800;
  doc.strokeColor(THEME.BORDER).lineWidth(0.5)
    .moveTo(MARGIN.left, y - 4).lineTo(MARGIN.left + USABLE, y - 4).stroke();
  doc.font('Helvetica-Oblique').fontSize(TYPO.CAPTION).fillColor(THEME.MUTED)
    .text(
      'Internal management report generated by Re-New GasLink. Not an audited financial statement. For statutory filings consult your CA.',
      MARGIN.left, y, { width: USABLE - 50, align: 'left' },
    );
  doc.text(`Page ${page}`, MARGIN.left + USABLE - 40, y, { width: 40, align: 'right' });
}

export interface ExpenseReportFilters {
  from?: string;
  to?: string;
  categoryId?: string; // single-leaf scope
  headerId?: string;   // one-header scope (all its leaves)
  vehicleId?: string;
  driverId?: string;
}

interface RowJoin {
  id: string;
  expenseDate: string;
  amount: Prisma.Decimal;
  description: string;
  vendorName: string | null;
  vehicle: { vehicleNumber: string } | null;
  driver: { driverName: string } | null;
  category: {
    id: string;
    name: string;
    sortOrder: number;
    parentId: string | null;
    parent: { id: string; name: string; sortOrder: number } | null;
  };
}

export async function generateExpenseReportPdf(
  distributorId: string,
  filters: ExpenseReportFilters,
): Promise<Buffer> {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { businessName: true, legalName: true },
  });
  if (!distributor) throw new Error('Distributor not found');

  const where: Prisma.ExpenseWhereInput = { distributorId, deletedAt: null };
  if (filters.from || filters.to) {
    where.expenseDate = {};
    if (filters.from) (where.expenseDate as { gte?: string }).gte = filters.from;
    if (filters.to) (where.expenseDate as { lte?: string }).lte = filters.to;
  }
  if (filters.categoryId) where.categoryId = filters.categoryId;
  if (filters.headerId) where.category = { parentId: filters.headerId };
  if (filters.vehicleId) where.vehicleId = filters.vehicleId;
  if (filters.driverId) where.driverId = filters.driverId;

  const rows: RowJoin[] = await prisma.expense.findMany({
    where,
    select: {
      id: true,
      expenseDate: true,
      amount: true,
      description: true,
      vendorName: true,
      vehicle: { select: { vehicleNumber: true } },
      driver: { select: { driverName: true } },
      category: {
        select: {
          id: true, name: true, sortOrder: true, parentId: true,
          parent: { select: { id: true, name: true, sortOrder: true } },
        },
      },
    },
    orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
  });

  const businessName = distributor.legalName ?? distributor.businessName;
  let reportTitle = 'Expense Report — Consolidated';
  if (filters.categoryId) {
    const cat = await prisma.expenseCategory.findFirst({
      where: { id: filters.categoryId, distributorId },
      select: { name: true, parent: { select: { name: true } } },
    });
    reportTitle = `Expense Report — ${cat?.parent?.name ? `${cat.parent.name} / ${cat.name}` : cat?.name ?? 'Category'}`;
  } else if (filters.headerId) {
    const hdr = await prisma.expenseCategory.findFirst({
      where: { id: filters.headerId, distributorId },
      select: { name: true },
    });
    reportTitle = `Expense Report — ${hdr?.name ?? 'Header'} (all subcategories)`;
  }

  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  let page = 1;
  doc.addPage({ size: 'A4', margin: 0 });
  let y = drawHeader(doc, businessName, reportTitle, filters.from ?? null, filters.to ?? null);
  y += drawTableHeader(doc, y);
  const pageBottom = 780;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageBottom) {
      drawFooter(doc, page); page += 1;
      doc.addPage({ size: 'A4', margin: 0 });
      y = MARGIN.top;
      y += drawTableHeader(doc, y);
    }
  };

  // Group rows by header → leaf.
  // Rows with no parent (top-level leaves) get a synthetic bucket "Uncategorised".
  interface Bucket {
    headerId: string;
    headerName: string;
    headerSort: number;
    leaves: Map<string, {
      leafName: string;
      leafSort: number;
      rows: RowJoin[];
      subtotal: number;
    }>;
    subtotal: number;
  }
  const buckets = new Map<string, Bucket>();
  const uncategorisedKey = '__uncategorised';
  for (const r of rows) {
    const headerId = r.category.parent?.id ?? uncategorisedKey;
    const headerName = r.category.parent?.name ?? 'Uncategorised';
    const headerSort = r.category.parent?.sortOrder ?? 9999;
    let b = buckets.get(headerId);
    if (!b) {
      b = { headerId, headerName, headerSort, leaves: new Map(), subtotal: 0 };
      buckets.set(headerId, b);
    }
    let leaf = b.leaves.get(r.category.id);
    if (!leaf) {
      leaf = { leafName: r.category.name, leafSort: r.category.sortOrder, rows: [], subtotal: 0 };
      b.leaves.set(r.category.id, leaf);
    }
    const amt = toNum(r.amount);
    leaf.rows.push(r);
    leaf.subtotal += amt;
    b.subtotal += amt;
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => a.headerSort - b.headerSort || a.headerName.localeCompare(b.headerName));

  let grandTotal = 0;
  const isFlatSingleLeaf = !!filters.categoryId;

  if (isFlatSingleLeaf) {
    // Flat table for single-leaf scope. Skip header/subtotal banding.
    let zebra = false;
    for (const b of sortedBuckets) {
      for (const leaf of b.leaves.values()) {
        for (const r of leaf.rows) {
          const amt = toNum(r.amount);
          ensureSpace(ROW_HEIGHT);
          y += drawRow(doc, y, [
            formatDate(r.expenseDate),
            r.category.parent ? `${r.category.parent.name} / ${r.category.name}` : r.category.name,
            r.description,
            r.vendorName ?? '—',
            r.vehicle?.vehicleNumber ?? '—',
            r.driver?.driverName ?? '—',
            formatMoney(amt),
          ], { zebra });
          zebra = !zebra;
          grandTotal += amt;
        }
      }
    }
  } else {
    // Grouped: HEADER BAND → leaves within → leaf subtotal → header subtotal.
    for (const b of sortedBuckets) {
      ensureSpace(ROW_HEIGHT + 4);
      y += drawHeaderBand(doc, y, b.headerName);
      const sortedLeaves = [...b.leaves.values()].sort((x, y) => x.leafSort - y.leafSort || x.leafName.localeCompare(y.leafName));
      for (const leaf of sortedLeaves) {
        let zebra = false;
        for (const r of leaf.rows) {
          const amt = toNum(r.amount);
          ensureSpace(ROW_HEIGHT);
          y += drawRow(doc, y, [
            formatDate(r.expenseDate),
            leaf.leafName,
            r.description,
            r.vendorName ?? '—',
            r.vehicle?.vehicleNumber ?? '—',
            r.driver?.driverName ?? '—',
            formatMoney(amt),
          ], { zebra });
          zebra = !zebra;
        }
        ensureSpace(ROW_HEIGHT);
        y += drawSubtotalRow(doc, y, `${leaf.leafName} subtotal`, leaf.subtotal);
        y += 2;
      }
      ensureSpace(ROW_HEIGHT + 4);
      y += drawSubtotalRow(doc, y, `${b.headerName} total`, b.subtotal, { emphasise: true });
      y += 6;
      grandTotal += b.subtotal;
    }
  }

  // Grand total.
  ensureSpace(ROW_HEIGHT + 6);
  y += 4;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.BODY);
  const amountCol = COLS[COLS.length - 1];
  const amountX = MARGIN.left + TABLE_WIDTH - amountCol.width;
  doc.text(`Grand total (${rows.length} entries)`, MARGIN.left + 3, y + 4, {
    width: TABLE_WIDTH - amountCol.width - 6, align: 'right', lineBreak: false,
  });
  doc.text(formatMoney(grandTotal), amountX + 3, y + 4, {
    width: amountCol.width - 6, align: 'right', lineBreak: false,
  });
  doc.fillColor(THEME.TEXT);
  y += ROW_HEIGHT + 2;

  drawFooter(doc, page);
  doc.end();
  return done;
}
