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

  // WI-065 redesign of trip identification:
  //
  // Primary path — `order.tripNumber === DVA.tripNumber`. Each
  // preflightOne/preflightAddToTrip call stamps this field atomically
  // with the pending_delivery transition (see transitionToPendingDelivery
  // in gstPreflightService.ts). Status filter widens to include
  // delivered / modified_delivered so the PDF stays downloadable after
  // the driver returns — the doc is useful BOTH in transit (checkpoint
  // proof) and post-trip (delivery audit).
  //
  // Legacy fallback — orders dispatched BEFORE WI-065 shipped have
  // tripNumber = NULL. For those, we fall back to the old
  // `updatedAt >= assignment.updatedAt` window with the original
  // pending_delivery-only filter so historical trip-sheet PDFs keep
  // working. Two-path OR keeps the query single-shot.
  const orderStatusInTrip = ['pending_delivery', 'delivered', 'modified_delivered'] as const;
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      driverId: assignment.driverId,
      deliveryDate: assignment.assignmentDate,
      deletedAt: null,
      OR: [
        // New path: explicit tripNumber match
        {
          tripNumber: assignment.tripNumber,
          status: { in: [...orderStatusInTrip] },
        },
        // Legacy path: tripNumber not stamped (pre-WI-065 row)
        {
          tripNumber: null,
          status: 'pending_delivery',
          updatedAt: { gte: assignment.updatedAt },
        },
      ],
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

  // Fallback rules (WI-038 + WI-065):
  //   - tripSheetNo present                       → "Consolidated Trip Sheet"
  //   - tripSheetNo null + ≥2 EWBs across orders → "Trip Sheet (Per-Order EWBs)"
  //     (gencewb either wasn't called or failed; per-order EWBs are still valid)
  //   - tripSheetNo null + exactly 1 EWB         → "Single Order Trip Sheet"
  //   - tripSheetNo null + 0 EWBs                → "Trip Summary — EWB Pending"
  //     (WI-065: was a hard 400 before, now downgraded — the doc is still
  //      useful as a driver checklist even without compliance numbers,
  //      and the trip sheet button on web + mobile is now always visible
  //      post-dispatch, so we should always have *something* to show.)
  // WI-065 also surfaces a SECOND consolidated EWB (tripSheetNo2) when
  // Add-to-Trip generated one — header lists both.
  const ewbCount = ewbByOrder.size;
  const hasAnyCewb = !!assignment.tripSheetNo || !!assignment.tripSheetNo2;
  const docTitle = hasAnyCewb
    ? 'DELIVERY TRIP SHEET'
    : ewbCount === 1
    ? 'SINGLE ORDER TRIP SHEET'
    : ewbCount >= 2
    ? 'DELIVERY TRIP SHEET (PER-ORDER EWBs)'
    : 'TRIP SUMMARY — EWB PENDING';
  const headerEwbLabel = hasAnyCewb
    ? assignment.tripSheetNo2 ? 'Consolidated EWBs:' : 'Consolidated EWB:'
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
    // WI-083a2 — GAP 1: Order # column widened from 45→85pt (order numbers are
    // ~15 chars at 9pt ≈ 82pt needed). Customer column shifted right from x=90
    // to x=130 and narrowed from 125→85pt to keep addr/ewb/items/val unchanged.
    // Layout: num[40..125] 5pt gap cust[130..215] 5pt gap addr[220..345] 5pt
    //         gap ewb[350..425] 5pt gap items[430..495] 5pt gap val[500..555].
    const colX = { num: 40, cust: 130, addr: 220, ewb: 350, items: 430, val: 500 };
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
      doc.text(order.orderNumber, colX.num, rowY, { width: 85 });
      doc.text(order.customer?.customerName ?? '—', colX.cust, rowY, { width: 85, ellipsis: true });
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
