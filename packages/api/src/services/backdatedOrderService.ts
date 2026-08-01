import { prisma } from '../lib/prisma.js';
import {
  localTodayISO, isBackdatedIssueDateAllowed, backdatedRejectMessage,
  type BackdatedOrderInput,
} from '@gaslink/shared';
import { computeOrderTotal } from './orderService.js';
import { getEffectivePrice } from './cylinderTypeService.js';
import { createInvoiceFromOrder } from './invoiceService.js';
import { createPaymentInTx } from './paymentService.js';
import { allocateNumber } from './numberingService.js';
import { toNum } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

// Fallback when distributor has no docCode set (matches the createOrder
// behaviour at orderService.ts — random alphanumeric prefixed with ORD).
function legacyOrderNumber(prefix: string): string {
  return `${prefix}-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;
}

export class BackdatedOrderError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'BackdatedOrderError';
  }
}

/**
 * Brief 3 — backdated / on-demand order + invoice.
 *
 * Atomically creates Order (status='delivered') + Invoice for a delivery
 * that already happened (paper trail). Optional payment is recorded in
 * the same transaction. IRN fires post-commit for B2B (existing
 * processInvoiceGst path); EWB fires inside processInvoiceGst when the
 * order has a vehicle (B2B or B2C — vehicle drives EWB, not customerType).
 *
 * NO inventory events. NO CustomerInventoryBalance update. By design.
 *
 * Same-month + before-today guard runs at the schema edge (Zod) AND here
 * (defence in depth) using {@link localTodayISO} from shared constants —
 * never `new Date().toISOString().split('T')[0]` (anti-pattern #21).
 */
export async function createBackdatedOrder(
  distributorId: string,
  userId: string,
  data: BackdatedOrderInput,
) {
  // Defence in depth: re-validate the same guard at the service layer in
  // case any future caller bypasses the Zod edge.
  // 2026-08-01 — window widened: previous calendar month is admitted
  // during the first PREV_MONTH_GRACE_DAYS (10) days of the current
  // month (matches GSTR-1 monthly filing convention). Delegates to
  // isBackdatedIssueDateAllowed so schema + service share ONE source.
  const todayStr = localTodayISO();
  if (!isBackdatedIssueDateAllowed(data.issueDate)) {
    throw new BackdatedOrderError(backdatedRejectMessage(), 400);
  }
  if (data.issueDate >= todayStr) {
    throw new BackdatedOrderError('Backdated date must be before today', 400);
  }
  if (data.vehicleId && !data.driverId) {
    throw new BackdatedOrderError('Driver is required when vehicle is provided', 400);
  }

  // Tenant-scoped customer load.
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: {
      id: true, customerName: true, customerType: true, gstin: true,
      stopSupply: true, transportChargePerCylinder: true,
      // 2026-07-29 — needed for the mini-op unitPriceOverride gate below.
      // Precedence: override wins when both (a) distributor is mini_operator
      // AND (b) customer.orderLevelPricingEnabled === true.
      orderLevelPricingEnabled: true,
    },
  });
  if (!customer) throw new BackdatedOrderError('Customer not found', 404);
  if (customer.stopSupply) {
    throw new BackdatedOrderError('Customer is on stop-supply', 400);
  }

  // Pre-load distributor docCode for the order-number allocator inside
  // the transaction below. Same pattern as orderService.createOrder.
  // 2026-07-29 — accountType joins here so the mini-op pricing gate can
  // fire on the same read.
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { docCode: true, accountType: true },
  });
  const isMiniOperator = distributor?.accountType === 'mini_operator';
  const orderLevelPricingAllowed =
    isMiniOperator && customer.orderLevelPricingEnabled === true;

  // Per-item price resolution mirrors orderService.createOrder.
  // 2026-07-29 — unitPriceOverride precedence:
  //   effectivePrice = unitPriceOverride ?? (unitPrice − discountPerUnit)
  // The catalog snapshot (unitPrice) and operator override
  // (unitPriceOverride) both persist to OrderItem so the audit stays
  // reconstructable through re-issue.
  const issueDate = new Date(data.issueDate);
  const itemsWithPrices = await Promise.all(data.items.map(async (item) => {
    const unitPrice = await getEffectivePrice(distributorId, item.cylinderTypeId, issueDate);
    const discount = await prisma.customerCylinderDiscount.findUnique({
      where: { customerId_cylinderTypeId: { customerId: data.customerId, cylinderTypeId: item.cylinderTypeId } },
    });
    const discountPerUnit = toNum(discount?.discountPerUnit);
    const override =
      orderLevelPricingAllowed
      && item.unitPriceOverride != null
      && item.unitPriceOverride >= 0
        ? item.unitPriceOverride
        : null;
    const effectivePrice = override != null
      ? override
      : Math.max(unitPrice - discountPerUnit, 0);
    const totalPrice = effectivePrice * item.quantity;
    return {
      cylinderTypeId: item.cylinderTypeId,
      quantity: item.quantity,
      unitPrice,
      discountPerUnit,
      unitPriceOverride: override,
      totalPrice,
      // Empties handed back at the historical delivery — feeds the
      // reconciliation_empties_return event written by
      // applyBackdatedInventoryAdjustment. Defaults to 0 via Zod.
      emptiesCollected: item.emptiesCollected ?? 0,
    };
  }));
  const totalAmount = computeOrderTotal(itemsWithPrices, toNum(customer.transportChargePerCylinder));

  // Atomic create: Order + status log + Invoice + (optional) Payment.
  const result = await prisma.$transaction(async (tx) => {
    // Structured order number — same allocator the rest of the system
    // uses (numberingService keys by `(distributor, type='O', FY)`,
    // derives FY from the supplied date so a backdated order in June
    // lands in FY 2627 regardless of when it was entered). Allocated
    // on `tx` so a rollback frees the sequence — see numberingService
    // doc-block (gapless invariant).
    const orderNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'O', issueDate, distributor.docCode)
      : legacyOrderNumber('ORD');
    const order = await tx.order.create({
      data: {
        distributorId,
        customerId: data.customerId,
        status: 'delivered',
        orderType: 'delivery',
        orderSource: 'regular',
        isBackdated: true,
        isGodownPickup: false,
        poNumber: data.poNumber ?? null,
        driverId: data.driverId ?? null,
        vehicleId: data.vehicleId ?? null,
        // 2026-07-29 Mini-op tenants use a free-text driver name instead
        // of the Driver FK — matches the regular createOrder path so the
        // customer-facing order/invoice display is consistent between
        // today's orders and backdated historical entries.
        driverNameFreeText: data.driverNameFreeText?.trim() || null,
        // Historical timestamps — orderDate/deliveryDate/deliveredAt all
        // land on the entered issueDate. createdAt stays `now()` so the
        // audit trail records when the row was actually entered.
        orderDate: issueDate,
        deliveryDate: issueDate,
        deliveredAt: issueDate,
        specialInstructions: data.specialInstructions ?? null,
        totalAmount,
        orderNumber,
        items: {
          create: itemsWithPrices.map((it) => ({
            cylinderTypeId: it.cylinderTypeId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountPerUnit: it.discountPerUnit,
            // 2026-07-29 — persist the per-line override alongside the
            // catalog snapshot. Matches OrderItem shape written by
            // orderService.createOrder so the confirmDelivery /
            // invoice / PDF / IRN readers all see it consistently.
            unitPriceOverride: it.unitPriceOverride,
            totalPrice: it.totalPrice,
            // Brief 3: backdated orders go straight to delivered — the
            // entered quantity IS the delivered quantity. No partial
            // pickup workflow for historical entries.
            deliveredQuantity: it.quantity,
            // Empties picked up at the historical delivery (0 by default).
            // applyBackdatedInventoryAdjustment guards on > 0 before
            // writing the reconciliation_empties_return event.
            emptiesCollected: it.emptiesCollected,
          })),
        },
      },
    });

    await tx.orderStatusLog.create({
      data: {
        orderId: order.id,
        oldStatus: 'new',
        newStatus: 'delivered',
        changedBy: userId,
        notes: `Backdated order created for ${data.issueDate} by user ${userId}`,
      },
    });

    const invoice = await createInvoiceFromOrder(tx, order.id, distributorId, userId, {
      issueDateOverride: issueDate,
    });

    if (data.payment && invoice) {
      await createPaymentInTx(tx, distributorId, userId, {
        customerId: data.customerId,
        amount: data.payment.amount,
        paymentMethod: data.payment.paymentMethod,
        referenceNumber: data.payment.referenceNumber,
        transactionDate: data.payment.transactionDate ?? data.issueDate,
        allocations: [{ invoiceId: invoice.id, amount: data.payment.amount }],
      });
    }

    return { order, invoice };
  });

  // Fire-and-forget IRN+EWB. Matches confirmDelivery's non-blocking
  // pattern (orderService.ts:1203-1207). gstService gates IRN by
  // customerType (B2B fires, B2C URP skips) and EWB by presence of a
  // vehicle on the order — no extra wiring needed here.
  if (result.invoice) {
    try {
      const { processInvoiceGst } = await import('./gst/gstService.js');
      processInvoiceGst(result.invoice.id, distributorId).catch((err) => {
        logger.warn('Backdated GST processing failed (non-blocking)', {
          orderId: result.order.id, invoiceId: result.invoice?.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch { /* non-blocking */ }
  }

  return result;
}
