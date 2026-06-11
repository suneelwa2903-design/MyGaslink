/**
 * 2026-06-11 — `business_name` column in the customer CSV importer.
 *
 *   1. Positive: a row with `businessName` writes Customer.businessName
 *      on create.
 *   2. Negative: a row without `businessName` still works (back-compat
 *      with existing CSV files).
 *   3. Positive: re-uploading with a businessName updates the matched
 *      customer (same non-blank-only upsert rule as the other columns).
 *   4. Regression: blank `businessName` on update does NOT overwrite a
 *      stored value — matches the broader Group 3 "non-blank only" rule.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { importCustomers } from '../services/customerService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK = 'BN-Test';
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

afterAll(async () => { await cleanup(); });

beforeEach(async () => { await cleanup(); });

describe('CSV importer — business_name column', () => {
  it('positive: businessName from CSV lands on Customer.businessName', async () => {
    const r = await importCustomers(distributorId, [
      { name: `${TRACK} Royal`, phone: '9100009001', businessName: 'Royal Kitchen Pvt Ltd' },
    ]);
    expect(r.created).toBe(1);

    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, phone: '9100009001' },
      select: { customerName: true, businessName: true },
    });
    expect(cust.customerName).toBe(`${TRACK} Royal`);
    expect(cust.businessName).toBe('Royal Kitchen Pvt Ltd');
  });

  it('negative: row without businessName is created cleanly (back-compat)', async () => {
    const r = await importCustomers(distributorId, [
      { name: `${TRACK} NoBN`, phone: '9100009002' },
    ]);
    expect(r.created).toBe(1);

    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, phone: '9100009002' },
      select: { businessName: true },
    });
    expect(cust.businessName).toBeNull();
  });

  it('positive: re-uploading with a new businessName updates the matched customer', async () => {
    await importCustomers(distributorId, [
      { name: `${TRACK} Upd`, phone: '9100009003', businessName: 'Old Name Pvt Ltd' },
    ]);
    const r2 = await importCustomers(distributorId, [
      { name: `${TRACK} Upd`, phone: '9100009003', businessName: 'New Name Pvt Ltd' },
    ]);
    expect(r2.updated).toBe(1);

    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, phone: '9100009003' },
      select: { businessName: true },
    });
    expect(cust.businessName).toBe('New Name Pvt Ltd');
  });

  it('regression: blank businessName on update does NOT overwrite a stored value', async () => {
    await importCustomers(distributorId, [
      { name: `${TRACK} Pres`, phone: '9100009004', businessName: 'Stored Pvt Ltd' },
    ]);
    // Same phone match, blank businessName — must leave the stored value alone.
    await importCustomers(distributorId, [
      { name: `${TRACK} Pres`, phone: '9100009004', businessName: '' },
    ]);
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId, phone: '9100009004' },
      select: { businessName: true },
    });
    expect(cust.businessName).toBe('Stored Pvt Ltd');
  });
});
