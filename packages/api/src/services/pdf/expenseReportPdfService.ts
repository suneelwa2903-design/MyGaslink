/**
 * Mini-op #5 (2026-07-27) — Expense Report PDF.
 *
 * Two report modes off the same endpoint:
 *   - CONSOLIDATED: every category grouped, with per-category subtotal
 *     and a grand total row. Use for "give me an overview of last month's
 *     spend".
 *   - SINGLE CATEGORY: flat table filtered to one ExpenseCategory. Use for
 *     "print me all fuel expenses for Q1".
 *
 * Portrait A4. Same header/footer style as purchaseLedgerPdfService.
 * Management report — NOT audited P&L. Footer disclaimer says so.
 */
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { formatDate, formatMoney } from './pdfLayoutUtils.js';
import type { Prisma, ExpenseCategory } from '@prisma/client';
import { toNum } from '../../utils/decimal.js';

const PAGE_WIDTH = 595;      // A4 portrait
const MARGIN = { left: 40, right: 40, top: 40, bottom: 40 };
const USABLE = PAGE_WIDTH - MARGIN.left - MARGIN.right; // 515

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT: '#111827',
  MUTED: '#6b7280',
  BORDER: '#e5e7eb',
  ZEBRA: '#f8fafc',
  ACCENT: '#1e4a76',
};
const TYPO = { H1: 18, H2: 12, BODY: 8, LABEL: 8, CAPTION: 7 };

const CATEGORY_LABELS: Record<string, string> = {
  fuel: 'Fuel',
  vehicle_maintenance: 'Vehicle maintenance',
  salaries_wages: 'Salaries & wages',
  rent: 'Rent',
  utilities: 'Utilities',
  loading_unloading: 'Loading / unloading',
  cylinder_deposits: 'Cylinder deposits',
  office_supplies: 'Office supplies',
  communication: 'Communication',
  insurance: 'Insurance',
  taxes_licenses: 'Taxes & licenses',
  bank_charges: 'Bank charges',
  other: 'Other',
};

interface Col {
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
}

// 515pt total. Wider Description & Vendor since most entries carry one or the other.
const COLS: Col[] = [
  { label: 'Date',        width: 62,  align: 'left'  },
  { label: 'Category',    width: 90,  align: 'left'  },
  { label: 'Description', width: 130, align: 'left'  },
  { label: 'Vendor',      width: 90,  align: 'left'  },
  { label: 'Vehicle',     width: 45,  align: 'left'  },
  { label: 'Driver',      width: 45,  align: 'left'  },
  { label: 'Amount',      width: 53,  align: 'right' },
];

const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);
const ROW_HEIGHT = 15;

// Rough per-column char cap. Undersized values get truncated with an ellipsis.
const COL_CHAR_CAP: number[] = [10, 15, 24, 16, 8, 8, 10];

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
    const period = `Period: ${from ?? 'earliest'}  →  ${to ?? 'today'}`;
    doc.font('Helvetica').fontSize(TYPO.LABEL).fillColor(THEME.MUTED)
      .text(period, MARGIN.left, y, { width: USABLE, align: 'center' });
    y += 14;
  }
  return y + 4;
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  let x = MARGIN.left;
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT + 2).fill(THEME.PRIMARY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(TYPO.CAPTION);
  for (const col of COLS) {
    doc.text(col.label, x + 3, y + 4, {
      width: col.width - 6, align: col.align, lineBreak: false, ellipsis: true,
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
  opts: { bold?: boolean; zebra?: boolean; color?: string } = {},
): number {
  if (opts.zebra) doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  doc.fillColor(opts.color ?? THEME.TEXT)
    .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPO.BODY);
  let x = MARGIN.left;
  for (let i = 0; i < COLS.length; i++) {
    doc.text(fitCell(cells[i] ?? '', COL_CHAR_CAP[i] ?? 999), x + 3, y + 4, {
      width: COLS[i].width - 6, align: COLS[i].align, lineBreak: false, ellipsis: true,
    });
    x += COLS[i].width;
  }
  return ROW_HEIGHT;
}

function drawSubtotalRow(doc: PDFKit.PDFDocument, y: number, label: string, amount: number): number {
  doc.rect(MARGIN.left, y, TABLE_WIDTH, ROW_HEIGHT).fill(THEME.ZEBRA);
  doc.strokeColor(THEME.BORDER).lineWidth(0.5)
    .moveTo(MARGIN.left, y).lineTo(MARGIN.left + TABLE_WIDTH, y).stroke();
  doc.fillColor(THEME.ACCENT).font('Helvetica-Bold').fontSize(TYPO.BODY);
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
  const y = 800; // A4 height 842 - 42 footer margin
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
  category?: string;
  vehicleId?: string;
  driverId?: string;
}

/**
 * Generates an expense-report PDF.
 * - filters.category present → single-category flat report
 * - filters.category absent  → consolidated grouped-by-category report
 */
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
  if (filters.category) where.category = filters.category as ExpenseCategory;
  if (filters.vehicleId) where.vehicleId = filters.vehicleId;
  if (filters.driverId) where.driverId = filters.driverId;

  const rows = await prisma.expense.findMany({
    where,
    include: {
      vehicle: { select: { vehicleNumber: true } },
      driver: { select: { driverName: true } },
    },
    orderBy: [{ category: 'asc' }, { expenseDate: 'asc' }, { createdAt: 'asc' }],
  });

  const businessName = distributor.legalName ?? distributor.businessName;
  const isConsolidated = !filters.category;
  const reportTitle = isConsolidated
    ? 'Expense Report — Consolidated'
    : `Expense Report — ${CATEGORY_LABELS[filters.category!] ?? filters.category}`;

  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  let page = 1;
  doc.addPage({ size: 'A4', margin: 0 });
  let y = drawHeader(doc, businessName, reportTitle, filters.from ?? null, filters.to ?? null);
  y += drawTableHeader(doc, y);

  const pageBottom = 780; // above footer
  const ensureSpace = (needed: number) => {
    if (y + needed > pageBottom) {
      drawFooter(doc, page);
      page += 1;
      doc.addPage({ size: 'A4', margin: 0 });
      y = MARGIN.top;
      y += drawTableHeader(doc, y);
    }
  };

  let grandTotal = 0;

  if (isConsolidated) {
    // Group by category. Prisma already sorted by category asc so a
    // single linear pass is enough.
    let currentCategory: ExpenseCategory | null = null;
    let categorySubtotal = 0;
    let zebra = false;

    const flushSubtotal = () => {
      if (currentCategory !== null) {
        ensureSpace(ROW_HEIGHT + 4);
        y += drawSubtotalRow(
          doc, y,
          `${CATEGORY_LABELS[currentCategory] ?? currentCategory} subtotal`,
          categorySubtotal,
        );
        y += 6;
      }
    };

    for (const r of rows) {
      if (r.category !== currentCategory) {
        flushSubtotal();
        currentCategory = r.category;
        categorySubtotal = 0;
        zebra = false;
      }
      const amount = toNum(r.amount);
      ensureSpace(ROW_HEIGHT);
      y += drawRow(doc, y, [
        formatDate(r.expenseDate),
        CATEGORY_LABELS[r.category] ?? r.category,
        r.description,
        r.vendorName ?? '—',
        r.vehicle?.vehicleNumber ?? '—',
        r.driver?.driverName ?? '—',
        formatMoney(amount),
      ], { zebra });
      zebra = !zebra;
      categorySubtotal += amount;
      grandTotal += amount;
    }
    flushSubtotal();
  } else {
    // Flat table for the single-category report.
    let zebra = false;
    for (const r of rows) {
      const amount = toNum(r.amount);
      ensureSpace(ROW_HEIGHT);
      y += drawRow(doc, y, [
        formatDate(r.expenseDate),
        CATEGORY_LABELS[r.category] ?? r.category,
        r.description,
        r.vendorName ?? '—',
        r.vehicle?.vehicleNumber ?? '—',
        r.driver?.driverName ?? '—',
        formatMoney(amount),
      ], { zebra });
      zebra = !zebra;
      grandTotal += amount;
    }
  }

  // Grand total row — always emit, even for zero-row reports.
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
