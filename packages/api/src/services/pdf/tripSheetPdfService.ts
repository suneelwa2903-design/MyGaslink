/**
 * Trip sheet PDF (WI-038, redesigned WI-084).
 *
 * Professional, invoice-quality layout matching invoicePdfService.ts:
 *   - Branded header: distributor name (left) / doc title (right)
 *   - Address + GSTIN beneath company name
 *   - PRIMARY divider
 *   - 2-column info block: Driver/Vehicle (left) | Date/EWB (right)
 *   - Dark table header via drawTableHeader + zebra rows
 *   - Ellipsis on every text cell — no hyphen-break overflow
 *   - drawBox border around entire table
 *
 * One-page A4 doc the driver carries during the day. Lists every
 * order in the route with its per-order EWB number alongside the
 * consolidated EWB number issued by WhiteBooks `gencewb`.
 */

import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { formatDate, formatMoney, drawBox, drawTableHeader } from './pdfLayoutUtils.js';
import { toNum } from '../../utils/decimal.js';

export class TripSheetError extends Error {
  statusCode: number;
  constructor(msg: string, statusCode = 400) { super(msg); this.statusCode = statusCode; }
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const ML = 40;   // margin left
const MT = 50;   // margin top

const THEME = {
  PRIMARY: '#0a3d62',
  TEXT:    '#111827',
  MUTED:   '#6b7280',
  BORDER:  '#e5e7eb',
  ZEBRA:   '#f8fafc',
};

const TABLE_X = ML;       // 40
const TABLE_W = 515;      // 595 − 40 − 40
const ROW_H   = 14;       // base row height for data rows

// Column definitions — total widths must equal TABLE_W (515)
// WI-090: Order# widened 90→102 so a 15-char "ORD-XXXXXXXXXX" (~92pt at
// Helvetica 9pt) fits in the inner width (102−8 pad = 94pt) WITHOUT
// PDFKit wrapping at the hyphen and discarding it ("ORDMPFG…"). Customer
// trimmed 115→103 to keep the row total at TABLE_W (515).
const COL_DEFS: { label: string; width: number }[] = [
  { label: 'Order #',  width: 102 },
  { label: 'Customer', width: 103 },
  { label: 'Address',  width: 105 },
  { label: 'EWB No',   width: 85  },
  { label: 'Items',    width: 55  },
  { label: 'Value',    width: 65  },
];

// Pre-compute absolute left-edge x for each column
const COL_X: number[] = COL_DEFS.reduce<number[]>((acc, col, i) => {
  acc.push(i === 0 ? TABLE_X : acc[i - 1] + COL_DEFS[i - 1].width);
  return acc;
}, []);

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build the trip sheet PDF for a given driver-vehicle assignment.
 * Returns the raw PDF as a Buffer. Throws TripSheetError on missing
 * data so the caller can map to a 400/404 response.
 */
export async function generateTripSheetPdf(
  assignmentId: string,
  distributorId: string,
): Promise<Buffer> {
  const assignment = await prisma.driverVehicleAssignment.findFirst({
    where: { id: assignmentId, distributorId },
    include: {
      driver:  { select: { driverName: true, phone: true } },
      vehicle: { select: { vehicleNumber: true } },
    },
  });
  if (!assignment) throw new TripSheetError('Assignment not found', 404);

  // Note on tripSheetNo: when present (set by gencewb in preflight when
  // 2+ orders generated EWBs in a single batch), the PDF labels itself
  // "Consolidated Trip Sheet". When null, we fall back to listing per-order
  // EWBs and label the doc accordingly. We only hard-fail when there's no
  // usable EWB anywhere on the route.

  // WI-065 redesign of trip identification:
  //
  // Primary path — `order.tripNumber === DVA.tripNumber`. Each
  // preflightOne/preflightAddToTrip call stamps this field atomically
  // with the pending_delivery transition. Status filter widens to include
  // delivered / modified_delivered so the PDF stays downloadable after
  // the driver returns.
  //
  // Legacy fallback — orders dispatched BEFORE WI-065 shipped have
  // tripNumber = NULL. For those, we fall back to the old
  // `updatedAt >= assignment.updatedAt` window with the original
  // pending_delivery-only filter so historical PDFs keep working.
  const orderStatusInTrip = ['pending_delivery', 'delivered', 'modified_delivered'] as const;
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      driverId:     assignment.driverId,
      deliveryDate: assignment.assignmentDate,
      deletedAt:    null,
      OR: [
        { tripNumber: assignment.tripNumber, status: { in: [...orderStatusInTrip] } },
        { tripNumber: null, status: 'pending_delivery', updatedAt: { gte: assignment.updatedAt } },
      ],
    },
    include: {
      customer: { select: { customerName: true, billingAddressLine1: true, billingCity: true } },
      items:    { include: { cylinderType: { select: { typeName: true } } } },
      invoice:  { select: { id: true } },
    },
    orderBy: { orderNumber: 'asc' },
  });

  // Fetch the latest gst_documents row per order in one query.
  const orderIds = orders.map((o) => o.id);
  const gstDocs = orderIds.length > 0
    ? await prisma.gstDocument.findMany({
        where:  { orderId: { in: orderIds }, isLatest: true, ewbNo: { not: null } },
        select: { orderId: true, ewbNo: true },
      })
    : [];
  const ewbByOrder = new Map(gstDocs.map((d) => [d.orderId, d.ewbNo]));

  // Fallback rules (WI-038 + WI-065):
  const ewbCount    = ewbByOrder.size;
  const hasAnyCewb  = !!assignment.tripSheetNo || !!assignment.tripSheetNo2;

  const docTitle = hasAnyCewb
    ? 'DELIVERY TRIP SHEET'
    : ewbCount === 1
    ? 'SINGLE ORDER TRIP SHEET'
    : ewbCount >= 2
    ? 'DELIVERY TRIP SHEET (PER-ORDER)'
    : 'TRIP SUMMARY — EWB PENDING';

  const headerEwbLabel = hasAnyCewb
    ? (assignment.tripSheetNo2 ? 'Consolidated EWBs:' : 'Consolidated EWB:')
    : ewbCount > 0 ? 'EWB References:' : 'EWB Status:';

  const headerEwbValue = hasAnyCewb
    ? [assignment.tripSheetNo, assignment.tripSheetNo2].filter(Boolean).join(' + ')
    : ewbCount === 1
    ? String([...ewbByOrder.values()][0])
    : ewbCount >= 2
    ? `${ewbCount} per-order EWBs (listed below)`
    : 'EWB generation pending — see per-order column below';

  const footerText = hasAnyCewb
    ? 'This is a legally valid trip document. The consolidated e-Way Bill(s) above cover ' +
      'all per-order EWBs listed in this trip sheet for the date shown. Carry this ' +
      'document during transit and present at NIC checkpoints on request.'
    : ewbCount > 0
    ? 'This is a legally valid trip document. Each order below carries its own ' +
      'e-Way Bill (no consolidated EWB was generated for this route). Carry this ' +
      'document during transit and present at NIC checkpoints on request.'
    : 'EWB generation has not completed for this trip. Carry this document as a ' +
      'route checklist; an updated trip sheet with EWB numbers will be available ' +
      'once preflight succeeds.';

  const distributor = await prisma.distributor.findUniqueOrThrow({
    where:  { id: distributorId },
    select: { businessName: true, address: true, city: true, gstin: true },
  });

  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: ML, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Branded header ────────────────────────────────────────────────────────
    //
    //   [Company name  (large, PRIMARY, bold)] . . . . [DOC TITLE (bold, right)]
    //   [Address + GSTIN (small, MUTED)]
    //
    const headerY  = MT;
    const leftW    = 310;
    const rightW   = 200;
    const rightX   = ML + leftW + 5;

    // Company name — left
    doc.fontSize(15).font('Helvetica-Bold').fillColor(THEME.PRIMARY)
      .text(distributor.businessName, ML, headerY, { width: leftW });
    let leftCursorY = doc.y;

    // Address + GSTIN — below company name, muted
    doc.fontSize(8.5).font('Helvetica').fillColor(THEME.MUTED);
    const addrLine = [distributor.address, distributor.city].filter(Boolean).join(', ');
    if (addrLine) {
      doc.text(addrLine, ML, leftCursorY, { width: leftW });
      leftCursorY = doc.y;
    }
    if (distributor.gstin) {
      doc.text(`GSTIN: ${distributor.gstin}`, ML, leftCursorY, { width: leftW });
      leftCursorY = doc.y;
    }

    // Doc title — right, aligned with top of company name
    doc.fontSize(13).font('Helvetica-Bold').fillColor(THEME.PRIMARY)
      .text(docTitle, rightX, headerY, { width: rightW, align: 'right' });
    const rightCursorY = doc.y;

    // ── PRIMARY divider ───────────────────────────────────────────────────────
    const divY = Math.max(leftCursorY, rightCursorY) + 8;
    doc.strokeColor(THEME.PRIMARY).lineWidth(1.5)
      .moveTo(ML, divY).lineTo(ML + TABLE_W, divY).stroke();
    doc.strokeColor('black').lineWidth(0.5);

    // ── 2-column info block ───────────────────────────────────────────────────
    //
    //   Driver:  <name>           Date:          <date>
    //   Vehicle: <number>         Consolidated EWB: <no>
    //
    const infoY      = divY + 10;
    const infoColW   = 255;
    const infoRightX = ML + TABLE_W - infoColW;

    doc.fontSize(9).fillColor(THEME.TEXT);

    // Left: Driver
    doc.font('Helvetica-Bold').text('Driver:', ML, infoY, { continued: true })
      .font('Helvetica').text(`  ${assignment.driver?.driverName ?? '—'}`);
    const afterDriverY = doc.y;

    // Left: Vehicle
    doc.font('Helvetica-Bold').text('Vehicle:', ML, afterDriverY, { continued: true })
      .font('Helvetica').text(`  ${assignment.vehicle?.vehicleNumber ?? '—'}`);
    const afterVehicleY = doc.y;

    // Right: Date (parallel to Driver line)
    doc.font('Helvetica-Bold').text('Date:', infoRightX, infoY, { continued: true, width: infoColW })
      .font('Helvetica').text(`  ${formatDate(assignment.assignmentDate)}`);

    // Right: EWB label (parallel to Vehicle line)
    doc.font('Helvetica-Bold').text(headerEwbLabel, infoRightX, afterDriverY, { continued: true, width: infoColW })
      .font('Helvetica').text(`  ${headerEwbValue}`, { width: infoColW });
    const infoRightBottom = doc.y;

    const infoBottom = Math.max(afterVehicleY, infoRightBottom) + 12;

    // ── Order table ───────────────────────────────────────────────────────────
    const tableY = infoBottom;

    // Dark header row via shared helper
    const headerH = drawTableHeader(doc, TABLE_X, tableY, COL_DEFS, THEME.PRIMARY, TABLE_W);

    // Data rows
    let rowY = tableY + headerH;
    doc.fontSize(9).font('Helvetica');

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];

      // Zebra background on odd rows
      if (i % 2 === 1) {
        doc.rect(TABLE_X, rowY, TABLE_W, ROW_H).fill(THEME.ZEBRA);
      }
      doc.fillColor(THEME.TEXT);

      const itemSummary = order.items
        .map((it) => `${it.quantity}×${it.cylinderType?.typeName ?? ''}`)
        .join(', ');
      const addr = [order.customer?.billingAddressLine1, order.customer?.billingCity]
        .filter(Boolean).join(', ');

      // Vertical padding: 3pt from top of row
      const textY = rowY + 3;
      const PAD   = 4;   // left inner padding per cell
      // WI-090: a height bound is REQUIRED for `ellipsis` to fire. Without
      // it PDFKit wraps overflowing text onto a second line (overflowing
      // ROW_H and, for hyphenated tokens, dropping the hyphen at the break).
      // height = ROW_H − 2 confines each cell to a single line and truncates
      // with an ellipsis instead.
      const CELL_H = ROW_H - 2;

      doc.text(order.orderNumber,
        COL_X[0] + PAD, textY, { width: COL_DEFS[0].width - PAD * 2, height: CELL_H, ellipsis: true });
      doc.text(order.customer?.customerName ?? '—',
        COL_X[1] + PAD, textY, { width: COL_DEFS[1].width - PAD * 2, height: CELL_H, ellipsis: true });
      doc.text(addr || '—',
        COL_X[2] + PAD, textY, { width: COL_DEFS[2].width - PAD * 2, height: CELL_H, ellipsis: true });
      doc.text(ewbByOrder.get(order.id) ?? '—',
        COL_X[3] + PAD, textY, { width: COL_DEFS[3].width - PAD * 2, height: CELL_H, ellipsis: true });
      doc.text(itemSummary || '—',
        COL_X[4] + PAD, textY, { width: COL_DEFS[4].width - PAD * 2, height: CELL_H, ellipsis: true });
      doc.text(formatMoney(toNum(order.totalAmount)),
        COL_X[5] + PAD, textY, { width: COL_DEFS[5].width - PAD * 2, height: CELL_H, ellipsis: true, align: 'right' });

      rowY += ROW_H;
    }

    // Empty-state row when there are no orders
    if (orders.length === 0) {
      doc.fillColor(THEME.MUTED).fontSize(9).font('Helvetica-Oblique')
        .text('No orders found for this trip.', TABLE_X + 4, rowY + 3, { width: TABLE_W - 8 });
      rowY += ROW_H;
    }

    // Border around entire table (header + data rows)
    const tableH = headerH + (orders.length > 0 ? orders.length : 1) * ROW_H;
    drawBox(doc, TABLE_X, tableY, TABLE_W, tableH, THEME.BORDER);

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.y = tableY + tableH + 12;
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor(THEME.MUTED)
      .text(footerText, ML, doc.y, { width: TABLE_W, align: 'center' });

    doc.end();
  });
}
