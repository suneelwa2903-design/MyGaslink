/**
 * Brief 3 — Backdated / on-demand order+invoice.
 *
 * Covers the locked design from docs/BACKDATED-INVOICE-INVESTIGATION.md:
 *   - Zod: same-month + before-today + vehicle-needs-driver guards
 *   - Service: atomic Order+Invoice+Payment, status=delivered,
 *     isBackdated=true, historical deliveredAt/orderDate/deliveryDate
 *   - Invoice.issueDate = backdated date
 *   - NO inventory events, NO CustomerInventoryBalance update
 *   - processInvoiceGst fires post-commit for B2B
 *   - Wire-shape: response carries isBackdated=true
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { backdatedOrderSchema, localTodayISO } from '@gaslink/shared';
import { createBackdatedOrder } from '../services/backdatedOrderService.js';
import * as gstService from '../services/gst/gstService.js';

// Dist-001 is the GST-disabled tenant — keeps tests off the WhiteBooks
// sandbox path. createBackdatedOrder still routes through processInvoiceGst
// post-commit, but for a gstMode=disabled distributor that's a no-op.
const D1 = 'dist-001';

const trackedOrderIds: string[] = [];
const trackedInvoiceIds: string[] = [];
const trackedPaymentIds: string[] = [];
const trackedCustomerIds: string[] = [];

/** Yesterday in local TZ as YYYY-MM-DD. Falls back to first-of-month if today IS the 1st. */
function yesterdayLocalISO(): string {
  const t = new Date();
  t.setDate(t.getDate() - 1);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  const yesterday = `${y}-${m}-${d}`;
  // If yesterday spilled into last month, fall back to today (validation
  // will fail in those calls — tests that need a valid in-month date
  // should call hasValidBackdatedSlot() first).
  if (!yesterday.startsWith(localTodayISO().slice(0, 8))) return localTodayISO();
  return yesterday;
}

function hasValidBackdatedSlot(): boolean {
  return yesterdayLocalISO() < localTodayISO();
}

async function makeCustomer(name: string, type: 'B2B' | 'B2C') {
  const c = await prisma.customer.create({
    data: {
      distributorId: D1,
      customerName: `${name}-${Date.now().toString(36)}`,
      customerType: type,
      phone: '+919999999999',
      gstin: type === 'B2B' ? '29ABCDE1234F1Z5' : null,
      billingAddressLine1: 'Test St',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
      creditPeriodDays: 30,
    },
    select: { id: true, customerType: true },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function ensurePrice(cylinderTypeId: string, price = 1000) {
  // Seed an effective cylinder price so getEffectivePrice resolves. The
  // model has no unique key on (distributor, cyl, date) — just find or
  // create.
  const existing = await prisma.cylinderPrice.findFirst({
    where: { distributorId: D1, cylinderTypeId, effectiveDate: new Date('2024-01-01') },
  });
  if (!existing) {
    await prisma.cylinderPrice.create({
      data: { distributorId: D1, cylinderTypeId, effectiveDate: new Date('2024-01-01'), price },
    });
  }
}

describe('backdatedOrderSchema — Zod guards', () => {
  const baseBody = {
    customerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    items: [{ cylinderTypeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', quantity: 1 }],
  };

  it('rejects a date from last month', () => {
    const today = new Date();
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
    const y = lastMonth.getFullYear();
    const m = String(lastMonth.getMonth() + 1).padStart(2, '0');
    const lastMonthDate = `${y}-${m}-15`;
    const r = backdatedOrderSchema.safeParse({ ...baseBody, issueDate: lastMonthDate });
    expect(r.success).toBe(false);
  });

  it("rejects today's date", () => {
    const r = backdatedOrderSchema.safeParse({ ...baseBody, issueDate: localTodayISO() });
    expect(r.success).toBe(false);
  });

  it('rejects a future date', () => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const future = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const r = backdatedOrderSchema.safeParse({ ...baseBody, issueDate: future });
    expect(r.success).toBe(false);
  });

  it('accepts a valid backdated date within the current month', () => {
    // Only meaningful when there IS a valid slot (skip on the 1st).
    if (!hasValidBackdatedSlot()) {
      expect(true).toBe(true);
      return;
    }
    const r = backdatedOrderSchema.safeParse({ ...baseBody, issueDate: yesterdayLocalISO() });
    expect(r.success).toBe(true);
  });

  it('rejects vehicleId without driverId', () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const r = backdatedOrderSchema.safeParse({
      ...baseBody, issueDate: yesterdayLocalISO(),
      vehicleId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    });
    expect(r.success).toBe(false);
  });

  it('accepts vehicleId + driverId together', () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const r = backdatedOrderSchema.safeParse({
      ...baseBody, issueDate: yesterdayLocalISO(),
      driverId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      vehicleId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    });
    expect(r.success).toBe(true);
  });
});

describe('createBackdatedOrder — service', () => {
  let ctId: string;
  const processGstSpy = vi.spyOn(gstService, 'processInvoiceGst');

  beforeAll(async () => {
    // Reuse an existing active cylinder type — seeding here would collide
    // with unique constraints on shared distributor data.
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    ctId = ct.id;
    await ensurePrice(ctId);
  });

  it('lands order in status=delivered with isBackdated=true and historical timestamps', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const customer = await makeCustomer('Backdated B2B basic', 'B2B');
    const issueDate = yesterdayLocalISO();
    const result = await createBackdatedOrder(D1, 'test-user', {
      customerId: customer.id,
      issueDate,
      items: [{ cylinderTypeId: ctId, quantity: 2 }],
    });
    trackedOrderIds.push(result.order.id);
    if (result.invoice) trackedInvoiceIds.push(result.invoice.id);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.order.id } });
    expect(order.status).toBe('delivered');
    expect(order.isBackdated).toBe(true);
    // Historical timestamps land on issueDate (UTC midnight of that date).
    expect(order.deliveredAt?.toISOString().slice(0, 10)).toBe(issueDate);
    expect(order.orderDate.toISOString().slice(0, 10)).toBe(issueDate);
    expect(order.deliveryDate.toISOString().slice(0, 10)).toBe(issueDate);
    // createdAt stays "now" — within the last minute.
    const createdAtMs = order.createdAt.getTime();
    expect(Date.now() - createdAtMs).toBeLessThan(60_000);

    // Invoice
    expect(result.invoice).toBeTruthy();
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoice!.id } });
    expect(inv.issueDate.toISOString().slice(0, 10)).toBe(issueDate);
    expect(inv.orderId).toBe(order.id);

    // No inventory events were written for this order.
    const events = await prisma.inventoryEvent.count({ where: { referenceId: order.id } });
    expect(events).toBe(0);

    // CustomerInventoryBalance unchanged for this customer.
    const balance = await prisma.customerInventoryBalance.findFirst({
      where: { customerId: customer.id, cylinderTypeId: ctId },
    });
    expect(balance).toBeNull();
  });

  it('records payment in same transaction when payment provided', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const customer = await makeCustomer('Backdated with payment', 'B2B');
    const result = await createBackdatedOrder(D1, 'test-user', {
      customerId: customer.id,
      issueDate: yesterdayLocalISO(),
      items: [{ cylinderTypeId: ctId, quantity: 1 }],
      payment: {
        amount: 1000, paymentMethod: 'cash',
        referenceNumber: 'BACKDATED-PAY-1',
      },
    });
    trackedOrderIds.push(result.order.id);
    if (result.invoice) trackedInvoiceIds.push(result.invoice.id);

    const payments = await prisma.paymentTransaction.findMany({
      where: { customerId: customer.id, referenceNumber: 'BACKDATED-PAY-1' },
      select: { id: true, amount: true, allocationStatus: true },
    });
    expect(payments).toHaveLength(1);
    trackedPaymentIds.push(payments[0].id);
    expect(Number(payments[0].amount)).toBe(1000);

    // Invoice outstanding reduced by allocation.
    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoice!.id } });
    expect(Number(invoiceAfter.amountPaid)).toBeGreaterThan(0);
    expect(Number(invoiceAfter.outstandingAmount)).toBeLessThan(Number(invoiceAfter.totalAmount));
  });

  it('calls processInvoiceGst post-commit', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const customer = await makeCustomer('Backdated GST trigger', 'B2B');
    processGstSpy.mockClear();
    const result = await createBackdatedOrder(D1, 'test-user', {
      customerId: customer.id,
      issueDate: yesterdayLocalISO(),
      items: [{ cylinderTypeId: ctId, quantity: 1 }],
    });
    trackedOrderIds.push(result.order.id);
    if (result.invoice) trackedInvoiceIds.push(result.invoice.id);

    // Small grace for the post-commit fire-and-forget.
    await new Promise((r) => setTimeout(r, 50));
    expect(processGstSpy).toHaveBeenCalledWith(result.invoice!.id, D1);
  });

  it('multi-tenant: rejects a customer that belongs to a different distributor', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    // dist-002 customer — won't exist on dist-001 scope.
    const other = await prisma.customer.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
      select: { id: true },
    });
    if (!other) { expect(true).toBe(true); return; }
    await expect(
      createBackdatedOrder(D1, 'test-user', {
        customerId: other.id,
        issueDate: yesterdayLocalISO(),
        items: [{ cylinderTypeId: ctId, quantity: 1 }],
      }),
    ).rejects.toThrow(/Customer not found/i);
  });

  it('service-layer defence: rejects last-month date even if bypassed', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const customer = await makeCustomer('Backdated DiD', 'B2B');
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const stale = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-15`;
    await expect(
      createBackdatedOrder(D1, 'test-user', {
        customerId: customer.id, issueDate: stale,
        items: [{ cylinderTypeId: ctId, quantity: 1 }],
      }),
    ).rejects.toThrow(/within the current calendar month/i);
  });

  it('service-layer defence: rejects today and future dates', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const customer = await makeCustomer('Backdated today guard', 'B2B');
    await expect(
      createBackdatedOrder(D1, 'test-user', {
        customerId: customer.id, issueDate: localTodayISO(),
        items: [{ cylinderTypeId: ctId, quantity: 1 }],
      }),
    ).rejects.toThrow(/before today/i);
  });
});

afterAll(async () => {
  if (trackedPaymentIds.length) {
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: trackedPaymentIds } } });
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: trackedPaymentIds } } });
  }
  if (trackedInvoiceIds.length) {
    await prisma.gstApiLog.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: trackedInvoiceIds } } });
  }
  if (trackedOrderIds.length) {
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedCustomerIds.length) {
    // Soft-delete — customers accumulate FK refs (ledger, audit) that the
    // standard hard-delete can't cascade cleanly. The unique random-suffixed
    // names already prevent any name collision across test runs.
    await prisma.customer.updateMany({
      where: { id: { in: trackedCustomerIds } },
      data: { deletedAt: new Date() },
    });
  }
});
