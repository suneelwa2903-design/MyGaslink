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
  if (!assignment.tripSheetNo) {
    throw new TripSheetError(
      'Trip sheet has not been generated for this assignment yet',
      400,
    );
  }

  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      driverId: assignment.driverId,
      deliveryDate: assignment.assignmentDate,
      deletedAt: null,
      status: { in: ['pending_delivery', 'delivered', 'modified_delivered'] },
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
      .text('DELIVERY TRIP SHEET', { align: 'center' });
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
    doc.font('Helvetica-Bold').text('Consolidated EWB:', { continued: true })
      .font('Helvetica').text(`  ${assignment.tripSheetNo}`);
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
      .text(
        'This is a legally valid trip document. The consolidated e-Way Bill above covers ' +
        'all per-order EWBs listed in this trip sheet for the date shown. Carry this ' +
        'document during transit and present at NIC checkpoints on request.',
        { align: 'center' },
      );

    doc.end();
  });
}
