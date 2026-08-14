/**
 * Cancelled-invoice ledger integrity (2026-08-14).
 *
 * Reproduces the live Taj Deccan Cafe statement bug and pins the fix so it
 * can never silently regress. The scenario:
 *
 *   - Invoice A (issued, real): 2 cylinder types on one order.
 *       big type  ×3 delivered, 3 collected  → 0 pending
 *       19 KG     ×4 delivered, 3 collected  → 1 pending
 *       total ₹25,300.
 *   - Invoice B (CANCELLED walk-in — "wrong customer"): 19 KG ×5, ₹11,000.
 *       Its ledger footprint is a matched pair:
 *         invoice_entry  +11,000
 *         adjustment     −11,000   narration "Cancelled: … — wrong customer"
 *
 * TWO bugs lived here before the fix (see paymentService.ts pre-pass gate +
 * customerLedgerPdfService.ts hideCancelledInvoices flip):
 *
 *   1. DOUBLE-COUNT (engine): the pending-empties pre-pass walked
 *      `inv.order.items` for EVERY entry carrying an invoiceId, not just
 *      invoice_entry. The cancellation `adjustment` shares invoice B's
 *      invoiceId, so its 5 cylinders were counted a SECOND time →
 *      pending 11, Emp Cost = 11 × price (₹38,500 live) instead of 6.
 *   2. CUSTOMER-VISIBLE cancelled order: regular-distributor statements showed
 *      the wrong-customer order + its reversal, with the reversal dumped into
 *      the "Received" column (fake ₹11,000 receipt) and the running Total Amt
 *      inflated to ₹36,300.
 *
 * The fix: (a) gate the pre-pass to invoice_entry (kills the double-count on
 * every path — money-neutral), and (b) hide the cancelled pair on the customer
 * statement for ALL account types (was mini-op only), which routes through the
 * existing filter that excludes the pair from computation entirely.
 *
 * SAFETY INVARIANT pinned below: the customer's NET outstanding (dueAmount /
 * closing balance) is IDENTICAL whether or not the pair is hidden — the fix
 * only re-buckets where the 11,000 sits, never the net a customer owes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { getCustomerLedger } from '../services/paymentService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK_CUSTOMER_NAME = 'CancelStmt-Test Customer';
const TRACK_PHONE = '9100000094';

let distributorId: string;
let customerId: string;
let tBigId: string;
let t19Id: string;
let price19: number;

async function cleanup() {
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_CUSTOMER_NAME } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_CUSTOMER_NAME } },
  });
  await prisma.order.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_CUSTOMER_NAME } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: TRACK_CUSTOMER_NAME },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;

  const t19 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, typeName: '19 KG' },
    select: { id: true },
  });
  const tBig = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, typeName: '5 KG' },
    select: { id: true },
  });
  t19Id = t19.id;
  tBigId = tBig.id;

  // Read the seeded empty-cylinder price for 19 KG. We compute expected
  // Emp Cost as pending × this price (rather than hard-coding a prod figure),
  // and assert it's > 0 so the multiplicative assertions actually discriminate
  // — if a future seed drops the price this test fails loudly instead of
  // silently passing on 0 === 0.
  const ep = await prisma.emptyCylinderPrice.findFirst({
    where: { distributorId, cylinderTypeId: t19Id },
    select: { emptyCylinderPrice: true },
  });
  price19 = ep ? Number(ep.emptyCylinderPrice) : 0;

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
  await prisma.order.deleteMany({ where: { distributorId, customerId } });
});

/**
 * Seed the exact Taj-Deccan shape: one real 2-type invoice + one cancelled
 * walk-in (19 KG ×5) with its matched +11,000 / −11,000 reversal pair.
 */
async function seedCancelledWalkInScenario() {
  // ── Invoice A — issued, real, ₹25,300 (5 KG ×3 @5,500 + 19 KG ×4 @2,200)
  const orderA = await prisma.order.create({
    data: {
      orderNumber: `CS-A-${Math.random().toString(36).slice(2, 8)}`,
      distributorId, customerId,
      status: 'delivered',
      orderDate: new Date('2026-08-06'),
      deliveryDate: new Date('2026-08-06'),
      items: {
        create: [
          { cylinderTypeId: tBigId, quantity: 3, deliveredQuantity: 3, emptiesCollected: 3, unitPrice: 5500, discountPerUnit: 0, totalPrice: 16500 },
          { cylinderTypeId: t19Id,  quantity: 4, deliveredQuantity: 4, emptiesCollected: 3, unitPrice: 2200, discountPerUnit: 0, totalPrice: 8800 },
        ],
      },
    } as never,
  });
  const invA = await prisma.invoice.create({
    data: {
      invoiceNumber: `CS-INV-A-${Math.random().toString(36).slice(2, 8)}`,
      distributorId, customerId, orderId: orderA.id,
      issueDate: new Date('2026-08-06'), dueDate: new Date('2026-08-06'),
      totalAmount: 25300, outstandingAmount: 25300, amountPaid: 0,
      status: 'issued', isOpeningBalance: false,
      // InvoiceItems drive the per-cylinder-type row split (revenue side);
      // empties come from the OrderItems above.
      items: {
        create: [
          { cylinderTypeId: tBigId, description: '5 KG',  quantity: 3, unitPrice: 5500, discountPerUnit: 0, gstRate: 18, totalPrice: 16500 },
          { cylinderTypeId: t19Id,  description: '19 KG', quantity: 4, unitPrice: 2200, discountPerUnit: 0, gstRate: 18, totalPrice: 8800 },
        ],
      },
    } as never,
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId, customerId,
      entryType: 'invoice_entry', referenceId: invA.id, invoiceId: invA.id,
      amountDelta: 25300, narration: `Invoice ${invA.invoiceNumber}`,
      entryDate: new Date('2026-08-06'),
    },
  });

  // ── Invoice B — CANCELLED walk-in, ₹11,000 (19 KG ×5 @2,200)
  const orderB = await prisma.order.create({
    data: {
      orderNumber: `CS-B-${Math.random().toString(36).slice(2, 8)}`,
      distributorId, customerId,
      status: 'cancelled',
      orderSource: 'walk_in',
      orderDate: new Date('2026-08-14'),
      deliveryDate: new Date('2026-08-14'),
      items: {
        create: [
          { cylinderTypeId: t19Id, quantity: 5, deliveredQuantity: 5, emptiesCollected: 0, unitPrice: 2200, discountPerUnit: 0, totalPrice: 11000 },
        ],
      },
    } as never,
  });
  const invB = await prisma.invoice.create({
    data: {
      invoiceNumber: `CS-INV-B-${Math.random().toString(36).slice(2, 8)}`,
      distributorId, customerId, orderId: orderB.id,
      issueDate: new Date('2026-08-14'), dueDate: new Date('2026-08-14'),
      totalAmount: 11000, outstandingAmount: 0, amountPaid: 0,
      status: 'cancelled', isOpeningBalance: false,
      items: {
        create: [
          { cylinderTypeId: t19Id, description: '19 KG', quantity: 5, unitPrice: 2200, discountPerUnit: 0, gstRate: 18, totalPrice: 11000 },
        ],
      },
    } as never,
  });
  // The matched pair: the original debit + its cancellation reversal.
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId, customerId,
      entryType: 'invoice_entry', referenceId: invB.id, invoiceId: invB.id,
      amountDelta: 11000, narration: `Invoice ${invB.invoiceNumber}`,
      entryDate: new Date('2026-08-14'),
    },
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId, customerId,
      entryType: 'adjustment', referenceId: invB.id, invoiceId: invB.id,
      amountDelta: -11000,
      narration: `Cancelled: ${orderB.orderNumber} — wrong customer`,
      entryDate: new Date('2026-08-14'),
    },
  });

  return { invA, invB, orderB };
}

describe('Cancelled-invoice ledger integrity', () => {
  it('sanity: the 19 KG empty price is seeded (>0) so the cost assertions discriminate', () => {
    expect(price19).toBeGreaterThan(0);
  });

  it('CUSTOMER STATEMENT (hide=true): cancelled pair vanishes, numbers are clean', async () => {
    await seedCancelledWalkInScenario();
    const r = await getCustomerLedger(distributorId, customerId, undefined, {
      hideCancelledInvoices: true,
    });

    // The wrong-customer order and its reversal are gone entirely.
    expect(r.rows.some((row) => (row.narration ?? '').startsWith('Cancelled:'))).toBe(false);
    // Only invoice A's two cylinder-type rows survive.
    const invoiceRows = r.rows.filter((row) => row.kind === 'invoice');
    expect(invoiceRows).toHaveLength(2);

    // Money: total 25,300, nothing "received", due 25,300 — no fake ₹11,000.
    expect(r.summary.totalAmount).toBe(25300);
    expect(r.summary.receivedAmount).toBe(0);
    expect(r.summary.dueAmount).toBe(25300);

    // Physical: only invoice A counts → 7 fulls delivered, 1 pending empty.
    const deliveredTotal = invoiceRows.reduce((s, row) => s + row.fullCylsDelivered, 0);
    expect(deliveredTotal).toBe(7);
    const row19 = invoiceRows.find((row) => row.cylinderType === '19 KG')!;
    expect(row19.pendingEmptyCyls).toBe(1);

    // Emp Cost = 1 × price — NOT the double-counted 11× and NOT the
    // non-hidden 6× the wrong-customer order would contribute.
    expect(r.summary.emptyCylsCost).toBe(1 * price19);
    expect(r.summary.emptyCylsCost).not.toBe(6 * price19);
    expect(r.summary.emptyCylsCost).not.toBe(11 * price19);
  });

  it('ENGINE (hide=false): double-count is dead — pending 6 not 11 (₹38,500 regression pin)', async () => {
    await seedCancelledWalkInScenario();
    const r = await getCustomerLedger(distributorId, customerId, undefined, {
      hideCancelledInvoices: false,
    });

    // The cancellation adjustment must NOT re-walk invoice B's order items.
    // Pre-fix: 19 KG delivered = 4 + 5 + 5(adjustment) = 14 → pending 11.
    // Post-fix: 4 + 5 = 9 → pending 6. The cancelled invoice's OWN 5 still
    // count on the non-hidden path (that's what the statement hide is for);
    // the SECOND count via the adjustment is what we killed here.
    expect(r.summary.emptyCylsCost).toBe(6 * price19);
    expect(r.summary.emptyCylsCost).not.toBe(11 * price19); // the live ₹38,500 bug
  });

  it('SAFETY INVARIANT: net outstanding is identical hidden vs not (only re-bucketed)', async () => {
    await seedCancelledWalkInScenario();
    const hidden = await getCustomerLedger(distributorId, customerId, undefined, {
      hideCancelledInvoices: true,
    });
    const shown = await getCustomerLedger(distributorId, customerId, undefined, {
      hideCancelledInvoices: false,
    });

    // The number that actually gates credit and drives collections must be
    // the same either way — the cancelled order nets to zero regardless of
    // whether we display it.
    expect(hidden.summary.dueAmount).toBe(25300);
    expect(shown.summary.dueAmount).toBe(25300);
    expect(hidden.summary.dueAmount).toBe(shown.summary.dueAmount);
  });
});
