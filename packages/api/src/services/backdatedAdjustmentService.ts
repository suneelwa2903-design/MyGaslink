/**
 * Backdated Inventory Adjustment — settle today's stock for a backdated
 * order. The events are dated TODAY (no historical cascade); the daily
 * summary updates from today forward only.
 *
 * Why: when a distributor enters a backdated order (Brief 3), the order
 * lands status='delivered' but no inventory events are written by design
 * — the admin handles stock manually. This service is the structured
 * "apply" path: it writes the same events a godown pickup would
 * (`manual_adjustment` for fulls, `reconciliation_empties_return` for
 * empties), but anchored to TODAY, and stamps the order so it can't be
 * double-applied.
 *
 * Reference: docs/BACKDATED-INVESTIGATION-GAPS.md §5 (locked design).
 */
import { prisma } from '../lib/prisma.js';
import { localTodayISO } from '@gaslink/shared';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';

export class BackdatedAdjustmentError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'BackdatedAdjustmentError';
  }
}

/**
 * Apply today's inventory adjustment for a backdated order.
 *
 * - One `manual_adjustment` event per cylinder type with
 *   `fullsChange = -deliveredQuantity`.
 * - One `reconciliation_empties_return` event per cylinder type where
 *   `emptiesCollected > 0` with `emptiesChange = +emptiesCollected`.
 * - All events dated TODAY (`localTodayISO()` in local TZ — never
 *   `new Date().toISOString().split('T')[0]`, anti-pattern #21).
 * - Sets `Order.inventoryAdjustedAt = now()` to block double-apply.
 * - Writes an `OrderStatusLog` audit row (delivered → delivered with
 *   a "Inventory adjusted as of today" note carrying the userId).
 * - Recalculates summaries FROM today only — past days untouched.
 */
export async function applyBackdatedInventoryAdjustment(
  distributorId: string,
  userId: string,
  orderId: string,
): Promise<{ order: { id: string; orderNumber: string; inventoryAdjustedAt: Date | null }; eventsWritten: number }> {
  // Tenant-scoped load + gates. Multi-tenant rules require an explicit
  // distributorId clause on every read (anti-pattern #1 / #13).
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId },
    include: { items: { select: { cylinderTypeId: true, deliveredQuantity: true, emptiesCollected: true } } },
  });
  if (!order) throw new BackdatedAdjustmentError('Order not found', 404);
  if (order.deletedAt) {
    throw new BackdatedAdjustmentError('Cannot adjust inventory for a cancelled order', 400);
  }
  if (!order.isBackdated) {
    throw new BackdatedAdjustmentError('Only backdated orders need an inventory adjustment', 400);
  }
  if (order.status !== 'delivered') {
    throw new BackdatedAdjustmentError(`Order must be delivered to adjust inventory (current status: ${order.status})`, 400);
  }
  if (order.inventoryAdjustedAt) {
    throw new BackdatedAdjustmentError('Inventory already adjusted for this order', 409);
  }

  // Today, local TZ. The brief explicitly bans the UTC split form.
  const adjustmentDate = new Date(localTodayISO());
  const orderNumber = order.orderNumber;
  const deliveryDateStr = order.deliveryDate.toISOString().slice(0, 10);
  const notes = `Backdated adjustment for order ${orderNumber} (delivered ${deliveryDateStr})`;

  let eventsWritten = 0;

  await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      const deliveredQty = item.deliveredQuantity ?? 0;
      const emptiesCollected = item.emptiesCollected ?? 0;
      // Fulls debit — one event per item with delivered > 0.
      if (deliveredQty > 0) {
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: item.cylinderTypeId,
          eventType: 'manual_adjustment',
          fullsChange: -deliveredQty,
          emptiesChange: 0,
          eventDate: adjustmentDate,
          referenceId: order.id,
          referenceType: 'backdated_inventory_adjustment',
          notes,
          createdBy: userId,
        });
        eventsWritten++;
      }
      // Empties credit — skip when no empties came back (mirrors what
      // godown confirmDelivery does — no zero-quantity events).
      if (emptiesCollected > 0) {
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: item.cylinderTypeId,
          eventType: 'reconciliation_empties_return',
          fullsChange: 0,
          emptiesChange: emptiesCollected,
          eventDate: adjustmentDate,
          referenceId: order.id,
          referenceType: 'backdated_inventory_adjustment',
          notes,
          createdBy: userId,
        });
        eventsWritten++;
      }
    }

    await tx.order.update({
      where: { id: order.id },
      data: { inventoryAdjustedAt: new Date() },
    });

    await tx.orderStatusLog.create({
      data: {
        orderId: order.id,
        oldStatus: 'delivered',
        newStatus: 'delivered',
        changedBy: userId,
        notes: `Inventory adjusted as of today by ${userId} (backdated order ${orderNumber})`,
      },
    });
  });

  // Recalc summaries from TODAY forward only. The carry-forward chain
  // for past days is intentionally untouched — that was the locked
  // design decision (no historical cascade).
  const uniqueCtIds = Array.from(new Set(order.items.map((i) => i.cylinderTypeId)));
  for (const ctId of uniqueCtIds) {
    await recalculateSummariesFromDate(distributorId, ctId, adjustmentDate);
  }

  return {
    order: { id: order.id, orderNumber, inventoryAdjustedAt: new Date() },
    eventsWritten,
  };
}

// ─── Listing queries ─────────────────────────────────────────────────────────

/**
 * Pending list — backdated orders that have NOT yet had their inventory
 * settled. Drives the top section of the Backdated Adjustments tab.
 */
export async function getPendingBackdatedAdjustments(distributorId: string) {
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      isBackdated: true,
      status: 'delivered',
      inventoryAdjustedAt: null,
      deletedAt: null,
    },
    include: {
      customer: { select: { customerName: true } },
      items: {
        select: {
          cylinderTypeId: true,
          deliveredQuantity: true,
          emptiesCollected: true,
          cylinderType: { select: { typeName: true } },
        },
      },
    },
    orderBy: { deliveryDate: 'desc' },
  });

  return orders.map((o) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    customerName: o.customer?.customerName ?? 'Deleted Customer',
    deliveryDate: o.deliveryDate.toISOString().slice(0, 10),
    createdAt: o.createdAt.toISOString(),
    items: o.items.map((it) => ({
      cylinderTypeId: it.cylinderTypeId,
      cylinderTypeName: it.cylinderType?.typeName ?? '—',
      deliveredQty: it.deliveredQuantity ?? 0,
      emptiesCollected: it.emptiesCollected ?? 0,
    })),
  }));
}

/**
 * History — the most-recent 50 `backdated_inventory_adjustment` events
 * with the originating order number joined back in.
 */
export async function getBackdatedAdjustmentHistory(distributorId: string) {
  const events = await prisma.inventoryEvent.findMany({
    where: { distributorId, referenceType: 'backdated_inventory_adjustment' },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  // Join back to Order via referenceId (anti-pattern #1 — explicit
  // distributorId on the lookup as well).
  const orderIds = Array.from(new Set(events.map((e) => e.referenceId).filter((x): x is string => !!x)));
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds }, distributorId },
        select: { id: true, orderNumber: true, deliveryDate: true },
      })
    : [];
  const byId = new Map(orders.map((o) => [o.id, o]));

  return events.map((e) => {
    const ord = e.referenceId ? byId.get(e.referenceId) : undefined;
    return {
      eventId: e.id,
      cylinderTypeId: e.cylinderTypeId,
      cylinderTypeName: e.cylinderType?.typeName ?? '—',
      eventType: e.eventType,
      fullsChange: e.fullsChange,
      emptiesChange: e.emptiesChange,
      eventDate: e.eventDate.toISOString().slice(0, 10),
      createdAt: e.createdAt.toISOString(),
      orderId: e.referenceId ?? null,
      orderNumber: ord?.orderNumber ?? null,
      deliveryDate: ord?.deliveryDate.toISOString().slice(0, 10) ?? null,
    };
  });
}
