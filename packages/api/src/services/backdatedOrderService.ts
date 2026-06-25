import { prisma } from '../lib/prisma.js';
import { localTodayISO, type BackdatedOrderInput } from '@gaslink/shared';
import { computeOrderTotal } from './orderService.js';
import { getEffectivePrice } from './cylinderTypeService.js';
import { createInvoiceFromOrder } from './invoiceService.js';
import { createPaymentInTx } from './paymentService.js';
import { toNum } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

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
  // Defence in depth: re-validate the same-month + before-today guard at
  // the service layer in case any future caller bypasses the Zod edge.
  const todayStr = localTodayISO();
  const now = new Date();
  const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!data.issueDate.startsWith(currentYM)) {
    throw new BackdatedOrderError('Backdated date must be within the current calendar month', 400);
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
    },
  });
  if (!customer) throw new BackdatedOrderError('Customer not found', 404);
  if (customer.stopSupply) {
    throw new BackdatedOrderError('Customer is on stop-supply', 400);
  }

  // Per-item price resolution mirrors orderService.createOrder.
  const issueDate = new Date(data.issueDate);
  const itemsWithPrices = await Promise.all(data.items.map(async (item) => {
    const unitPrice = await getEffectivePrice(distributorId, item.cylinderTypeId, issueDate);
    const discount = await prisma.customerCylinderDiscount.findUnique({
      where: { customerId_cylinderTypeId: { customerId: data.customerId, cylinderTypeId: item.cylinderTypeId } },
    });
    const discountPerUnit = toNum(discount?.discountPerUnit);
    const effectivePrice = Math.max(unitPrice - discountPerUnit, 0);
    const totalPrice = effectivePrice * item.quantity;
    return {
      cylinderTypeId: item.cylinderTypeId,
      quantity: item.quantity,
      unitPrice,
      discountPerUnit,
      totalPrice,
    };
  }));
  const totalAmount = computeOrderTotal(itemsWithPrices, toNum(customer.transportChargePerCylinder));

  // Atomic create: Order + status log + Invoice + (optional) Payment.
  const result = await prisma.$transaction(async (tx) => {
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
        // Historical timestamps — orderDate/deliveryDate/deliveredAt all
        // land on the entered issueDate. createdAt stays `now()` so the
        // audit trail records when the row was actually entered.
        orderDate: issueDate,
        deliveryDate: issueDate,
        deliveredAt: issueDate,
        specialInstructions: data.specialInstructions ?? null,
        totalAmount,
        orderNumber: `OBK-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase(),
        items: {
          create: itemsWithPrices.map((it) => ({
            cylinderTypeId: it.cylinderTypeId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountPerUnit: it.discountPerUnit,
            totalPrice: it.totalPrice,
            // Brief 3: backdated orders go straight to delivered — the
            // entered quantity IS the delivered quantity. No partial
            // pickup workflow for historical entries.
            deliveredQuantity: it.quantity,
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
