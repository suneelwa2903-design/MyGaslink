/**
 * Group 4 (2026-06-11) — Empty cylinder opening balances + tenant fix.
 *
 *   4a. setupCustomerBalance now requires distributorId. Calling it with
 *       a customer from another tenant throws CrossTenantError → the
 *       route maps to 403 CROSS_TENANT_ACCESS. Empirically confirmed in
 *       Group K7 audit: Bhargava token wrote a balance to a Sharma
 *       customer; that path is now closed.
 *
 *   4b. importEmptyBalances CSV importer: idempotent upsert keyed on
 *       (customerId, cylinderTypeId); customer matched by name then
 *       phone fallback; cylinder type matched by typeName (case-
 *       insensitive). Per-row failures surface in the response.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { prisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import {
  setupCustomerBalance,
  importEmptyBalances,
  CrossTenantError,
} from '../services/customerService.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

const TRACK = 'G4-Test';
let app: Express;
let dist1Id: string;
let dist2Id: string;
let bhargavaToken: string;
let cylType19_d1: string;
let cylType19_d2: string;
let sharmaCustomerId: string;
let bhargavaCustomerId: string;

async function cleanup() {
  await prisma.customerInventoryBalance.deleteMany({
    where: { customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.customer.deleteMany({
    where: { customerName: { startsWith: TRACK } },
  });
}

beforeAll(async () => {
  app = createApp();
  dist1Id = 'dist-001';
  dist2Id = 'dist-002';

  const bhargava = await prisma.user.findUniqueOrThrow({
    where: { email: 'bhargava@gasagency.com' },
  });
  bhargavaToken = generateToken({
    userId: bhargava.id, email: bhargava.email,
    role: bhargava.role as UserRole, distributorId: bhargava.distributorId,
  });

  const t19_d1 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: dist1Id, typeName: '19 KG' }, select: { id: true },
  });
  const t19_d2 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: dist2Id, typeName: '19 KG' }, select: { id: true },
  });
  cylType19_d1 = t19_d1.id;
  cylType19_d2 = t19_d2.id;

  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  // Seed one customer on each tenant for the tenant-isolation test.
  const c1 = await prisma.customer.create({
    data: {
      distributorId: dist1Id, customerName: `${TRACK} Bhargava`, phone: '9100000400',
      customerType: 'B2C', creditPeriodDays: 30,
    },
  });
  bhargavaCustomerId = c1.id;
  const c2 = await prisma.customer.create({
    data: {
      distributorId: dist2Id, customerName: `${TRACK} Sharma`, phone: '9100000401',
      customerType: 'B2C', creditPeriodDays: 30,
    },
  });
  sharmaCustomerId = c2.id;
});

// ─── 4a — Tenant isolation on balance-setup ────────────────────────────────

describe('G4.4a — setupCustomerBalance tenant isolation', () => {
  it('positive: same-tenant call succeeds', async () => {
    const balances = await setupCustomerBalance(
      bhargavaCustomerId, dist1Id,
      [{ cylinderTypeId: cylType19_d1, withCustomerQty: 3, pendingReturns: 0 }],
    );
    expect(balances.length).toBeGreaterThan(0);
  });

  it('negative: dist-001 token cannot setup a dist-002 customer (CrossTenantError)', async () => {
    await expect(
      setupCustomerBalance(
        sharmaCustomerId, dist1Id,
        [{ cylinderTypeId: cylType19_d1, withCustomerQty: 3, pendingReturns: 0 }],
      ),
    ).rejects.toBeInstanceOf(CrossTenantError);

    // And the DB row must not exist
    const rows = await prisma.customerInventoryBalance.count({
      where: { customerId: sharmaCustomerId },
    });
    expect(rows).toBe(0);
  });

  it('negative: same-tenant customer + WRONG-tenant cylinderType also rejects', async () => {
    // Bhargava customer, but cylinderType id from dist-002 — must reject.
    await expect(
      setupCustomerBalance(
        bhargavaCustomerId, dist1Id,
        [{ cylinderTypeId: cylType19_d2, withCustomerQty: 3, pendingReturns: 0 }],
      ),
    ).rejects.toBeInstanceOf(CrossTenantError);
  });

  it('negative: HTTP route maps the throw to 403 CROSS_TENANT_ACCESS', async () => {
    const res = await request(app)
      .post(`/api/customers/${sharmaCustomerId}/balance-setup`)
      .set('Authorization', `Bearer ${bhargavaToken}`)
      .send({ balances: [{ cylinderTypeId: cylType19_d1, withCustomerQty: 3, pendingReturns: 0 }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_TENANT_ACCESS');

    const rows = await prisma.customerInventoryBalance.count({
      where: { customerId: sharmaCustomerId },
    });
    expect(rows).toBe(0);
  });
});

// ─── 4b — importEmptyBalances ──────────────────────────────────────────────

describe('G4.4b — importEmptyBalances', () => {
  it('positive: imports a new (customer, type) row', async () => {
    const r = await importEmptyBalances(dist1Id, [
      { customerName: `${TRACK} Bhargava`, cylinderType: '19 KG', emptyQuantity: 5 },
    ]);
    expect(r.imported).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.failures).toHaveLength(0);

    const row = await prisma.customerInventoryBalance.findFirstOrThrow({
      where: { customerId: bhargavaCustomerId, cylinderTypeId: cylType19_d1 },
      select: { withCustomerQty: true },
    });
    expect(row.withCustomerQty).toBe(5);
  });

  it('positive: re-import updates in place (idempotent)', async () => {
    await importEmptyBalances(dist1Id, [
      { customerName: `${TRACK} Bhargava`, cylinderType: '19 KG', emptyQuantity: 5 },
    ]);
    const r2 = await importEmptyBalances(dist1Id, [
      { customerName: `${TRACK} Bhargava`, cylinderType: '19 KG', emptyQuantity: 12 },
    ]);
    expect(r2.imported).toBe(0);
    expect(r2.updated).toBe(1);

    const row = await prisma.customerInventoryBalance.findFirstOrThrow({
      where: { customerId: bhargavaCustomerId, cylinderTypeId: cylType19_d1 },
      select: { withCustomerQty: true },
    });
    expect(row.withCustomerQty).toBe(12);
  });

  it('negative: unknown cylinder type fails the row, does not 500', async () => {
    const r = await importEmptyBalances(dist1Id, [
      { customerName: `${TRACK} Bhargava`, cylinderType: 'Made Up KG', emptyQuantity: 3 },
    ]);
    expect(r.imported).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toMatch(/not found/);
  });

  it('negative: unknown customer fails the row, does not 500', async () => {
    const r = await importEmptyBalances(dist1Id, [
      { customerName: `${TRACK} Does Not Exist`, cylinderType: '19 KG', emptyQuantity: 3 },
    ]);
    expect(r.imported).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toMatch(/customer not found/);
  });

  it('negative: cross-tenant customer name match is impossible (scoped by distributorId)', async () => {
    // Importing as dist-001 a customer whose name matches a dist-002
    // customer should not bind to that customer — scoped lookup fails.
    const r = await importEmptyBalances(dist1Id, [
      { customerName: `${TRACK} Sharma`, cylinderType: '19 KG', emptyQuantity: 7 },
    ]);
    expect(r.imported).toBe(0);
    expect(r.failures).toHaveLength(1);

    const rows = await prisma.customerInventoryBalance.count({
      where: { customerId: sharmaCustomerId },
    });
    expect(rows).toBe(0);
  });

  it('positive: phone fallback resolves when name is missing', async () => {
    const r = await importEmptyBalances(dist1Id, [
      { phone: '9100000400', cylinderType: '19 KG', emptyQuantity: 4 },
    ]);
    expect(r.imported).toBe(1);
    const row = await prisma.customerInventoryBalance.findFirstOrThrow({
      where: { customerId: bhargavaCustomerId, cylinderTypeId: cylType19_d1 },
      select: { withCustomerQty: true },
    });
    expect(row.withCustomerQty).toBe(4);
  });
});
