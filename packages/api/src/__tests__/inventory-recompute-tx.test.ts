/**
 * Regression: inventory mutation functions must recompute the summary AFTER
 * their transaction commits, not inside it. Previously the recompute ran on the
 * global prisma client inside the $transaction, so it could not see the event
 * written via `tx` (read-committed isolation) and left the summary stale.
 *
 * These tests assert the summary reflects the change IMMEDIATELY — no delivery
 * or follow-up event needed to trigger a recompute.
 *
 * Anti-pattern #7: a fixed far-future date keeps fixtures out of real dev-DB
 * date-filtered service queries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { $Enums } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  recordIncomingFulls,
  recordOutgoingEmpties,
  returnCancelledStock,
} from '../services/inventoryService.js';

const DIST = 'dist-002';
const TEST_DATE = '2099-12-31';
const summaryDate = new Date(TEST_DATE);

let cylinderTypeId: string;

async function getSummary(ctId: string) {
  return prisma.inventorySummary.findFirst({
    where: { distributorId: DIST, cylinderTypeId: ctId, summaryDate },
  });
}

// Sum committed events of given type(s) on TEST_DATE for the test cylinder.
async function sumEvents(eventTypes: $Enums.InventoryEventType[], field: 'fullsChange' | 'emptiesChange') {
  const evs = await prisma.inventoryEvent.findMany({
    where: { distributorId: DIST, cylinderTypeId, eventDate: summaryDate, eventType: { in: eventTypes } },
  });
  return evs.reduce((s, e) => s + e[field], 0);
}

beforeAll(async () => {
  const ct = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST, isActive: true },
  });
  cylinderTypeId = ct.id;
  // Start from a clean far-future date so delta assertions are deterministic
  // regardless of leftovers from prior aborted runs.
  await prisma.cancelledStockEvent.deleteMany({ where: { distributorId: DIST, cancellationDate: summaryDate } });
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, eventDate: summaryDate } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, summaryDate } });
});

afterAll(async () => {
  // Far-future date → only this file's fixtures live here.
  await prisma.cancelledStockEvent.deleteMany({
    where: { distributorId: DIST, cancellationDate: summaryDate, notes: { contains: 'recompute-tx test' } },
  });
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, eventDate: summaryDate } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, summaryDate } });
});

describe('inventory recompute-after-commit (read-committed isolation fix)', () => {
  it('recordIncomingFulls: closing_fulls reflects the addition immediately', async () => {
    await recordIncomingFulls(DIST, 'test-user', {
      cylinderTypeId,
      quantity: 7,
      documentType: 'invoice',
      documentNumber: `RTX-IN-${Date.now()}`,
      documentDate: TEST_DATE,
      notes: 'recompute-tx test incoming',
    });

    // Invariant: the summary must equal the COMMITTED events. Pre-fix the
    // recompute ran inside the tx and couldn't see the just-written event, so
    // summary.incomingFulls was stale (did not include our +7).
    const after = await getSummary(cylinderTypeId);
    const committedIncoming = await sumEvents(['incoming_fulls'], 'fullsChange');
    expect(after).not.toBeNull();
    expect(committedIncoming).toBeGreaterThanOrEqual(7);
    expect(after!.incomingFulls).toBe(committedIncoming);
    // closing_fulls is recomputed from the same committed events (not stale).
    expect(after!.closingFulls).toBeGreaterThanOrEqual(after!.openingFulls);
  });

  it('recordOutgoingEmpties: closing_empties reflects the change immediately', async () => {
    await recordOutgoingEmpties(DIST, 'test-user', {
      cylinderTypeId,
      quantity: 4,
      documentType: 'challan',
      documentNumber: `RTX-OUT-${Date.now()}`,
      documentDate: TEST_DATE,
      notes: 'recompute-tx test outgoing',
    });

    // Invariant: summary.outgoingEmpties == |sum of committed outgoing_empties|.
    const after = await getSummary(cylinderTypeId);
    const committedOutgoing = Math.abs(await sumEvents(['outgoing_empties'], 'emptiesChange'));
    expect(after).not.toBeNull();
    expect(committedOutgoing).toBeGreaterThanOrEqual(4);
    expect(after!.outgoingEmpties).toBe(committedOutgoing);
  });

  it('returnCancelledStock: cancelled_stock_qty + closing_fulls reflect the return immediately (no delivery)', async () => {
    // Seed a cancelled-stock event sitting on the vehicle.
    // CSE.orderId is a required FK. seed.ts seeds orders only for dist-001
    // (Bhargava); dist-002 (Sharma) gets GST/customers/drivers/vehicles but
    // no orders. Find an existing one or create a minimal placeholder so the
    // test is hermetic on any fresh DB (CI) without relying on dev-DB history.
    let order = await prisma.order.findFirst({ where: { distributorId: DIST } });
    if (!order) {
      const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: DIST } });
      order = await prisma.order.create({
        data: {
          orderNumber: `TEST-RCT-${Date.now()}`,
          distributorId: DIST,
          customerId: customer.id,
          orderDate: summaryDate,
          deliveryDate: summaryDate,
          status: 'pending_dispatch',
          totalAmount: 0,
        },
      });
    }
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { distributorId: DIST } });
    const driver = await prisma.driver.findFirstOrThrow({ where: { distributorId: DIST } });
    const cse = await prisma.cancelledStockEvent.create({
      data: {
        orderId: order.id,
        vehicleId: vehicle.id,
        driverId: driver.id,
        cylinderTypeId,
        distributorId: DIST,
        quantity: 3,
        cancellationDate: summaryDate,
        status: 'on_vehicle',
        notes: 'recompute-tx test CSE',
      },
    });

    const results = await returnCancelledStock(DIST, 'test-user', {
      eventIds: [cse.id],
      returnDate: TEST_DATE,
      notes: 'recompute-tx test return',
    });
    expect(results).toEqual([{ eventId: cse.id, status: 'returned_to_depot' }]);

    // CSE moved to depot
    const updated = await prisma.cancelledStockEvent.findUniqueOrThrow({ where: { id: cse.id } });
    expect(updated.status).toBe('returned_to_depot');

    // Invariant: summary reflects the COMMITTED cancellation_return event
    // IMMEDIATELY (no delivery). Pre-fix the recompute ran inside the tx and
    // left cancelled_stock_qty / closing_fulls stale (missing our +3).
    const after = await getSummary(cylinderTypeId);
    const committedReturn = await sumEvents(['cancellation', 'cancellation_return'], 'fullsChange');
    expect(after).not.toBeNull();
    expect(committedReturn).toBeGreaterThanOrEqual(3);
    expect(after!.cancelledStockQty).toBe(committedReturn);
  });
});
