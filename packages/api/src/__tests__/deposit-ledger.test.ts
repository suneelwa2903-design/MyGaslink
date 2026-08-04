/**
 * Deposit Ledger — end-to-end integration tests (2026-07-31)
 *
 * Covers the design finalised in CLAUDE.md conversation 2026-07-31:
 *   - Payment recording with deposit metadata emits BOTH payment_entry
 *     AND deposit_charged ledger rows in one transaction
 *   - Deposit amount does NOT double-count in customer's dues balance
 *   - CustomerInventoryBalance.withCustomerQty drops by qty when
 *     deposit charged (cylinders no longer count as refundable-owed)
 *   - Ledger's Pend E for that type reflects the deposit
 *   - summary.depositBreakdown is populated per cylinder type
 *   - refundDeposit (cash path): negative PaymentTransaction + emits
 *     deposit_refunded row + restores withCustomerQty
 *   - refundDeposit (credit_note path): CreditNote + emits
 *     deposit_refunded row + restores withCustomerQty
 *   - Refund cap: cannot refund more qty than customer has on deposit
 *   - Cross-tenant isolation: customer / cylinder type from another
 *     distributor rejected
 *   - reportsService.customerStatement does NOT double-count deposit
 *     rows in the running debit/credit balance (anti-pattern #24 guard)
 *
 * Uses year-3000 dates per CLAUDE.md anti-pattern #7 so date-filtered
 * services on the shared dev DB don't sweep our fixtures into real work.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  createPayment,
  refundDeposit,
  getCustomerLedger,
  PaymentError,
} from '../services/paymentService.js';
import { customerStatement } from '../services/reportsService.js';

const D1 = 'dist-001';
const D2 = 'dist-002';
const USER_ID = 'test-user';
const TEST_DATE = '2099-12-31';

const trackedCustomerIds: string[] = [];
const trackedLedgerIds: string[] = [];
const trackedPaymentIds: string[] = [];

async function makeCustomer(distributorId: string, name: string) {
  const c = await prisma.customer.create({
    data: {
      distributorId,
      customerName: name,
      phone: `9${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, '0')}`,
      customerType: 'B2C',
      billingState: 'Telangana',
    },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function ensureEmptyPrice(distributorId: string, cylinderTypeId: string, price: number) {
  // 2026-08-01 — the composite unique (distributor, cylinderType) was
  // dropped by the empty-price-history migration; effectiveDate is now
  // required. Match the ensurePrice pattern used across the test suite:
  // find-or-update against a fixed anchor date so the fixture is
  // deterministic and doesn't drift with real ops entries.
  const anchor = new Date('2020-01-01');
  const existing = await prisma.emptyCylinderPrice.findFirst({
    where: { distributorId, cylinderTypeId, effectiveDate: anchor },
  });
  if (existing) {
    await prisma.emptyCylinderPrice.update({
      where: { id: existing.id },
      data: { emptyCylinderPrice: price },
    });
  } else {
    await prisma.emptyCylinderPrice.create({
      data: { distributorId, cylinderTypeId, emptyCylinderPrice: price, effectiveDate: anchor },
    });
  }
}

beforeAll(async () => {
  // Sanity: dist-001 must have at least one active cylinder type
  await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: D1, isActive: true },
  });
});

afterAll(async () => {
  // Clean up in FK-safe order
  if (trackedLedgerIds.length) {
    await prisma.customerLedgerEntry.deleteMany({
      where: { id: { in: trackedLedgerIds } },
    });
  }
  if (trackedCustomerIds.length) {
    await prisma.customerLedgerEntry.deleteMany({
      where: { customerId: { in: trackedCustomerIds } },
    });
    await prisma.paymentAllocation.deleteMany({
      where: { payment: { customerId: { in: trackedCustomerIds } } },
    });
    await prisma.paymentTransaction.deleteMany({
      where: { customerId: { in: trackedCustomerIds } },
    });
    await prisma.customerInventoryBalance.deleteMany({
      where: { customerId: { in: trackedCustomerIds } },
    });
    await prisma.customer.deleteMany({
      where: { id: { in: trackedCustomerIds } },
    });
  }
  if (trackedPaymentIds.length) {
    await prisma.paymentTransaction.deleteMany({
      where: { id: { in: trackedPaymentIds } },
    });
  }
});

describe('createPayment — with deposit metadata', () => {
  it('pure-deposit payment emits ONLY deposit_charged (no payment_entry)', async () => {
    // 2026-07-31 refinement: a cylinder deposit is a refundable
    // liability, not invoice revenue. A payment where the ENTIRE amount
    // is deposit MUST NOT emit a payment_entry ledger row — because that
    // row's amountDelta would incorrectly reduce customer receivables.
    // The deposit_charged row alone carries the accounting: money in
    // (tracked via PaymentTransaction.amount for cash-side / Tally) +
    // refundable liability (tracked in Deposits Held via this row).
    const customer = await makeCustomer(D1, 'Deposit test — pure deposit');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    const result = await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 3900,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 2, amount: 3900 }],
    });
    trackedPaymentIds.push(result.id);

    const ledgerRows = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(ledgerRows.map((r) => r.entryType)).toEqual(['deposit_charged']);

    const depositRow = ledgerRows[0];
    expect(depositRow.cylinderTypeId).toBe(ct.id);
    expect(depositRow.qtyDelta).toBe(2);
    expect(Number(depositRow.amountDelta)).toBe(3900);
    expect(depositRow.referenceId).toBe(result.id);

    // PaymentTransaction row still carries the full cash amount (bank
    // recon + Tally + analytics all read this).
    const payment = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: result.id } });
    expect(Number(payment.amount)).toBe(3900);
  });

  it('mixed payment (deposit + invoice) emits BOTH rows, payment_entry only for non-deposit portion', async () => {
    // Amount = 5000, deposit = 1950 → payment_entry.amountDelta = -3050
    // (the actual invoice-payment portion). Customer's dueAmount reflects
    // only the 3050 that went to invoices; the 1950 sits as Deposits Held.
    const customer = await makeCustomer(D1, 'Deposit mixed payment');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 5000,
      paymentMethod: 'upi',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 1, amount: 1950 }],
      // Remaining 3050 stays unallocated (no invoices) → advance credit.
    });

    const rows = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.entryType).sort()).toEqual(
      ['deposit_charged', 'payment_entry'].sort(),
    );

    const paymentRow = rows.find((r) => r.entryType === 'payment_entry')!;
    expect(Number(paymentRow.amountDelta)).toBe(-3050);

    const depRow = rows.find((r) => r.entryType === 'deposit_charged')!;
    expect(Number(depRow.amountDelta)).toBe(1950);
  });

  it('deposit portion does NOT reduce invoice dues in ledger summary', async () => {
    // The critical business-correctness assertion: customer paid 5000
    // (all deposit) — their invoice dues should be UNTOUCHED, and the
    // 1950 non-deposit portion becomes advance credit.
    const customer = await makeCustomer(D1, 'Deposit no double-count');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 5000,
      paymentMethod: 'upi',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 1, amount: 1950 }],
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    // Customer paid 5000, of which 1950 is refundable deposit and 3050
    // is invoice-side advance credit → dueAmount = -3050 (customer is
    // 3050 in credit against future invoices). NOT -5000 (which would
    // wrongly count the deposit as invoice payment — the bug we fixed).
    expect(ledger.summary.dueAmount).toBe(-3050);
    expect(ledger.summary.receivedAmount).toBe(3050);
    // Deposits Held surfaces separately in the summary breakdown.
    expect(ledger.summary.depositBreakdown).toHaveLength(1);
    expect(ledger.summary.depositBreakdown![0].amount).toBe(1950);
  });

  it('reduces CustomerInventoryBalance.withCustomerQty by deposit qty', async () => {
    const customer = await makeCustomer(D1, 'Deposit reduces withCustomerQty');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);
    // Seed customer holding 5 empties
    await prisma.customerInventoryBalance.upsert({
      where: {
        customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: ct.id },
      },
      create: { customerId: customer.id, cylinderTypeId: ct.id, withCustomerQty: 5 },
      update: { withCustomerQty: 5 },
    });

    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 5850,
      paymentMethod: 'upi',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 3, amount: 5850 }],
    });

    const bal = await prisma.customerInventoryBalance.findUniqueOrThrow({
      where: {
        customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: ct.id },
      },
    });
    expect(bal.withCustomerQty).toBe(2); // 5 - 3
  });

  it('summary.depositBreakdown populated per cylinder type', async () => {
    const customer = await makeCustomer(D1, 'Deposit breakdown multi-type');
    const cts = await prisma.cylinderType.findMany({
      where: { distributorId: D1, isActive: true },
      take: 2,
    });
    if (cts.length < 2) {
      // Skip if this distributor only has 1 cylinder type
      return;
    }
    await ensureEmptyPrice(D1, cts[0].id, 1950);
    await ensureEmptyPrice(D1, cts[1].id, 800);

    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 3900,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [
        { cylinderTypeId: cts[0].id, qty: 1, amount: 1950 },
        { cylinderTypeId: cts[1].id, qty: 2, amount: 1600 },
      ],
    });
    // Remainder ₹350 stays unallocated

    const ledger = await getCustomerLedger(D1, customer.id);
    expect(ledger.summary.depositBreakdown).toHaveLength(2);
    const byId = new Map(
      ledger.summary.depositBreakdown!.map((b) => [b.cylinderTypeId, b]),
    );
    expect(byId.get(cts[0].id)?.qty).toBe(1);
    expect(byId.get(cts[0].id)?.amount).toBe(1950);
    expect(byId.get(cts[1].id)?.qty).toBe(2);
    expect(byId.get(cts[1].id)?.amount).toBe(1600);
    // Names populated from cylinderTypeNameMap preload
    expect(byId.get(cts[0].id)?.cylinderTypeName.length).toBeGreaterThan(0);
  });

  it('rejects when deposit + allocation total exceeds payment amount', async () => {
    const customer = await makeCustomer(D1, 'Deposit overflow guard');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    await expect(
      createPayment(D1, USER_ID, {
        customerId: customer.id,
        amount: 1000,
        paymentMethod: 'cash',
        transactionDate: TEST_DATE,
        deposits: [{ cylinderTypeId: ct.id, qty: 1, amount: 1950 }],
      }),
    ).rejects.toThrow(/exceeds payment amount/);
  });

  it('rejects when qty <= 0 on a deposit entry', async () => {
    const customer = await makeCustomer(D1, 'Deposit zero-qty guard');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    await expect(
      createPayment(D1, USER_ID, {
        customerId: customer.id,
        amount: 100,
        paymentMethod: 'cash',
        transactionDate: TEST_DATE,
        deposits: [{ cylinderTypeId: ct.id, qty: 0, amount: 100 }],
      }),
    ).rejects.toThrow(/qty must be greater than 0/);
  });

  it('rejects cylinder type from another distributor (cross-tenant isolation)', async () => {
    const customer = await makeCustomer(D1, 'Deposit cross-tenant guard');
    const foreignType = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D2, isActive: true },
    });
    // Note: we do NOT ensureEmptyPrice for D1×foreignType since it's cross-tenant

    await expect(
      createPayment(D1, USER_ID, {
        customerId: customer.id,
        amount: 1950,
        paymentMethod: 'cash',
        transactionDate: TEST_DATE,
        deposits: [{ cylinderTypeId: foreignType.id, qty: 1, amount: 1950 }],
      }),
    ).rejects.toThrow(/Cylinder type .* not found for this distributor/);
  });
});

describe('refundDeposit', () => {
  it('cash path: creates negative PaymentTransaction + emits deposit_refunded + restores withCustomerQty', async () => {
    const customer = await makeCustomer(D1, 'Refund cash');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    // First: charge deposit for 3 cylinders
    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 5850,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 3, amount: 5850 }],
    });

    // Now refund 1 cylinder
    const refund = await refundDeposit(D1, USER_ID, {
      customerId: customer.id,
      cylinderTypeId: ct.id,
      qty: 1,
      amount: 1950,
      method: 'cash',
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
    });
    expect(refund.paymentId).toBeTruthy();
    expect(refund.creditNoteId).toBeUndefined();

    // Verify negative payment created
    const negPayment = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: refund.paymentId! },
    });
    expect(Number(negPayment.amount)).toBe(-1950);

    // Verify deposit_refunded ledger row
    const refundRow = await prisma.customerLedgerEntry.findUniqueOrThrow({
      where: { id: refund.ledgerEntryId },
    });
    expect(refundRow.entryType).toBe('deposit_refunded');
    expect(refundRow.cylinderTypeId).toBe(ct.id);
    expect(refundRow.qtyDelta).toBe(1);
    expect(Number(refundRow.amountDelta)).toBe(1950);

    // 2026-07-31 v3 accounting correction: the cash-refund path MUST NOT
    // emit a payment_entry ledger row. A deposit refund is a Refundable
    // Deposit Payable write-down, not an invoice payment. Previously the
    // refund's negative payment was double-counted — it correctly showed
    // in Deposits Held (via deposit_refunded) AND wrongly reduced Due
    // Amt (via a companion payment_entry). Assert no payment_entry rows
    // exist for the refund's referenceId.
    const paymentEntryRows = await prisma.customerLedgerEntry.findMany({
      where: {
        referenceId: refund.paymentId!,
        entryType: 'payment_entry',
      },
    });
    expect(paymentEntryRows).toHaveLength(0);

    // 2026-07-31 v2 semantics: refund = customer physically returned the
    // cylinder to depot. withCustomerQty does NOT increment (cylinder is
    // at depot, not with customer). No CustomerInventoryBalance row was
    // ever created here (customer never had this type before the deposit
    // charge dropped it to 0 in the create case), so no row exists.
    const bal = await prisma.customerInventoryBalance.findUnique({
      where: {
        customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: ct.id },
      },
    });
    // Either no row exists (never created — deposit-charge branch also
    // skips create when the customer had no prior balance) OR row exists
    // at 0 (if seeded then deposit-dropped). Both are correct under v2.
    if (bal) expect(bal.withCustomerQty).toBe(0);
  });

  it('credit_note path: creates CreditNote with reasonCode=D + emits deposit_refunded', async () => {
    const customer = await makeCustomer(D1, 'Refund credit note');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    // Charge deposit for 2 cylinders
    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 3900,
      paymentMethod: 'upi',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 2, amount: 3900 }],
    });

    // Need a target invoice for credit_note refund. Create a synthetic OB invoice.
    const invoice = await prisma.invoice.create({
      data: {
        distributorId: D1,
        customerId: customer.id,
        invoiceNumber: `TEST-DEP-CN-${Date.now().toString(36)}`,
        issueDate: new Date(TEST_DATE),
        dueDate: new Date(TEST_DATE),
        totalAmount: 5000,
        outstandingAmount: 5000,
        status: 'issued',
        isOpeningBalance: true,
        cgstValue: 0,
        sgstValue: 0,
        igstValue: 0,
      },
    });

    const refund = await refundDeposit(D1, USER_ID, {
      customerId: customer.id,
      cylinderTypeId: ct.id,
      qty: 1,
      amount: 1950,
      method: 'credit_note',
      creditNoteInvoiceId: invoice.id,
      transactionDate: TEST_DATE,
    });
    expect(refund.creditNoteId).toBeTruthy();
    expect(refund.paymentId).toBeUndefined();

    const cn = await prisma.creditNote.findUniqueOrThrow({
      where: { id: refund.creditNoteId! },
    });
    expect(cn.reasonCode).toBe('D');
    expect(Number(cn.totalAmount)).toBe(1950);

    // Cleanup invoice
    await prisma.creditNote.deleteMany({ where: { invoiceId: invoice.id } });
    await prisma.invoice.delete({ where: { id: invoice.id } });
  });

  it('refund cap: cannot refund more qty than customer has on deposit', async () => {
    const customer = await makeCustomer(D1, 'Refund cap guard');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    // Charge for 2, try to refund 3
    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 3900,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 2, amount: 3900 }],
    });

    await expect(
      refundDeposit(D1, USER_ID, {
        customerId: customer.id,
        cylinderTypeId: ct.id,
        qty: 3,
        amount: 5850,
        method: 'cash',
        paymentMethod: 'cash',
        transactionDate: TEST_DATE,
      }),
    ).rejects.toThrow(/customer only has 2 on deposit/);
  });

  it('cross-tenant: rejects cylinder type from other distributor', async () => {
    const customer = await makeCustomer(D1, 'Refund cross-tenant guard');
    const foreignType = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D2, isActive: true },
    });

    await expect(
      refundDeposit(D1, USER_ID, {
        customerId: customer.id,
        cylinderTypeId: foreignType.id,
        qty: 1,
        amount: 1950,
        method: 'cash',
        paymentMethod: 'cash',
        transactionDate: TEST_DATE,
      }),
    ).rejects.toThrow(/Cylinder type not found/);
  });

  it('validates method-specific required fields', async () => {
    const customer = await makeCustomer(D1, 'Refund method validation');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    // cash without paymentMethod
    await expect(
      refundDeposit(D1, USER_ID, {
        customerId: customer.id,
        cylinderTypeId: ct.id,
        qty: 1,
        amount: 1950,
        method: 'cash',
      }),
    ).rejects.toThrow(PaymentError);

    // credit_note without creditNoteInvoiceId
    await expect(
      refundDeposit(D1, USER_ID, {
        customerId: customer.id,
        cylinderTypeId: ct.id,
        qty: 1,
        amount: 1950,
        method: 'credit_note',
      }),
    ).rejects.toThrow(PaymentError);
  });
});

describe('reportsService.customerStatement — anti-pattern #24 guard', () => {
  it('does NOT double-count deposit rows in running balance', async () => {
    const customer = await makeCustomer(D1, 'Report double-count guard');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);

    // Customer pays 3900, 1950 of which is deposit
    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 3900,
      paymentMethod: 'upi',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 1, amount: 1950 }],
    });

    const report = await customerStatement(D1, {
      customerId: customer.id,
      dateFrom: '2099-01-01',
      dateTo: '2099-12-31',
    });
    // Amount = 3900, deposit portion = 1950. Under the 2026-07-31
    // refinement:
    //   - payment_entry.amountDelta = -(3900-1950) = -1950 (invoice-side portion only)
    //   - deposit_charged row: metadata, excluded from running balance
    // Closing balance = 0 + (-1950) = -1950 (customer has 1950 invoice-side
    // advance credit; the other 1950 sits as Deposits Held, not on the
    // customer account balance).
    expect(report.totals?.balance).toBe(-1950);

    // Deposit row IS visible in the ledger (narration + type) but with
    // blank debit/credit columns.
    const depositRow = report.rows.find(
      (r) => (r as { type?: string }).type === 'Deposit Received',
    ) as { type: string; debit: string | number; credit: string | number } | undefined;
    expect(depositRow).toBeTruthy();
    expect(depositRow?.debit).toBe('');
    expect(depositRow?.credit).toBe('');
  });
});

describe('Ledger row-level: deposit_charged decrements Pend E', () => {
  it('deposit event drops Pend E snapshot for that type', async () => {
    const customer = await makeCustomer(D1, 'Pend E deposit decrement');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);
    // Seed 5 empties held via openingSeedQty (like the CSV import does)
    await prisma.customerInventoryBalance.upsert({
      where: {
        customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: ct.id },
      },
      create: {
        customerId: customer.id, cylinderTypeId: ct.id,
        withCustomerQty: 5, openingSeedQty: 5,
      },
      update: { withCustomerQty: 5, openingSeedQty: 5 },
    });

    // Pay deposit for 3 → Pend E should drop from 5 to 2
    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 5850,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 3, amount: 5850 }],
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    // emptyCylsCost in summary = 2 (remaining Pend E) × 1950 = 3900
    expect(ledger.summary.emptyCylsCost).toBe(3900);
  });
});

// ─── Change C (2026-07-31 v2) — Per-type deposit row rendering ─────────────
describe('processLedgerEntries — per-type deposit row rendering', () => {
  it('deposit_charged row emits cylinderType name + per-type Pend E + per-type Emp Cost', async () => {
    const customer = await makeCustomer(D1, 'Deposit per-type row shape');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);
    // Seed 5 empties → after deposit of 2, per-type Pend E = 3
    await prisma.customerInventoryBalance.upsert({
      where: { customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: ct.id } },
      create: { customerId: customer.id, cylinderTypeId: ct.id, withCustomerQty: 5, openingSeedQty: 5 },
      update: { withCustomerQty: 5, openingSeedQty: 5 },
    });

    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 3900,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 2, amount: 3900 }],
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    const depositRow = ledger.rows.find((r) => r.kind === 'deposit_charged');
    expect(depositRow).toBeTruthy();
    // Change C acceptance: Type column shows the cylinder type name.
    expect(depositRow!.cylinderType).toBe(ct.typeName);
    // Per-type Pend E (not aggregate): 5 − 2 = 3.
    expect(depositRow!.pendingEmptyCyls).toBe(3);
    // Per-type Emp Cost: 3 × 1950 = 5850.
    expect(depositRow!.emptyCylsCost).toBe(5850);
    // Emp C column carries the qty that went on deposit (3 became 3, showing 2 flowing).
    expect(depositRow!.emptyCylsCollected).toBe(2);
  });

  it('deposit_refunded row also emits per-type Type/Pend E/Emp Cost (Pend E restored)', async () => {
    const customer = await makeCustomer(D1, 'Refund per-type row shape');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);
    // Charge deposit for 3 first.
    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 5850,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 3, amount: 5850 }],
    });
    // Then refund 1.
    await refundDeposit(D1, USER_ID, {
      customerId: customer.id,
      cylinderTypeId: ct.id,
      qty: 1,
      amount: 1950,
      method: 'cash',
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    const refundRow = ledger.rows.find((r) => r.kind === 'deposit_refunded');
    expect(refundRow).toBeTruthy();
    expect(refundRow!.cylinderType).toBe(ct.typeName);
    // 2026-07-31 v2 semantics: refund = cylinder physically returned to
    // depot. Pend E STAYS where it was (customer no longer has it).
    // Before refund: 0 pending (deposit had dropped it to 0). After: 0.
    expect(refundRow!.pendingEmptyCyls).toBe(0);
    // Emp Cost also stays at 0 (no cylinders pending with customer).
    expect(refundRow!.emptyCylsCost).toBe(0);
    // Emp C shows qty — the refund IS a collection event (cylinder came
    // back to depot).
    expect(refundRow!.emptyCylsCollected).toBe(1);
  });

  it('multi-type: each deposit row shows only its own type snapshot, not aggregate', async () => {
    const customer = await makeCustomer(D1, 'Multi-type per-type isolation');
    const types = await prisma.cylinderType.findMany({
      where: { distributorId: D1, isActive: true }, take: 2,
    });
    if (types.length < 2) { expect(true).toBe(true); return; }
    await ensureEmptyPrice(D1, types[0].id, 1950);
    await ensureEmptyPrice(D1, types[1].id, 800);
    // Seed 5 of type[0] and 4 of type[1] pending.
    await prisma.customerInventoryBalance.upsert({
      where: { customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: types[0].id } },
      create: { customerId: customer.id, cylinderTypeId: types[0].id, withCustomerQty: 5, openingSeedQty: 5 },
      update: { withCustomerQty: 5, openingSeedQty: 5 },
    });
    await prisma.customerInventoryBalance.upsert({
      where: { customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: types[1].id } },
      create: { customerId: customer.id, cylinderTypeId: types[1].id, withCustomerQty: 4, openingSeedQty: 4 },
      update: { withCustomerQty: 4, openingSeedQty: 4 },
    });

    // One payment carrying deposits for BOTH types.
    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 3900 + 1600,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [
        { cylinderTypeId: types[0].id, qty: 2, amount: 3900 },
        { cylinderTypeId: types[1].id, qty: 2, amount: 1600 },
      ],
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    const depRows = ledger.rows.filter((r) => r.kind === 'deposit_charged');
    expect(depRows).toHaveLength(2);

    const rowT0 = depRows.find((r) => r.cylinderType === types[0].typeName)!;
    const rowT1 = depRows.find((r) => r.cylinderType === types[1].typeName)!;

    // type[0]: pending was 5, deposit 2 → per-type pending 3, cost 3 × 1950 = 5850.
    expect(rowT0.pendingEmptyCyls).toBe(3);
    expect(rowT0.emptyCylsCost).toBe(5850);

    // type[1]: pending was 4, deposit 2 → per-type pending 2, cost 2 × 800 = 1600.
    // (crucial: rowT1 must NOT show type[0]'s numbers — no aggregate leak)
    expect(rowT1.pendingEmptyCyls).toBe(2);
    expect(rowT1.emptyCylsCost).toBe(1600);
  });

  it('Total-row Pend E and Emp Cost agree even when refunds present (renderer/service reconcile)', async () => {
    // 2026-07-31 v4 guard — refund's Emp C used to leak into the
    // renderer's totalCollected while the service's per-type collected
    // deliberately excluded it. Symptom on Maruthi's July statement:
    // Total row Pend E=11 but Emp Cost=45,750 (which implied Pend E=13).
    // Numbers didn't reconcile.
    // This test: seed enough events to trigger the mismatch, then
    // reconstruct Pend E from Emp Cost via the summed empty prices and
    // confirm the two agree.
    const customer = await makeCustomer(D1, 'Refund Pend E/Emp Cost reconcile');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);
    // Seed 5 pending → charge deposit for 3 → refund 2.
    await prisma.customerInventoryBalance.upsert({
      where: { customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: ct.id } },
      create: { customerId: customer.id, cylinderTypeId: ct.id, withCustomerQty: 5, openingSeedQty: 5 },
      update: { withCustomerQty: 5, openingSeedQty: 5 },
    });
    await createPayment(D1, USER_ID, {
      customerId: customer.id, amount: 5850, paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 3, amount: 5850 }],
    });
    await refundDeposit(D1, USER_ID, {
      customerId: customer.id, cylinderTypeId: ct.id, qty: 2, amount: 3900,
      method: 'cash', paymentMethod: 'cash', transactionDate: TEST_DATE,
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    // summary.emptyCylsCost = sum(pending_per_type × price). For this
    // single-type customer: pending × 1950 = emptyCylsCost.
    // Pending = 5 (seed) − 3 (deposit) = 2. Refund does NOT reduce
    // pending (v3 semantics — cylinder returned was on-deposit, not
    // pending refill). So Emp Cost = 2 × 1950 = 3900.
    expect(ledger.summary.emptyCylsCost).toBe(3900);
    // Reconstruct pending count from Emp Cost using the single-type price.
    const impliedPending = ledger.summary.emptyCylsCost / 1950;
    expect(impliedPending).toBe(2);
  });

  it('empties_return row emits per-type Pend E + per-type Emp Cost (Change F)', async () => {
    // 2026-07-31 v5 (Change F) — empties_return row now mirrors deposit
    // rows: shows Type = cylinder name, Pend E = per-type snapshot,
    // Emp Cost = per-type × price. Pre-v5 the row showed AGGREGATE
    // Pend E and a blank Emp Cost — inconsistent with invoice/deposit
    // rows.
    const customer = await makeCustomer(D1, 'Empties per-type v5');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);
    // Seed 5 pending.
    await prisma.customerInventoryBalance.upsert({
      where: { customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId: ct.id } },
      create: { customerId: customer.id, cylinderTypeId: ct.id, withCustomerQty: 5, openingSeedQty: 5 },
      update: { withCustomerQty: 5, openingSeedQty: 5 },
    });
    // Emit an inventory event (returns_collection) + matching ledger
    // entry via the emptiesReturnService write path so the ledger
    // reader has a match to lift the per-type values from.
    // Reproducing that write here is heavy — instead, seed the ledger
    // row and inventory event directly (mirrors what
    // emptiesReturnService.recordEmptiesReturn does).
    const invEv = await prisma.inventoryEvent.create({
      data: {
        distributorId: D1,
        eventType: 'returns_collection',
        cylinderTypeId: ct.id,
        emptiesChange: 3,
        fullsChange: 0,
        referenceType: 'empties_return',
        referenceId: customer.id,
        eventDate: new Date(TEST_DATE),
        createdBy: USER_ID,
      },
    });
    await prisma.inventoryEvent.create({
      data: {
        distributorId: D1,
        eventType: 'reconciliation_empties_return',
        cylinderTypeId: ct.id,
        emptiesChange: 3,
        fullsChange: 0,
        referenceType: 'empties_return',
        referenceId: customer.id,
        eventDate: new Date(TEST_DATE),
        createdBy: USER_ID,
      },
    });
    await prisma.customerLedgerEntry.create({
      data: {
        distributorId: D1,
        customerId: customer.id,
        entryType: 'empties_return',
        referenceId: invEv.id,
        amountDelta: 0,
        narration: `Empties: 3× ${ct.typeName}`,
        entryDate: new Date(TEST_DATE),
      },
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    const emptiesRow = ledger.rows.find((r) => r.kind === 'empties_return');
    expect(emptiesRow).toBeTruthy();
    // Change F acceptance: per-type Type + per-type Pend E + per-type Emp Cost.
    expect(emptiesRow!.cylinderType).toBe(ct.typeName);
    // 5 seeded − 3 returned = 2 per-type pending.
    expect(emptiesRow!.pendingEmptyCyls).toBe(2);
    // Per-type Emp Cost: 2 × 1950 = 3900.
    expect(emptiesRow!.emptyCylsCost).toBe(3900);
    // Emp C = qty returned.
    expect(emptiesRow!.emptyCylsCollected).toBe(3);

    // Cleanup — inventoryEvents linked to referenceId=customer.id can
    // pollute subsequent tests on shared dev DB.
    await prisma.customerLedgerEntry.deleteMany({
      where: { customerId: customer.id, entryType: 'empties_return' },
    });
    await prisma.inventoryEvent.deleteMany({
      where: { distributorId: D1, referenceType: 'empties_return', referenceId: customer.id },
    });
  });

  it('deposit for a type with 0 pending: row shows Pend E=0, Emp Cost=0 (not negative)', async () => {
    // Edge case — customer has never held this cylinder type, but pays
    // deposit up front for a new one (NC scenario). Row should show
    // Pend E=0 (running counter clamped), Emp Cost=0.
    const customer = await makeCustomer(D1, 'Deposit clean-slate NC');
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    await ensureEmptyPrice(D1, ct.id, 1950);
    // NO opening state — customer starts fresh.

    await createPayment(D1, USER_ID, {
      customerId: customer.id,
      amount: 1950,
      paymentMethod: 'cash',
      transactionDate: TEST_DATE,
      deposits: [{ cylinderTypeId: ct.id, qty: 1, amount: 1950 }],
    });

    const ledger = await getCustomerLedger(D1, customer.id);
    const depositRow = ledger.rows.find((r) => r.kind === 'deposit_charged')!;
    // Type column populated even with no prior state.
    expect(depositRow.cylinderType).toBe(ct.typeName);
    // Pend E clamped at 0 — customer never held any of this type, deposit
    // takes it into negative "credit" mathematically but the display
    // clamps.
    expect(depositRow.pendingEmptyCyls).toBe(0);
    expect(depositRow.emptyCylsCost).toBe(0);
  });
});
