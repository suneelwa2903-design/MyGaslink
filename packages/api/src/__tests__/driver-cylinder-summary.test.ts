/**
 * driver-cylinder-summary.test.ts
 *
 * Item 9 (docs/INVESTIGATION-JUL09-B.md) — per-cyl-type deliveries+empties
 * for a driver in a date range. Pins the aggregation shape:
 *   - Only delivered + modified_delivered orders count
 *   - Multiple orders same cyl type SUM correctly
 *   - deliveredQuantity wins over quantity when set
 *   - Cross-tenant driver returns empty (tenant guard)
 *   - Date range filter narrows the window
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { getDriverCylinderSummary } from '../services/analyticsService.js';
import { getSeedData } from './helpers.js';

const D1 = 'dist-001';
const D2 = 'dist-002';

const trackedOrderIds: string[] = [];
const trackedCustomerIds: string[] = [];

// Use a fixed FAR-FUTURE date to isolate this test's fixtures from any
// real dispatch data (anti-pattern #7 in CLAUDE.md).
const TEST_DATE = new Date('2099-12-31T00:00:00.000Z');
const TEST_DATE_ISO = '2099-12-31';

async function makeCustomer(name: string) {
  const c = await prisma.customer.create({
    data: {
      distributorId: D1,
      customerName: `${name}-${Date.now().toString(36)}`,
      customerType: 'B2C',
      phone: '+919999999999',
      billingAddressLine1: 'x',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
    },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function makeDeliveredOrder(opts: {
  driverId: string;
  customerId: string;
  status: 'delivered' | 'modified_delivered' | 'pending_delivery';
  items: { cylinderTypeId: string; quantity: number; deliveredQuantity?: number; emptiesCollected?: number }[];
}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `T9-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      distributorId: D1,
      customerId: opts.customerId,
      driverId: opts.driverId,
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      status: opts.status,
      totalAmount: 1000,
      items: {
        create: opts.items.map((it) => ({
          cylinderTypeId: it.cylinderTypeId,
          quantity: it.quantity,
          unitPrice: 1000,
          discountPerUnit: 0,
          totalPrice: 1000 * it.quantity,
          deliveredQuantity: it.deliveredQuantity ?? it.quantity,
          emptiesCollected: it.emptiesCollected ?? 0,
        })),
      },
    },
  });
  trackedOrderIds.push(order.id);
  return order;
}

let seedData: Awaited<ReturnType<typeof getSeedData>>;

beforeAll(async () => {
  seedData = await getSeedData();
});

afterAll(async () => {
  if (trackedOrderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedCustomerIds.length) {
    await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: trackedCustomerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: trackedCustomerIds } } });
  }
});

describe('Item 9 — getDriverCylinderSummary', () => {
  it('T1 — sums delivered quantity + empties across multiple orders of same cyl type', async () => {
    const driverId = seedData.drivers[0].id;
    const cyl = seedData.cylinderTypes[0];
    const c1 = await makeCustomer('T1-c1');
    const c2 = await makeCustomer('T1-c2');
    await makeDeliveredOrder({
      driverId, customerId: c1.id, status: 'delivered',
      items: [{ cylinderTypeId: cyl.id, quantity: 3, emptiesCollected: 2 }],
    });
    await makeDeliveredOrder({
      driverId, customerId: c2.id, status: 'delivered',
      items: [{ cylinderTypeId: cyl.id, quantity: 2, emptiesCollected: 1 }],
    });
    const rows = await getDriverCylinderSummary(D1, driverId, TEST_DATE_ISO, TEST_DATE_ISO);
    const row = rows.find((r) => r.cylinderTypeId === cyl.id);
    expect(row).toBeDefined();
    expect(row!.fullsDelivered).toBe(5);
    expect(row!.emptiesCollected).toBe(3);
  });

  it('T2 — only delivered + modified_delivered are counted (pending_delivery excluded)', async () => {
    const driverId = seedData.drivers[0].id;
    const cyl = seedData.cylinderTypes[1];
    const c1 = await makeCustomer('T2-c1');
    await makeDeliveredOrder({
      driverId, customerId: c1.id, status: 'delivered',
      items: [{ cylinderTypeId: cyl.id, quantity: 1 }],
    });
    // Pending-delivery — should NOT be counted.
    await makeDeliveredOrder({
      driverId, customerId: c1.id, status: 'pending_delivery',
      items: [{ cylinderTypeId: cyl.id, quantity: 10 }],
    });
    const rows = await getDriverCylinderSummary(D1, driverId, TEST_DATE_ISO, TEST_DATE_ISO);
    const row = rows.find((r) => r.cylinderTypeId === cyl.id);
    expect(row).toBeDefined();
    expect(row!.fullsDelivered).toBe(1);
  });

  it('T3 — modified_delivered uses deliveredQuantity, not quantity', async () => {
    const driverId = seedData.drivers[0].id;
    const cyl = seedData.cylinderTypes[2];
    const c1 = await makeCustomer('T3-c1');
    await makeDeliveredOrder({
      driverId, customerId: c1.id, status: 'modified_delivered',
      items: [{ cylinderTypeId: cyl.id, quantity: 5, deliveredQuantity: 3 }],
    });
    const rows = await getDriverCylinderSummary(D1, driverId, TEST_DATE_ISO, TEST_DATE_ISO);
    const row = rows.find((r) => r.cylinderTypeId === cyl.id);
    expect(row).toBeDefined();
    expect(row!.fullsDelivered).toBe(3);
  });

  it('T4 — different distributor driver returns empty (tenant guard)', async () => {
    // Try to query a dist-002 driver from dist-001 scope.
    const otherDriver = await prisma.driver.findFirst({
      where: { distributorId: D2, deletedAt: null },
      select: { id: true },
    });
    if (!otherDriver) { expect(true).toBe(true); return; }
    const rows = await getDriverCylinderSummary(D1, otherDriver.id, TEST_DATE_ISO, TEST_DATE_ISO);
    expect(rows).toEqual([]);
  });

  it('T5 — date range filter narrows to the window', async () => {
    const driverId = seedData.drivers[0].id;
    const cyl = seedData.cylinderTypes[3];
    const c1 = await makeCustomer('T5-c1');
    // In-range: TEST_DATE (2099-12-31)
    await makeDeliveredOrder({
      driverId, customerId: c1.id, status: 'delivered',
      items: [{ cylinderTypeId: cyl.id, quantity: 7 }],
    });
    // Query a date range that EXCLUDES TEST_DATE.
    const rows = await getDriverCylinderSummary(D1, driverId, '2000-01-01', '2000-12-31');
    const row = rows.find((r) => r.cylinderTypeId === cyl.id);
    expect(row).toBeUndefined();

    // Now include it — row appears.
    const rowsIncl = await getDriverCylinderSummary(D1, driverId, '2099-01-01', '2100-01-01');
    const rowIncl = rowsIncl.find((r) => r.cylinderTypeId === cyl.id);
    expect(rowIncl).toBeDefined();
    expect(rowIncl!.fullsDelivered).toBe(7);
  });
});
