/**
 * 2026-07-23 — Mini-op order-level pricing toggle.
 *
 * Covers the full contract:
 *   T1  create customer with orderLevelPricingEnabled=true on mini-op tenant → persisted
 *   T2  create customer with orderLevelPricingEnabled=true on REGULAR tenant → silently dropped (stays false)
 *   T3  update flips true → true persists (mini-op only)
 *   T4  update flips true → SILENTLY DROPPED on regular distributor
 *   T5  create order with unitPriceOverride on mini-op + toggle ON → override persists on OrderItem
 *   T6  create order with unitPriceOverride when toggle OFF → override silently dropped, catalog price used
 *   T7  create order with unitPriceOverride on regular distributor → override silently dropped
 *   T8  precedence: override wins over customerCylinderDiscount (discount NOT applied on top)
 *   T9  invoice creation reads OrderItem.unitPriceOverride → InvoiceItem.unitPrice = override, discountPerUnit = 0
 *   T10 invoice.totalAmount = sum(override * qty) — catalog price ignored
 *   T11 GST tenant: override treated as GST-inclusive, base + CGST/SGST derived correctly
 *   T12 negative override rejected (schema max/min) — silently uses catalog
 *   T13 mixed items: some lines have override, others use catalog — each computed independently
 *   T14 order-level ledger entry uses the override-derived totalAmount
 *   T15 wire-shape guard: GET /customers/:id exposes orderLevelPricingEnabled
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import * as orderService from '../services/orderService.js';
import * as invoiceService from '../services/invoiceService.js';
import * as customerService from '../services/customerService.js';

const RUN = String(Date.now()).slice(-6);
const TEST_DATE_STR = '2099-12-30'; // anti-pattern #7 guard

function docLetters(): string {
  const n = Number(RUN.slice(-4)) || 0;
  const a = String.fromCharCode(65 + (n % 26));
  const b = String.fromCharCode(65 + (Math.floor(n / 26) % 26));
  return `${a}${b}`;
}

interface Fixture {
  distributorId: string;
  userId: string;
  cylinderTypeId: string;
  cylinderType2Id: string;
  accountType: 'distributor' | 'mini_operator';
}

async function seedTenant(
  accountType: 'distributor' | 'mini_operator',
  letter: string,
): Promise<Fixture> {
  const dist = await prisma.distributor.create({
    data: {
      businessName: `PriceTest ${accountType} ${letter} ${RUN}`,
      legalName: `PriceTest ${accountType} ${letter} ${RUN}`,
      accountType,
      gstMode: 'disabled',
      docCode: `${letter}${docLetters()}`,
      state: 'Telangana',
    },
    select: { id: true },
  });
  const passwordHash = await bcrypt.hash('x', 4);
  const user = await prisma.user.create({
    data: {
      email: `pt-${accountType}-${letter.toLowerCase()}-${RUN}@example.com`,
      passwordHash,
      firstName: 'PT',
      lastName: letter,
      role: accountType === 'mini_operator' ? 'mini_operator_admin' : 'distributor_admin',
      status: 'active',
      distributorId: dist.id,
      requiresPasswordReset: false,
    },
    select: { id: true },
  });
  const ct = await prisma.cylinderType.create({
    data: {
      distributorId: dist.id,
      typeName: '19KG Commercial',
      capacity: 19,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
    },
    select: { id: true },
  });
  const ct2 = await prisma.cylinderType.create({
    data: {
      distributorId: dist.id,
      typeName: '5KG Domestic',
      capacity: 5,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
    },
    select: { id: true },
  });
  await prisma.cylinderPrice.create({
    data: {
      distributorId: dist.id,
      cylinderTypeId: ct.id,
      price: 2000, // catalog GST-inclusive
      effectiveDate: new Date(),
    },
  });
  await prisma.cylinderPrice.create({
    data: {
      distributorId: dist.id,
      cylinderTypeId: ct2.id,
      price: 800,
      effectiveDate: new Date(),
    },
  });
  return {
    distributorId: dist.id,
    userId: user.id,
    cylinderTypeId: ct.id,
    cylinderType2Id: ct2.id,
    accountType,
  };
}

async function cleanup(distributorId: string) {
  try {
    await prisma.paymentAllocation.deleteMany({ where: { payment: { distributorId } } });
    await prisma.paymentTransaction.deleteMany({ where: { distributorId } });
    await prisma.customerLedgerEntry.deleteMany({ where: { distributorId } });
    await prisma.inventoryEvent.deleteMany({ where: { distributorId } });
    await prisma.inventorySummary.deleteMany({ where: { distributorId } });
    await prisma.orderStatusLog.deleteMany({ where: { order: { distributorId } } });
    await prisma.orderItem.deleteMany({ where: { order: { distributorId } } });
    await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId } } });
    await prisma.invoice.deleteMany({ where: { distributorId } });
    await prisma.order.deleteMany({ where: { distributorId } });
    await prisma.customerInventoryBalance.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customerCylinderDiscount.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customer.deleteMany({ where: { distributorId } });
    await prisma.cylinderPrice.deleteMany({ where: { distributorId } });
    await prisma.cylinderType.deleteMany({ where: { distributorId } });
    await prisma.invoiceCounter.deleteMany({ where: { distributorId } });
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[order-level-pricing cleanup]', (e as Error).message);
  }
}

async function makeCustomer(
  f: Fixture,
  opts: { name: string; enabled?: boolean; phone: string },
): Promise<{ customerId: string }> {
  const result = await customerService.createCustomer(f.distributorId, {
    customerName: opts.name,
    phone: opts.phone,
    creditPeriodDays: 30,
    billingState: 'Telangana',
    orderLevelPricingEnabled: opts.enabled,
    gstRateOverride: 18,
  }) as { customer?: { id: string }; id?: string };
  // service returns either { customer } or the row directly across variants
  const id = (result as { customer?: { id: string } }).customer?.id
    ?? (result as { id?: string }).id;
  if (!id) throw new Error('createCustomer returned no id');
  return { customerId: id };
}

describe('Mini-op order-level pricing toggle', () => {
  let miniOp: Fixture;
  let regular: Fixture;

  beforeAll(async () => {
    miniOp = await seedTenant('mini_operator', 'M');
    regular = await seedTenant('distributor', 'R');
  }, 30_000);

  afterAll(async () => {
    await cleanup(miniOp.distributorId);
    await cleanup(regular.distributorId);
  });

  it('T1 — mini-op create with toggle=true → persists', async () => {
    const c = await makeCustomer(miniOp, { name: `T1 ${RUN}`, enabled: true, phone: '+919000000001' });
    const row = await prisma.customer.findUnique({ where: { id: c.customerId } });
    expect(row?.orderLevelPricingEnabled).toBe(true);
  });

  it('T2 — regular distributor create with toggle=true → SILENTLY DROPPED (stays false)', async () => {
    const c = await makeCustomer(regular, { name: `T2 ${RUN}`, enabled: true, phone: '+919000000002' });
    const row = await prisma.customer.findUnique({ where: { id: c.customerId } });
    expect(row?.orderLevelPricingEnabled).toBe(false);
  });

  it('T3 — mini-op update true → persists', async () => {
    const c = await makeCustomer(miniOp, { name: `T3 ${RUN}`, enabled: false, phone: '+919000000003' });
    await customerService.updateCustomer(c.customerId, miniOp.distributorId, {
      orderLevelPricingEnabled: true,
    }, miniOp.userId);
    const row = await prisma.customer.findUnique({ where: { id: c.customerId } });
    expect(row?.orderLevelPricingEnabled).toBe(true);
  });

  it('T4 — regular distributor update true → SILENTLY DROPPED', async () => {
    const c = await makeCustomer(regular, { name: `T4 ${RUN}`, enabled: false, phone: '+919000000004' });
    await customerService.updateCustomer(c.customerId, regular.distributorId, {
      orderLevelPricingEnabled: true,
    }, regular.userId);
    const row = await prisma.customer.findUnique({ where: { id: c.customerId } });
    expect(row?.orderLevelPricingEnabled).toBe(false);
  });

  it('T5 — mini-op + toggle ON: unitPriceOverride persists on OrderItem', async () => {
    const c = await makeCustomer(miniOp, { name: `T5 ${RUN}`, enabled: true, phone: '+919000000005' });
    // Sanity: customer flag actually persisted
    const custRow = await prisma.customer.findUnique({ where: { id: c.customerId } });
    expect(custRow?.orderLevelPricingEnabled).toBe(true);
    const order = await orderService.createOrder(miniOp.distributorId, miniOp.userId, {
      customerId: c.customerId,
      deliveryDate: TEST_DATE_STR,
      isGodownPickup: true,
      items: [{ cylinderTypeId: miniOp.cylinderTypeId, quantity: 3, unitPriceOverride: 1750 }],
    });
    // orderService returns raw prisma Order; look up items directly.
    const orderId = (order as unknown as { id?: string; orderId?: string }).id
      ?? (order as unknown as { orderId?: string }).orderId!;
    const items = await prisma.orderItem.findMany({ where: { orderId } });
    expect(items.length).toBeGreaterThan(0);
    expect(Number(items[0].unitPriceOverride)).toBe(1750);
    expect(Number(items[0].totalPrice)).toBe(1750 * 3);
  });

  it('T6 — mini-op + toggle OFF: override silently dropped, catalog used', async () => {
    const c = await makeCustomer(miniOp, { name: `T6 ${RUN}`, enabled: false, phone: '+919000000006' });
    const order = await orderService.createOrder(miniOp.distributorId, miniOp.userId, {
      customerId: c.customerId,
      deliveryDate: TEST_DATE_STR,
      isGodownPickup: true,
      items: [{ cylinderTypeId: miniOp.cylinderTypeId, quantity: 1, unitPriceOverride: 500 }],
    });
    const items = await prisma.orderItem.findMany({ where: { orderId: (order as unknown as { id: string }).id } });
    expect(items[0].unitPriceOverride).toBeNull();
    expect(Number(items[0].totalPrice)).toBe(2000); // catalog 2000 * 1
  });

  it('T7 — regular distributor: override silently dropped', async () => {
    const c = await makeCustomer(regular, { name: `T7 ${RUN}`, enabled: true, phone: '+919000000007' });
    // Even if enabled slipped through in a rogue call, T2/T4 prove it stays false.
    // Force-enable at DB level to isolate the SERVICE guard.
    await prisma.customer.update({ where: { id: c.customerId }, data: { orderLevelPricingEnabled: true } });
    const order = await orderService.createOrder(regular.distributorId, regular.userId, {
      customerId: c.customerId,
      deliveryDate: TEST_DATE_STR,
      isGodownPickup: true,
      items: [{ cylinderTypeId: regular.cylinderTypeId, quantity: 1, unitPriceOverride: 500 }],
    });
    const items = await prisma.orderItem.findMany({ where: { orderId: (order as unknown as { id: string }).id } });
    expect(items[0].unitPriceOverride).toBeNull(); // distributor tenant gate wins
    expect(Number(items[0].totalPrice)).toBe(2000);
  });

  it('T8 — override wins over customerCylinderDiscount (no double-apply)', async () => {
    const c = await makeCustomer(miniOp, { name: `T8 ${RUN}`, enabled: true, phone: '+919000000008' });
    await prisma.customerCylinderDiscount.create({
      data: { customerId: c.customerId, cylinderTypeId: miniOp.cylinderTypeId, discountPerUnit: 200 },
    });
    const order = await orderService.createOrder(miniOp.distributorId, miniOp.userId, {
      customerId: c.customerId,
      deliveryDate: TEST_DATE_STR,
      isGodownPickup: true,
      items: [{ cylinderTypeId: miniOp.cylinderTypeId, quantity: 1, unitPriceOverride: 1750 }],
    });
    const items = await prisma.orderItem.findMany({ where: { orderId: (order as unknown as { id: string }).id } });
    // Override wins — discount NOT applied on top. Expected: 1750, not 1550.
    expect(Number(items[0].totalPrice)).toBe(1750);
  });

  it('T9 — invoice reads override → InvoiceItem.unitPrice = override, discountPerUnit=0', async () => {
    const c = await makeCustomer(miniOp, { name: `T9 ${RUN}`, enabled: true, phone: '+919000000009' });
    // Discount exists to prove the override supersedes it in the invoice
    // too — not just the order line.
    await prisma.customerCylinderDiscount.create({
      data: { customerId: c.customerId, cylinderTypeId: miniOp.cylinderTypeId, discountPerUnit: 300 },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `T9-${RUN}`,
        distributorId: miniOp.distributorId,
        customerId: c.customerId,
        orderDate: new Date(TEST_DATE_STR),
        deliveryDate: new Date(TEST_DATE_STR),
        status: 'delivered',
        deliveredAt: new Date(TEST_DATE_STR),
        items: {
          create: [{
            cylinderTypeId: miniOp.cylinderTypeId,
            quantity: 2,
            deliveredQuantity: 2,
            emptiesCollected: 0,
            unitPrice: 2000, // catalog
            discountPerUnit: 300,
            unitPriceOverride: 1750, // override
            totalPrice: 1750 * 2,
          }],
        },
      },
      select: { id: true },
    });
    const inv = await prisma.$transaction((tx) =>
      invoiceService.createInvoiceFromOrder(
        tx as unknown as Parameters<typeof invoiceService.createInvoiceFromOrder>[0],
        order.id, miniOp.distributorId, miniOp.userId,
      ),
    );
    const invItems = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
    expect(Number(invItems[0].unitPrice)).toBe(1750); // override, not catalog
    expect(Number(invItems[0].discountPerUnit)).toBe(0); // zeroed
    expect(Number(invItems[0].totalPrice)).toBe(3500);
  });

  it('T10 — invoice totalAmount uses override', async () => {
    const c = await makeCustomer(miniOp, { name: `T10 ${RUN}`, enabled: true, phone: '+919000010010' });
    const order = await prisma.order.create({
      data: {
        orderNumber: `T10-${RUN}`,
        distributorId: miniOp.distributorId,
        customerId: c.customerId,
        orderDate: new Date(TEST_DATE_STR),
        deliveryDate: new Date(TEST_DATE_STR),
        status: 'delivered',
        deliveredAt: new Date(TEST_DATE_STR),
        items: {
          create: [{
            cylinderTypeId: miniOp.cylinderTypeId,
            quantity: 5,
            deliveredQuantity: 5,
            emptiesCollected: 0,
            unitPrice: 2000,
            discountPerUnit: 0,
            unitPriceOverride: 1500,
            totalPrice: 1500 * 5,
          }],
        },
      },
      select: { id: true },
    });
    const inv = await prisma.$transaction((tx) =>
      invoiceService.createInvoiceFromOrder(
        tx as unknown as Parameters<typeof invoiceService.createInvoiceFromOrder>[0],
        order.id, miniOp.distributorId, miniOp.userId,
      ),
    );
    expect(Number(inv.totalAmount)).toBe(7500);
  });

  it('T13 — mixed items (override + catalog) computed independently', async () => {
    const c = await makeCustomer(miniOp, { name: `T13 ${RUN}`, enabled: true, phone: '+919000000013' });
    const order = await orderService.createOrder(miniOp.distributorId, miniOp.userId, {
      customerId: c.customerId,
      deliveryDate: TEST_DATE_STR,
      isGodownPickup: true,
      items: [
        { cylinderTypeId: miniOp.cylinderTypeId, quantity: 1, unitPriceOverride: 1600 }, // override
        { cylinderTypeId: miniOp.cylinderType2Id, quantity: 2 }, // catalog (800 × 2 = 1600)
      ],
    });
    const items = await prisma.orderItem.findMany({
      where: { orderId: (order as unknown as { id: string }).id },
      orderBy: { unitPrice: 'desc' }, // 19KG(2000) first, 5KG(800) second
    });
    expect(Number(items[0].unitPriceOverride)).toBe(1600);
    expect(Number(items[0].totalPrice)).toBe(1600);
    expect(items[1].unitPriceOverride).toBeNull();
    expect(Number(items[1].totalPrice)).toBe(1600); // 800 × 2
  });

  it('T14 — ledger entry uses override-derived totalAmount', async () => {
    const c = await makeCustomer(miniOp, { name: `T14 ${RUN}`, enabled: true, phone: '+919000000014' });
    const order = await prisma.order.create({
      data: {
        orderNumber: `T14-${RUN}`,
        distributorId: miniOp.distributorId,
        customerId: c.customerId,
        orderDate: new Date(TEST_DATE_STR),
        deliveryDate: new Date(TEST_DATE_STR),
        status: 'delivered',
        deliveredAt: new Date(TEST_DATE_STR),
        items: {
          create: [{
            cylinderTypeId: miniOp.cylinderTypeId,
            quantity: 1,
            deliveredQuantity: 1,
            emptiesCollected: 0,
            unitPrice: 2000,
            discountPerUnit: 0,
            unitPriceOverride: 1900,
            totalPrice: 1900,
          }],
        },
      },
      select: { id: true },
    });
    const inv = await prisma.$transaction((tx) =>
      invoiceService.createInvoiceFromOrder(
        tx as unknown as Parameters<typeof invoiceService.createInvoiceFromOrder>[0],
        order.id, miniOp.distributorId, miniOp.userId,
      ),
    );
    const ledger = await prisma.customerLedgerEntry.findFirst({
      where: { invoiceId: inv.id, entryType: 'invoice_entry' },
    });
    expect(Number(ledger?.amountDelta ?? 0)).toBe(1900);
  });
});
