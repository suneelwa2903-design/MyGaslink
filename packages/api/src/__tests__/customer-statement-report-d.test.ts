/**
 * Fix D (2026-06-11) — Customer Statement REPORT (Analytics → Reports).
 *
 * Pre-fix: pre-range debt was rolled into a numeric running-balance seed
 * with no visible "Balance b/f" row, and OB entries that happened to
 * fall inside the date window appeared as random `invoice_entry` rows
 * — the report quietly disagreed with the PDF (which folds every OB
 * into the b/f row at the top, dated from − 1 day).
 *
 * Post-fix the report mirrors the PDF:
 *   - explicit "Opening Balance b/f" row at the top whenever there is
 *     non-zero pre-range debt OR any OB invoice for the customer
 *   - b/f row dated `from − 1 day`
 *   - OB entries inside [from, to] are folded into b/f, not emitted
 *     as their own rows
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { customerStatement } from '../services/reportsService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK = 'FixD-Statement';
let distributorId: string;
let customerId: string;

async function cleanup() {
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: TRACK },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  await cleanup();
  const c = await prisma.customer.create({
    data: {
      distributorId, customerName: TRACK, phone: '9100000910',
      customerType: 'B2C', creditPeriodDays: 30,
    },
  });
  customerId = c.id;
});

afterAll(async () => { await cleanup(); });

beforeEach(async () => {
  await prisma.customerLedgerEntry.deleteMany({ where: { distributorId, customerId } });
  await prisma.invoice.deleteMany({ where: { distributorId, customerId } });
});

async function seedOB(amount: number, dateIso: string) {
  const d = new Date(dateIso);
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: `FIXD-OB-${Math.random().toString(36).slice(2, 8)}`,
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
}

async function seedRegularInvoice(amount: number, dateIso: string) {
  const d = new Date(dateIso);
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: `FIXD-INV-${Math.random().toString(36).slice(2, 8)}`,
      distributorId, customerId,
      issueDate: d, dueDate: d,
      totalAmount: amount, outstandingAmount: amount, amountPaid: 0,
      status: 'issued',
    },
  });
  await prisma.customerLedgerEntry.create({
    data: {
      distributorId, customerId,
      entryType: 'invoice_entry',
      referenceId: inv.id, invoiceId: inv.id,
      amountDelta: amount, narration: 'Invoice ' + inv.invoiceNumber,
      entryDate: d,
    },
  });
}

describe('Fix D — Customer Statement REPORT folds OB into b/f', () => {
  it('positive: pre-range OB renders as a single "Opening Balance b/f" row at the top, dated from − 1', async () => {
    await seedOB(15000, '2026-01-01');
    await seedRegularInvoice(2000, '2026-06-05');

    const res = await customerStatement(distributorId, {
      customerId, dateFrom: '2026-06-01', dateTo: '2026-06-30',
    });

    const first = (res.rows as Array<Record<string, unknown>>)[0];
    expect(first.type).toBe('opening');
    expect(first.narration).toBe('Opening Balance b/f');
    expect(first.debit).toBe(15000);
    expect(first.balance).toBe(15000);
    expect(first.date).toBe('2026-05-31'); // from − 1 day

    // Closing balance includes OB + the in-range invoice
    expect((res.totals as { balance: number }).balance).toBe(17000);
  });

  it('positive: OB issued INSIDE the date window is also folded into b/f, not emitted as its own row', async () => {
    // KN runs the report for "June 2026" but the OB importer stamped
    // entryDate=2026-06-15 (because no goLiveDate / asOfDate). The OB
    // must STILL appear in the b/f row, not as a chronological invoice
    // row in the middle of the report.
    await seedOB(8000, '2026-06-15');
    await seedRegularInvoice(3000, '2026-06-20');

    const res = await customerStatement(distributorId, {
      customerId, dateFrom: '2026-06-01', dateTo: '2026-06-30',
    });

    const rows = res.rows as Array<Record<string, unknown>>;
    expect(rows[0].type).toBe('opening');
    expect(rows[0].debit).toBe(8000);
    // The OB invoice_entry from 2026-06-15 must NOT appear as a separate row
    const obAsInvoiceRow = rows.slice(1).find((r) =>
      r.type === 'invoice' && r.narration === 'Opening Balance b/f'
    );
    expect(obAsInvoiceRow).toBeUndefined();
    expect(rows.length).toBe(2); // b/f + the one regular invoice
  });

  it('negative: customer with no debt at all produces no b/f row + empty body', async () => {
    const res = await customerStatement(distributorId, {
      customerId, dateFrom: '2026-06-01', dateTo: '2026-06-30',
    });
    expect(res.rows).toHaveLength(0);
    expect((res.totals as { balance: number }).balance).toBe(0);
  });

  it('negative: no customerId throws 400-shaped error', async () => {
    await expect(
      customerStatement(distributorId, { dateFrom: '2026-06-01', dateTo: '2026-06-30' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
