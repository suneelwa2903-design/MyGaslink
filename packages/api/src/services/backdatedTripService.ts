/**
 * backdatedTripService.ts
 *
 * Item 6 (docs/INVESTIGATION-JUL09-B.md) — bulk backdated driver trip.
 * Records N customer deliveries by a single driver + vehicle on a past
 * date within the current calendar month. The trip already physically
 * happened; this is a paper-trail entry.
 *
 * Semantics (per single-order Brief 3 + trip extension):
 *   - Every order → status='delivered', isBackdated=true
 *   - historical timestamps: orderDate = deliveryDate = deliveredAt = issueDate
 *   - createdAt stays `now()` so the audit trail records when it was entered
 *   - Invoice.issueDate = issueDate → NIC IRN DocDtls.Dt gets the right date
 *   - NO inventory events by design (mirrors single backdated order —
 *     stock adjustment is a separate operator step via applyBackdatedInventoryAdjustment)
 *   - Optional payment per order is recorded atomically with that order's invoice
 *
 * DVA: one row per (driverId, assignmentDate=issueDate, tripNumber=1),
 * status='reconciled', isReconciled=true. This skips the state machine
 * intentionally — the trip already happened. If a row already exists for
 * that (driver, date, trip) we reuse it verbatim (don't clobber real
 * state).
 *
 * IRN + EWB fire post-commit per invoice (same fire-and-forget pattern
 * as createBackdatedOrder / confirmDelivery).
 *
 * Orders are created SEQUENTIALLY, each inside its own transaction.
 * Reasons: (a) IRN idempotency guard is per-invoice; (b) numberingService
 * uses `SELECT ... FOR UPDATE` so a mega-tx wrapping 20 allocations
 * serialises the numbering row for the whole trip — cheaper to keep it
 * per-order; (c) failure of one order doesn't roll back the others (the
 * caller sees a partial success with the failing customer IDs).
 */
import { prisma } from '../lib/prisma.js';
import { localTodayISO, type BackdatedTripInput } from '@gaslink/shared';
import { computeOrderTotal } from './orderService.js';
import { getEffectivePrice } from './cylinderTypeService.js';
import { createInvoiceFromOrder } from './invoiceService.js';
import { createPaymentInTx } from './paymentService.js';
import { allocateNumber } from './numberingService.js';
import { toNum } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

export class BackdatedTripError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'BackdatedTripError';
  }
}

function legacyOrderNumber(prefix: string): string {
  return `${prefix}-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;
}

interface CreatedOrderRow {
  customerId: string;
  orderId: string;
  orderNumber: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  paymentRecorded: boolean;
}

export async function createBackdatedTrip(
  distributorId: string,
  userId: string,
  data: BackdatedTripInput,
): Promise<{
  dvaId: string;
  ordersCreated: number;
  invoicesCreated: number;
  orders: CreatedOrderRow[];
}> {
  // Defence in depth — same-month + before-today guard at the service
  // layer in case any future caller bypasses the Zod edge (anti-pattern
  // #21 — use localTodayISO(), never toISOString().split('T')[0]).
  const todayStr = localTodayISO();
  const now = new Date();
  const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!data.issueDate.startsWith(currentYM)) {
    throw new BackdatedTripError('Trip date must be within the current calendar month', 400);
  }
  if (data.issueDate >= todayStr) {
    throw new BackdatedTripError('Trip date must be before today', 400);
  }

  // Tenant-scope driver + vehicle.
  const driver = await prisma.driver.findFirst({
    where: { id: data.driverId, distributorId, deletedAt: null },
    select: { id: true, driverName: true },
  });
  if (!driver) throw new BackdatedTripError('Driver not found', 404);

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: data.vehicleId, distributorId, deletedAt: null },
    select: { id: true, vehicleNumber: true },
  });
  if (!vehicle) throw new BackdatedTripError('Vehicle not found', 404);

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { docCode: true },
  });

  const issueDate = new Date(data.issueDate);

  // 1) DVA upsert. Natural key on (driverId, assignmentDate, tripNumber) —
  //    we always target tripNumber=1 for backdated trips. If one exists,
  //    use it as-is; don't clobber real state.
  let dva = await prisma.driverVehicleAssignment.findFirst({
    where: {
      distributorId,
      driverId: data.driverId,
      assignmentDate: issueDate,
      tripNumber: 1,
    },
    select: { id: true },
  });
  if (!dva) {
    dva = await prisma.driverVehicleAssignment.create({
      data: {
        distributorId,
        driverId: data.driverId,
        vehicleId: data.vehicleId,
        assignmentDate: issueDate,
        tripNumber: 1,
        status: 'reconciled',
        isReconciled: true,
        dispatchedAt: issueDate,
        returnedAt: issueDate,
        reconciledAt: new Date(),
      },
      select: { id: true },
    });
  }

  // 2) Per-order sequential creation. Each order gets its own tx.
  const createdOrders: CreatedOrderRow[] = [];
  for (const orderInput of data.orders) {
    const customer = await prisma.customer.findFirst({
      where: { id: orderInput.customerId, distributorId, deletedAt: null },
      select: {
        id: true, customerName: true, customerType: true, gstin: true,
        stopSupply: true, transportChargePerCylinder: true,
      },
    });
    if (!customer) {
      throw new BackdatedTripError(
        `Customer ${orderInput.customerId} not found`, 404,
      );
    }
    if (customer.stopSupply) {
      throw new BackdatedTripError(
        `Customer ${customer.customerName} is on stop-supply`, 400,
      );
    }

    const itemsWithPrices = await Promise.all(orderInput.items.map(async (item) => {
      const unitPrice = await getEffectivePrice(distributorId, item.cylinderTypeId, issueDate);
      const discount = await prisma.customerCylinderDiscount.findUnique({
        where: {
          customerId_cylinderTypeId: {
            customerId: orderInput.customerId,
            cylinderTypeId: item.cylinderTypeId,
          },
        },
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
        emptiesCollected: item.emptiesCollected ?? 0,
      };
    }));
    const totalAmount = computeOrderTotal(
      itemsWithPrices, toNum(customer.transportChargePerCylinder),
    );

    const perOrder = await prisma.$transaction(async (tx) => {
      const orderNumber = distributor?.docCode
        ? await allocateNumber(tx, distributorId, 'O', issueDate, distributor.docCode)
        : legacyOrderNumber('ORD');
      const order = await tx.order.create({
        data: {
          distributorId,
          customerId: orderInput.customerId,
          status: 'delivered',
          orderType: 'delivery',
          orderSource: 'regular',
          isBackdated: true,
          isGodownPickup: false,
          poNumber: orderInput.poNumber ?? null,
          driverId: data.driverId,
          vehicleId: data.vehicleId,
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
              totalPrice: it.totalPrice,
              deliveredQuantity: it.quantity,
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
          notes: `Backdated trip order created for ${data.issueDate} by user ${userId}`,
        },
      });

      const invoice = await createInvoiceFromOrder(tx, order.id, distributorId, userId, {
        issueDateOverride: issueDate,
      });

      let paymentRecorded = false;
      if (orderInput.payment && invoice) {
        await createPaymentInTx(tx, distributorId, userId, {
          customerId: orderInput.customerId,
          amount: orderInput.payment.amount,
          paymentMethod: orderInput.payment.paymentMethod,
          referenceNumber: orderInput.payment.referenceNumber,
          transactionDate: data.issueDate,
          allocations: [{ invoiceId: invoice.id, amount: orderInput.payment.amount }],
        });
        paymentRecorded = true;
      }

      return { order, invoice, paymentRecorded };
    });

    createdOrders.push({
      customerId: orderInput.customerId,
      orderId: perOrder.order.id,
      orderNumber: perOrder.order.orderNumber,
      invoiceId: perOrder.invoice?.id ?? null,
      invoiceNumber: perOrder.invoice?.invoiceNumber ?? null,
      paymentRecorded: perOrder.paymentRecorded,
    });

    // Fire-and-forget GST — same non-blocking shape as createBackdatedOrder.
    if (perOrder.invoice) {
      try {
        const { processInvoiceGst } = await import('./gst/gstService.js');
        processInvoiceGst(perOrder.invoice.id, distributorId).catch((err) => {
          logger.warn('Backdated trip GST processing failed (non-blocking)', {
            orderId: perOrder.order.id,
            invoiceId: perOrder.invoice?.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch { /* non-blocking */ }
    }
  }

  return {
    dvaId: dva.id,
    ordersCreated: createdOrders.length,
    invoicesCreated: createdOrders.filter((o) => o.invoiceId != null).length,
    orders: createdOrders,
  };
}
