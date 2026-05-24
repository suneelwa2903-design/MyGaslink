/**
 * WI-093 — customer portal order modify (modifyMyOrder).
 *
 * Quantity-only edit of a customer's own pending order. Covers the happy
 * path plus the three rejections: wrong customer (tenant/customer scope),
 * wrong status, invalid quantity.
 *
 * Fixtures use dedicated customers/orders on the far-future test date
 * (anti-pattern #7) and are torn down in afterAll. Orders carry no driverId
 * so the dispatch/preflight suites (which filter by driver+date) never sweep
 * them up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { modifyMyOrder, createMyOrder } from '../services/customerPortalService.js';
import { UserRole } from '@gaslink/shared';

const DIST = 'dist-002';
const TEST_DATE = new Date('2099-12-31');

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

const createdOrderIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdUserIds: string[] = [];

let cylId: string;
let customerA: { id: string };
let customerB: { id: string };
let userId: string;

async function makeCustomer(name: string) {
  const c = await prisma.customer.create({
    data: {
      distributorId: DIST,
      customerName: name,
      phone: '9' + Math.random().toString().slice(2, 11),
      customerType: 'B2C',
    },
  });
  createdCustomerIds.push(c.id);
  return c;
}

async function makeOrder(customerId: string, status: string, qty: number, unitPrice: number) {
  const order = await prisma.order.create({
    data: {
      distributorId: DIST,
      customerId,
      status: status as any,
      orderType: 'delivery',
      orderNumber: `MOD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      totalAmount: unitPrice * qty,
      items: {
        create: [{ cylinderTypeId: cylId, quantity: qty, unitPrice, totalPrice: unitPrice * qty }],
      },
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
  cylId = cyl.id;
  customerA = await makeCustomer('WI-093 Modify Cust A');
  customerB = await makeCustomer('WI-093 Modify Cust B');

  const user = await prisma.user.create({
    data: {
      email: `wi125-${Date.now()}@test.com`,
      passwordHash: 'x',
      firstName: 'WI125', lastName: 'User',
      phone: '9' + Math.random().toString().slice(2, 11),
      role: UserRole.CUSTOMER, status: 'active', provisioningStatus: 'active',
      distributorId: DIST, customerId: customerA.id, requiresPasswordReset: false,
    },
  });
  userId = user.id;
  createdUserIds.push(user.id);
});

afterAll(async () => {
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
});

describe('WI-093 — modifyMyOrder', () => {
  it('updates quantity + recomputes totals on a pending order', async () => {
    const order = await makeOrder(customerA.id, 'pending_dispatch', 2, 1000);

    const updated = await modifyMyOrder(DIST, customerA.id, order.id, [
      { cylinderTypeId: cylId, quantity: 5 },
    ]);

    expect(Number(updated.totalAmount)).toBe(5000);
    const item = updated.items.find((i: any) => i.cylinderTypeId === cylId)!;
    expect(item.quantity).toBe(5);
    expect(Number(item.totalPrice)).toBe(5000);

    // persisted
    const dbItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(dbItem.quantity).toBe(5);
  });

  it('rejects 404 when the order belongs to a different customer', async () => {
    const order = await makeOrder(customerA.id, 'pending_dispatch', 2, 1000);
    await expect(
      modifyMyOrder(DIST, customerB.id, order.id, [{ cylinderTypeId: cylId, quantity: 3 }]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects 400 when the order is no longer in a modifiable status', async () => {
    const order = await makeOrder(customerA.id, 'delivered', 2, 1000);
    await expect(
      modifyMyOrder(DIST, customerA.id, order.id, [{ cylinderTypeId: cylId, quantity: 3 }]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects 400 when a quantity is not a positive integer', async () => {
    const order = await makeOrder(customerA.id, 'pending_driver_assignment', 2, 1000);
    await expect(
      modifyMyOrder(DIST, customerA.id, order.id, [{ cylinderTypeId: cylId, quantity: 0 }]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('WI-125 — order date selection + edit', () => {
  it('creates a new order on the selected delivery date (not hardcoded tomorrow)', async () => {
    const order = await createMyOrder(DIST, customerA.id, userId, {
      deliveryDate: isoDay(0), // today
      items: [{ cylinderTypeId: cylId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    expect(order.deliveryDate.toISOString().split('T')[0]).toBe(isoDay(0));
  });

  it('rejects a new order with a delivery date beyond tomorrow (400)', async () => {
    await expect(
      createMyOrder(DIST, customerA.id, userId, {
        deliveryDate: isoDay(5),
        items: [{ cylinderTypeId: cylId, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('reschedules a pending order to a new in-window date', async () => {
    const order = await makeOrder(customerA.id, 'pending_dispatch', 2, 1000);
    const updated = await modifyMyOrder(
      DIST, customerA.id, order.id, [{ cylinderTypeId: cylId, quantity: 2 }], isoDay(1),
    );
    expect(updated.deliveryDate.toISOString().split('T')[0]).toBe(isoDay(1));
  });

  it('rejects an edit that pushes the delivery date beyond tomorrow (400)', async () => {
    const order = await makeOrder(customerA.id, 'pending_dispatch', 2, 1000);
    await expect(
      modifyMyOrder(DIST, customerA.id, order.id, [{ cylinderTypeId: cylId, quantity: 2 }], isoDay(5)),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
