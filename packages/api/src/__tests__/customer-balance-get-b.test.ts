/**
 * Fix B (2026-06-11) — GET /api/customers/:id/balance.
 *
 *   1. Positive: returns CustomerInventoryBalance rows enriched with
 *      cylinderTypeName for the customer's own tenant.
 *   2. Negative: returns 404 when the customer id belongs to another
 *      tenant — mirrors the existing pattern in this file (we don't
 *      leak tenant existence with a 403).
 *   3. Positive: a customer with no balances returns `{ balances: [] }`
 *      (not an error).
 *   4. Regression: POST /balance-setup still works after the GET
 *      addition (covered by G4 tests; quick re-pin here).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { prisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

const TRACK = 'FixB-Balance';
let app: Express;
let dist1Token: string;
let dist1CustomerId: string;
let dist2CustomerId: string;
let cyl19_d1: string;

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
  const u = await prisma.user.findUniqueOrThrow({ where: { email: 'bhargava@gasagency.com' } });
  dist1Token = generateToken({
    userId: u.id, email: u.email, role: u.role as UserRole, distributorId: u.distributorId,
  });
  const t19 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: 'dist-001', typeName: '19 KG' }, select: { id: true },
  });
  cyl19_d1 = t19.id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  const c1 = await prisma.customer.create({
    data: {
      distributorId: 'dist-001', customerName: `${TRACK} Own`, phone: '9100000700',
      customerType: 'B2C', creditPeriodDays: 30,
    },
  });
  dist1CustomerId = c1.id;
  const c2 = await prisma.customer.create({
    data: {
      distributorId: 'dist-002', customerName: `${TRACK} Other`, phone: '9100000701',
      customerType: 'B2C', creditPeriodDays: 30,
    },
  });
  dist2CustomerId = c2.id;
});

describe('Fix B — GET /api/customers/:id/balance', () => {
  it('positive: returns own-tenant balances with cylinderTypeName + count', async () => {
    await prisma.customerInventoryBalance.create({
      data: {
        customerId: dist1CustomerId, cylinderTypeId: cyl19_d1,
        withCustomerQty: 5, pendingReturns: 1, missingQty: 0,
      },
    });
    const res = await request(app)
      .get(`/api/customers/${dist1CustomerId}/balance`)
      .set('Authorization', `Bearer ${dist1Token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.balances).toHaveLength(1);
    expect(res.body.data.balances[0]).toMatchObject({
      cylinderTypeId: cyl19_d1,
      cylinderTypeName: '19 KG',
      withCustomerQty: 5,
      pendingReturns: 1,
      missingQty: 0,
    });
    expect(typeof res.body.data.balances[0].updatedAt).toBe('string');
  });

  it('negative: dist-001 cannot read a dist-002 customer (404, no leak)', async () => {
    await prisma.customerInventoryBalance.create({
      data: {
        customerId: dist2CustomerId, cylinderTypeId: cyl19_d1,
        withCustomerQty: 99, pendingReturns: 0, missingQty: 0,
      },
    });
    const res = await request(app)
      .get(`/api/customers/${dist2CustomerId}/balance`)
      .set('Authorization', `Bearer ${dist1Token}`);
    expect(res.status).toBe(404);
  });

  it('positive: customer with no balances returns { balances: [] }', async () => {
    const res = await request(app)
      .get(`/api/customers/${dist1CustomerId}/balance`)
      .set('Authorization', `Bearer ${dist1Token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.balances).toEqual([]);
  });

  it('regression: GET then POST /balance-setup round-trip still works', async () => {
    // Write via POST, read via GET, confirm values match.
    await request(app)
      .post(`/api/customers/${dist1CustomerId}/balance-setup`)
      .set('Authorization', `Bearer ${dist1Token}`)
      .send({ balances: [{ cylinderTypeId: cyl19_d1, withCustomerQty: 7, pendingReturns: 2 }] });
    const res = await request(app)
      .get(`/api/customers/${dist1CustomerId}/balance`)
      .set('Authorization', `Bearer ${dist1Token}`);
    expect(res.body.data.balances[0].withCustomerQty).toBe(7);
    expect(res.body.data.balances[0].pendingReturns).toBe(2);
  });
});
