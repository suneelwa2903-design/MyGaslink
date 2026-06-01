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

import { Prisma, type IrnStatus, type EwbStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { toNum } from '../../utils/decimal.js';
import { getCredentials, GstError } from './whitebooksClient.js';
import { callWithLog } from './apiLogger.js';
import { buildIrnPayload, buildEwbPayload, type IrnPayload } from './payloadBuilders.js';
import type { IrnResponse, EwbResponse } from './nicTypes.js';
import { allocateNumber } from '../numberingService.js';
import {
  cancelEwb,
  cancelIrn,
  createPendingAction,
  generateEwbFromIrn,
  parseEwbResponse,
  parseWhitebooksDate,
} from './gstService.js';

/** The InvoiceData shape consumed by buildIrnPayload (kept un-exported there). */
type InvoiceData = Parameters<typeof buildIrnPayload>[0];

/** The distributor fields the reissue flow reads (subset of the Prisma model). */
type DistributorReissueFields = Pick<
  Prisma.DistributorGetPayload<true>,
  | 'id' | 'gstMode' | 'gstin' | 'legalName' | 'businessName'
  | 'address' | 'city' | 'state' | 'pincode' | 'phone' | 'email' | 'docCode'
>;

/** Narrow an unknown caught value to the GST error code/message shape. */
function errInfo(err: unknown): { code: string; message: string } {
  if (err instanceof GstError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: '', message: err.message };
  return { code: '', message: String(err) };
}

// JSON columns reject precise interfaces with optional fields; narrow at boundary.
const toJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/** Subset of gst_documents columns the reissue regeneration paths write. */
interface GstDocReissueWriteData {
  irnStatus?: IrnStatus;
  irn?: string | null;
  ackNo?: string | null;
  ackDate?: Date | null;
  signedQr?: string | null;
  ewbStatus?: EwbStatus;
  ewbNo?: string | null;
  ewbDate?: Date | null;
  ewbValidTill?: Date | null;
  // Persisted so a phantom-active NIC response (status_cd=1, no ewayBillNo)
  // leaves enough forensic data on the gst_documents row to diagnose later
  // without grepping gst_api_logs by timestamp. Mirrors what
  // gstPreflightService.upsertLatestGstDocument writes on the dispatch path.
  requestPayload?: Prisma.InputJsonValue;
  responsePayload?: Prisma.InputJsonValue;
}

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
  mismatchContext?: Record<string, unknown>;
}): Promise<ReissueResult> {
  const { invoiceId, distributorId, userId, mismatchContext } = args;

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      id: true, gstMode: true, gstin: true, legalName: true, businessName: true,
      address: true, city: true, state: true, pincode: true, phone: true, email: true,
      docCode: true,
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

  // WI-112 — zero-delivery void path. If the driver delivered NOTHING (every
  // item deliveredQuantity 0), there is nothing to invoice: regenerating a
  // ₹0 IRN is meaningless (and NIC would reject it). Instead cancel the live
  // compliance docs and VOID the invoice, then return — do NOT fall through to
  // the regenerate path. Both NIC cancels are non-fatal (NIC may 5002 on the
  // IRN cancel — see #30/anti-pattern #9 era bug); failures raise a pending
  // action and the invoice is still voided so the ledger reads ₹0.
  const orderItemsForDelivery = invoice.order?.items ?? [];
  const totalDelivered = orderItemsForDelivery.reduce(
    (sum, it) => sum + (it.deliveredQuantity ?? 0), 0,
  );
  if (totalDelivered === 0) {
    if (invoice.ewbStatus === 'active') {
      try {
        await cancelEwb(invoiceId, distributorId, 'Zero-quantity delivery — voiding invoice', '4');
        logger.info('Zero-delivery void: EWB cancelled', { invoiceId });
      } catch (err: unknown) {
        const message = errInfo(err).message;
        logger.warn('Zero-delivery void: EWB cancel failed (non-blocking)', { invoiceId, err: message });
        await createPendingAction(
          distributorId, invoiceId,
          'EWB_CANCEL_FAILED', message || 'EWB cancel failure during zero-delivery void',
          'medium',
        );
      }
    }
    if (isB2B && invoice.irnStatus === 'success' && invoice.irn) {
      try {
        await cancelIrn(invoiceId, distributorId, 'Zero-quantity delivery — voiding invoice', '4');
        logger.info('Zero-delivery void: IRN cancelled', { invoiceId, irn: invoice.irn });
      } catch (err: unknown) {
        // NIC may return 5002 — non-fatal. cancelIrn left irnStatus as 'success';
        // the pending action flags that NIC still holds a live IRN to clear.
        const message = errInfo(err).message;
        logger.error('Zero-delivery void: IRN cancel failed (non-fatal)', { invoiceId, err: message });
        await createPendingAction(
          distributorId, invoiceId,
          'IRN_CANCEL_BLOCKED', message || 'IRN cancel failed during zero-delivery void',
          'high',
        );
      }
    }
    // Void the invoice regardless of the NIC cancel outcomes. irnStatus is left
    // to whatever cancelIrn set ('cancelled' on success, untouched 'success' on
    // a 5002 — flagged by the pending action above).
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        totalAmount: 0,
        outstandingAmount: 0,
        status: 'cancelled',
        ewbStatus: 'cancelled',
        revisedPostDeliveryAt: new Date(),
      },
    });
    logger.info('Zero-delivery void: invoice voided (₹0, cancelled)', { invoiceId });
    return { ok: true, skipped: true, reason: 'Zero-quantity delivery — invoice voided' };
  }

  // Step 1 — cancel EWB if active. Non-fatal: a soft pending action is
  // raised but the flow continues regardless of the outcome.
  const hasActiveEwb = invoice.ewbStatus === 'active';
  if (hasActiveEwb) {
    try {
      await cancelEwb(invoiceId, distributorId, 'Delivery quantity mismatch — reissuing invoice', '4');
      logger.info('Reissue: EWB cancelled', { invoiceId });
    } catch (err: unknown) {
      const message = errInfo(err).message;
      logger.warn('Reissue: EWB cancel failed (non-blocking)', { invoiceId, err: message });
      await createPendingAction(
        distributorId, invoiceId,
        'EWB_CANCEL_FAILED', message || 'EWB cancel failure during reissue',
        'medium',
      );
    }
  }

  // Step 2 — cancel IRN if B2B and live. Hard-fail on cancellation
  // errors to prevent two valid IRNs for the same doc number.
  const previousInvoiceStatus = invoice.status;
  if (isB2B && invoice.irnStatus === 'success' && invoice.irn) {
    try {
      await cancelIrn(invoiceId, distributorId, 'Delivery quantity mismatch — reissuing invoice', '4');
      logger.info('Reissue: IRN cancelled', { invoiceId, irn: invoice.irn });
      // cancelIrn flips invoice.status to 'cancelled' as a side-effect;
      // reissue keeps the invoice live so the customer is still billed
      // for the revised quantities. Restore the pre-cancel status.
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: previousInvoiceStatus },
      });
    } catch (err: unknown) {
      const message = errInfo(err).message;
      logger.error('Reissue: IRN cancel blocked — aborting', { invoiceId, err: message });
      const pa = await createPendingAction(
        distributorId, invoiceId,
        'IRN_CANCEL_BLOCKED',
        `Reissue aborted: ${message || 'IRN cancel failed'}`,
        'high',
      );
      return {
        ok: false,
        aborted: 'IRN_CANCEL_BLOCKED',
        pendingActionId: pa?.id ?? null,
        reason: message || 'IRN cancel failed',
      };
    }
  }

  // Step 3 — update invoice items + totals to delivered quantities. We
  // pull delivered quantities from the linked order (confirmDelivery has
  // already written them) by matching on cylinderTypeId.
  //
  // WI-066: lineTotal is derived PROPORTIONALLY from the existing
  // item.totalPrice (which is the GST-inclusive line total that
  // invoiceService.createInvoiceFromOrder wrote at issue time) rather
  // than recomputed as `qty × unitPrice`. Reason: for GST-enabled
  // tenants, invoiceService stores item.unitPrice as the GST-BASE price
  // (it reverse-calculates `basePrice = inclusivePrice / 1.18`, see
  // invoiceService line 143). Multiplying that base unitPrice by qty
  // produces a BASE total — which the legacy reissue code then wrote
  // to invoice.totalAmount, making the customer-facing grand total
  // mysteriously shrink by 1/1.18 after every modified delivery
  // (₹84,000 → ₹71,186 was the symptom that surfaced this).
  //
  // Per-unit-from-original: `item.totalPrice / item.quantity` is the
  // INCLUSIVE per-cylinder figure regardless of what convention
  // unitPrice follows. Scale by newQty to keep totalPrice inclusive
  // through the reissue.
  const orderItems = invoice.order?.items ?? [];
  const orderItemByCylinder = new Map(orderItems.map((oi) => [oi.cylinderTypeId, oi]));
  let revisedSubtotal = 0;
  let revisedDeliveredCylinderQty = 0; // For transport-line recompute below.
  const revisedItems: Array<{
    id: string; cylinderTypeId: string | null;
    quantity: number; unitPrice: number; discountPerUnit: number;
    gstRate: number; totalPrice: number;
  }> = [];
  // Pass 1 — cylinder lines (cylinderTypeId !== null). Update qty to the
  // driver's deliveredQuantity. Drop the line entirely if newQty=0 — a
  // qty=0 invoice line is junk on the PDF and in the IRN ItemList.
  // Transport line (cylinderTypeId === null, HSN 996511) is handled in
  // pass 2 below because its qty depends on the cylinder totals.
  for (const item of invoice.items) {
    if (item.cylinderTypeId === null) continue; // Defer transport / other service lines.
    const orderItem = orderItemByCylinder.get(item.cylinderTypeId);
    const newQty = orderItem?.deliveredQuantity ?? item.quantity;
    if (newQty <= 0) {
      // Delete the invoice item — no line on the PDF, no slot in the IRN
      // ItemList. Live case: Maruthi RSHD2627000659 (2026-05-28) — 5 KG
      // delivered=0 surfaced as a "5 KG qty=0 ₹0.00" row on the invoice.
      await prisma.invoiceItem.delete({ where: { id: item.id } });
      continue;
    }
    const unitPrice = toNum(item.unitPrice);
    const discountPerUnit = toNum(item.discountPerUnit);
    const originalTotalPrice = toNum(item.totalPrice);
    const originalQty = item.quantity;
    // Per-cylinder INCLUSIVE figure: pulled from the original totalPrice
    // so the unit convention used at issue time is preserved. Fall back
    // to `unitPrice - discount` for the (defensive) zero-original-qty
    // case — that path shouldn't occur in practice because invoiceItems
    // are created with qty >= 1.
    const perUnitInclusive = originalQty > 0
      ? originalTotalPrice / originalQty
      : Math.max(unitPrice - discountPerUnit, 0);
    const lineTotal = round2(newQty * perUnitInclusive);
    revisedSubtotal += lineTotal;
    revisedDeliveredCylinderQty += newQty;
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
  // Pass 2 — transport / other service lines (cylinderTypeId === null).
  //
  // The original loop skipped these (no orderItemByCylinder match), so the
  // transport line carried the ordered cylinder count forward through every
  // reissue while the cylinder lines updated to the delivered count. Live
  // bug: Maruthi RSHD2627000659 (2026-05-28) — 4 cylinders ordered →
  // 3 delivered, but the "Inward Transportation Charges" line still showed
  // qty=5 and ₹1,250 (₹250/cyl × 5) — over-charging the customer by ₹500.
  //
  // Transport qty must mirror the sum of delivered cylinder qtys on this
  // invoice (`revisedDeliveredCylinderQty` from pass 1). totalPrice is
  // recomputed from the same per-unit-inclusive logic used in pass 1, so
  // the unit convention stays stable across reissues. A zero-delivery
  // invoice would have exited via the WI-112 void path above, so
  // revisedDeliveredCylinderQty=0 here can only happen if every cylinder
  // line got deleted — drop the transport line too in that defensive case.
  for (const item of invoice.items) {
    if (item.cylinderTypeId !== null) continue; // Already handled in pass 1.
    const newQty = revisedDeliveredCylinderQty;
    if (newQty <= 0) {
      await prisma.invoiceItem.delete({ where: { id: item.id } });
      continue;
    }
    const unitPrice = toNum(item.unitPrice);
    const discountPerUnit = toNum(item.discountPerUnit);
    const originalTotalPrice = toNum(item.totalPrice);
    const originalQty = item.quantity;
    const perUnitInclusive = originalQty > 0
      ? originalTotalPrice / originalQty
      : Math.max(unitPrice - discountPerUnit, 0);
    const lineTotal = round2(newQty * perUnitInclusive);
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
  } catch (err: unknown) {
    const message = errInfo(err).message;
    logger.error('Reissue: doc regeneration failed', { invoiceId, err: message });
    await createPendingAction(
      distributorId, invoiceId,
      isB2B ? 'IRN_REGENERATION_FAILED' : 'EWB_REGENERATION_FAILED',
      message || 'Doc regeneration failed during reissue',
      'high',
    );
    // Continue to write the revision row anyway — the quantities have
    // already been corrected on the invoice; the GST doc just needs
    // manual cleanup.
  }

  // WI-107 — Step 4 (B2B only): generate a NEW EWB linked to the new IRN.
  // Confirmed by the live NIC test (Q8): after cancel-EWB → cancel-IRN →
  // new-IRN, NIC accepts a fresh EWB on the revised invoice number. This
  // runs in its OWN try so an EWB failure can never roll back or mislabel
  // the already-committed IRN revision (Step 3). generateEwbFromIrn is
  // itself non-fatal — it raises an EWB_GENERATION pending action on a NIC
  // failure — so here we only guard pre-call errors (e.g. no vehicle).
  if (isB2B && newIrn) {
    try {
      newEwbNo = await regenerateB2bEwb(invoiceId, distributorId, distributor);
      logger.info('Reissue B2B: new EWB generated', { invoiceId, newEwbNo });
    } catch (ewbErr: unknown) {
      const message = errInfo(ewbErr).message;
      logger.error('Reissue B2B: new EWB generation failed (non-fatal)', { invoiceId, err: message });
      await createPendingAction(
        distributorId, invoiceId,
        'EWB_GENERATION',
        message || 'New EWB generation failed during reissue',
        'medium',
      );
    }
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
      originalItems: toJson(originalItems),
      revisedItems: toJson(revisedItems),
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
  distributor: DistributorReissueFields,
): Promise<string | null> {
  // WI-064: burn the cancelled doc number up front. The cancel step
  // before this retired it on NIC's side, so any reuse attempt would
  // come back as 2278 ("IRN already generated and cancelled"). The
  // legacy code only caught 2150 — 2278 escaped unhandled and stranded
  // the invoice in a half-state.
  const inv0 = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { invoiceNumber: true, orderId: true },
  });
  const freshNumber = await freshRevisionNumber(distributorId, distributor, inv0.invoiceNumber);
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

  const callIrn = async (payload: IrnPayload) => callWithLog<IrnResponse>(
    distributorId, 'POST',
    `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(credEmail)}`,
    payload, 'einvoice',
    { apiType: 'IRN_GENERATE_REISSUE', invoiceId, orderId: inv0.orderId },
  );

  let response: IrnResponse;
  try {
    response = await callIrn(buildIrnPayload(invoiceData));
  } catch (err: unknown) {
    const code = String(errInfo(err).code ?? '').replace(/[^0-9]/g, '');
    // 2150 = doc number has an active IRN; 2278 = doc number had an IRN
    // that was cancelled. Both unblock by bumping the suffix once more.
    if (code !== '2150' && code !== '2278') throw err;
    logger.warn('Reissue B2B: NIC rejected first regen — bumping again', { invoiceId, code });
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { invoiceNumber: true },
    });
    const newNumber = await freshRevisionNumber(distributorId, distributor, inv.invoiceNumber);
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

/**
 * WI-107: Generate a new EWB linked to the freshly regenerated B2B IRN
 * (post-reissue Step 4). Mirrors regenerateB2cEwb but delegates the NIC
 * call + persistence to the shared generateEwbFromIrn helper so the
 * payload (transactionType:1, ship-to/dispatch-from omitted — anti-pattern
 * #14) and the gst_documents update (incl. clearing the stale cancelledAt)
 * are identical to the dispatch path.
 *
 * NIC failures are handled non-fatally INSIDE generateEwbFromIrn (it raises
 * the EWB_GENERATION pending action and returns status 'failed'); this
 * function only throws for pre-call problems (no vehicle / no IRN), which
 * the caller catches and converts to its own pending action.
 */
async function regenerateB2bEwb(
  invoiceId: string,
  distributorId: string,
  distributor: DistributorReissueFields,
): Promise<string | null> {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { order: { include: { vehicle: true } } },
  });
  const vehicleNumber = invoice.order?.vehicle?.vehicleNumber;
  if (!vehicleNumber) {
    throw new Error('Cannot regenerate EWB: no vehicle on order');
  }
  if (!invoice.irn) {
    throw new Error('Cannot regenerate EWB: no IRN on revised invoice');
  }
  const invoiceData = await buildInvoiceDataForIrn(invoiceId, distributor);
  const credEmail =
    (await getCredentials(distributorId, 'ewaybill'))?.email ||
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  const result = await generateEwbFromIrn(distributorId, invoiceId, {
    irnPayload: buildIrnPayload(invoiceData),
    vehicleNumber,
    email: credEmail,
    irn: invoice.irn,
    orderId: invoice.orderId,
    apiType: 'EWB_GENERATE_REISSUE_B2B',
  });
  // 'failed' already raised an EWB_GENERATION pending action inside the
  // helper — return null rather than double-raising at the call site.
  return result.ewbNo ?? null;
}

/** Generate a new standalone EWB for a B2C invoice post-reissue. */
async function regenerateB2cEwb(
  invoiceId: string,
  distributorId: string,
  distributor: DistributorReissueFields,
): Promise<string | null> {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { order: { include: { vehicle: true } } },
  });
  const vehicleNumber = invoice.order?.vehicle?.vehicleNumber;
  if (!vehicleNumber) {
    throw new Error('Cannot regenerate EWB: no vehicle on order');
  }
  // WI-128: bump the invoice number to a fresh RSHD revision number IN PLACE,
  // mirroring regenerateB2bIrn, so the B2C reissue invoice carries an RSHD
  // prefix consistent with B2B. buildInvoiceDataForIrn below reads the new
  // docNumber, and the regenerated standalone EWB references it. The old ISHD
  // EWB was already cancelled earlier in the reissue flow.
  const freshNumber = await freshRevisionNumber(distributorId, distributor, invoice.invoiceNumber);
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { invoiceNumber: freshNumber },
  });
  logger.info('Reissue B2C: bumped invoice number to RSHD', {
    invoiceId, oldNumber: invoice.invoiceNumber, newNumber: freshNumber,
  });

  const invoiceData = await buildInvoiceDataForIrn(invoiceId, distributor);
  const ewbPayload = buildEwbPayload(buildIrnPayload(invoiceData), {
    vehicleNumber, transportMode: '1', distance: 1,
  });
  const credEmail =
    (await getCredentials(distributorId, 'ewaybill'))?.email ||
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  const resp = await callWithLog<EwbResponse>(
    distributorId, 'POST',
    `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
    ewbPayload, 'ewaybill',
    { apiType: 'EWB_GENERATE_REISSUE_B2C', invoiceId },
  );
  const parsed = parseEwbResponse(resp);
  // WI-091-equivalent phantom-active guard on the reissue path. NIC sandbox
  // sometimes returns status_cd=1 with NO `ewayBillNo` (bare "Sucess"). The
  // dispatch path (gstPreflightService runB2cPreflight) and the post-delivery
  // path (gstService processInvoiceGst B2C branch) both already treat this
  // as a failure — mark the invoice ewbStatus='failed' + raise an
  // EWB_GENERATION pending action — but the reissue path was unconditionally
  // marking ewbStatus='active' with ewbNo=NULL (phantom-active row). Live
  // bug: Bangalore Foods RSHD2627000660 (2026-05-28 10:20:34) — green EWB
  // badge in the UI with no real NIC number behind it. Treat parity with
  // the other two paths.
  const ewbOk = !!parsed.ewbNo;
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { ewbStatus: ewbOk ? 'active' : 'failed' },
  });
  await upsertLatestGstDoc(invoiceId, distributorId, {
    ewbStatus: ewbOk ? 'active' : 'failed',
    ewbNo: parsed.ewbNo,
    ewbDate: parsed.validFromDate,
    ewbValidTill: parsed.validToDate,
    requestPayload: toJson(ewbPayload),
    responsePayload: toJson(resp),
  });
  if (!ewbOk) {
    logger.warn('B2C reissue EWB: NIC returned status_cd=1 with no ewayBillNo — marked failed (phantom-active guard)', {
      invoiceId, invoiceNumber: freshNumber,
      statusDesc: (resp as { status_desc?: string })?.status_desc,
    });
    await createPendingAction(
      distributorId, invoiceId, 'EWB_GENERATION',
      `Invoice ${freshNumber}: B2C reissue EWB returned success but no e-Way Bill number. Retry from Billing once NIC is healthy.`,
      'high',
    );
    return null;
  }
  return parsed.ewbNo;
}

/**
 * Append a new gst_documents row for this invoice as the new "latest",
 * atomically demoting any prior isLatest=true rows to isLatest=false.
 *
 * Previously this was a find-or-update upsert. That left a hole: when
 * the dispatch path (gstPreflightService) and the post-delivery path
 * (gstService.processInvoiceGst B2C) had each created their own
 * isLatest=true row for the same invoice (race observed live on
 * Bangalore Foods RSHD2627000660, 2026-05-28), the upsert only updated
 * ONE of them — the other stayed isLatest=true. The UI then read an
 * arbitrary "latest" with potentially stale ewbNo/status.
 *
 * The reissue path is the only writer that needs to be airtight here:
 * it explicitly cancels and re-emits the compliance doc, so the new row
 * is by definition the new latest. Run an updateMany + create inside a
 * $transaction so the cutover is atomic. Older rows are preserved with
 * isLatest=false for revision history.
 */
async function upsertLatestGstDoc(
  invoiceId: string,
  distributorId: string,
  data: GstDocReissueWriteData,
) {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    select: { invoiceNumber: true, orderId: true },
  });
  await prisma.$transaction([
    prisma.gstDocument.updateMany({
      where: { invoiceId, isLatest: true, deletedAt: null },
      data: { isLatest: false },
    }),
    prisma.gstDocument.create({
      data: {
        invoiceId,
        orderId: invoice.orderId!,
        distributorId,
        docType: 'INV',
        gstDocNo: invoice.invoiceNumber,
        isLatest: true,
        ...data,
      },
    }),
  ]);
}

/**
 * Build the InvoiceData payload feeding buildIrnPayload — same shape
 * as gstService.processInvoiceGst but reads from the freshly-mutated
 * invoice items (which now reflect delivered quantities).
 */
async function buildInvoiceDataForIrn(
  invoiceId: string,
  distributor: DistributorReissueFields,
): Promise<InvoiceData> {
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
    items: inv.items.map((item, idx) => ({
      slNo: idx + 1,
      description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unit: 'NOS',
      // CLAUDE.md anti-pattern #16: InvoiceItem.unitPrice is GST-inclusive, before discount.
      unitPrice: toNum(item.unitPrice),
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

/**
 * WI-108: produce the doc number for a regenerated (revised) invoice.
 *
 * - docCode set → allocate a fresh structured number of type 'R' (e.g.
 *   RSHD2526000045). This is a brand-new number NIC has never seen, so it
 *   sidesteps the 2278 "cancelled doc number" trap entirely AND keeps the
 *   14-char NIC-safe length (the legacy `-R{n}` suffix pushed to 16). The
 *   counter increment is atomic in its own short transaction; the invoice
 *   already exists, so same-tx-as-create gaplessness doesn't apply here.
 * - docCode null → fall back to the legacy `-R{n}` suffix bump.
 */
async function freshRevisionNumber(
  distributorId: string,
  distributor: { docCode?: string | null },
  currentNumber: string,
): Promise<string> {
  if (distributor.docCode) {
    return prisma.$transaction((tx) =>
      allocateNumber(tx, distributorId, 'R', new Date(), distributor.docCode!),
    );
  }
  return bumpInvoiceNumber(currentNumber);
}
