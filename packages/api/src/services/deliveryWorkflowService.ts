/**
 * Delivery Workflow Service
 *
 * Real-world flow:
 * 1. Driver delivers → enters delivered qty + collected empties
 * 2. Customer gets notification → confirms or disputes the quantities
 * 3. If customer confirms → delivery finalized, invoice generated
 * 4. If customer disputes → pending resolution
 * 5. Driver marks vehicle returned to depot
 * 6. Inventory team verifies physical stock matches system stock
 * 7. On verification → cancelled/undelivered stock added to depot, GST invoices cancelled for non-delivered
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';
import { toNum } from '../utils/decimal.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import { computeOrderTotal } from './orderService.js';

// ─── Customer Delivery Confirmation ─────────────────────────────────────────

/**
 * Get pending delivery confirmations for a customer
 */
export async function getCustomerPendingConfirmations(customerId: string) {
  return prisma.order.findMany({
    where: {
      customerId,
      status: { in: ['delivered', 'modified_delivered'] },
      customerConfirmed: null, // Not yet confirmed
      deletedAt: null,
    },
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      driver: { select: { driverName: true } },
    },
    orderBy: { deliveredAt: 'desc' },
  });
}

/**
 * Customer confirms delivery quantities
 * If quantities match → finalize
 * If quantities don't match → create dispute, trigger modified invoice
 */
export async function customerConfirmDelivery(
  orderId: string,
  customerId: string,
  data: {
    confirmed: boolean;
    items?: { cylinderTypeId: string; confirmedDelivered: number; confirmedEmpties: number }[];
    disputeReason?: string;
  }
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId, deletedAt: null },
    include: {
      items: true,
      invoice: { select: { id: true, status: true, irnStatus: true } },
      customer: { select: { transportChargePerCylinder: true } },
    },
  });
  if (!order) throw new Error('Order not found');
  if (!['delivered', 'modified_delivered'].includes(order.status)) {
    throw new Error('Order is not in a deliverable state for confirmation');
  }

  if (data.confirmed) {
    // Customer agrees with driver's reported quantities
    await prisma.order.update({
      where: { id: orderId },
      data: { customerConfirmed: true, customerConfirmedAt: new Date() },
    });

    await prisma.orderStatusLog.create({
      data: {
        orderId,
        oldStatus: order.status,
        newStatus: order.status,
        changedBy: customerId,
        notes: 'Customer confirmed delivery quantities',
      },
    });

    return { status: 'confirmed' as const, message: 'Delivery confirmed by customer' };
  } else {
    // Customer disputes - check if quantities differ
    if (!data.items || data.items.length === 0) {
      throw new Error('Disputed confirmation must include corrected item quantities');
    }

    const hasChanges = data.items.some(ci => {
      const oi = order.items.find(i => i.cylinderTypeId === ci.cylinderTypeId);
      return oi && (ci.confirmedDelivered !== (oi.deliveredQuantity ?? oi.quantity) || ci.confirmedEmpties !== (oi.emptiesCollected ?? 0));
    });

    if (!hasChanges) {
      // Quantities actually match - just confirm
      await prisma.order.update({
        where: { id: orderId },
        data: { customerConfirmed: true, customerConfirmedAt: new Date() },
      });
      return { status: 'confirmed' as const, message: 'Quantities match - delivery confirmed' };
    }

    // Quantities differ - update items, recalculate, and regenerate invoice
    return prisma.$transaction(async (tx) => {
      // Update order items with customer-confirmed quantities, then recompute
      // totalAmount including the transport fee (cylinderSubtotal + rate × qty)
      // so the order stays apples-to-apples with the regenerated invoice.
      const deliveredLines: Array<{ quantity: number; totalPrice: number }> = [];
      for (const ci of data.items!) {
        const orderItem = order.items.find(i => i.cylinderTypeId === ci.cylinderTypeId);
        if (orderItem) {
          await tx.orderItem.update({
            where: { id: orderItem.id },
            data: {
              deliveredQuantity: ci.confirmedDelivered,
              emptiesCollected: ci.confirmedEmpties,
            },
          });
          const effectivePrice = Math.max(toNum(orderItem.unitPrice) - toNum(orderItem.discountPerUnit), 0);
          deliveredLines.push({
            quantity: ci.confirmedDelivered,
            totalPrice: effectivePrice * ci.confirmedDelivered,
          });
        }
      }
      const newTotal = computeOrderTotal(deliveredLines, toNum(order.customer?.transportChargePerCylinder));

      // Update order total
      const isModified = data.items!.some(ci => {
        const oi = order.items.find(i => i.cylinderTypeId === ci.cylinderTypeId);
        return oi && ci.confirmedDelivered !== oi.quantity;
      });

      const newStatus = isModified ? 'modified_delivered' as const : 'delivered' as const;

      await tx.order.update({
        where: { id: orderId },
        data: {
          totalAmount: newTotal,
          status: newStatus,
          customerConfirmed: true,
          customerConfirmedAt: new Date(),
          customerDisputeReason: data.disputeReason || null,
        },
      });

      await tx.orderStatusLog.create({
        data: {
          orderId,
          oldStatus: order.status,
          newStatus,
          changedBy: customerId,
          notes: `Customer disputed quantities. Reason: ${data.disputeReason || 'Quantity mismatch'}`,
        },
      });

      // Update inventory events for the corrected quantities
      const { createInventoryEvent } = await import('./inventoryService.js');

      // Delete old delivery/collection events for this order and recreate
      await tx.inventoryEvent.deleteMany({
        where: { referenceId: orderId, referenceType: 'order', eventType: { in: ['delivery', 'collection'] } },
      });

      for (const ci of data.items!) {
        if (ci.confirmedDelivered > 0) {
          await createInventoryEvent(tx, {
            distributorId: order.distributorId,
            cylinderTypeId: ci.cylinderTypeId,
            eventType: 'delivery',
            fullsChange: -ci.confirmedDelivered,
            emptiesChange: 0,
            eventDate: order.deliveryDate,
            referenceId: orderId,
            referenceType: 'order',
            createdBy: customerId,
            notes: `Customer-confirmed delivery for ${order.orderNumber}`,
          });
        }
        if (ci.confirmedEmpties > 0) {
          await createInventoryEvent(tx, {
            distributorId: order.distributorId,
            cylinderTypeId: ci.cylinderTypeId,
            eventType: 'collection',
            fullsChange: 0,
            emptiesChange: ci.confirmedEmpties,
            eventDate: order.deliveryDate,
            referenceId: orderId,
            referenceType: 'order',
            createdBy: customerId,
            notes: `Customer-confirmed empties for ${order.orderNumber}`,
          });
        }

        // Update customer balance
        const originalDelivered = order.items.find(i => i.cylinderTypeId === ci.cylinderTypeId)?.deliveredQuantity ?? 0;
        const originalEmpties = order.items.find(i => i.cylinderTypeId === ci.cylinderTypeId)?.emptiesCollected ?? 0;
        const deliveredDiff = ci.confirmedDelivered - originalDelivered;
        const emptiesDiff = ci.confirmedEmpties - originalEmpties;
        const balanceChange = deliveredDiff - emptiesDiff;

        if (balanceChange !== 0) {
          await tx.customerInventoryBalance.upsert({
            where: { customerId_cylinderTypeId: { customerId, cylinderTypeId: ci.cylinderTypeId } },
            create: { customerId, cylinderTypeId: ci.cylinderTypeId, withCustomerQty: balanceChange },
            update: { withCustomerQty: { increment: balanceChange } },
          });
        }
      }

      return {
        status: 'disputed_and_corrected' as const,
        message: 'Quantities updated based on customer confirmation',
        newTotal,
        requiresInvoiceRegeneration: true,
        invoiceId: order.invoice?.id,
      };
    });
  }
}

// ─── Vehicle Return to Depot ────────────────────────────────────────────────

/**
 * Driver marks vehicle as returned to depot
 * Returns summary of what's on the vehicle (cancelled/undelivered stock)
 */
export async function markVehicleReturned(
  vehicleId: string,
  driverId: string,
  distributorId: string
) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, distributorId },
  });
  if (!vehicle) throw new Error('Vehicle not found');

  // WI-100 Gap C: block re-running on a trip already returned + reconciled.
  // After reconciliation the vehicle is back to 'idle' and its DVA is
  // isReconciled — without this the driver app could re-trigger the return
  // endlessly (the Mark-Vehicle-Returned loop). 409 via the route's message map.
  const guardDva = await prisma.driverVehicleAssignment.findFirst({
    where: { vehicleId, distributorId, assignmentDate: startOfUtcDay(), status: { not: 'cancelled' } },
    orderBy: { tripNumber: 'desc' },
    select: { isReconciled: true },
  });
  if (vehicle.status === 'idle' || guardDva?.isReconciled) {
    throw new Error('Vehicle has already been reconciled for this trip.');
  }

  // Get all pending cancelled stock on this vehicle
  const cancelledStock = await prisma.cancelledStockEvent.findMany({
    where: {
      vehicleId,
      distributorId,
      status: { in: ['on_vehicle', 'pending_return'] },
    },
    include: {
      cylinderType: { select: { typeName: true, capacity: true } },
      order: { select: { orderNumber: true } },
    },
  });

  // Get all orders for today that are still pending on this vehicle
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const undeliveredOrders = await prisma.order.findMany({
    where: {
      vehicleId,
      distributorId,
      deliveryDate: { gte: today },
      status: { in: ['pending_delivery', 'pending_dispatch'] },
      deletedAt: null,
    },
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      customer: { select: { customerName: true } },
    },
  });

  // WI-087 BUG FIX: Block return if any orders are actively out for delivery.
  // pending_delivery = IRN/EWB committed at NIC — the order is with the
  // driver and cannot be silently abandoned. The admin must cancel those
  // orders (which cancels the GST docs) BEFORE marking the vehicle returned.
  // pending_dispatch orders are not yet dispatched so they CAN be reconciled
  // at the inventory step, but pending_delivery ones cannot.
  const pendingDeliveryOrders = undeliveredOrders.filter(
    (o) => o.status === 'pending_delivery',
  );
  if (pendingDeliveryOrders.length > 0) {
    const orderNumbers = pendingDeliveryOrders.map((o) => o.orderNumber).join(', ');
    throw new Error(
      `Cannot mark vehicle as returned — ${pendingDeliveryOrders.length} order(s) are still out for delivery: ${orderNumbers}. Cancel or confirm these orders before returning the vehicle.`,
    );
  }

  // Update vehicle status
  await prisma.vehicle.update({
    where: { id: vehicleId },
    data: { status: 'returned' },
  });

  // WI-094: stamp returnedAt on this vehicle's active DVA for today, so the
  // driver app's trip timeline can show when the vehicle came back. Scoped
  // to the latest non-cancelled assignment on this vehicle today.
  const returnDva = await prisma.driverVehicleAssignment.findFirst({
    where: { vehicleId, distributorId, assignmentDate: startOfUtcDay(), status: { not: 'cancelled' } },
    orderBy: { tripNumber: 'desc' },
    select: { id: true },
  });
  if (returnDva) {
    await prisma.driverVehicleAssignment.update({
      where: { id: returnDva.id },
      data: { returnedAt: new Date() },
    });
  }

  // Build stock summary for inventory team verification
  const stockSummary: Record<string, { typeName: string; cancelledQty: number; undeliveredQty: number; totalOnVehicle: number }> = {};

  for (const cs of cancelledStock) {
    const key = cs.cylinderTypeId;
    if (!stockSummary[key]) {
      stockSummary[key] = { typeName: cs.cylinderType?.typeName || 'Unknown', cancelledQty: 0, undeliveredQty: 0, totalOnVehicle: 0 };
    }
    stockSummary[key].cancelledQty += cs.quantity;
    stockSummary[key].totalOnVehicle += cs.quantity;
  }

  for (const order of undeliveredOrders) {
    for (const item of order.items) {
      const key = item.cylinderTypeId;
      if (!stockSummary[key]) {
        stockSummary[key] = { typeName: item.cylinderType?.typeName || 'Unknown', cancelledQty: 0, undeliveredQty: 0, totalOnVehicle: 0 };
      }
      stockSummary[key].undeliveredQty += item.quantity;
      stockSummary[key].totalOnVehicle += item.quantity;
    }
  }

  logger.info('Vehicle returned to depot', {
    vehicleId, driverId, distributorId,
    cancelledStockCount: cancelledStock.length,
    undeliveredOrderCount: undeliveredOrders.length,
    stockSummary,
  });

  return {
    vehicleId,
    vehicleNumber: vehicle.vehicleNumber,
    driverName: driverId,
    returnedAt: new Date(),
    cancelledStock: cancelledStock.map(cs => ({
      id: cs.id,
      orderNumber: cs.order?.orderNumber,
      cylinderType: cs.cylinderType?.typeName,
      quantity: cs.quantity,
    })),
    undeliveredOrders: undeliveredOrders.map(o => ({
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customer?.customerName,
      items: o.items.map(i => ({ cylinderType: i.cylinderType?.typeName, quantity: i.quantity })),
    })),
    stockSummary: Object.entries(stockSummary).map(([cylinderTypeId, summaryData]) => ({
      cylinderTypeId,
      ...summaryData,
    })),
    requiresInventoryVerification: Object.keys(stockSummary).length > 0,
  };
}

// ─── Inventory Team Reconciliation ──────────────────────────────────────────

/**
 * Inventory team confirms physical stock matches system stock for a returned vehicle.
 * This triggers:
 * 1. Cancelled stock → returned to depot inventory
 * 2. Undelivered orders → cancelled with stock returned
 * 3. GST invoices for non-delivered orders → cancelled
 */
export async function confirmVehicleReconciliation(
  vehicleId: string,
  distributorId: string,
  userId: string,
  data: {
    physicalStockConfirmed: boolean; // true = physical matches system
    notes?: string;
    // WI: supervisor's physically-verified per-type empties count at trip end.
    // Optional — entries with quantity <= 0 are ignored.
    emptiesReturned?: Array<{ cylinderTypeId: string; quantity: number }>;
  }
) {
  if (!data.physicalStockConfirmed) {
    // If physical stock doesn't match, create a pending action for investigation
    await prisma.pendingAction.create({
      data: {
        distributorId,
        module: 'inventory',
        actionType: 'STOCK_MISMATCH',
        entityId: vehicleId,
        entityType: 'vehicle',
        description: `Physical stock mismatch on vehicle ${vehicleId}. ${data.notes || ''}`,
        severity: 'critical',
        status: 'open',
      },
    });
    return { status: 'mismatch_reported' as const, message: 'Stock mismatch reported - pending investigation' };
  }

  // Physical stock confirmed - process reconciliation
  // Pre-check: collect pending orders so the response can warn the caller
  const pendingOrdersPrecheck = await prisma.order.findMany({
    where: {
      vehicleId,
      distributorId,
      status: { in: ['pending_delivery', 'pending_dispatch'] },
      deletedAt: null,
    },
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      customer: { select: { customerName: true } },
    },
  });

  const ordersToBeForceCanelled = pendingOrdersPrecheck.map((o) => ({
    orderNumber: o.orderNumber,
    customerName: o.customer?.customerName ?? null,
    items: o.items.map((i) => ({ cylinderType: i.cylinderType?.typeName, quantity: i.quantity })),
  }));

  const results: {
    cancelledStockReturned: number;
    undeliveredOrdersCancelled: number;
    gstInvoicesCancelled: number;
    inventoryRestored: Record<string, number>;
    ordersToBeForceCanelled: typeof ordersToBeForceCanelled;
    emptiesReturned: number;
  } = {
    cancelledStockReturned: 0,
    undeliveredOrdersCancelled: 0,
    gstInvoicesCancelled: 0,
    inventoryRestored: {},
    ordersToBeForceCanelled,
    emptiesReturned: 0,
  };

  // Validate empties verified ≤ empties collected on this trip BEFORE any DB
  // mutation. Must run before the DVA is stamped isReconciled=true (the active-
  // DVA lookup inside the helper filters by isReconciled=false), and before any
  // events are written. Catches both the pre-fill carry-over bug (where trip 1
  // collections leaked into trip 2's pre-fill) and any supervisor typo.
  //
  // Option A guard (2026-05-29): the cap is `collected − alreadyVerifiedByMismatch`
  // because a prior Report Mismatch (write_off) on this vehicle's active trip
  // already credited `reconciliation_empties_return` events that landed on
  // emptiesReturnedVerified. Without subtracting them, the user could file a
  // mismatch for the whole gap (closing it on the books) AND THEN reconcile
  // with another non-zero supervisor count for the same trip — producing
  // `emptiesReturnedVerified = 2 × collected` and `emptiesOnVehicle = −collected`.
  // We saw exactly that pattern on dist-002 / TS09-AB-1260 on 2026-05-29.
  const emptiesInput = (data.emptiesReturned ?? []).filter((e) => e.quantity > 0);
  if (emptiesInput.length > 0) {
    const vehicleForValidation = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { vehicleNumber: true },
    });
    const { collectedByType } = await aggregateActiveTripCollections(
      vehicleId, distributorId, vehicleForValidation?.vehicleNumber ?? null,
    );

    // Sum already-credited mismatch write-offs on this vehicle for today.
    // Approximation: scope by (vehicleId, tripDate=today). stockMismatchRecord
    // has no tripNumber column, so two trips on the same vehicle on the same
    // day with mismatches on both would over-count — that's a rare edge case
    // the operator can override by waiting out the next dispatch; meanwhile
    // the alternative (no scope) under-counts and re-opens the bug.
    const todayUtc = startOfUtcDay();
    const tripMismatches = await prisma.stockMismatchRecord.findMany({
      where: {
        distributorId, vehicleId, tripDate: todayUtc,
        mismatchType: { in: ['empties_short', 'both'] },
      },
      select: { cylinderTypeId: true, qtyUnaccounted: true },
    });
    const alreadyVerifiedByMismatch = new Map<string, number>();
    for (const m of tripMismatches) {
      alreadyVerifiedByMismatch.set(
        m.cylinderTypeId,
        (alreadyVerifiedByMismatch.get(m.cylinderTypeId) ?? 0) + m.qtyUnaccounted,
      );
    }

    const overByType: Array<{ cylinderTypeId: string; verified: number; collected: number; alreadyVerified: number; allowed: number }> = [];
    for (const e of emptiesInput) {
      const collected = collectedByType.get(e.cylinderTypeId) ?? 0;
      const alreadyVerified = alreadyVerifiedByMismatch.get(e.cylinderTypeId) ?? 0;
      const allowed = Math.max(0, collected - alreadyVerified);
      if (e.quantity > allowed) {
        overByType.push({ cylinderTypeId: e.cylinderTypeId, verified: e.quantity, collected, alreadyVerified, allowed });
      }
    }
    if (overByType.length > 0) {
      const names = await prisma.cylinderType.findMany({
        where: { id: { in: overByType.map((o) => o.cylinderTypeId) }, distributorId },
        select: { id: true, typeName: true },
      });
      const nameMap = new Map(names.map((n) => [n.id, n.typeName]));
      const detail = overByType
        .map((o) => {
          const base = `${nameMap.get(o.cylinderTypeId) ?? o.cylinderTypeId}: verified ${o.verified} > allowed ${o.allowed} (collected ${o.collected}`;
          return o.alreadyVerified > 0
            ? `${base}, already credited by mismatch ${o.alreadyVerified})`
            : `${base})`;
        })
        .join('; ');
      const err = new Error(
        `Empties verified cannot exceed empties remaining to verify on this trip. ${detail}.`,
      );
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
  }

  // 1. Return all cancelled stock on this vehicle to depot
  const cancelledStock = await prisma.cancelledStockEvent.findMany({
    where: { vehicleId, distributorId, status: { in: ['on_vehicle', 'pending_return'] } },
  });

  const { createInventoryEvent, recalculateSummariesFromDate } = await import('./inventoryService.js');

  for (const cs of cancelledStock) {
    await prisma.$transaction(async (tx) => {
      // Mark cancelled stock as returned to depot
      await tx.cancelledStockEvent.update({
        where: { id: cs.id },
        data: { status: 'returned_to_depot', returnedDate: new Date(), reconciledBy: userId, notes: 'Vehicle reconciliation' },
      });

      // Create inventory event - cylinders back in depot
      await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: cs.cylinderTypeId,
        eventType: 'cancellation_return',
        fullsChange: cs.quantity,
        emptiesChange: 0,
        eventDate: new Date(),
        referenceId: cs.id,
        referenceType: 'cancelled_stock',
        createdBy: userId,
        notes: 'Cancelled stock returned from vehicle - reconciliation',
      });
    });

    // Recalculate after transaction
    await recalculateSummariesFromDate(distributorId, cs.cylinderTypeId, new Date());

    results.cancelledStockReturned++;
    results.inventoryRestored[cs.cylinderTypeId] = (results.inventoryRestored[cs.cylinderTypeId] || 0) + cs.quantity;
  }

  // 2. Cancel undelivered orders and return their stock
  const undeliveredOrders = await prisma.order.findMany({
    where: {
      vehicleId, distributorId,
      status: { in: ['pending_delivery', 'pending_dispatch'] },
      deletedAt: null,
    },
    include: {
      items: true,
      invoice: { select: { id: true, irn: true, irnStatus: true } },
    },
  });

  for (const order of undeliveredOrders) {
    await prisma.$transaction(async (tx) => {
      // Cancel the order
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: 'Vehicle reconciliation - order not delivered',
        },
      });

      await tx.orderStatusLog.create({
        data: {
          orderId: order.id,
          oldStatus: order.status,
          newStatus: 'cancelled',
          changedBy: userId,
          notes: 'Cancelled during vehicle reconciliation',
        },
      });

      // Return cylinders to depot inventory.
      // WI-083a2 — GAP 2: also create a CancelledStockEvent for each item so
      // the Undelivered Stock tab has a record even when reconciliation runs
      // before the admin manually cancels. We write 'on_vehicle' and then
      // immediately update to 'returned_to_depot' within the same transaction
      // — this preserves the invariant that 'returned_to_depot' is always
      // written by reconcileVehicle (Step 1 or here) or returnCancelledStock.
      for (const item of order.items) {
        const cse = await tx.cancelledStockEvent.create({
          data: {
            orderId: order.id,
            vehicleId,
            driverId: order.driverId,
            cylinderTypeId: item.cylinderTypeId,
            distributorId,
            quantity: item.quantity,
            cancellationDate: order.deliveryDate ?? new Date(),
            status: 'on_vehicle',
          },
        });
        await tx.cancelledStockEvent.update({
          where: { id: cse.id },
          data: { status: 'returned_to_depot', returnedDate: new Date(), reconciledBy: userId, notes: `Vehicle reconciliation — order ${order.orderNumber}` },
        });

        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: item.cylinderTypeId,
          eventType: 'cancellation_return',
          fullsChange: item.quantity,
          emptiesChange: 0,
          eventDate: new Date(),
          referenceId: order.id,
          referenceType: 'order',
          createdBy: userId,
          notes: `Undelivered order ${order.orderNumber} - vehicle reconciliation`,
        });

        results.inventoryRestored[item.cylinderTypeId] = (results.inventoryRestored[item.cylinderTypeId] || 0) + item.quantity;
      }
    });

    // Recalculate after each order
    for (const item of order.items) {
      await recalculateSummariesFromDate(distributorId, item.cylinderTypeId, new Date());
    }

    // Cancel GST invoice if it exists
    if (order.invoice?.id) {
      try {
        // Just cancel, don't regenerate for undelivered orders
        if (order.invoice.irn && order.invoice.irnStatus === 'success') {
          const { cancelIrn } = await import('./gst/gstService.js');
          await cancelIrn(order.invoice.id, distributorId, 'Order cancelled during vehicle reconciliation');
        }
        await prisma.invoice.update({
          where: { id: order.invoice.id },
          data: { status: 'cancelled', deletedAt: new Date() },
        });
        results.gstInvoicesCancelled++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to cancel invoice during reconciliation', { invoiceId: order.invoice.id, error: message });
      }
    }

    results.undeliveredOrdersCancelled++;
  }

  // 3. Update vehicle status to idle
  await prisma.vehicle.update({
    where: { id: vehicleId },
    data: { status: 'idle' },
  });

  // WI-094: stamp reconciledAt on this vehicle's active DVA for today (and
  // flip isReconciled), completing the trip timeline.
  const reconcileDva = await prisma.driverVehicleAssignment.findFirst({
    where: { vehicleId, distributorId, assignmentDate: startOfUtcDay(), status: { not: 'cancelled' } },
    orderBy: { tripNumber: 'desc' },
    select: { id: true, vehicle: { select: { vehicleNumber: true } }, driver: { select: { driverName: true } } },
  });
  if (reconcileDva) {
    await prisma.driverVehicleAssignment.update({
      where: { id: reconcileDva.id },
      // WI-100 Gap A: advance the DVA to its terminal state for a completed
      // trip — dispatch_ready (vehicle idle, waiting for the next dispatch).
      // Without this the DVA stuck at loaded_and_dispatched after reconcile, so
      // the driver app re-showed "Mark Vehicle Returned" forever (the loop).
      // preflightDispatch (WI-100 Gap B) rolls this dispatch_ready+isReconciled
      // DVA to the next trip when a new batch is dispatched.
      data: { status: 'dispatch_ready', reconciledAt: new Date(), isReconciled: true },
    });
  }

  // WI: physically-verified empties returned to depot at reconciliation. Each
  // non-zero entry is persisted (audit) and written as a positive-empties
  // inventory event so the depot empties balance reflects the verified count.
  // Optional — if no entries (or all zero), nothing is written and reconcile
  // still completes. Requires a DVA to anchor the events.
  // Reuse the `emptiesInput` already validated above.
  const empties = emptiesInput;
  if (empties.length > 0 && reconcileDva) {
    const now = new Date();
    for (const e of empties) {
      await prisma.$transaction(async (tx) => {
        await tx.reconciliationEmptiesReturned.create({
          data: { distributorId, dvaId: reconcileDva.id, cylinderTypeId: e.cylinderTypeId, quantity: e.quantity },
        });
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: e.cylinderTypeId,
          eventType: 'reconciliation_empties_return',
          fullsChange: 0,
          emptiesChange: e.quantity,
          eventDate: now,
          referenceId: reconcileDva.id,
          referenceType: 'driver_vehicle_assignment',
          vehicleNumber: reconcileDva.vehicle?.vehicleNumber,
          driverName: reconcileDva.driver?.driverName,
          createdBy: userId,
          notes: 'Empties physically verified returned to depot at reconciliation',
        });
      });
      // Recompute AFTER commit so the snapshot sees the just-written event.
      await recalculateSummariesFromDate(distributorId, e.cylinderTypeId, now);
    }
    results.emptiesReturned = empties.reduce((s, e) => s + e.quantity, 0);
  }

  logger.info('Vehicle reconciliation complete', { vehicleId, distributorId, results });

  return {
    status: 'reconciled' as const,
    cancelledStockReturned: results.cancelledStockReturned,
    undeliveredOrdersCancelled: results.undeliveredOrdersCancelled,
    gstInvoicesCancelled: results.gstInvoicesCancelled,
    emptiesReturned: results.emptiesReturned,
    inventoryRestored: results.inventoryRestored,
    ordersToBeForceCanelled: results.ordersToBeForceCanelled,
  };
}

/**
 * Trip-scoped collection aggregation used by both pending-list pre-fill and the
 * reconcile validation guard. Returns the active trip's tripNumber, the set of
 * cylinder types touched on the trip, and per-type collected-empties totals
 * scoped to THIS trip (not all of today). This is the fix for the cross-trip
 * carry-over bug where a second trip's pre-fill incorrectly included trip 1's
 * already-reconciled collections.
 */
// WI-4 — exported so the mismatch service can read the per-vehicle
// per-cylinder collected-empties figure to bound qtyUnaccounted against
// "actual gap" on the empties_short path.
export async function aggregateActiveTripCollections(
  vehicleId: string,
  distributorId: string,
  vehicleNumber: string | null,
): Promise<{ activeTripNumber: number | null; collectedByType: Map<string, number>; activeTypeIds: Set<string> }> {
  const todayStart = startOfUtcDay();
  // Most recent NON-reconciled DVA for this vehicle today → that's the trip
  // being reconciled. After reconcile, isReconciled flips to true; the next
  // dispatch creates a new tripNumber on the same DVA.
  const activeDva = await prisma.driverVehicleAssignment.findFirst({
    where: { vehicleId, distributorId, assignmentDate: todayStart, isReconciled: false, status: { not: 'cancelled' } },
    orderBy: { tripNumber: 'desc' },
    select: { tripNumber: true },
  });
  const collectedByType = new Map<string, number>();
  const activeTypeIds = new Set<string>();
  if (!activeDva) {
    return { activeTripNumber: null, collectedByType, activeTypeIds };
  }
  const tripNumber = activeDva.tripNumber;
  // Orders dispatched on this exact trip. tripNumber is stamped at dispatch
  // (WI-065). Joining by tripNumber excludes orders from prior trips on the
  // same vehicle+date that have already been reconciled.
  const tripOrders = await prisma.order.findMany({
    where: { vehicleId, distributorId, deliveryDate: todayStart, tripNumber },
    select: { id: true },
  });
  const tripOrderIds = tripOrders.map((o) => o.id);
  if (tripOrderIds.length === 0) {
    // Edge: vehicle in returned state but no orders carry this trip number —
    // fall back to today's dispatch events for the cylinder type set so the
    // empties step still surfaces the relevant types.
    const fallbackDispatch = vehicleNumber
      ? await prisma.inventoryEvent.findMany({
          where: { distributorId, eventType: 'dispatch', vehicleNumber, eventDate: todayStart },
          select: { cylinderTypeId: true },
        })
      : [];
    for (const e of fallbackDispatch) activeTypeIds.add(e.cylinderTypeId);
    return { activeTripNumber: tripNumber, collectedByType, activeTypeIds };
  }
  // Dispatch events on this trip — scope by referenceId not vehicleNumber so we
  // don't bleed in dispatches from an earlier trip on the same vehicle.
  const dispatchEvents = await prisma.inventoryEvent.findMany({
    where: { distributorId, eventType: 'dispatch', referenceType: 'order', referenceId: { in: tripOrderIds } },
    select: { cylinderTypeId: true },
  });
  // Collection + returns_collection events for orders on this trip ONLY.
  const collectionEvents = await prisma.inventoryEvent.findMany({
    where: { distributorId, eventType: { in: ['collection', 'returns_collection'] }, referenceType: 'order', referenceId: { in: tripOrderIds } },
    select: { cylinderTypeId: true, emptiesChange: true },
  });
  for (const e of collectionEvents) collectedByType.set(e.cylinderTypeId, (collectedByType.get(e.cylinderTypeId) ?? 0) + e.emptiesChange);
  for (const e of dispatchEvents) activeTypeIds.add(e.cylinderTypeId);
  for (const k of collectedByType.keys()) activeTypeIds.add(k);
  return { activeTripNumber: tripNumber, collectedByType, activeTypeIds };
}

/**
 * Get vehicles pending reconciliation (returned but not yet verified).
 * Includes pending order summaries so the UI can warn about force-cancellations.
 */
export async function getVehiclesPendingReconciliation(distributorId: string) {
  const vehicles = await prisma.vehicle.findMany({
    where: { distributorId, status: 'returned' },
  });

  const result = [];
  for (const vehicle of vehicles) {
    // Per-line cancelled-stock detail for the inline display on the Vehicle
    // Return card (replaces the old "Undelivered Stock" tab — same data, but
    // inlined per vehicle so the user closes the trip in one action). Caps at
    // 100 lines per vehicle; no realistic trip carries more.
    const cancelledLineRows = await prisma.cancelledStockEvent.findMany({
      where: { vehicleId: vehicle.id, distributorId, status: { in: ['on_vehicle', 'pending_return'] } },
      include: {
        cylinderType: { select: { typeName: true } },
        order: {
          select: {
            orderNumber: true,
            customer: { select: { customerName: true } },
            items: { select: { cylinderTypeId: true, quantity: true, deliveredQuantity: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const pendingCancelledStockLines = cancelledLineRows.map((cse) => {
      const orderItem = cse.order?.items.find((i) => i.cylinderTypeId === cse.cylinderTypeId);
      const orderedQty = orderItem?.quantity ?? cse.quantity;
      const deliveredQty = orderItem?.deliveredQuantity ?? 0;
      return {
        cseId: cse.id,
        cylinderTypeId: cse.cylinderTypeId,
        cylinderTypeName: cse.cylinderType?.typeName ?? '—',
        orderNumber: cse.order?.orderNumber ?? null,
        customerName: cse.order?.customer?.customerName ?? null,
        orderedQty,
        deliveredQty,
        shortfallQty: cse.quantity,
        status: cse.status,
      };
    });
    const cancelledCount = pendingCancelledStockLines.length;
    const pendingOrders = await prisma.order.findMany({
      where: { vehicleId: vehicle.id, distributorId, status: { in: ['pending_delivery', 'pending_dispatch'] }, deletedAt: null },
      include: { customer: { select: { customerName: true } } },
    });

    // Empties pre-fill — scoped to the active (non-reconciled) trip's orders
    // only. Replaces the prior today-wide aggregation which leaked prior trips'
    // already-reconciled collections into the next trip's pre-fill.
    const { collectedByType, activeTypeIds } = await aggregateActiveTripCollections(vehicle.id, distributorId, vehicle.vehicleNumber);
    const typeNames = activeTypeIds.size
      ? await prisma.cylinderType.findMany({ where: { id: { in: [...activeTypeIds] }, distributorId }, select: { id: true, typeName: true } })
      : [];
    const typeNameMap = new Map(typeNames.map((t) => [t.id, t.typeName]));
    const emptiesTypes = [...activeTypeIds].map((cylinderTypeId) => ({
      cylinderTypeId,
      typeName: typeNameMap.get(cylinderTypeId) ?? '—',
      collectedQty: collectedByType.get(cylinderTypeId) ?? 0,
    }));

    // Surface whether this vehicle has an open STOCK_MISMATCH pending action so
    // the card can render an amber "Mismatch reported — check Pending Actions"
    // banner under the vehicle number. The mutation creates this PA when
    // physicalStockConfirmed=false; the vehicle remains in `returned` status.
    const openMismatchPa = await prisma.pendingAction.findFirst({
      where: {
        distributorId,
        entityId: vehicle.id,
        entityType: 'vehicle',
        actionType: 'STOCK_MISMATCH',
        status: { in: ['open', 'in_progress'] },
      },
      select: { id: true, createdAt: true, description: true },
    });

    result.push({
      vehicleId: vehicle.id,
      vehicleNumber: vehicle.vehicleNumber,
      pendingCancelledStock: cancelledCount,
      pendingUndeliveredOrders: pendingOrders.length,
      totalPendingItems: cancelledCount + pendingOrders.length,
      pendingOrderSummaries: pendingOrders.map((o) => ({
        orderId: o.id,
        orderNumber: o.orderNumber,
        customerName: o.customer?.customerName ?? null,
      })),
      pendingCancelledStockLines,
      emptiesTypes,
      mismatchReported: !!openMismatchPa,
    });
  }

  return result;
}
