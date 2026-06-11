/**
 * Group E1 (2026-06-11) — multi-branch customers (same GSTIN).
 *
 *   - createCustomer with a GSTIN already used by another customer in
 *     the same tenant now succeeds + returns `warnings`. No more 409.
 *   - updateCustomer to set a GSTIN matching another row also returns
 *     `warnings` instead of 409.
 *   - importCustomers flags a CSV row that would CREATE a new customer
 *     whose GSTIN collides with an existing one. UPDATE paths skip the
 *     check (no self-match noise).
 *   - Multi-branch siblings get independent ledgers and IRN payloads
 *     (that's the whole reason a hard block was wrong).
 *
 * Tenant isolation: dist-001's GSTIN never trips a warning on dist-002.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  createCustomer,
  updateCustomer,
  importCustomers,
} from '../services/customerService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK = 'E1-Test';
const SHARED_GSTIN_36 = '36AABCU9603R1ZX'; // Telangana — for dist-001
const SHARED_GSTIN_29 = '29AABCU9603R1ZX'; // Karnataka  — for dist-002

let dist1Id: string;
let dist1UserId: string;
const dist2Id = 'dist-002';

async function cleanup() {
  // Delete in FK-safe order: child tables that reference customer first.
  await prisma.customerAuditTrail.deleteMany({
    where: { customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.customerLedgerEntry.deleteMany({
    where: { customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.customerContact.deleteMany({
    where: { customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.customer.deleteMany({
    where: { customerName: { startsWith: TRACK } },
  });
}

beforeAll(async () => {
  const a = await loginAsDistAdmin();
  dist1Id = a.distributorId;
  dist1UserId = a.user.id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

describe('E1 — createCustomer no longer throws 409 on duplicate GSTIN', () => {
  it('first customer with a GSTIN saves cleanly, no warnings', async () => {
    const r = await createCustomer(dist1Id, {
      customerName: `${TRACK}-KINARA-Main`,
      phone: '9123450101',
      gstin: SHARED_GSTIN_36,
    });
    expect(r.customer.customerName).toBe(`${TRACK}-KINARA-Main`);
    expect(r.warnings).toEqual([]);
  });

  it('second customer with the SAME GSTIN saves and returns a soft warning', async () => {
    await createCustomer(dist1Id, {
      customerName: `${TRACK}-KINARA-Main`,
      phone: '9123450101',
      gstin: SHARED_GSTIN_36,
    });
    const r = await createCustomer(dist1Id, {
      customerName: `${TRACK}-KINARA-Sec`,
      phone: '9123450102',
      gstin: SHARED_GSTIN_36,
    });
    expect(r.customer.customerName).toBe(`${TRACK}-KINARA-Sec`);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(`${TRACK}-KINARA-Main`);
    expect(r.warnings[0]).toContain('separate branch');
  });

  it('both branches persist as independent customer rows', async () => {
    await createCustomer(dist1Id, {
      customerName: `${TRACK}-Branch-A`,
      phone: '9123450103',
      gstin: SHARED_GSTIN_36,
      billingCity: 'Hyderabad',
    });
    await createCustomer(dist1Id, {
      customerName: `${TRACK}-Branch-B`,
      phone: '9123450104',
      gstin: SHARED_GSTIN_36,
      billingCity: 'Vijayawada',
    });
    const rows = await prisma.customer.findMany({
      where: { distributorId: dist1Id, gstin: SHARED_GSTIN_36, deletedAt: null },
      orderBy: { customerName: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].billingCity).toBe('Hyderabad');
    expect(rows[1].billingCity).toBe('Vijayawada');
    expect(rows[0].id).not.toBe(rows[1].id);
  });
});

describe('E1 — updateCustomer no longer throws 409 on duplicate GSTIN', () => {
  it('updating customer B to use customer A\'s GSTIN succeeds with a warning', async () => {
    const a = await createCustomer(dist1Id, {
      customerName: `${TRACK}-A`,
      phone: '9123450201',
      gstin: SHARED_GSTIN_36,
    });
    const b = await createCustomer(dist1Id, {
      customerName: `${TRACK}-B`,
      phone: '9123450202',
    });
    const updated = await updateCustomer(
      b.customer.id,
      dist1Id,
      { gstin: SHARED_GSTIN_36 },
      dist1UserId,
    );
    expect(updated.warnings).toHaveLength(1);
    expect(updated.warnings[0]).toContain(`${TRACK}-A`);
    expect(updated.customer.gstin).toBe(SHARED_GSTIN_36);
    void a;
  });

  it('updating without changing GSTIN does not produce a warning', async () => {
    const a = await createCustomer(dist1Id, {
      customerName: `${TRACK}-NoGstinChange`,
      phone: '9123450203',
      gstin: SHARED_GSTIN_36,
    });
    const updated = await updateCustomer(
      a.customer.id,
      dist1Id,
      { customerName: `${TRACK}-NoGstinChange-Renamed` },
      dist1UserId,
    );
    expect(updated.warnings).toEqual([]);
  });
});

describe('E1 — importCustomers (CSV) flags duplicate GSTIN on CREATE rows', () => {
  it('CSV row creating a new customer whose GSTIN matches existing yields a warning', async () => {
    await createCustomer(dist1Id, {
      customerName: `${TRACK}-CSV-First`,
      phone: '9123450301',
      gstin: SHARED_GSTIN_36,
    });
    const r = await importCustomers(dist1Id, [
      {
        name: `${TRACK}-CSV-Branch`,
        phone: '9123450302',
        gstin: SHARED_GSTIN_36,
      },
    ]);
    expect(r.created).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toContain(SHARED_GSTIN_36);
    expect(r.warnings[0].message).toContain(`${TRACK}-CSV-First`);
  });

  it('CSV UPDATE path (same phone match) skips the duplicate-GSTIN check', async () => {
    await createCustomer(dist1Id, {
      customerName: `${TRACK}-Update-Target`,
      phone: '9123450303',
      gstin: SHARED_GSTIN_36,
    });
    // CSV re-imports the same phone with the same GSTIN → matches by
    // phone → UPDATE path → no self-match warning.
    const r = await importCustomers(dist1Id, [
      {
        name: `${TRACK}-Update-Target`,
        phone: '9123450303',
        gstin: SHARED_GSTIN_36,
      },
    ]);
    expect(r.updated).toBe(1);
    expect(r.warnings).toEqual([]);
  });
});

describe('E1 — tenant isolation', () => {
  it('a GSTIN registered on dist-001 does not trigger a warning on dist-002', async () => {
    await createCustomer(dist1Id, {
      customerName: `${TRACK}-Dist1-Hold`,
      phone: '9123450401',
      gstin: SHARED_GSTIN_29,
    });
    const r = await createCustomer(dist2Id, {
      customerName: `${TRACK}-Dist2-Same-GSTIN`,
      phone: '9123450402',
      gstin: SHARED_GSTIN_29,
    });
    expect(r.warnings).toEqual([]);
  });

  it('CSV imports on dist-001 do not flag rows against dist-002 customers', async () => {
    await createCustomer(dist2Id, {
      customerName: `${TRACK}-Dist2-Holder`,
      phone: '9123450403',
      gstin: SHARED_GSTIN_29,
    });
    const r = await importCustomers(dist1Id, [
      {
        name: `${TRACK}-Dist1-NewBranch`,
        phone: '9123450404',
        gstin: SHARED_GSTIN_29,
      },
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.created).toBe(1);
  });
});
