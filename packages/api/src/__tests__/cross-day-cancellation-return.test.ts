/**
 * cross-day-cancellation-return.test.ts
 *
 * Pins the date-discipline fix on `cancellation_return` inventory events
 * (Investigation A, shipped 2026-06-01). Three write sites used to stamp
 * `eventDate: new Date()` — wall-clock NOW — even though the matching
 * `dispatch` event lives on `order.deliveryDate`. When a trip ran from
 * Day D₀ into Day D₁ (e.g. dispatched 11 PM, reconciled 1 AM), the daily
 * summary's per-day formula
 *     inFlightFulls = dispatchedQty − deliveredQty − cancelledStockQty
 * would never close on either day:
 *   D₀: 2 − 1 − 0 = +1 forever
 *   D₁: 0 − 0 − 1 = −1 forever
 *
 * After the fix all three sites pin the return event to the trip's
 * deliveryDate / cancellationDate. Both legs always land on the same
 * summary row.
 *
 * Test strategy: drive the service functions directly with a real
 * CancelledStockEvent whose `cancellationDate` is intentionally an
 * earlier day, then assert the inventory_event the service writes
 * carries THAT date (not wall-clock today).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { returnCancelledStock } from '../services/inventoryService.js';

const DIST = 'dist-001'; // GST-disabled, simpler fixture
// A historical date — guaranteed not "today" in any timezone.
const TRIP_DATE = new Date('2099-12-30T00:00:00Z');
const TRIP_DATE_ISO = '2099-12-30';

const cleanupTag = 'CROSS-DAY-CR-TEST';
let cylinderTypeId: string;
let driverUserId: string;
let customerId: string;

beforeAll(async () => {
  // Use any 5 KG seed cylinder type — never invented, the seed has one.
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST, typeName: '5 KG' },
  });
  cylinderTypeId = cyl.id;

  // Any user; just need a non-null userId FK on inventory_events.
  const u = await prisma.user.findFirstOrThrow({
    where: { distributorId: DIST },
    select: { id: true },
  });
  driverUserId = u.id;

  // A customer to anchor the seeded orders against — CancelledStockEvent
  // requires a non-null orderId, and Order requires a non-null customerId.
  const cust = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, deletedAt: null },
    select: { id: true },
  });
  customerId = cust.id;
});

async function seedOrderAndCseOnTripDate(quantity: number) {
  const order = await prisma.order.create({
    data: {
      distributorId: DIST,
      customerId,
      orderNumber: `${cleanupTag}-${Math.random().toString(36).slice(2, 8)}`,
      orderDate: TRIP_DATE,
      deliveryDate: TRIP_DATE,
      status: 'pending_delivery',
      orderType: 'delivery',
      totalAmount: 0,
    },
  });
  const cse = await prisma.cancelledStockEvent.create({
    data: {
      orderId: order.id,
      distributorId,
      cylinderTypeId,
      quantity,
      cancellationDate: TRIP_DATE,
      status: 'on_vehicle',
      notes: cleanupTag,
    },
  });
  return { orderId: order.id, cse };
}

// Helper alias for symbol use below.
const distributorId = DIST;

afterEach(async () => {
  // Strip everything this test created — anchored on the unique notes tag,
  // the orderNumber prefix, and the cse cancellationDate so we never
  // bleed into other tests.
  await prisma.inventoryEvent.deleteMany({
    where: {
      distributorId: DIST,
      OR: [
        { notes: { contains: cleanupTag } },
        { eventDate: new Date(TRIP_DATE_ISO) },
      ],
    },
  });
  await prisma.cancelledStockEvent.deleteMany({
    where: { distributorId: DIST, notes: { contains: cleanupTag } },
  });
  await prisma.inventorySummary.deleteMany({
    where: {
      distributorId: DIST,
      cylinderTypeId,
      summaryDate: new Date(TRIP_DATE_ISO),
    },
  });
  await prisma.order.deleteMany({
    where: { distributorId: DIST, orderNumber: { startsWith: cleanupTag } },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('returnCancelledStock — cancellation_return eventDate pins to cse.cancellationDate', () => {
  it('stamps the inventory_event with cse.cancellationDate, NOT wall-clock today', async () => {
    // 1. Seed an order + CSE on the trip date (D₀ — yesterday-equivalent).
    const { cse } = await seedOrderAndCseOnTripDate(1);

    // 2. Operator clicks "Return Cancelled Stock" TODAY.
    //    data.returnDate = today's ISO; the service used to stamp the
    //    inventory_event with this date. After the fix it must use
    //    cse.cancellationDate instead.
    const todayIso = new Date().toISOString().slice(0, 10);
    await returnCancelledStock(DIST, driverUserId, {
      eventIds: [cse.id],
      returnDate: todayIso,
      notes: `${cleanupTag} return click`,
    });

    // 3. Read back the inventory_event the service wrote.
    const event = await prisma.inventoryEvent.findFirstOrThrow({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceId: cse.id,
      },
    });

    // 4. eventDate must equal the trip's cancellationDate (TRIP_DATE),
    //    NOT today.
    const eventDateIso = event.eventDate.toISOString().slice(0, 10);
    expect(eventDateIso).toBe(TRIP_DATE_ISO);
    expect(eventDateIso).not.toBe(todayIso);
  });

  it('summary row recomputed for the TRIP date, not today', async () => {
    const { cse } = await seedOrderAndCseOnTripDate(3);

    await returnCancelledStock(DIST, driverUserId, {
      eventIds: [cse.id],
      returnDate: new Date().toISOString().slice(0, 10),
      notes: `${cleanupTag} return click 2`,
    });

    // A summary row keyed on the TRIP date must exist after the recompute.
    const summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: DIST,
          cylinderTypeId,
          summaryDate: new Date(TRIP_DATE_ISO),
        },
      },
    });
    expect(summary).not.toBeNull();
    // cancelled_stock_qty on the trip-date row reflects the +3 return.
    expect(summary?.cancelledStockQty).toBeGreaterThanOrEqual(3);
  });
});
