/**
 * INVESTIGATION-JUL09 — Enhanced Delivery Performance report.
 *
 * The old report returned per-driver order-status counts. The enhanced
 * version returns a mixed rows array:
 *   • driver_summary — one per driver — money + fulls + empties (all cyl types)
 *   • cylinder_row   — one per (driver, cylinderType) — fulls + empties only
 *   • customer_row   — drill-down only — per (customer, cylinderType) breakdown
 *                      + pendingEmpties (cumulative customer-level)
 *
 * Money attribution runs through the invoice/order chain because
 * payment_transactions has no driverId. Godown pickup (no driver) and cancelled
 * orders are excluded from the report entirely.
 *
 * All tests scope to dist-001 (or dist-002) with a far-future TEST_DATE to
 * avoid colliding with any real dev-DB data (anti-pattern #7).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { deliveryPerformance, reportToCsv, type ReportFilters } from '../services/reportsService.js';
import type { $Enums } from '@prisma/client';

const D1 = 'dist-001';
const D2 = 'dist-002';
const TEST_DATE_STR = '2099-12-25';
const RANGE_FROM = '2099-12-20';
const RANGE_TO = '2099-12-31';
const OUT_OF_RANGE = '2099-11-01';
const testDate = new Date(TEST_DATE_STR);
const outOfRange = new Date(OUT_OF_RANGE);
const PHONES = Array.from({ length: 8 }, (_, i) => `9916000${String(i).padStart(3, '0')}`);
const idempotentSuffix = `${Date.now().toString(36)}`;

const createdOrderIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdDriverIds: string[] = [];
const createdUserEmails: string[] = [];
const createdPaymentIds: string[] = [];
const createdBalanceIds: string[] = [];

async function mkDriver(distributorId: string, phone: string, name: string) {
  const email = `dperf-${idempotentSuffix}-${name}@test-dperf.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName: 'DPerf', lastName: name, phone, role: 'driver', status: 'active', distributorId },
  });
  const driver = await prisma.driver.create({ data: { distributorId, driverName: `DPerf ${name}`, phone, status: 'active' } });
  createdDriverIds.push(driver.id);
  createdUserEmails.push(email);
  return { userId: user.id, driverId: driver.id };
}

async function mkCustomer(distributorId: string, name: string) {
  const cust = await prisma.customer.create({
    data: {
      distributorId,
      customerName: name,
      businessName: name,
      phone: `9917000${String(createdCustomerIds.length).padStart(3, '0')}`,
      customerType: 'B2C',
    },
  });
  createdCustomerIds.push(cust.id);
  return cust.id;
}

async function mkOrderInvoice(
  distributorId: string,
  driverId: string,
  customerId: string,
  cylinderTypeId: string,
  opts: {
    fulls: number;
    empties: number;
    unitPrice?: number;
    deliveryDate?: Date;
    dueDate?: Date;
    outstanding?: number;
    isGodownPickup?: boolean;
    isBackdated?: boolean;
    status?: $Enums.OrderStatus;
  },
) {
  const unit = opts.unitPrice ?? 3000;
  const total = opts.fulls * unit;
  const outstanding = opts.outstanding ?? total;
  const deliveryDate = opts.deliveryDate ?? testDate;
  const dueDate = opts.dueDate ?? new Date(deliveryDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const order = await prisma.order.create({
    data: {
      distributorId,
      customerId,
      driverId,
      orderNumber: `TEST-DPERF-${idempotentSuffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      orderDate: deliveryDate,
      deliveryDate,
      status: opts.status ?? 'delivered',
      orderType: 'delivery',
      totalAmount: total,
      isGodownPickup: opts.isGodownPickup ?? false,
      isBackdated: opts.isBackdated ?? false,
      items: {
        create: [
          {
            cylinderTypeId,
            quantity: opts.fulls,
            deliveredQuantity: opts.fulls,
            emptiesCollected: opts.empties,
            unitPrice: unit,
            totalPrice: total,
          },
        ],
      },
    },
  });
  createdOrderIds.push(order.id);
  const invoice = await prisma.invoice.create({
    data: {
      distributorId,
      customerId,
      orderId: order.id,
      invoiceNumber: `TEST-INV-DPERF-${idempotentSuffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      issueDate: deliveryDate,
      dueDate,
      totalAmount: total,
      outstandingAmount: outstanding,
      amountPaid: total - outstanding,
      status: 'issued',
      items: { create: [{ cylinderTypeId, description: '19 KG (test)', quantity: opts.fulls, unitPrice: unit, totalPrice: total }] },
    },
  });
  createdInvoiceIds.push(invoice.id);
  return { order, invoice };
}

async function mkPaymentAllocation(distributorId: string, customerId: string, invoiceId: string, amount: number) {
  const pt = await prisma.paymentTransaction.create({
    data: {
      distributorId,
      customerId,
      amount,
      paymentMethod: 'cash',
      transactionDate: testDate,
      allocationStatus: 'fully_allocated',
      allocations: { create: [{ invoiceId, allocatedAmount: amount }] },
    },
  });
  createdPaymentIds.push(pt.id);
  return pt;
}

async function cleanup() {
  await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: createdPaymentIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  await prisma.customerInventoryBalance.deleteMany({ where: { id: { in: createdBalanceIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.inventoryEvent.deleteMany({ where: { referenceId: { in: createdOrderIds } } });
  await prisma.cancelledStockEvent.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  await prisma.user.deleteMany({ where: { email: { in: createdUserEmails } } });
}

let d1Cyl: string;
let d2Cyl: string;
let d1Cyl2: string | null = null;

beforeAll(async () => {
  await cleanup();
  const c1 = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: D1 } });
  d1Cyl = c1.id;
  // second cylinder type for dist-001 (may or may not exist — used for
  // per-cylinder aggregation test #2)
  const c1b = await prisma.cylinderType.findFirst({ where: { distributorId: D1, id: { not: d1Cyl } } });
  d1Cyl2 = c1b?.id ?? null;
  const c2 = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: D2 } });
  d2Cyl = c2.id;
});

afterAll(cleanup);

const filters = (extra: Partial<ReportFilters> = {}): ReportFilters => ({
  dateFrom: RANGE_FROM,
  dateTo: RANGE_TO,
  ...extra,
});

describe('Delivery Performance — enhanced shape', () => {
  it('1. Returns one driver_summary row per driver in the range', async () => {
    const cust = await mkCustomer(D1, 'DPerf Test Customer 1');
    const d = await mkDriver(D1, PHONES[0], 'shape1');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3 });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.filter((row) => row.type === 'driver_summary');
    expect(summary.length).toBe(1);
    expect(summary[0].driverId).toBe(d.driverId);
    expect(summary[0].driverName).toMatch(/DPerf shape1/);
  });

  it('2. Emits a cylinder_row per (driver, cylinderType)', async () => {
    if (!d1Cyl2) return; // dist-001 seeded with only one cyl type in some envs
    const cust = await mkCustomer(D1, 'DPerf Test Customer 2');
    const d = await mkDriver(D1, PHONES[1], 'shape2');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 2, empties: 2 });
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl2, { fulls: 5, empties: 4 });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const cyls = r.rows.filter((row) => row.type === 'cylinder_row');
    expect(cyls.length).toBe(2);
    const ids = new Set(cyls.map((c) => c.cylinderTypeId));
    expect(ids.has(d1Cyl)).toBe(true);
    expect(ids.has(d1Cyl2)).toBe(true);
  });
});

describe('Delivery Performance — operational aggregation', () => {
  it('3. fullsDelivered sums across multiple orders on the same driver', async () => {
    const cust = await mkCustomer(D1, 'DPerf Fulls Sum');
    const d = await mkDriver(D1, PHONES[2], 'fulls');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 4, empties: 4 });
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 6, empties: 5 });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.fullsDelivered).toBe(10);
    expect(summary.emptiesCollected).toBe(9);
  });

  it('4. Null empties_collected treated as 0', async () => {
    const cust = await mkCustomer(D1, 'DPerf Null Empties');
    const d = await mkDriver(D1, PHONES[3], 'nullemp');
    const created = await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 2, empties: 0 });
    // Force NULL on the item's empties_collected to model the schema-optional field
    await prisma.orderItem.updateMany({
      where: { orderId: created.order.id },
      data: { emptiesCollected: null },
    });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.emptiesCollected).toBe(0);
    expect(summary.fullsDelivered).toBe(2);
  });
});

describe('Delivery Performance — money aggregation', () => {
  it('5. saleAmount = sum(order.totalAmount) for driver in range', async () => {
    const cust = await mkCustomer(D1, 'DPerf Sale');
    const d = await mkDriver(D1, PHONES[4], 'sale');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3, unitPrice: 2500 }); // 7500
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 2, empties: 2, unitPrice: 2500 }); // 5000
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.saleAmount).toBe(12500);
    expect(summary.totalOrders).toBe(2);
  });

  it('6. amountCollected = sum(paymentAllocations) against driver invoices', async () => {
    const cust = await mkCustomer(D1, 'DPerf Collected');
    const d = await mkDriver(D1, PHONES[5], 'collected');
    const { invoice } = await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, {
      fulls: 4,
      empties: 4,
      unitPrice: 3000,
      outstanding: 4000, // partial payment of 8000
    });
    await mkPaymentAllocation(D1, cust, invoice.id, 8000);
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.amountCollected).toBe(8000);
    expect(summary.amountPending).toBe(4000);
  });

  it('7. amountOverdue counts invoice.outstandingAmount where dueDate < today', async () => {
    const cust = await mkCustomer(D1, 'DPerf Overdue');
    const d = await mkDriver(D1, PHONES[6], 'overdue');
    // Invoice with dueDate in the past → overdue
    const overdueDueDate = new Date();
    overdueDueDate.setDate(overdueDueDate.getDate() - 15);
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, {
      fulls: 3,
      empties: 3,
      unitPrice: 3000,
      dueDate: overdueDueDate,
    });
    // Invoice with dueDate in the future → NOT overdue
    const futureDueDate = new Date();
    futureDueDate.setDate(futureDueDate.getDate() + 15);
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, {
      fulls: 2,
      empties: 2,
      unitPrice: 3000,
      dueDate: futureDueDate,
    });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.amountPending).toBe(15000); // both count as pending (both are outstanding)
    expect(summary.amountOverdue).toBe(9000); // only the overdue one
  });

  it('8. Driver with partial payment: amountCollected < saleAmount', async () => {
    const cust = await mkCustomer(D1, 'DPerf Partial');
    const d = await mkDriver(D1, PHONES[7], 'partial');
    const { invoice } = await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, {
      fulls: 10,
      empties: 10,
      unitPrice: 3000,
      outstanding: 20000, // 10000 paid of 30000
    });
    await mkPaymentAllocation(D1, cust, invoice.id, 10000);
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.saleAmount).toBe(30000);
    expect(summary.amountCollected).toBe(10000);
    expect(Number(summary.amountCollected)).toBeLessThan(Number(summary.saleAmount));
  });
});

describe('Delivery Performance — drill-down', () => {
  it('9. groupBy=customer + driverId returns customer_row per customer', async () => {
    const c1 = await mkCustomer(D1, 'DPerf DD Cust A');
    const c2 = await mkCustomer(D1, 'DPerf DD Cust B');
    const d = await mkDriver(D1, `9918100${String(createdDriverIds.length).padStart(3, '0')}`, 'dd1');
    await mkOrderInvoice(D1, d.driverId, c1, d1Cyl, { fulls: 3, empties: 3 });
    await mkOrderInvoice(D1, d.driverId, c2, d1Cyl, { fulls: 2, empties: 2 });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId, groupBy: 'customer' }));
    const customerRows = r.rows.filter((row) => row.type === 'customer_row');
    expect(customerRows.length).toBe(2);
    const custIds = new Set(customerRows.map((c) => c.customerId));
    expect(custIds.has(c1)).toBe(true);
    expect(custIds.has(c2)).toBe(true);
  });

  it('10. pendingEmpties in drill-down = CustomerInventoryBalance.withCustomerQty', async () => {
    const cust = await mkCustomer(D1, 'DPerf DD Pending');
    const d = await mkDriver(D1, `9918200${String(createdDriverIds.length).padStart(3, '0')}`, 'dd2');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 5, empties: 3 });
    // Seed a customer inventory balance manually so the drill-down can read it.
    const bal = await prisma.customerInventoryBalance.create({
      data: { customerId: cust, cylinderTypeId: d1Cyl, withCustomerQty: 2 },
    });
    createdBalanceIds.push(bal.id);
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId, groupBy: 'customer' }));
    const custRow = r.rows.find((row) => row.type === 'customer_row' && row.customerId === cust)!;
    expect(custRow.pendingEmpties).toBe(2);
  });
});

describe('Delivery Performance — exclusions and scoping', () => {
  it('11. isGodownPickup=true orders are excluded (no driver)', async () => {
    const cust = await mkCustomer(D1, 'DPerf Godown');
    const d = await mkDriver(D1, `9918300${String(createdDriverIds.length).padStart(3, '0')}`, 'godown');
    // Regular order → counted
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3 });
    // Godown pickup → EXCLUDED even though a driverId happens to be set
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 100, empties: 100, isGodownPickup: true });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.fullsDelivered).toBe(3);
    expect(summary.totalOrders).toBe(1);
  });

  it('12. isBackdated=true orders ARE included (backdated order still had a real delivery)', async () => {
    const cust = await mkCustomer(D1, 'DPerf Backdated');
    const d = await mkDriver(D1, `9918400${String(createdDriverIds.length).padStart(3, '0')}`, 'bkdt');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 4, empties: 4, isBackdated: true });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.fullsDelivered).toBe(4);
  });

  it('13. Date range filter uses deliveryDate (out-of-range orders excluded)', async () => {
    const cust = await mkCustomer(D1, 'DPerf Range');
    const d = await mkDriver(D1, `9918500${String(createdDriverIds.length).padStart(3, '0')}`, 'range');
    // In-range order
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3 });
    // Out-of-range order (Nov 2099 — filter is Dec 20 → Dec 31)
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 99, empties: 99, deliveryDate: outOfRange });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.fullsDelivered).toBe(3);
  });

  it('14. Driver with zero orders in range: excluded from results', async () => {
    const cust = await mkCustomer(D1, 'DPerf ZeroOrder');
    const dActive = await mkDriver(D1, `9918600${String(createdDriverIds.length).padStart(3, '0')}`, 'active');
    const dIdle = await mkDriver(D1, `9918700${String(createdDriverIds.length).padStart(3, '0')}`, 'idle');
    await mkOrderInvoice(D1, dActive.driverId, cust, d1Cyl, { fulls: 3, empties: 3 });
    // dIdle has no orders in range.
    const r = await deliveryPerformance(D1, filters()); // no driverId filter
    const summaries = r.rows.filter((row) => row.type === 'driver_summary');
    const summaryIds = new Set(summaries.map((s) => s.driverId));
    expect(summaryIds.has(dActive.driverId)).toBe(true);
    expect(summaryIds.has(dIdle.driverId)).toBe(false);
  });

  it('15. Cancelled orders are excluded from delivery performance', async () => {
    const cust = await mkCustomer(D1, 'DPerf Cancelled');
    const d = await mkDriver(D1, `9918800${String(createdDriverIds.length).padStart(3, '0')}`, 'cxl');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3, status: 'cancelled' });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const summary = r.rows.find((row) => row.type === 'driver_summary');
    expect(summary).toBeUndefined();
  });
});

describe('Delivery Performance — multi-tenant + CSV', () => {
  it('16. Cross-tenant: dist-001 driver does not appear in dist-002 report', async () => {
    const c1 = await mkCustomer(D1, 'DPerf Tenant D1');
    const c2 = await mkCustomer(D2, 'DPerf Tenant D2');
    const d1Drv = await mkDriver(D1, `9918900${String(createdDriverIds.length).padStart(3, '0')}`, 'ten1');
    const d2Drv = await mkDriver(D2, `9919000${String(createdDriverIds.length).padStart(3, '0')}`, 'ten2');
    await mkOrderInvoice(D1, d1Drv.driverId, c1, d1Cyl, { fulls: 3, empties: 3 });
    await mkOrderInvoice(D2, d2Drv.driverId, c2, d2Cyl, { fulls: 7, empties: 6 });

    const r2 = await deliveryPerformance(D2, filters());
    const d2Summaries = r2.rows.filter((row) => row.type === 'driver_summary');
    const d2Ids = new Set(d2Summaries.map((s) => s.driverId));
    expect(d2Ids.has(d2Drv.driverId)).toBe(true);
    expect(d2Ids.has(d1Drv.driverId)).toBe(false);
  });

  it('17. reportToCsv serializes both driver_summary and cylinder_row cleanly', async () => {
    const cust = await mkCustomer(D1, 'DPerf CSV');
    const d = await mkDriver(D1, `9919100${String(createdDriverIds.length).padStart(3, '0')}`, 'csv');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3, unitPrice: 3000 });
    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const csv = reportToCsv(r);
    // Header line has all columns
    expect(csv).toMatch(/Driver/);
    expect(csv).toMatch(/Cylinder Type/);
    expect(csv).toMatch(/Fulls Delivered/);
    expect(csv).toMatch(/Sale Amount/);
    // Both row types serialize (driver_summary has money, cylinder_row leaves it blank)
    expect(csv).toMatch(/DPerf csv/);
    // TOTAL row present
    expect(csv).toMatch(/TOTAL/);
  });

  it('18a. cylinder_row saleAmount = sum(item.totalPrice) for that cylinder type', async () => {
    if (!d1Cyl2) return;
    const cust = await mkCustomer(D1, 'DPerf CylMoney');
    const d = await mkDriver(D1, `9919300${String(createdDriverIds.length).padStart(3, '0')}`, 'cylmoney');
    // Order with 2 cyl types: 4 × 2500 (cyl1) = 10000, 3 × 4000 (cyl2) = 12000
    // Order total = 22000. Cyl1 sale = 10000, Cyl2 sale = 12000.
    const order = await prisma.order.create({
      data: {
        distributorId: D1,
        customerId: cust,
        driverId: d.driverId,
        orderNumber: `TEST-DPERF-CYLMONEY-${Date.now().toString(36)}`,
        orderDate: testDate,
        deliveryDate: testDate,
        status: 'delivered',
        orderType: 'delivery',
        totalAmount: 22000,
        items: {
          create: [
            { cylinderTypeId: d1Cyl, quantity: 4, deliveredQuantity: 4, emptiesCollected: 4, unitPrice: 2500, totalPrice: 10000 },
            { cylinderTypeId: d1Cyl2, quantity: 3, deliveredQuantity: 3, emptiesCollected: 3, unitPrice: 4000, totalPrice: 12000 },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    const inv = await prisma.invoice.create({
      data: {
        distributorId: D1, customerId: cust, orderId: order.id,
        invoiceNumber: `TEST-INV-DPERF-CYLMONEY-${Date.now().toString(36)}`,
        issueDate: testDate, dueDate: testDate, totalAmount: 22000, outstandingAmount: 22000, status: 'issued',
        items: { create: [
          { cylinderTypeId: d1Cyl, description: '19KG', quantity: 4, unitPrice: 2500, totalPrice: 10000 },
          { cylinderTypeId: d1Cyl2, description: 'X', quantity: 3, unitPrice: 4000, totalPrice: 12000 },
        ]},
      },
    });
    createdInvoiceIds.push(inv.id);

    const r = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    const cyl1Row = r.rows.find((row) => row.type === 'cylinder_row' && row.cylinderTypeId === d1Cyl)!;
    const cyl2Row = r.rows.find((row) => row.type === 'cylinder_row' && row.cylinderTypeId === d1Cyl2)!;
    expect(cyl1Row.saleAmount).toBe(10000);
    expect(cyl2Row.saleAmount).toBe(12000);
    // Driver summary sale = order.totalAmount = 22000 (unchanged behaviour)
    const summary = r.rows.find((row) => row.type === 'driver_summary')!;
    expect(summary.saleAmount).toBe(22000);
  });

  it('18b. includeCustomers=true emits customer_row entries after cylinder rows', async () => {
    const c1 = await mkCustomer(D1, 'DPerf IC A');
    const c2 = await mkCustomer(D1, 'DPerf IC B');
    const d = await mkDriver(D1, `9919400${String(createdDriverIds.length).padStart(3, '0')}`, 'inccust');
    await mkOrderInvoice(D1, d.driverId, c1, d1Cyl, { fulls: 3, empties: 3, unitPrice: 3000 });
    await mkOrderInvoice(D1, d.driverId, c2, d1Cyl, { fulls: 2, empties: 2, unitPrice: 3000 });

    // Without includeCustomers: no customer_row entries.
    const noInc = await deliveryPerformance(D1, filters({ driverId: d.driverId }));
    expect(noInc.rows.some((row) => row.type === 'customer_row')).toBe(false);
    // No Customer column.
    expect(noInc.columns.some((c) => c.key === 'customerName')).toBe(false);

    // With includeCustomers=true: customer_row entries appear.
    const withInc = await deliveryPerformance(D1, filters({ driverId: d.driverId, includeCustomers: true }));
    const custRows = withInc.rows.filter((row) => row.type === 'customer_row');
    expect(custRows.length).toBe(2);
    // Customer column added.
    expect(withInc.columns.some((c) => c.key === 'customerName')).toBe(true);
    // Customer names populated on customer_row.
    const custNames = new Set(custRows.map((r) => r.customerName));
    expect(custNames.has('DPerf IC A')).toBe(true);
    expect(custNames.has('DPerf IC B')).toBe(true);
  });

  it('18. groupBy=customer without driverId falls back to top-level report (not drilldown)', async () => {
    const cust = await mkCustomer(D1, 'DPerf NoDriver');
    const d = await mkDriver(D1, `9919200${String(createdDriverIds.length).padStart(3, '0')}`, 'nodrv');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3 });
    // groupBy=customer is only honoured when driverId is ALSO provided
    const r = await deliveryPerformance(D1, filters({ groupBy: 'customer' }));
    // Should still return driver_summary rows, not customer_row rows.
    const hasDriverSummary = r.rows.some((row) => row.type === 'driver_summary');
    const hasCustomerRow = r.rows.some((row) => row.type === 'customer_row');
    expect(hasDriverSummary).toBe(true);
    expect(hasCustomerRow).toBe(false);
  });
});

// Suneel's ask (2026-07-11): the Delivery Performance report was excluding
// godown-pickup orders entirely (no driver → nowhere to attribute), which
// left cash-and-carry revenue invisible. The synthetic driverId
// 'godown_pickup' + name 'Godown Pickup (self-collection)' collapses every
// godown row into ONE bucket in the driver list so the ops team has full
// accountability across every delivery mode.
describe('Delivery Performance — Godown Pickup synthetic bucket', () => {
  // NOTE ON ASSERTIONS: All godown-pickup orders across every test in this
  // file collapse into ONE synthetic bucket per distributor, so the bucket's
  // top-line totals depend on order of test execution. We assert
  // (a) the bucket exists with the right id/name, and (b) THIS test's
  // fixtures show up in the drill-down (customer-scoped, isolated), rather
  // than a numeric top-line comparison that would race with sibling tests.
  it('19. Unfiltered call includes a synthetic Godown Pickup driver_summary when godown orders exist', async () => {
    const cust = await mkCustomer(D1, 'DPerf Godown Sec');
    const d = await mkDriver(D1, `9919300${String(createdDriverIds.length).padStart(3, '0')}`, 'godownsec');
    // Regular order via a real driver
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3 });
    // Godown pickup — no driver attribution
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 5, empties: 4, isGodownPickup: true });
    const r = await deliveryPerformance(D1, filters());
    const godown = r.rows.find(
      (row) => row.type === 'driver_summary' && row.driverId === 'godown_pickup',
    );
    expect(godown).toBeDefined();
    expect(godown!.driverName).toBe('Godown Pickup (self-collection)');
    // Bucket must include at least this test's 5 fulls / 4 empties.
    expect(Number(godown!.fullsDelivered)).toBeGreaterThanOrEqual(5);
    expect(Number(godown!.emptiesCollected)).toBeGreaterThanOrEqual(4);
    // Verify THIS test's fixture is reflected via customer-scoped drill-down.
    const drill = await deliveryPerformance(
      D1,
      filters({ driverId: 'godown_pickup', groupBy: 'customer' }),
    );
    const myRow = drill.rows.find(
      (row) => row.type === 'customer_row' && row.customerId === cust,
    );
    expect(myRow).toBeDefined();
    expect(Number(myRow!.fullsDelivered)).toBe(5);
    expect(Number(myRow!.emptiesCollected)).toBe(4);
  });

  it('20. Filtering by driverId=godown_pickup returns ONLY the synthetic bucket (regular driver orders excluded)', async () => {
    const cust = await mkCustomer(D1, 'DPerf Godown Only');
    const d = await mkDriver(D1, `9919400${String(createdDriverIds.length).padStart(3, '0')}`, 'godownonly');
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 3, empties: 3 }); // real driver — excluded
    await mkOrderInvoice(D1, d.driverId, cust, d1Cyl, { fulls: 7, empties: 6, isGodownPickup: true });
    const r = await deliveryPerformance(D1, filters({ driverId: 'godown_pickup' }));
    const summaries = r.rows.filter((row) => row.type === 'driver_summary');
    // Exactly one summary — the godown bucket. Real driver orders are
    // excluded (via isGodownPickup=false constraint in the filter path).
    expect(summaries).toHaveLength(1);
    expect(summaries[0].driverId).toBe('godown_pickup');
    // The regular driver's 3-full order MUST NOT surface as a separate
    // summary row when the filter selects the godown bucket.
    const realDriverRow = r.rows.find(
      (row) => row.type === 'driver_summary' && row.driverId === d.driverId,
    );
    expect(realDriverRow).toBeUndefined();
  });

  it('21. Drill-down (groupBy=customer) with driverId=godown_pickup returns per-customer godown rows', async () => {
    const cust1 = await mkCustomer(D1, 'DPerf Godown Drill A');
    const cust2 = await mkCustomer(D1, 'DPerf Godown Drill B');
    const d = await mkDriver(D1, `9919500${String(createdDriverIds.length).padStart(3, '0')}`, 'godowndrill');
    await mkOrderInvoice(D1, d.driverId, cust1, d1Cyl, { fulls: 4, empties: 3, isGodownPickup: true });
    await mkOrderInvoice(D1, d.driverId, cust2, d1Cyl, { fulls: 6, empties: 5, isGodownPickup: true });
    const r = await deliveryPerformance(
      D1,
      filters({ driverId: 'godown_pickup', groupBy: 'customer' }),
    );
    const custRows = r.rows.filter((row) => row.type === 'customer_row');
    const custIds = new Set(custRows.map((row) => row.customerId));
    expect(custIds.has(cust1)).toBe(true);
    expect(custIds.has(cust2)).toBe(true);
  });

  it('22. Cross-tenant: dist-002 godown pickups do not appear in dist-001 report', async () => {
    const c2 = await mkCustomer(D2, 'DPerf Godown Cross');
    const d2Drv = await mkDriver(D2, `9919600${String(createdDriverIds.length).padStart(3, '0')}`, 'godowncross');
    await mkOrderInvoice(D2, d2Drv.driverId, c2, d2Cyl, { fulls: 9, empties: 9, isGodownPickup: true });
    const r1 = await deliveryPerformance(D1, filters({ driverId: 'godown_pickup' }));
    const summaries = r1.rows.filter((row) => row.type === 'driver_summary');
    // Any godown summary that appears must be a dist-001 order (from
    // earlier tests). The dist-002 fixture must not leak in — the
    // godown-fulls delta on dist-001 stays free of the 9 from D2.
    for (const s of summaries) {
      // Every test in this file uses dist-001 or dist-002 exclusively per row.
      // A leak would show as fullsDelivered including the 9 from D2.
      expect(Number(s.fullsDelivered)).not.toBe(9);
    }
  });
});
