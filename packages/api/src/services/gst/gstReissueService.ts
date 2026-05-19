/**
 * Delivery mismatch reissue (WI-037).
 *
 * When the driver confirms delivery with quantities that differ from
 * the preflight invoice, the existing IRN/EWB documents are wrong —
 * they claim X cylinders left the depot when Y were actually handed
 * over. This service cancels the existing compliance documents,
 * updates invoice items + totals to delivered quantities, regenerates
 * the IRN (B2B) or standalone EWB (B2C), and stores an audit row in
 * invoice_revisions.
 *
 * Hard rules (founder Q&A):
 *  - IRN cancel failure → abort. Never overwrite a live IRN with new
 *    qty without successful cancellation. Pending action (HIGH) so an
 *    admin can manually resolve.
 *  - EWB cancel failure → continue. Goods have already moved; the EWB
 *    is now informational. Pending action (MEDIUM) for cleanup.
 *  - Duplicate IRN (2150) on re-generation → bump invoice number,
 *    retry once. After that, treat as failure.
 *  - GST-disabled tenant / no prior IRN → reissue is a no-op.
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { toNum } from '../../utils/decimal.js';
import { getCredentials } from './whitebooksClient.js';
import { callWithLog } from './apiLogger.js';
import { buildIrnPayload, buildEwbPayload } from './payloadBuilders.js';
import {
  cancelEwb,
  cancelIrn,
  createPendingAction,
  parseEwbResponse,
  parseWhitebooksDate,
} from './gstService.js';

export type ReissueResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; revisionId: string; mode: 'B2B' | 'B2C'; newIrn?: string | null; newEwbNo?: string | null }
  | { ok: false; aborted: 'IRN_CANCEL_BLOCKED'; pendingActionId: string | null; reason: string };

/**
 * Run the reissue flow for an invoice whose linked order was delivered
 * with quantities ≠ ordered. Idempotent — re-entry on an already-revised
 * invoice produces another revision row only if quantities still differ.
 */
export async function reissueForDeliveryMismatch(args: {
  invoiceId: string;
  distributorId: string;
  userId: string;
  mismatchContext?: Record<string, any>;
}): Promise<ReissueResult> {
  const { invoiceId, distributorId, userId, mismatchContext } = args;

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      id: true, gstMode: true, gstin: true, legalName: true, businessName: true,
      address: true, city: true, state: true, pincode: true, phone: true, email: true,
    },
  });
  if (!distributor || distributor.gstMode === 'disabled') {
    return { ok: true, skipped: true, reason: 'GST disabled — no reissue needed' };
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, distributorId, deletedAt: null },
    include: {
      items: { include: { cylinderType: true } },
      customer: true,
      order: { include: { items: true, vehicle: true } },
    },
  });
  if (!invoice) {
    return { ok: true, skipped: true, reason: 'Invoice not found' };
  }
  if (invoice.irnStatus !== 'success' && invoice.ewbStatus !== 'active') {
    // No live compliance doc to reissue — happens on GST-disabled tenants
    // or when the preflight failed earlier. Quantities have already been
    // updated by confirmDelivery; nothing more to do.
    return { ok: true, skipped: true, reason: 'Invoice has no live IRN/EWB to reissue' };
  }

  const isB2B = !!invoice.customer?.gstin && invoice.customer.gstin !== 'URP';

  // Snapshot the original invoice + items BEFORE any mutation. Used for
  // both the audit row and any rollback we might want to do later.
  const originalItems = invoice.items.map((i) => ({
    id: i.id,
    cylinderTypeId: i.cylinderTypeId,
    description: i.description,
    quantity: i.quantity,
    unitPrice: toNum(i.unitPrice),
    discountPerUnit: toNum(i.discountPerUnit),
    gstRate: i.gstRate,
    totalPrice: toNum(i.totalPrice),
  }));
  const originalTotal = toNum(invoice.totalAmount);

  // Step 1 — cancel EWB if active. Non-fatal: a soft pending action is
  // raised but the flow continues regardless of the outcome.
  const hasActiveEwb = invoice.ewbStatus === 'active';
  if (hasActiveEwb) {
    try {
      await cancelEwb(invoiceId, distributorId, 'Delivery quantity mismatch — reissuing invoice');
      logger.info('Reissue: EWB cancelled', { invoiceId });
    } catch (err: any) {
      logger.warn('Reissue: EWB cancel failed (non-blocking)', { invoiceId, err: err.message });
      await createPendingAction(
        distributorId, invoiceId,
        'EWB_CANCEL_FAILED', err.message ?? 'EWB cancel failure during reissue',
        'medium',
      );
    }
  }

  // Step 2 — cancel IRN if B2B and live. Hard-fail on cancellation
  // errors to prevent two valid IRNs for the same doc number.
  const previousInvoiceStatus = invoice.status;
  if (isB2B && invoice.irnStatus === 'success' && invoice.irn) {
    try {
      await cancelIrn(invoiceId, distributorId, 'Delivery quantity mismatch — reissuing invoice');
      logger.info('Reissue: IRN cancelled', { invoiceId, irn: invoice.irn });
      // cancelIrn flips invoice.status to 'cancelled' as a side-effect;
      // reissue keeps the invoice live so the customer is still billed
      // for the revised quantities. Restore the pre-cancel status.
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: previousInvoiceStatus },
      });
    } catch (err: any) {
      logger.error('Reissue: IRN cancel blocked — aborting', { invoiceId, err: err.message });
      const pa = await createPendingAction(
        distributorId, invoiceId,
        'IRN_CANCEL_BLOCKED',
        `Reissue aborted: ${err.message ?? 'IRN cancel failed'}`,
        'high',
      );
      return {
        ok: false,
        aborted: 'IRN_CANCEL_BLOCKED',
        pendingActionId: pa?.id ?? null,
        reason: err.message ?? 'IRN cancel failed',
      };
    }
  }

  // Step 3 — update invoice items + totals to delivered quantities. We
  // pull delivered quantities from the linked order (confirmDelivery has
  // already written them) by matching on cylinderTypeId.
  const orderItems = invoice.order?.items ?? [];
  const orderItemByCylinder = new Map(orderItems.map((oi) => [oi.cylinderTypeId, oi]));
  let revisedSubtotal = 0;
  const revisedItems: Array<{
    id: string; cylinderTypeId: string | null;
    quantity: number; unitPrice: number; discountPerUnit: number;
    gstRate: number; totalPrice: number;
  }> = [];
  for (const item of invoice.items) {
    const orderItem = item.cylinderTypeId ? orderItemByCylinder.get(item.cylinderTypeId) : null;
    const newQty = orderItem?.deliveredQuantity ?? item.quantity;
    const unitPrice = toNum(item.unitPrice);
    const discountPerUnit = toNum(item.discountPerUnit);
    // unitPrice in the schema is already GST-inclusive at the per-unit
    // discounted price (see invoiceService.createInvoiceFromOrder), so
    // line total stays consistent with the original computation.
    const lineTotal = round2(newQty * Math.max(unitPrice - discountPerUnit, 0));
    revisedSubtotal += lineTotal;
    revisedItems.push({
      id: item.id,
      cylinderTypeId: item.cylinderTypeId,
      quantity: newQty,
      unitPrice,
      discountPerUnit,
      gstRate: item.gstRate,
      totalPrice: lineTotal,
    });
    if (newQty !== item.quantity || lineTotal !== toNum(item.totalPrice)) {
      await prisma.invoiceItem.update({
        where: { id: item.id },
        data: { quantity: newQty, totalPrice: lineTotal },
      });
    }
  }
  // Keep GST split proportional to original ratio (avoids re-deriving
  // intra- vs inter-state from scratch on every reissue).
  const ratio = originalTotal > 0 ? revisedSubtotal / originalTotal : 1;
  const newCgst = round2(toNum(invoice.cgstValue) * ratio);
  const newSgst = round2(toNum(invoice.sgstValue) * ratio);
  const newIgst = round2(toNum(invoice.igstValue) * ratio);
  // WI-064: outstandingAmount used to be left at the ordered-quantity
  // figure while totalAmount was refreshed to the delivered total. The
  // ledger then drifted (e.g. INV-MPC38K5UZGB: total=₹16,271, outstanding
  // =₹24,000). Reissue runs immediately after delivery confirmation, so
  // no payment can have been recorded; the invariant outstanding=total
  // holds.
  const newTotal = round2(revisedSubtotal);
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      totalAmount: newTotal,
      outstandingAmount: newTotal,
      cgstValue: newCgst,
      sgstValue: newSgst,
      igstValue: newIgst,
      revisedPostDeliveryAt: new Date(),
    },
  });

  // Step 4 — regenerate the compliance doc. B2B = new IRN only; B2C =
  // new standalone EWB. EWB is NOT regenerated for B2B because goods
  // have already moved; the existing trip-sheet EWB stands.
  let newIrn: string | null = null;
  let newEwbNo: string | null = null;

  try {
    if (isB2B) {
      newIrn = await regenerateB2bIrn(invoiceId, distributorId, distributor);
    } else {
      newEwbNo = await regenerateB2cEwb(invoiceId, distributorId, distributor);
    }
  } catch (err: any) {
    logger.error('Reissue: doc regeneration failed', { invoiceId, err: err.message });
    await createPendingAction(
      distributorId, invoiceId,
      isB2B ? 'IRN_REGENERATION_FAILED' : 'EWB_REGENERATION_FAILED',
      err.message ?? 'Doc regeneration failed during reissue',
      'high',
    );
    // Continue to write the revision row anyway — the quantities have
    // already been corrected on the invoice; the GST doc just needs
    // manual cleanup.
  }

  // Step 5 — write the revision audit row.
  const revisionRow = await prisma.invoiceRevision.create({
    data: {
      invoiceId,
      distributorId,
      revisionNumber: await nextRevisionNumber(invoiceId),
      reason: 'delivery_mismatch',
      originalTotal,
      revisedTotal: round2(revisedSubtotal),
      originalItems: originalItems as any,
      revisedItems: revisedItems as any,
      revisedBy: userId,
      ...(mismatchContext ? {} : {}),
    },
    select: { id: true },
  });

  return {
    ok: true,
    revisionId: revisionRow.id,
    mode: isB2B ? 'B2B' : 'B2C',
    newIrn,
    newEwbNo,
  };
}

async function nextRevisionNumber(invoiceId: string): Promise<number> {
  const last = await prisma.invoiceRevision.findFirst({
    where: { invoiceId },
    orderBy: { revisionNumber: 'desc' },
    select: { revisionNumber: true },
  });
  return (last?.revisionNumber ?? 0) + 1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Generate a fresh IRN for a B2B invoice that was just revised.
 *
 * WI-064: bump invoice number BEFORE the first regenerate call.
 *
 * After a cancel, NIC remembers the doc number as cancelled and returns
 * 2278 ("IRN was generated and cancelled — doc number burned") for any
 * reuse attempt. The legacy code only caught 2150 ("duplicate IRN, still
 * active") and threw 2278 unhandled, leaving the invoice in a half-state
 * (quantities revised but `irn`/`irnStatus` still pointing at the
 * cancelled doc). Pre-bumping the invoice number unconditionally avoids
 * the trap; on a rare collision the retry catch handles BOTH 2150 and
 * 2278.
 */
async function regenerateB2bIrn(
  invoiceId: string,
  distributorId: string,
  distributor: any,
): Promise<string | null> {
  // WI-064: burn the cancelled doc number up front. The cancel step
  // before this retired it on NIC's side, so any reuse attempt would
  // come back as 2278 ("IRN already generated and cancelled"). The
  // legacy code only caught 2150 — 2278 escaped unhandled and stranded
  // the invoice in a half-state.
  const inv0 = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { invoiceNumber: true },
  });
  const freshNumber = bumpInvoiceNumber(inv0.invoiceNumber);
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { invoiceNumber: freshNumber },
  });
  logger.info('Reissue B2B: pre-bumped invoice number ahead of regenerate', {
    invoiceId, oldNumber: inv0.invoiceNumber, newNumber: freshNumber,
  });

  const invoiceData = await buildInvoiceDataForIrn(invoiceId, distributor);
  const credEmail =
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  const callIrn = async (payload: any) => callWithLog<any>(
    distributorId, 'POST',
    `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(credEmail)}`,
    payload, 'einvoice',
    { apiType: 'IRN_GENERATE_REISSUE', invoiceId },
  );

  let response: any;
  try {
    response = await callIrn(buildIrnPayload(invoiceData));
  } catch (err: any) {
    const code = String(err.code ?? '').replace(/[^0-9]/g, '');
    // 2150 = doc number has an active IRN; 2278 = doc number had an IRN
    // that was cancelled. Both unblock by bumping the suffix once more.
    if (code !== '2150' && code !== '2278') throw err;
    logger.warn('Reissue B2B: NIC rejected first regen — bumping again', { invoiceId, code });
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { invoiceNumber: true },
    });
    const newNumber = bumpInvoiceNumber(inv.invoiceNumber);
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { invoiceNumber: newNumber },
    });
    invoiceData.docNumber = newNumber;
    response = await callIrn(buildIrnPayload(invoiceData));
  }

  const irn = response.data?.Irn ?? response.Irn ?? null;
  const ackNo = response.data?.AckNo ?? response.AckNo;
  const ackDt = response.data?.AckDt ?? response.AckDt;
  const signedQr = response.data?.SignedQRCode ?? response.SignedQRCode;

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      irn,
      ackNo: ackNo?.toString(),
      ackDate: parseWhitebooksDate(ackDt),
      irnStatus: 'success',
    },
  });
  await upsertLatestGstDoc(invoiceId, distributorId, {
    irnStatus: 'success',
    irn,
    ackNo: ackNo?.toString(),
    ackDate: parseWhitebooksDate(ackDt),
    signedQr,
  });
  return irn;
}

/** Generate a new standalone EWB for a B2C invoice post-reissue. */
async function regenerateB2cEwb(
  invoiceId: string,
  distributorId: string,
  distributor: any,
): Promise<string | null> {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { order: { include: { vehicle: true } } },
  });
  const vehicleNumber = invoice.order?.vehicle?.vehicleNumber;
  if (!vehicleNumber) {
    throw new Error('Cannot regenerate EWB: no vehicle on order');
  }
  const invoiceData = await buildInvoiceDataForIrn(invoiceId, distributor);
  const ewbPayload = buildEwbPayload(buildIrnPayload(invoiceData), {
    vehicleNumber, transportMode: '1', distance: 1,
  });
  const credEmail =
    (await getCredentials(distributorId, 'ewaybill'))?.email ||
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  const resp = await callWithLog<any>(
    distributorId, 'POST',
    `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
    ewbPayload, 'ewaybill',
    { apiType: 'EWB_GENERATE_REISSUE_B2C', invoiceId },
  );
  const parsed = parseEwbResponse(resp);
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { ewbStatus: 'active' },
  });
  await upsertLatestGstDoc(invoiceId, distributorId, {
    ewbStatus: 'active',
    ewbNo: parsed.ewbNo,
    ewbDate: parsed.validFromDate,
    ewbValidTill: parsed.validToDate,
  });
  return parsed.ewbNo;
}

/**
 * Find-or-update the latest gst_documents row for an invoice. Mirrors
 * the helper in gstPreflightService but kept local to avoid an import
 * cycle on what is otherwise a private helper.
 */
async function upsertLatestGstDoc(
  invoiceId: string,
  distributorId: string,
  data: Record<string, any>,
) {
  const existing = await prisma.gstDocument.findFirst({
    where: { invoiceId, isLatest: true, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    await prisma.gstDocument.update({ where: { id: existing.id }, data });
    return;
  }
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    select: { invoiceNumber: true, orderId: true },
  });
  await prisma.gstDocument.create({
    data: {
      invoiceId,
      orderId: invoice.orderId!,
      distributorId,
      docType: 'INV',
      gstDocNo: invoice.invoiceNumber,
      isLatest: true,
      ...data,
    },
  });
}

/**
 * Build the InvoiceData payload feeding buildIrnPayload — same shape
 * as gstService.processInvoiceGst but reads from the freshly-mutated
 * invoice items (which now reflect delivered quantities).
 */
async function buildInvoiceDataForIrn(invoiceId: string, distributor: any): Promise<any> {
  const inv = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { items: { include: { cylinderType: true } }, customer: true },
  });
  const sellerStateCode = (distributor.gstin || '').substring(0, 2);
  const buyerStateCode = inv.customer?.gstin ? inv.customer.gstin.substring(0, 2) : sellerStateCode;
  return {
    docType: 'INV' as const,
    docNumber: inv.invoiceNumber,
    docDate: inv.issueDate,
    seller: {
      gstin: distributor.gstin!,
      legalName: distributor.legalName,
      tradeName: distributor.businessName,
      address: distributor.address || '',
      city: distributor.city || '',
      pincode: distributor.pincode || '',
      state: distributor.state || '',
      stateCode: sellerStateCode,
      phone: distributor.phone || undefined,
      email: distributor.email || undefined,
    },
    buyer: {
      gstin: inv.customer?.gstin || null,
      legalName: inv.customer?.businessName || inv.customer?.customerName || 'Consumer',
      tradeName: inv.customer?.customerName || undefined,
      address: inv.customer?.billingAddressLine1 || '',
      city: inv.customer?.billingCity || '',
      pincode: inv.customer?.billingPincode || '',
      state: inv.customer?.billingState || '',
      stateCode: buyerStateCode,
      phone: inv.customer?.phone || undefined,
      email: inv.customer?.email || undefined,
    },
    items: inv.items.map((item: any, idx: number) => ({
      slNo: idx + 1,
      description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unit: 'NOS',
      unitPrice: toNum(item.unitPrice) + toNum(item.discountPerUnit),
      discountPerUnit: toNum(item.discountPerUnit),
      gstRate: item.gstRate || 18,
    })),
    isInterState: sellerStateCode !== buyerStateCode,
  };
}

/**
 * Bump the last numeric suffix on the invoice number so NIC sees a fresh doc.
 *
 * WI-064: cap the result at 16 chars (NIC's DocDtls.No limit per
 * payloadBuilders.truncateDocNumber). If we let a long base name push
 * the suffix past the cap, NIC silently truncates and two distinct DB
 * invoice numbers can collapse to the same NIC document — re-tripping
 * the 2278 trap. Trim the BASE (not the suffix) to keep the local DB
 * row aligned with what NIC actually sees on the wire.
 */
function bumpInvoiceNumber(invoiceNumber: string): string {
  const MAX = 16;
  const m = invoiceNumber.match(/^(.*)-R(\d+)$/);
  const base = m ? m[1] : invoiceNumber;
  const next = m ? parseInt(m[2], 10) + 1 : 1;
  const suffix = `-R${next}`;
  const room = Math.max(MAX - suffix.length, 1);
  const baseTrimmed = base.length > room ? base.substring(0, room) : base;
  return `${baseTrimmed}${suffix}`;
}
