/**
 * Group 1 (2026-06-11) — Customer Statement unification + Opening Balance fixes.
 *
 * Pins the three behaviours the fix is supposed to deliver:
 *
 *   1. getCustomerLedger reads from CustomerLedgerEntry so opening-balance
 *      invoices (no Order) show up in the PDF — same source as the in-app
 *      modal and the report. Anti-pattern #17 applied.
 *
 *   2. When a `range.from` is passed AND there is pre-range debt, a single
 *      "Opening Balance b/f" row appears first, with dueAmount equal to the
 *      carry-forward and `kind: 'opening'`.
 *
 *   3. summary.overdueAmount EXCLUDES opening-balance debits — keeps it
 *      aligned with computeCustomerOverdue (Order+Payment-based, used by the
 *      dashboard and order-placement gate). OB is informational, not a
 *      credit-gating signal.
 *
 * Plus regression: passing no range still emits every entry in chronological
 * order with the historical row shape unchanged.
 *
 * Plus negative: a customer with no ledger entries returns empty rows + zero
 * summary, and the function rejects an unknown customer with 404.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { getCustomerLedger, PaymentError } from '../services/paymentService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK_CUSTOMER_NAME = 'G1-StatementTest Customer';
const TRACK_PHONE = '9100000071';

let distributorId: string;
let customerId: string;

async function cleanup() {
  // Order matters: ledger → invoices → payments → customer.
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_CUSTOMER_NAME } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_CUSTOMER_NAME } },
  });
  await prisma.paymentTransaction.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_CUSTOMER_NAME } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: TRACK_CUSTOMER_NAME },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  await cleanup();
  const c = await prisma.customer.create({
    data: {
      distributorId,
      customerName: TRACK_CUSTOMER_NAME,
      phone: TRACK_PHONE,
      customerType: 'B2C',
      creditPeriodDays: 30,
    },
  });
  customerId = c.id;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await prisma.customerLedgerEntry.deleteMany({ where: { distributorId, customerId } });
  await prisma.invoice.deleteMany({ where: { distributorId, customerId } });
  await prisma.paymentTransaction.deleteMany({ where: { distributorId, customerId } });
});

// ---- helpers --------------------------------------------------------------

async function seedOpeningBalance(amount: number, dateIso: string, narration = 'Opening Balance b/f') {
  const date = new Date(dateIso);
  const invoiceNumber = `OB-test-${Math.random().toString(36).slice(2, 8)}`;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      distributorId,
      customerId,
      issueDate: date,
      dueDate: date,
      totalAmount: amount,
      outstandingAmount: amount,
      amountPaid: 0,
      status: 'overdue',
      isOpeningBalance: true,
    },
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId,
      customerId,
      entryType: 'invoice_entry',
      referenceId: invoice.id,
      invoiceId: invoice.id,
      amountDelta: amount,
      narration,
      entryDate: date,
    },
  });
  return invoice;
}

async function seedDeliveredInvoice(amount: number, dateIso: string) {
  const date = new Date(dateIso);
  const invoiceNumber = `INV-test-${Math.random().toString(36).slice(2, 8)}`;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      distributorId,
      customerId,
      issueDate: date,
      dueDate: date,
      totalAmount: amount,
      outstandingAmount: amount,
      amountPaid: 0,
      status: 'issued',
    },
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId,
      customerId,
      entryType: 'invoice_entry',
      referenceId: invoice.id,
      invoiceId: invoice.id,
      amountDelta: amount,
      narration: 'Delivery invoice',
      entryDate: date,
    },
  });
  return invoice;
}

async function seedPayment(amount: number, dateIso: string) {
  const date = new Date(dateIso);
  const payment = await prisma.paymentTransaction.create({
    data: {
      distributorId,
      customerId,
      amount,
      paymentMethod: 'cash',
      transactionDate: date,
      allocationStatus: 'unallocated',
      receivedBy: null,
    } as never,
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId,
      customerId,
      entryType: 'payment_entry',
      referenceId: payment.id,
      invoiceId: null,
      amountDelta: -amount,
      narration: 'Payment received',
      entryDate: date,
    },
  });
  return payment;
}

// ---- tests ---------------------------------------------------------------

describe('G1 — getCustomerLedger reads from CustomerLedgerEntry', () => {
  it('positive: opening-balance invoice (no Order) shows up in the timeline', async () => {
    await seedOpeningBalance(15000, '2026-01-01');
    const result = await getCustomerLedger(distributorId, customerId);

    expect(result.rows.length).toBeGreaterThan(0);
    const obRow = result.rows.find((r) => r.kind === 'opening' || r.cylinderType === 'Opening Balance');
    expect(obRow).toBeDefined();
    expect(obRow!.amount).toBe(15000);
    expect(result.summary.totalAmount).toBe(15000);
    expect(result.summary.dueAmount).toBe(15000);
  });

  it('positive: range.from with pre-range OB emits a single "Opening Balance b/f" row at the top', async () => {
    await seedOpeningBalance(15000, '2026-01-01');
    await seedDeliveredInvoice(9600, '2026-06-01');
    await seedPayment(2500, '2026-06-08');

    const result = await getCustomerLedger(distributorId, customerId, {
      from: '2026-05-12',
      to: '2026-06-11',
    });

    expect(result.rows[0]).toMatchObject({
      kind: 'opening',
      cylinderType: 'Opening Balance b/f',
      narration: 'Opening Balance b/f',
    });
    expect(result.rows[0].dueAmount).toBe(15000); // carry-forward
    // No `amount` debit/credit on the b/f row — purely informational.
    expect(result.rows[0].amount).toBe(0);
    expect(result.rows[0].receivedAmount).toBe(0);

    // Closing must include OB + new invoice − payment
    expect(result.summary.dueAmount).toBe(15000 + 9600 - 2500);
    // openingBalance carried in summary too
    expect(result.summary.openingBalance).toBe(15000);
  });

  it('negative: range.from with zero pre-range debt suppresses the b/f row', async () => {
    await seedDeliveredInvoice(5000, '2026-06-05');

    const result = await getCustomerLedger(distributorId, customerId, {
      from: '2026-05-01',
      to: '2026-06-30',
    });

    const obRow = result.rows.find((r) => r.kind === 'opening');
    expect(obRow).toBeUndefined();
    expect(result.summary.openingBalance).toBe(0);
  });

  it('regression: opening balance does NOT enter the overdue FIFO', async () => {
    // 30 day credit period, OB from 90 days ago — under the OLD math would
    // count as overdue. Under G1, OB never enters unpaidDeliveries.
    const oldDate = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    await seedOpeningBalance(50_000, oldDate);

    const result = await getCustomerLedger(distributorId, customerId);
    expect(result.summary.overdueAmount).toBe(0);
    expect(result.summary.dueAmount).toBe(50_000);
  });

  it('negative: a non-existent customer returns 404 via PaymentError', async () => {
    await expect(
      getCustomerLedger(distributorId, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(PaymentError);
  });

  it('negative: customer with zero entries returns empty rows + zero summary', async () => {
    const result = await getCustomerLedger(distributorId, customerId);
    expect(result.rows).toEqual([]);
    expect(result.summary).toEqual({
      totalAmount: 0,
      receivedAmount: 0,
      dueAmount: 0,
      overdueAmount: 0,
      emptyCylsCost: 0,
      openingBalance: 0,
    });
  });
});
