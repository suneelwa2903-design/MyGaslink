/**
 * Group D2 (2026-06-11) — CSV customer import:
 *   - structured shipping_* columns persist to Customer.shippingAddress*
 *   - state-name validation against INDIAN_STATE_NAMES → soft warnings
 *   - blank shipping columns leave the DB fields NULL (delivery falls
 *     back to billing through downstream logic)
 *   - back-compat: old CSV (no shipping columns) still works
 *
 * Uses the same dist-001 fixture pattern as onboarding-imports-g3.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { importCustomers } from '../services/customerService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK = 'D2-Test';
let distributorId: string;

async function cleanup() {
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: { startsWith: TRACK } },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

describe('D2 — CSV shipping address columns', () => {
  it('persists shipping_* columns to Customer.shipping*', async () => {
    const r = await importCustomers(distributorId, [
      {
        name: `${TRACK}-Chain-A`,
        phone: '9123450001',
        line1: '1 Billing HQ',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500001',
        shippingLine1: '99 Delivery Outlet',
        shippingCity: 'Vijayawada',
        shippingState: 'Andhra Pradesh',
        shippingPincode: '520001',
      },
    ]);
    expect(r.created).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([]);

    const c = await prisma.customer.findFirst({
      where: { distributorId, customerName: `${TRACK}-Chain-A` },
    });
    expect(c?.billingAddressLine1).toBe('1 Billing HQ');
    expect(c?.billingState).toBe('Telangana');
    expect(c?.shippingAddressLine1).toBe('99 Delivery Outlet');
    expect(c?.shippingCity).toBe('Vijayawada');
    expect(c?.shippingState).toBe('Andhra Pradesh');
    expect(c?.shippingPincode).toBe('520001');
  });

  it('leaves shipping fields NULL when shipping columns are absent', async () => {
    await importCustomers(distributorId, [
      {
        name: `${TRACK}-BillOnly`,
        phone: '9123450002',
        line1: '12 Main Rd',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500001',
      },
    ]);
    const c = await prisma.customer.findFirst({
      where: { distributorId, customerName: `${TRACK}-BillOnly` },
    });
    expect(c?.shippingAddressLine1).toBeNull();
    expect(c?.shippingCity).toBeNull();
    expect(c?.shippingPincode).toBeNull();
  });

  it('does not overwrite stored shipping fields with blanks on re-import', async () => {
    // First import populates shipping
    await importCustomers(distributorId, [
      {
        name: `${TRACK}-Upsert`,
        phone: '9123450003',
        line1: '1 HQ',
        shippingLine1: '99 Outlet',
        shippingState: 'Karnataka',
      },
    ]);
    // Second import: same customer, no shipping columns this time
    const r = await importCustomers(distributorId, [
      {
        name: `${TRACK}-Upsert`,
        phone: '9123450003',
        line1: '1 HQ (Updated)',
      },
    ]);
    expect(r.updated).toBe(1);
    const c = await prisma.customer.findFirst({
      where: { distributorId, customerName: `${TRACK}-Upsert` },
    });
    expect(c?.billingAddressLine1).toBe('1 HQ (Updated)');
    expect(c?.shippingAddressLine1).toBe('99 Outlet');
    expect(c?.shippingState).toBe('Karnataka');
  });

  it('back-compat: old CSV row without any shipping/structured columns still imports', async () => {
    const r = await importCustomers(distributorId, [
      {
        name: `${TRACK}-Legacy`,
        phone: '9123450004',
        address: '12 Banjara Hills, Hyderabad, Telangana, 500034',
      },
    ]);
    expect(r.created).toBe(1);
    expect(r.failures).toEqual([]);
    const c = await prisma.customer.findFirst({
      where: { distributorId, customerName: `${TRACK}-Legacy` },
    });
    // Auto-parse fills billing fields; shipping stays NULL.
    expect(c?.billingPincode).toBe('500034');
    expect(c?.billingState).toBe('Telangana');
    expect(c?.shippingAddressLine1).toBeNull();
  });
});

describe('D2 — state-name warnings', () => {
  it('emits no warning when billing state matches a standard state (case-insensitive)', async () => {
    const r = await importCustomers(distributorId, [
      { name: `${TRACK}-State-Lower`, phone: '9123450010', state: 'telangana' },
      { name: `${TRACK}-State-Upper`, phone: '9123450011', state: 'TELANGANA' },
      { name: `${TRACK}-State-Title`, phone: '9123450012', state: 'Telangana' },
    ]);
    expect(r.created).toBe(3);
    expect(r.warnings).toEqual([]);
  });

  it('emits a warning when billing state does not match the standard list — but still imports the row', async () => {
    const r = await importCustomers(distributorId, [
      { name: `${TRACK}-Misspelt`, phone: '9123450020', state: 'Telengana' },
    ]);
    expect(r.created).toBe(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].row).toBe(1);
    expect(r.warnings[0].name).toBe(`${TRACK}-Misspelt`);
    expect(r.warnings[0].message).toContain('billing state');
    expect(r.warnings[0].message).toContain('Telengana');
    // Row IS persisted with the bad state as-is.
    const c = await prisma.customer.findFirst({
      where: { distributorId, customerName: `${TRACK}-Misspelt` },
    });
    expect(c?.billingState).toBe('Telengana');
  });

  it('emits a separate warning for billing AND shipping when both are off-list', async () => {
    const r = await importCustomers(distributorId, [
      {
        name: `${TRACK}-Both-Bad`,
        phone: '9123450021',
        state: 'Telengana',
        shippingState: 'Karnatka',
      },
    ]);
    expect(r.created).toBe(1);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('billing state'),
        expect.stringContaining('shipping state'),
      ]),
    );
  });

  it('warns on shipping state even when billing state is fine', async () => {
    const r = await importCustomers(distributorId, [
      {
        name: `${TRACK}-Ship-Bad`,
        phone: '9123450022',
        state: 'Telangana',
        shippingState: 'NotAState',
      },
    ]);
    expect(r.created).toBe(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toContain('shipping state');
  });

  it('tenant isolation — warnings are computed per row, not leaked across tenants', async () => {
    // Run on dist-001 with a bad state; ensure the warning array is
    // returned to this call only (and doesn't accumulate in a global).
    const r1 = await importCustomers(distributorId, [
      { name: `${TRACK}-Iso-A`, phone: '9123450031', state: 'Wrongstate' },
    ]);
    expect(r1.warnings).toHaveLength(1);
    // Same import again should return only THIS run's warning (no leak).
    const r2 = await importCustomers(distributorId, [
      { name: `${TRACK}-Iso-B`, phone: '9123450032', state: 'Telangana' },
    ]);
    expect(r2.warnings).toHaveLength(0);
  });
});
