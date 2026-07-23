/**
 * 2026-07-23 — Mini-op delivered-order cancellation flow.
 *
 * Covers the extended `orderService.cancelOrder` contract:
 *   - Delivered order + mini-op tenant + cancellationType → succeeds.
 *   - Regular distributor tenant tries delivered cancel → 400.
 *   - Missing cancellationType on delivered cancel → 400.
 *   - Payment allocation without applyAsCustomerCredit → 409.
 *   - Payment allocation with applyAsCustomerCredit → reversed to
 *     Customer.onAccountBalance.
 *   - Ledger reversal: negative-delta row with "Cancelled:" narration.
 *   - Inventory rollback matrix per cancellation type.
 *   - Next invoice auto-consumes onAccountBalance.
 *
 * TEST_DATE avoids anti-pattern #7 (time-sensitive fixtures on shared
 * dev DB). Fixtures use their own tenant so cross-tenant regression
 * from other suites doesn't hijack rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import * as orderService from '../services/orderService.js';
import * as invoiceService from '../services/invoiceService.js';

const RUN = String(Date.now()).slice(-6);
const TEST_DATE = new Date('2099-12-31'); // anti-pattern #7 guard

// Turn the timestamp suffix into a 2-letter suffix so we can build a
// 3-char docCode (numberingService constraint). Two letters gives 26*26
// buckets — enough to avoid collision across consecutive test runs on
// the shared dev DB.
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
  customerId: string;
  accountType: 'distributor' | 'mini_operator';
}

async function seedTenant(
  accountType: 'distributor' | 'mini_operator',
  letter: string,
): Promise<Fixture> {
  const dist = await prisma.distributor.create({
    data: {
      businessName: `CancelTest ${accountType} ${letter} ${RUN}`,
      legalName: `CancelTest ${accountType} ${letter} ${RUN}`,
      accountType,
      gstMode: 'disabled',
      docCode: `${letter}${docLetters()}`, // 3 uppercase letters — numberingService constraint
      state: 'Telangana',
    },
    select: { id: true },
  });
  const passwordHash = await bcrypt.hash('x', 4);
  const user = await prisma.user.create({
    data: {
      email: `ct-${accountType}-${letter.toLowerCase()}-${RUN}@example.com`,
      passwordHash,
      firstName: 'CT',
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
  await prisma.cylinderPrice.create({
    data: {
      distributorId: dist.id,
      cylinderTypeId: ct.id,
      price: 2000,
      effectiveDate: new Date(),
    },
  });
  const cust = await prisma.customer.create({
    data: {
      distributorId: dist.id,
      customerName: `Cancel Cust ${letter} ${RUN}`,
      customerType: 'B2C',
      phone: `+91999999${letter.charCodeAt(0)}${RUN.slice(-2)}`,
      status: 'active',
      creditPeriodDays: 30,
      billingState: 'Telangana',
    },
    select: { id: true },
  });
  return {
    distributorId: dist.id,
    userId: user.id,
    cylinderTypeId: ct.id,
    customerId: cust.id,
    accountType,
  };
}

async function cleanup(distributorId: string) {
  try {
    await prisma.paymentAllocation.deleteMany({ where: { distributorId } });
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
    await prisma.customer.deleteMany({ where: { distributorId } });
    await prisma.cylinderPrice.deleteMany({ where: { distributorId } });
    await prisma.cylinderType.deleteMany({ where: { distributorId } });
    await prisma.invoiceCounter.deleteMany({ where: { distributorId } });
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[cancel-order cleanup]', (e as Error).message);
  }
}

async function seedDeliveredOrder(
  f: Fixture,
  opts: { qty: number; empties: number; orderNumber: string },
): Promise<{ orderId: string; invoiceId: string }> {
  const order = await prisma.order.create({
    data: {
      orderNumber: opts.orderNumber,
      distributorId: f.distributorId,
      customerId: f.customerId,
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      status: 'delivered',
      deliveredAt: TEST_DATE,
      items: {
        create: [{
          cylinderTypeId: f.cylinderTypeId,
          quantity: opts.qty,
          deliveredQuantity: opts.qty,
          emptiesCollected: opts.empties,
          unitPrice: 2000,
          discountPerUnit: 0,
          totalPrice: 2000,
        }],
      },
    },
    select: { id: true },
  });
  const invoiceId = await prisma.$transaction(async (tx) => {
    const inv = await invoiceService.createInvoiceFromOrder(
      tx as unknown as Parameters<typeof invoiceService.createInvoiceFromOrder>[0],
      order.id,
      f.distributorId,
      f.userId,
    );
    return inv.id;
  });
  return { orderId: order.id, invoiceId };
}

describe('Mini-op delivered-order cancellation', () => {
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

  it('T1 — wrong_customer: full reversal + ledger + inventory', async () => {
    const { orderId, invoiceId } = await seedDeliveredOrder(miniOp, {
      qty: 3, empties: 3, orderNumber: `CT-T1-${RUN}`,
    });
    const cancelled = await orderService.cancelOrder(
      orderId, miniOp.distributorId, miniOp.userId,
      'Delivered to wrong customer',
      { cancellationType: 'wrong_customer' },
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationType).toBe('wrong_customer');
    // Invoice soft-cancelled with audit trail
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe('cancelled');
    expect(inv?.deletedAt).toBeNull(); // spec: stays visible on Invoices list
    expect(inv?.cancellationType).toBe('wrong_customer');
    expect(Number(inv?.outstandingAmount)).toBe(0);
    // Reversal ledger entry with "Cancelled:" narration + negative delta
    const reversal = await prisma.customerLedgerEntry.findFirst({
      where: { invoiceId, entryType: 'adjustment' },
    });
    expect(reversal?.narration.startsWith('Cancelled:')).toBe(true);
    expect(Number(reversal?.amountDelta ?? 0)).toBeLessThan(0);
    // Inventory: fulls returned to godown (fullsChange=+3) + empties
    // returned to customer (emptiesChange=-3 from our stock).
    const events = await prisma.inventoryEvent.findMany({
      where: { distributorId: miniOp.distributorId, referenceId: orderId },
      orderBy: { createdAt: 'asc' },
    });
    const cancelEvents = events.filter((e) => e.eventType === 'cancellation');
    expect(cancelEvents.length).toBeGreaterThanOrEqual(2);
    const fullsBack = cancelEvents.find((e) => e.fullsChange === 3);
    const emptiesOut = cancelEvents.find((e) => e.emptiesChange === -3);
    expect(fullsBack).toBeDefined();
    expect(emptiesOut).toBeDefined();
  });

  it('T2 — damaged_returned: fulls back, empties stay with us', async () => {
    const { orderId } = await seedDeliveredOrder(miniOp, {
      qty: 2, empties: 2, orderNumber: `CT-T2-${RUN}`,
    });
    await orderService.cancelOrder(
      orderId, miniOp.distributorId, miniOp.userId,
      'Cylinder was damaged',
      { cancellationType: 'damaged_returned' },
    );
    const events = await prisma.inventoryEvent.findMany({
      where: { distributorId: miniOp.distributorId, referenceId: orderId, eventType: 'cancellation' },
    });
    // Only one cancellation event: fulls back to godown. No empties event.
    const emptiesEvent = events.find((e) => e.emptiesChange !== 0);
    expect(emptiesEvent).toBeUndefined();
    const fullsBack = events.find((e) => e.fullsChange === 2);
    expect(fullsBack).toBeDefined();
  });

  it('T3 — customer_refused: fulls back, empties returned', async () => {
    const { orderId } = await seedDeliveredOrder(miniOp, {
      qty: 1, empties: 1, orderNumber: `CT-T3-${RUN}`,
    });
    await orderService.cancelOrder(
      orderId, miniOp.distributorId, miniOp.userId,
      'Customer refused delivery',
      { cancellationType: 'customer_refused' },
    );
    const events = await prisma.inventoryEvent.findMany({
      where: { distributorId: miniOp.distributorId, referenceId: orderId, eventType: 'cancellation' },
    });
    const fullsBack = events.find((e) => e.fullsChange === 1);
    const emptiesOut = events.find((e) => e.emptiesChange === -1);
    expect(fullsBack).toBeDefined();
    expect(emptiesOut).toBeDefined();
  });

  it('T4 — regular distributor delivered-cancel is rejected with helpful message', async () => {
    const { orderId } = await seedDeliveredOrder(regular, {
      qty: 1, empties: 1, orderNumber: `CT-T4-${RUN}`,
    });
    await expect(
      orderService.cancelOrder(
        orderId, regular.distributorId, regular.userId,
        'Try to cancel a delivered order',
        { cancellationType: 'wrong_customer' },
      ),
    ).rejects.toThrow(/Credit Note/i);
  });

  it('T5 — delivered cancel without cancellationType → 400', async () => {
    const { orderId } = await seedDeliveredOrder(miniOp, {
      qty: 1, empties: 0, orderNumber: `CT-T5-${RUN}`,
    });
    await expect(
      orderService.cancelOrder(
        orderId, miniOp.distributorId, miniOp.userId,
        'Missing type',
        {},
      ),
    ).rejects.toThrow(/cancellationType is required/i);
  });

  it('T6 — payment applied → 409 without applyAsCustomerCredit', async () => {
    const { orderId, invoiceId } = await seedDeliveredOrder(miniOp, {
      qty: 1, empties: 0, orderNumber: `CT-T6-${RUN}`,
    });
    // Record a payment for ₹1000 allocated to this invoice.
    const pmt = await prisma.paymentTransaction.create({
      data: {
        distributorId: miniOp.distributorId,
        customerId: miniOp.customerId,
        amount: 1000,
        paymentMethod: 'cash',
        transactionDate: TEST_DATE,
        receivedBy: miniOp.userId,
      },
      select: { id: true },
    });
    await prisma.paymentAllocation.create({
      data: {
        paymentId: pmt.id,
        invoiceId,
        allocatedAmount: 1000,
      },
    });
    let threw = false;
    try {
      await orderService.cancelOrder(
        orderId, miniOp.distributorId, miniOp.userId,
        'Cancel with payment applied',
        { cancellationType: 'wrong_customer' },
      );
    } catch (e) {
      threw = true;
      const err = e as { statusCode?: number; code?: string; allocatedAmount?: number };
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('PAYMENT_APPLIED');
      expect(err.allocatedAmount).toBe(1000);
    }
    expect(threw).toBe(true);
  });

  it('T7 — payment applied + applyAsCustomerCredit → allocation reversed, on-account credited', async () => {
    const { orderId, invoiceId } = await seedDeliveredOrder(miniOp, {
      qty: 1, empties: 0, orderNumber: `CT-T7-${RUN}`,
    });
    const pmt = await prisma.paymentTransaction.create({
      data: {
        distributorId: miniOp.distributorId,
        customerId: miniOp.customerId,
        amount: 1500,
        paymentMethod: 'cash',
        transactionDate: TEST_DATE,
        receivedBy: miniOp.userId,
      },
      select: { id: true },
    });
    await prisma.paymentAllocation.create({
      data: { paymentId: pmt.id, invoiceId, allocatedAmount: 1500 },
    });
    const before = await prisma.customer.findUnique({
      where: { id: miniOp.customerId },
      select: { onAccountBalance: true },
    });
    await orderService.cancelOrder(
      orderId, miniOp.distributorId, miniOp.userId,
      'Convert to credit',
      { cancellationType: 'wrong_customer', applyAsCustomerCredit: true },
    );
    // Allocation deleted, customer.onAccountBalance incremented by 1500.
    const allocCount = await prisma.paymentAllocation.count({ where: { invoiceId } });
    expect(allocCount).toBe(0);
    const after = await prisma.customer.findUnique({
      where: { id: miniOp.customerId },
      select: { onAccountBalance: true },
    });
    const beforeAmt = Number(before?.onAccountBalance ?? 0);
    const afterAmt = Number(after?.onAccountBalance ?? 0);
    expect(afterAmt - beforeAmt).toBeCloseTo(1500, 2);
  });

  it('T8 — next invoice auto-applies on-account credit', async () => {
    // Bump credit to a known ₹500 for a clean assertion.
    await prisma.customer.update({
      where: { id: miniOp.customerId },
      data: { onAccountBalance: 500 },
    });
    // Seed a new delivered order and let invoiceService create the invoice.
    const order = await prisma.order.create({
      data: {
        orderNumber: `CT-T8-${RUN}`,
        distributorId: miniOp.distributorId,
        customerId: miniOp.customerId,
        orderDate: TEST_DATE,
        deliveryDate: TEST_DATE,
        status: 'delivered',
        deliveredAt: TEST_DATE,
        items: {
          create: [{
            cylinderTypeId: miniOp.cylinderTypeId,
            quantity: 1,
            deliveredQuantity: 1,
            emptiesCollected: 0,
            unitPrice: 2000,
            discountPerUnit: 0,
            totalPrice: 2000,
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
    // Invoice total 2000, credit 500 applied → outstanding 1500, amountPaid 500.
    expect(Number(inv.totalAmount)).toBe(2000);
    expect(Number(inv.outstandingAmount)).toBe(1500);
    expect(Number(inv.amountPaid)).toBe(500);
    // Customer's on-account balance now 0.
    const after = await prisma.customer.findUnique({
      where: { id: miniOp.customerId },
      select: { onAccountBalance: true },
    });
    expect(Number(after?.onAccountBalance ?? 0)).toBe(0);
    // Ledger has both rows: the debit AND the credit-applied row.
    const rows = await prisma.customerLedgerEntry.findMany({
      where: { invoiceId: inv.id },
    });
    const debit = rows.find((r) => Number(r.amountDelta) > 0);
    const credit = rows.find((r) => Number(r.amountDelta) < 0 && r.narration.startsWith('On-account credit applied'));
    expect(debit).toBeDefined();
    expect(credit).toBeDefined();
    expect(Number(debit?.amountDelta)).toBe(2000);
    expect(Number(credit?.amountDelta)).toBe(-500);
  });
});
