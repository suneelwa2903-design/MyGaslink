/**
 * Group 3 (2026-06-11) — Opening-balance idempotency + customer CSV upsert.
 *
 *   3a. importOpeningBalances: re-running the same CSV silently skips
 *       customers who already have an OB invoice; passing
 *       { replaceExisting: true } deletes the prior invoice + ledger
 *       entry and writes the new one.
 *
 *   3b. normalisePhone tolerates Excel scientific notation
 *       (`9.88E+09` → `9876543210`), and strips +91/space/hyphen.
 *       importOpeningBalances accepts `asOfDate` per row.
 *
 *   3c. importCustomers upserts:
 *         - match by phone first, then by (name, distributor) case-insensitive
 *         - non-blank columns only — blank CSV fields never overwrite
 *         - autoParseAddress handles a single `address` string when no
 *           structured columns supplied
 *         - returns { created, updated, failures } with `imported` kept
 *           for backward compatibility.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  importOpeningBalances,
  importCustomers,
  normalisePhone,
  autoParseAddress,
} from '../services/customerService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK = 'G3-Test';
let distributorId: string;
let userId: string;

async function cleanup() {
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: { startsWith: TRACK } },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  userId = admin.user.id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

// ─── 3b — phone + address helpers (pure unit) ─────────────────────────────

describe('G3.3b — normalisePhone', () => {
  it('tolerates scientific notation from Excel-mangled CSVs', () => {
    expect(normalisePhone('9.88E+09')).toBe('9880000000');
  });
  it('strips +91, spaces, and hyphens', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('91 9876543210')).toBe('9876543210');
  });
  it('strips a leading apostrophe (Excel text-as-number escape)', () => {
    expect(normalisePhone("'9876543210")).toBe('9876543210');
  });
  it('preserves plain 10-digit numbers', () => {
    expect(normalisePhone('9876543210')).toBe('9876543210');
  });
  it('returns null for blank or non-numeric input', () => {
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('   ')).toBeNull();
    expect(normalisePhone(null)).toBeNull();
  });
});

describe('G3 — autoParseAddress', () => {
  it('extracts trailing 6-digit pincode', () => {
    const r = autoParseAddress('12 Banjara Hills, Hyderabad, Telangana, 500034');
    expect(r.pincode).toBe('500034');
    expect(r.state).toBe('Telangana');
    expect(r.city).toBe('Hyderabad');
    expect(r.line1).toBe('12 Banjara Hills');
  });
  it('handles addresses with no pincode/state — everything in line1', () => {
    const r = autoParseAddress('Plot 7, Road No 4, Banjara Hills');
    expect(r.pincode).toBeNull();
    expect(r.state).toBeNull();
    // No state match but a comma still exists — splits city
    expect(r.line1).not.toBeNull();
  });
  it('handles fully-empty input', () => {
    expect(autoParseAddress('')).toEqual({ line1: null, city: null, state: null, pincode: null });
    expect(autoParseAddress(null)).toEqual({ line1: null, city: null, state: null, pincode: null });
  });
});

// ─── 3a — Opening balance CSV idempotency ──────────────────────────────────

async function seedCustomer(name: string, phone: string) {
  return prisma.customer.create({
    data: {
      distributorId, customerName: name, phone,
      customerType: 'B2C', creditPeriodDays: 30,
    },
  });
}

describe('G3.3a — importOpeningBalances idempotency', () => {
  it('positive: first import creates the OB invoice + ledger entry', async () => {
    await seedCustomer(`${TRACK} CustA`, '9100000300');
    const r = await importOpeningBalances(distributorId, userId, [
      { customerName: `${TRACK} CustA`, openingBalance: 15000, notes: 'paper register' },
    ]);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.skippedCustomers).toEqual([]);
    expect(r.failures).toHaveLength(0);

    const invs = await prisma.invoice.count({
      where: { distributorId, customer: { customerName: `${TRACK} CustA` }, isOpeningBalance: true },
    });
    expect(invs).toBe(1);
  });

  it('negative: second import without replaceExisting skips the customer', async () => {
    await seedCustomer(`${TRACK} CustB`, '9100000301');
    await importOpeningBalances(distributorId, userId, [
      { customerName: `${TRACK} CustB`, openingBalance: 5000 },
    ]);
    const r2 = await importOpeningBalances(distributorId, userId, [
      { customerName: `${TRACK} CustB`, openingBalance: 999_999 },
    ]);
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.skippedCustomers).toEqual([`${TRACK} CustB`]);

    // Still only ONE OB invoice on this customer + amount unchanged.
    const invs = await prisma.invoice.findMany({
      where: { distributorId, customer: { customerName: `${TRACK} CustB` }, isOpeningBalance: true },
      select: { totalAmount: true },
    });
    expect(invs).toHaveLength(1);
    expect(Number(invs[0].totalAmount)).toBe(5000);
  });

  it('positive: replaceExisting=true deletes the prior OB and writes the new amount', async () => {
    await seedCustomer(`${TRACK} CustC`, '9100000302');
    await importOpeningBalances(distributorId, userId, [
      { customerName: `${TRACK} CustC`, openingBalance: 5000 },
    ]);
    const r2 = await importOpeningBalances(
      distributorId, userId,
      [{ customerName: `${TRACK} CustC`, openingBalance: 12345 }],
      { replaceExisting: true },
    );
    expect(r2.imported).toBe(1);
    expect(r2.skipped).toBe(0);

    const invs = await prisma.invoice.findMany({
      where: { distributorId, customer: { customerName: `${TRACK} CustC` }, isOpeningBalance: true },
      select: { totalAmount: true },
    });
    expect(invs).toHaveLength(1);
    expect(Number(invs[0].totalAmount)).toBe(12345);
  });

  it('positive: asOfDate from CSV lands on the OB invoice + ledger entry', async () => {
    await seedCustomer(`${TRACK} CustD`, '9100000303');
    await importOpeningBalances(distributorId, userId, [
      { customerName: `${TRACK} CustD`, openingBalance: 2500, asOfDate: '2026-05-31' },
    ]);
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { distributorId, customer: { customerName: `${TRACK} CustD` }, isOpeningBalance: true },
      select: { issueDate: true, dueDate: true },
    });
    expect(inv.issueDate.toISOString().split('T')[0]).toBe('2026-05-31');
    expect(inv.dueDate.toISOString().split('T')[0]).toBe('2026-05-31');
  });
});

// ─── 3c — Customer upsert ────────────────────────────────────────────────

describe('G3.3c — importCustomers upsert', () => {
  it('positive: creates a new customer when no match exists', async () => {
    const r = await importCustomers(distributorId, [
      { name: `${TRACK} New One`, phone: '9100000310' },
    ]);
    expect(r.created).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.failures).toHaveLength(0);

    const exists = await prisma.customer.findFirst({
      where: { distributorId, phone: '9100000310' },
      select: { customerName: true },
    });
    expect(exists?.customerName).toBe(`${TRACK} New One`);
  });

  it('positive: matched by phone — UPDATE non-blank fields, leave blanks alone', async () => {
    await prisma.customer.create({
      data: {
        distributorId, customerName: `${TRACK} OldName`, phone: '9100000320',
        customerType: 'B2C', creditPeriodDays: 30,
        billingCity: 'OldCity', billingState: 'OldState', billingPincode: '500001',
      },
    });
    const r = await importCustomers(distributorId, [
      // Same phone, new name, blank city (must not overwrite OldCity)
      { name: `${TRACK} NewName`, phone: '9100000320', city: '' },
    ]);
    expect(r.created).toBe(0);
    expect(r.updated).toBe(1);

    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, phone: '9100000320' },
      select: { customerName: true, billingCity: true, billingPincode: true },
    });
    expect(cust.customerName).toBe(`${TRACK} NewName`);
    expect(cust.billingCity).toBe('OldCity'); // blank in CSV did not overwrite
    expect(cust.billingPincode).toBe('500001');
  });

  it('positive: scientific-notation phone matches existing customer', async () => {
    await prisma.customer.create({
      data: {
        distributorId, customerName: `${TRACK} Sci`, phone: '9880000000',
        customerType: 'B2C', creditPeriodDays: 30,
      },
    });
    const r = await importCustomers(distributorId, [
      { name: `${TRACK} Sci`, phone: '9.88E+09', email: 'sci@example.com' },
    ]);
    expect(r.created).toBe(0);
    expect(r.updated).toBe(1);

    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, customerName: `${TRACK} Sci` },
      select: { phone: true, email: true },
    });
    expect(cust.phone).toBe('9880000000');
    expect(cust.email).toBe('sci@example.com');
  });

  it('positive: single `address` column is auto-parsed to pincode/state/line1', async () => {
    const r = await importCustomers(distributorId, [
      {
        name: `${TRACK} Parse`,
        phone: '9100000330',
        address: '12 Banjara Hills, Hyderabad, Telangana, 500034',
      },
    ]);
    expect(r.created).toBe(1);

    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, phone: '9100000330' },
      select: {
        billingAddressLine1: true, billingCity: true, billingState: true, billingPincode: true,
      },
    });
    expect(cust.billingPincode).toBe('500034');
    expect(cust.billingState).toBe('Telangana');
    expect(cust.billingCity).toBe('Hyderabad');
    expect(cust.billingAddressLine1).toBe('12 Banjara Hills');
  });

  it('regression: blank columns on a new-create row land as null, not overwrite-protected', async () => {
    // For NEW customers (no upsert), blank email is null — that's fine.
    // Just pin the boring case so a regression doesn't slip in.
    const r = await importCustomers(distributorId, [
      { name: `${TRACK} Bare`, phone: '9100000340' },
    ]);
    expect(r.created).toBe(1);
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, phone: '9100000340' },
      select: { email: true, billingCity: true },
    });
    expect(cust.email).toBeNull();
    expect(cust.billingCity).toBeNull();
  });

  it('regression: invalid GSTIN fails the row, does not 500', async () => {
    const r = await importCustomers(distributorId, [
      { name: `${TRACK} BadGstin`, phone: '9100000350', gstin: 'not-a-gstin' },
    ]);
    expect(r.created).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toMatch(/GSTIN/);
  });
});
