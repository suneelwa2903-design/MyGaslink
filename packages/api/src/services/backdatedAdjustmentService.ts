/**
 * Backdated Inventory Adjustment — settle inventory for a backdated
 * order, dated on the DELIVERY DATE (not today), with a full cascade
 * forward through every daily summary that carries the stock chain.
 *
 * Why: when a distributor enters a backdated order (Brief 3), the order
 * lands status='delivered' but no inventory events are written by design
 * — this service is the structured "apply" path. It writes the same
 * events a godown pickup would (`manual_adjustment` for fulls,
 * `reconciliation_empties_return` for empties), anchored to the order's
 * `deliveryDate`, and stamps the order so it can't be double-applied.
 * The `is_locked` guard inside `recalculateSummariesFromDate` protects
 * any past day the operator has already closed — locked days silently
 * skip and the cascade continues past them.
 *
 * Reference: docs/BACKDATED-INVESTIGATION-GAPS.md §5 (original locked
 * design was "today-only" — flipped 2026-07-10 per Suneel's Option-A
 * decision so backdated deliveries move stock on the delivery day, not
 * on the entry day).
 */
import { prisma } from '../lib/prisma.js';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';

export class BackdatedAdjustmentError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'BackdatedAdjustmentError';
  }
}

/**
 * Apply the inventory adjustment for a backdated order — dated on the
 * delivery day, with a full cascade forward.
 *
 * - One `manual_adjustment` event per cylinder type with
 *   `fullsChange = -deliveredQuantity`.
 * - One `reconciliation_empties_return` event per cylinder type where
 *   `emptiesCollected > 0` with `emptiesChange = +emptiesCollected`.
 * - All events dated on the ORDER's DELIVERY DATE (retro-dated per
 *   Suneel's Option-A decision on 2026-07-10). `Order.deliveryDate`
 *   is stored as a `Date` — used verbatim without any UTC-split
 *   round-trip so anti-pattern #21 is not in scope.
 * - Sets `Order.inventoryAdjustedAt = now()` to block double-apply.
 *   `inventoryAdjustedAt` is a real timestamp (WHEN the operator ran
 *   the adjustment), NOT the delivery date. The two answer different
 *   questions and both are needed for the audit trail.
 * - Writes an `OrderStatusLog` audit row (delivered → delivered with
 *   a note carrying the userId + the fact that inventory was adjusted).
 * - Recalculates summaries FROM the delivery date forward. The
 *   `is_locked` guard in `recalculateSummariesFromDate` still applies —
 *   any past day the operator has already closed silently skips and
 *   the cascade continues past it (correct behaviour: closed days stay
 *   closed, everything after re-derives from the events chain).
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

  // Option A (2026-07-10) — events are dated on the delivery day, not
  // today. `order.deliveryDate` is a real `Date` at local midnight (see
  // invoice/order write paths that persist it) so we use it verbatim as
  // the event_date; no UTC-split anywhere.
  const adjustmentDate = order.deliveryDate;
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
        notes: `Inventory adjusted (dated ${deliveryDateStr}) by ${userId} for backdated order ${orderNumber}`,
      },
    });
  });

  // Cascade summaries from the DELIVERY DATE forward through every
  // touched cylinder type. recalculateSummariesFromDate walks day-by-day
  // and re-derives closing_fulls/closing_empties from the events chain
  // — locked days silently skip (correct) and everything past them
  // recomputes so today's closing reflects the new event.
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
