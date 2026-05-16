/**
 * Trip sheet PDF (WI-038).
 *
 * One-page A4 doc the driver carries during the day. Lists every
 * order in the route with its per-order EWB number alongside the
 * consolidated EWB number issued by WhiteBooks `gencewb`.
 *
 * Kept deliberately simple — not the invoice template. The driver
 * just needs proof at a checkpoint that the goods on the vehicle
 * are covered by valid e-Way Bills.
 */

import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma.js';
import { formatDate, formatMoney } from './pdfLayoutUtils.js';
import { toNum } from '../../utils/decimal.js';

export class TripSheetError extends Error {
  statusCode: number;
  constructor(msg: string, statusCode = 400) { super(msg); this.statusCode = statusCode; }
}

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
      driver: { select: { driverName: true, phone: true } },
      vehicle: { select: { vehicleNumber: true } },
    },
  });
  if (!assignment) throw new TripSheetError('Assignment not found', 404);
  // Note on tripSheetNo: when present (set by gencewb in preflight when
  // 2+ orders generated EWBs in a single batch), the PDF labels itself
  // "Consolidated EWB". When null, we fall back to listing per-order
  // EWBs and label the doc accordingly — see below. We only hard-fail
  // when there's no usable EWB anywhere on the route.

  // WI-061: the trip sheet is a TRANSIT document for orders currently
  // on the truck. The prior query swept up `delivered` /
  // `modified_delivered` too, which leaked finished morning-trip
  // orders into the afternoon-trip sheet on multi-trip days. Two
  // tightenings:
  //   1. Status set narrows to `pending_delivery` only — orders that
  //      have been dispatched but not yet confirmed delivered.
  //   2. `updatedAt >= assignment.updatedAt` lower bound. Preflight
  //      reuses the same DVA row across trips and bumps `updatedAt`
  //      on each trip increment (see preflightDispatch:146 — sets
  //      tripNumber: { increment: 1 }, which Prisma's @updatedAt
  //      handler refreshes). So trip-1 orders whose pending_delivery
  //      transition predates the current DVA.updatedAt are excluded.
  //      Defense in depth — the status guard already covers the
  //      common case, this catches the rare manual rollback.
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      driverId: assignment.driverId,
      deliveryDate: assignment.assignmentDate,
      deletedAt: null,
      status: 'pending_delivery',
      updatedAt: { gte: assignment.updatedAt },
    },
    include: {
      customer: { select: { customerName: true, billingAddressLine1: true, billingCity: true } },
      items: { include: { cylinderType: { select: { typeName: true } } } },
      invoice: { select: { id: true } },
    },
    orderBy: { orderNumber: 'asc' },
  });

  // Fetch the latest gst_documents row per order in one query so the
  // EWB number column doesn't fire N round-trips.
  const orderIds = orders.map((o) => o.id);
  const gstDocs = orderIds.length > 0 ? await prisma.gstDocument.findMany({
    where: { orderId: { in: orderIds }, isLatest: true, ewbNo: { not: null } },
    select: { orderId: true, ewbNo: true },
  }) : [];
  const ewbByOrder = new Map(gstDocs.map((d) => [d.orderId, d.ewbNo]));

  // Fallback rules (WI-038 + post-launch fix):
  //   - tripSheetNo present                       → "Consolidated Trip Sheet"
  //   - tripSheetNo null + ≥2 EWBs across orders → "Trip Sheet (Per-Order EWBs)"
  //     (gencewb either wasn't called or failed; per-order EWBs are still valid)
  //   - tripSheetNo null + exactly 1 EWB         → "Single Order Trip Sheet"
  //   - tripSheetNo null + 0 EWBs                → 400 "No EWB available"
  const ewbCount = ewbByOrder.size;
  if (!assignment.tripSheetNo && ewbCount === 0) {
    throw new TripSheetError(
      'No EWB available for trip sheet — no orders on this route have an e-Way Bill yet',
      400,
    );
  }
  const docTitle = assignment.tripSheetNo
    ? 'DELIVERY TRIP SHEET'
    : ewbCount === 1
    ? 'SINGLE ORDER TRIP SHEET'
    : 'DELIVERY TRIP SHEET (PER-ORDER EWBs)';
  const headerEwbLabel = assignment.tripSheetNo
    ? 'Consolidated EWB:'
    : 'EWB References:';
  // For the fallback paths, surface either the single EWB number or
  // "(see per-order column below)". Avoids a blank line in the metadata.
  const headerEwbValue = assignment.tripSheetNo
    ? assignment.tripSheetNo
    : ewbCount === 1
    ? String([...ewbByOrder.values()][0])
    : `${ewbCount} per-order EWBs (listed below)`;
  const footerText = assignment.tripSheetNo
    ? 'This is a legally valid trip document. The consolidated e-Way Bill above covers ' +
      'all per-order EWBs listed in this trip sheet for the date shown. Carry this ' +
      'document during transit and present at NIC checkpoints on request.'
    : 'This is a legally valid trip document. Each order below carries its own ' +
      'e-Way Bill (no consolidated EWB was generated for this route). Carry this ' +
      'document during transit and present at NIC checkpoints on request.';

  const distributor = await prisma.distributor.findUniqueOrThrow({
    where: { id: distributorId },
    select: { businessName: true, address: true, city: true, gstin: true },
  });

  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(16).font('Helvetica-Bold')
      .text(docTitle, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica')
      .text(distributor.businessName, { align: 'center' });
    if (distributor.address || distributor.city) {
      doc.text(`${distributor.address ?? ''} ${distributor.city ?? ''}`.trim(), { align: 'center' });
    }
    if (distributor.gstin) doc.text(`GSTIN: ${distributor.gstin}`, { align: 'center' });
    doc.moveDown(0.6);

    // Trip metadata box
    const leftX = doc.x;
    doc.fontSize(10).font('Helvetica-Bold').text('Driver:', leftX, doc.y, { continued: true })
      .font('Helvetica').text(`  ${assignment.driver?.driverName ?? '—'}`);
    doc.font('Helvetica-Bold').text('Vehicle:', { continued: true })
      .font('Helvetica').text(`  ${assignment.vehicle?.vehicleNumber ?? '—'}`);
    doc.font('Helvetica-Bold').text('Date:', { continued: true })
      .font('Helvetica').text(`  ${formatDate(assignment.assignmentDate)}`);
    doc.font('Helvetica-Bold').text(headerEwbLabel, { continued: true })
      .font('Helvetica').text(`  ${headerEwbValue}`);
    doc.moveDown(0.8);

    // Table header
    const colX = { num: 40, cust: 90, addr: 220, ewb: 350, items: 430, val: 500 };
    const headerY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold')
      .text('Order #', colX.num, headerY)
      .text('Customer', colX.cust, headerY)
      .text('Address', colX.addr, headerY)
      .text('EWB No', colX.ewb, headerY)
      .text('Items', colX.items, headerY)
      .text('Value', colX.val, headerY);
    doc.moveTo(40, doc.y + 12).lineTo(555, doc.y + 12).stroke();
    doc.moveDown(1);

    // Rows
    doc.font('Helvetica').fontSize(9);
    for (const order of orders) {
      const rowY = doc.y;
      const itemSummary = order.items
        .map((it) => `${it.quantity}×${it.cylinderType?.typeName ?? ''}`)
        .join(', ');
      const addr = [order.customer?.billingAddressLine1, order.customer?.billingCity]
        .filter(Boolean).join(', ');
      doc.text(order.orderNumber, colX.num, rowY, { width: 45 });
      doc.text(order.customer?.customerName ?? '—', colX.cust, rowY, { width: 125, ellipsis: true });
      doc.text(addr || '—', colX.addr, rowY, { width: 125, ellipsis: true });
      doc.text(ewbByOrder.get(order.id) ?? '—', colX.ewb, rowY, { width: 75 });
      doc.text(itemSummary || '—', colX.items, rowY, { width: 65 });
      doc.text(formatMoney(toNum(order.totalAmount)), colX.val, rowY, { width: 55 });
      // Advance to next row, sizing on the longest column. Address is the
      // longest in practice so we use that as our anchor.
      doc.y = Math.max(doc.y, rowY + 14);
    }

    doc.moveDown(1);
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#555')
      .text(footerText, { align: 'center' });

    doc.end();
  });
}
