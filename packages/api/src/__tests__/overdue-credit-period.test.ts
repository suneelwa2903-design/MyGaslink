/**
 * overdue-credit-period.test.ts
 *
 * Item-8 (docs/INVESTIGATION-JUL09-B.md): overdue derives from
 * `invoice.issueDate + customer.creditPeriodDays` at read time. The
 * frozen `invoice.dueDate` snapshot stays put as the legal-document
 * date; the aging readers all read live from the customer's CURRENT
 * credit period.
 *
 * These tests pin: bumping/shrinking a customer's creditPeriodDays
 * IMMEDIATELY reshapes the overdue surfaces without touching stored
 * invoice.dueDate values.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { getOverdueCallList, getDueAmountsReport, getDashboardStats } from '../services/analyticsService.js';
import { markOverdueInvoices } from '../services/invoiceService.js';
import { getSeedData } from './helpers.js';

const DIST = 'dist-001';

async function seedCustomerWithOpenInvoice(opts: {
  customerName: string;
  creditPeriodDays: number;
  issueDate: Date;
  outstandingAmount: number;
}): Promise<{ customerId: string; invoiceId: string }> {
  const seed = await getSeedData();
  const cyl = seed.cylinderTypes[0];
  const customer = await prisma.customer.create({
    data: {
      distributorId: DIST,
      customerName: `${opts.customerName}-${Date.now().toString(36)}`,
      customerType: 'B2C',
      phone: '+919999999999',
      billingAddressLine1: 'x',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
      creditPeriodDays: opts.creditPeriodDays,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `OVRD-${Date.now().toString(36)}`,
      distributorId: DIST,
      customerId: customer.id,
      orderDate: opts.issueDate,
      deliveryDate: opts.issueDate,
      status: 'delivered',
      totalAmount: opts.outstandingAmount,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          quantity: 1,
          unitPrice: opts.outstandingAmount,
          discountPerUnit: 0,
          totalPrice: opts.outstandingAmount,
        }],
      },
    },
  });
  const dueDate = new Date(opts.issueDate);
  dueDate.setDate(dueDate.getDate() + opts.creditPeriodDays);
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-OVRD-${Date.now().toString(36)}`,
      distributorId: DIST,
      customerId: customer.id,
      orderId: order.id,
      issueDate: opts.issueDate,
      dueDate,
      totalAmount: opts.outstandingAmount,
      amountPaid: 0,
      outstandingAmount: opts.outstandingAmount,
      status: 'issued',
    },
  });
  return { customerId: customer.id, invoiceId: invoice.id };
}

async function cleanup(customerIds: string[]) {
  if (customerIds.length === 0) return;
  const invoices = await prisma.invoice.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true, orderId: true },
  });
  const orderIds = invoices.map((i) => i.orderId).filter((v): v is string => !!v);
  await prisma.paymentAllocation.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { customerId: { in: customerIds } } });
  if (orderIds.length > 0) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
}

describe('Item 8 — overdue derives from creditPeriodDays live', () => {
  const createdCustomerIds: string[] = [];

  afterAll(async () => {
    await cleanup(createdCustomerIds);
  });

  it('T1 — bumping creditPeriodDays 30→45 pushes an invoice OFF the overdue call list when the derived cutoff moves past today', async () => {
    // issueDate = 40 days ago. At 30d credit: overdue by 10 days. At
    // 45d credit: not overdue yet.
    const issueDate = new Date();
    issueDate.setDate(issueDate.getDate() - 40);
    issueDate.setHours(0, 0, 0, 0);
    const { customerId } = await seedCustomerWithOpenInvoice({
      customerName: 'ItemT1',
      creditPeriodDays: 30,
      issueDate,
      outstandingAmount: 500,
    });
    createdCustomerIds.push(customerId);

    // At 30d credit: appears in overdue list.
    let list = await getOverdueCallList(DIST);
    expect(list.some((r) => r.customerId === customerId)).toBe(true);

    // Bump credit period to 45 (SIMULATES the user changing customer
    // form). No invoice mutation.
    await prisma.customer.update({ where: { id: customerId }, data: { creditPeriodDays: 45 } });

    // Now the derived due (issue + 45d) is 5 days in the future — NOT overdue.
    list = await getOverdueCallList(DIST);
    expect(list.some((r) => r.customerId === customerId)).toBe(false);
  });

  it('T2 — shrinking creditPeriodDays 30→15 pulls an invoice ONTO the overdue list even though stored dueDate is future', async () => {
    // issueDate = 20 days ago. At 30d credit: not overdue (due at day 30).
    // At 15d credit: overdue by 5 days.
    const issueDate = new Date();
    issueDate.setDate(issueDate.getDate() - 20);
    issueDate.setHours(0, 0, 0, 0);
    const { customerId } = await seedCustomerWithOpenInvoice({
      customerName: 'ItemT2',
      creditPeriodDays: 30,
      issueDate,
      outstandingAmount: 700,
    });
    createdCustomerIds.push(customerId);

    let list = await getOverdueCallList(DIST);
    expect(list.some((r) => r.customerId === customerId)).toBe(false);

    await prisma.customer.update({ where: { id: customerId }, data: { creditPeriodDays: 15 } });

    list = await getOverdueCallList(DIST);
    const row = list.find((r) => r.customerId === customerId);
    expect(row).toBeDefined();
    expect(row!.daysOverdue).toBeGreaterThanOrEqual(4);
    expect(row!.daysOverdue).toBeLessThanOrEqual(6);
  });

  it('T3 — getDueAmountsReport.overdueDays reflects current credit period', async () => {
    const issueDate = new Date();
    issueDate.setDate(issueDate.getDate() - 50);
    issueDate.setHours(0, 0, 0, 0);
    const { customerId } = await seedCustomerWithOpenInvoice({
      customerName: 'ItemT3',
      creditPeriodDays: 30,
      issueDate,
      outstandingAmount: 900,
    });
    createdCustomerIds.push(customerId);

    let rows = await getDueAmountsReport(DIST);
    const rowAt30 = rows.find((r) => r.customerId === customerId);
    expect(rowAt30).toBeDefined();
    // At 30d credit: overdue by ~20 days.
    expect(rowAt30!.overdueDays).toBeGreaterThanOrEqual(19);
    expect(rowAt30!.overdueDays).toBeLessThanOrEqual(21);

    // Bump to 60d — no longer overdue.
    await prisma.customer.update({ where: { id: customerId }, data: { creditPeriodDays: 60 } });
    rows = await getDueAmountsReport(DIST);
    const rowAt60 = rows.find((r) => r.customerId === customerId);
    expect(rowAt60).toBeDefined();
    expect(rowAt60!.overdueDays).toBe(0);
  });

  it('T4 — Dashboard overdue count reflects current credit period (not stored status flag)', async () => {
    const issueDate = new Date();
    issueDate.setDate(issueDate.getDate() - 40);
    issueDate.setHours(0, 0, 0, 0);
    const { customerId, invoiceId } = await seedCustomerWithOpenInvoice({
      customerName: 'ItemT4',
      creditPeriodDays: 30,
      issueDate,
      outstandingAmount: 1100,
    });
    createdCustomerIds.push(customerId);

    // Verify the seed didn't accidentally set status='overdue' (we want
    // the check to be about the derived cutoff, not the stale flag).
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe('issued');

    const stats1 = await getDashboardStats(DIST);
    const overdueBefore = stats1.overdueInvoices;
    expect(overdueBefore).toBeGreaterThanOrEqual(1);

    // Bump credit period well past today — invoice should drop out of
    // the derived overdue count.
    await prisma.customer.update({ where: { id: customerId }, data: { creditPeriodDays: 120 } });

    const stats2 = await getDashboardStats(DIST);
    expect(stats2.overdueInvoices).toBe(overdueBefore - 1);
  });

  it('T5 — markOverdueInvoices flips status based on derived cutoff, not stored dueDate', async () => {
    // issueDate 40d ago, credit 30d → derived 10d in past → overdue.
    // Stored dueDate is 30d after issueDate (past). Confirms flag flip.
    const issueDate = new Date();
    issueDate.setDate(issueDate.getDate() - 40);
    issueDate.setHours(0, 0, 0, 0);
    const { customerId, invoiceId } = await seedCustomerWithOpenInvoice({
      customerName: 'ItemT5',
      creditPeriodDays: 30,
      issueDate,
      outstandingAmount: 800,
    });
    createdCustomerIds.push(customerId);

    let inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe('issued');

    await markOverdueInvoices(DIST);
    inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe('overdue');

    // Now bump credit period so it's NOT overdue by derivation. Reset
    // status to 'issued' (simulating a fresh state), rerun mark — should
    // NOT flip to overdue.
    await prisma.customer.update({ where: { id: customerId }, data: { creditPeriodDays: 120 } });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'issued' } });
    await markOverdueInvoices(DIST);
    inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe('issued');
  });
});
