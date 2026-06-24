/**
 * Fix C (2026-06-11) — computeCustomerOverdue includes OB invoices.
 *
 * Pre-fix: the function read from Order + PaymentTransaction only, so
 * opening-balance invoices (no Order) were silently excluded from the
 * credit-gate overdue total. A customer with ₹15,000 pre-go-live debt
 * could keep placing orders even when credit was fully consumed.
 *
 * Now: OB invoices are merged into the FIFO list as synthetic
 * deliveries dated at issueDate. Same credit-period logic as real
 * deliveries — past the window → counts as overdue.
 *
 * Regression: getCustomerLedger's summary.overdueAmount used to
 * EXCLUDE OB from its own FIFO (the previous contract). It now
 * INCLUDES OB so the dashboard, statement, and credit gate all agree.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  computeCustomerOverdue,
  getCustomerLedger,
} from '../services/paymentService.js';
import { loginAsDistAdmin, today } from './helpers.js';

const TRACK = 'FixC-Overdue';
let distributorId: string;
let customerId: string;

async function cleanup() {
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.invoiceItem.deleteMany({
    where: { invoice: { distributorId, customer: { customerName: TRACK } } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.orderItem.deleteMany({
    where: { order: { distributorId, customer: { customerName: TRACK } } },
  });
  await prisma.order.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.paymentTransaction.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: TRACK },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, typeName: '19 KG' }, select: { id: true },
  });
  await cleanup();
  const c = await prisma.customer.create({
    data: {
      distributorId, customerName: TRACK, phone: '9100000800',
      customerType: 'B2C', creditPeriodDays: 30,
    },
  });
  customerId = c.id;
});

afterAll(async () => { await cleanup(); });

beforeEach(async () => {
  await prisma.customerLedgerEntry.deleteMany({ where: { distributorId, customerId } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId, customerId } } });
  await prisma.invoice.deleteMany({ where: { distributorId, customerId } });
  await prisma.orderItem.deleteMany({ where: { order: { distributorId, customerId } } });
  await prisma.order.deleteMany({ where: { distributorId, customerId } });
  await prisma.paymentTransaction.deleteMany({ where: { distributorId, customerId } });
});

async function seedOB(amount: number, dateIso: string) {
  const d = new Date(dateIso);
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: `${TRACK}-OB-${Math.random().toString(36).slice(2, 8)}`,
      distributorId, customerId,
      issueDate: d, dueDate: d,
      totalAmount: amount, outstandingAmount: amount, amountPaid: 0,
      status: 'overdue', isOpeningBalance: true,
    },
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId, customerId,
      entryType: 'invoice_entry',
      referenceId: inv.id, invoiceId: inv.id,
      amountDelta: amount, narration: 'Opening Balance b/f',
      entryDate: d,
    },
  });
  return inv;
}

async function seedPayment(amount: number, dateIso: string) {
  const d = new Date(dateIso);
  const pay = await prisma.paymentTransaction.create({
    data: {
      distributorId, customerId, amount,
      paymentMethod: 'cash', transactionDate: d,
      allocationStatus: 'unallocated', receivedBy: null,
    } as never,
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId, customerId,
      entryType: 'payment_entry',
      referenceId: pay.id, invoiceId: null,
      amountDelta: -amount, narration: 'Payment received',
      entryDate: d,
    },
  });
}

describe('Fix C — computeCustomerOverdue includes OB invoices', () => {
  it('positive: customer with only OB (issued 90 days ago, credit=30) → overdue includes the OB', async () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    await seedOB(15000, ninetyDaysAgo);
    const overdue = await computeCustomerOverdue(distributorId, customerId);
    expect(overdue).toBe(15000);
  });

  it('positive: OB + partial payment → overdue = OB - payment', async () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    await seedOB(15000, ninetyDaysAgo);
    await seedPayment(5000, today());
    const overdue = await computeCustomerOverdue(distributorId, customerId);
    expect(overdue).toBe(10000);
  });

  it('regression: customer with no OB returns same value as pre-fix', async () => {
    // No OB, no orders → 0
    const overdue = await computeCustomerOverdue(distributorId, customerId);
    expect(overdue).toBe(0);
  });

  it('negative: OB issued today (within credit window) does NOT count as overdue', async () => {
    const todayStr = today();
    await seedOB(15000, todayStr);
    const overdue = await computeCustomerOverdue(distributorId, customerId);
    expect(overdue).toBe(0); // within 30-day credit window
  });

  it('alignment: getCustomerLedger.summary.overdueAmount equals computeCustomerOverdue', async () => {
    // Fix C also flipped getCustomerLedger to include OB in its FIFO so
    // the two functions stay in lock-step. Without that change the
    // dashboard (computeCustomerOverdue) and the statement summary
    // (getCustomerLedger) would diverge by the OB total.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    await seedOB(15000, ninetyDaysAgo);
    const fromGate = await computeCustomerOverdue(distributorId, customerId);
    const ledger = await getCustomerLedger(distributorId, customerId);
    expect(ledger.summary.overdueAmount).toBe(fromGate);
  });
});
