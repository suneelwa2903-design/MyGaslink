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
      // Update order items with customer-confirmed quantities
      let newTotal = 0;
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
          newTotal += effectivePrice * ci.confirmedDelivered;
        }
      }

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
  const empties = (data.emptiesReturned ?? []).filter((e) => e.quantity > 0);
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

    // ── Empties returned step: cylinder types active on today's trip plus the
    // sum of delivery-time collection events (pre-fills the verify inputs). The
    // active types come from this vehicle's dispatch events today; the collected
    // totals come from collection/returns_collection events on the trip's orders.
    const todayStart = startOfUtcDay();
    const dispatchEvents = await prisma.inventoryEvent.findMany({
      where: { distributorId, eventType: 'dispatch', vehicleNumber: vehicle.vehicleNumber, eventDate: todayStart },
      select: { cylinderTypeId: true },
    });
    const tripOrders = await prisma.order.findMany({
      where: { vehicleId: vehicle.id, distributorId, deliveryDate: todayStart },
      select: { id: true },
    });
    const tripOrderIds = tripOrders.map((o) => o.id);
    const collectionEvents = tripOrderIds.length
      ? await prisma.inventoryEvent.findMany({
          where: { distributorId, eventType: { in: ['collection', 'returns_collection'] }, referenceType: 'order', referenceId: { in: tripOrderIds } },
          select: { cylinderTypeId: true, emptiesChange: true },
        })
      : [];
    const collectedByType = new Map<string, number>();
    for (const e of collectionEvents) collectedByType.set(e.cylinderTypeId, (collectedByType.get(e.cylinderTypeId) ?? 0) + e.emptiesChange);
    const activeTypeIds = new Set<string>([...dispatchEvents.map((e) => e.cylinderTypeId), ...collectedByType.keys()]);
    const typeNames = activeTypeIds.size
      ? await prisma.cylinderType.findMany({ where: { id: { in: [...activeTypeIds] }, distributorId }, select: { id: true, typeName: true } })
      : [];
    const typeNameMap = new Map(typeNames.map((t) => [t.id, t.typeName]));
    const emptiesTypes = [...activeTypeIds].map((cylinderTypeId) => ({
      cylinderTypeId,
      typeName: typeNameMap.get(cylinderTypeId) ?? '—',
      collectedQty: collectedByType.get(cylinderTypeId) ?? 0,
    }));

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
    });
  }

  return result;
}
