/**
 * WI-2 — Empty Deposit Price in Settings.
 *
 * Per the WI-2 design discussion we reuse the existing
 * EmptyCylinderPrice table (single source of truth) instead of
 * duplicating onto CylinderType. The Settings UI is relabelled to
 * "Empty Deposit Price"; this test covers the wire contract that backs
 * it:
 *
 *   1) PUT /cylinder-types/empty-prices persists; GET /cylinder-types
 *      surfaces the value as `emptyDepositPrice` on the cylinder-type
 *      record (no extra round trip needed).
 *   2) Negative price -> 400 (Zod min(0) guard).
 *   3) Finance and inventory roles are forbidden (admin-only per WI-2 —
 *      deposit price drives Report Mismatch unit-amount, so non-admins
 *      must not be able to shift it).
 *
 * Fixtures: uses dist-002 (Sharma) which is seeded with real cylinder
 * types. Cleans up the test cylinder type at the end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';

const DIST = 'dist-002';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;
let cylinderTypeId: string;

beforeAll(async () => {
  app = createApp();

  // Real admin (sharma@gasdist.com) — seeded.
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  adminToken = generateToken({
    userId: admin.id, email: admin.email,
    role: admin.role as UserRole, distributorId: admin.distributorId,
  });

  const finance = await prisma.user.findFirstOrThrow({ where: { distributorId: DIST, role: 'finance', deletedAt: null } });
  financeToken = generateToken({
    userId: finance.id, email: finance.email,
    role: finance.role as UserRole, distributorId: finance.distributorId,
  });

  const inventory = await prisma.user.findFirstOrThrow({ where: { distributorId: DIST, role: 'inventory', deletedAt: null } });
  inventoryToken = generateToken({
    userId: inventory.id, email: inventory.email,
    role: inventory.role as UserRole, distributorId: inventory.distributorId,
  });

  // Use a dedicated test cylinder type so we don't trample real prices.
  const ct = await prisma.cylinderType.create({
    data: {
      distributorId: DIST,
      typeName: `WI2-TEST-${Date.now()}`,
      capacity: 1,
    },
  });
  cylinderTypeId = ct.id;
});

afterAll(async () => {
  await prisma.emptyCylinderPrice.deleteMany({ where: { cylinderTypeId } });
  await prisma.cylinderType.delete({ where: { id: cylinderTypeId } }).catch(() => undefined);
});

describe('WI-2 — Empty Deposit Price', () => {
  it('admin can save; GET /cylinder-types surfaces it as `emptyDepositPrice`', async () => {
    const putRes = await request(app)
      .put('/api/cylinder-types/empty-prices')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST)
      .send({ cylinderTypeId, emptyCylinderPrice: 1500 });

    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);

    const listRes = await request(app)
      .get('/api/cylinder-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST);

    expect(listRes.status).toBe(200);
    const types = listRes.body.data?.cylinderTypes as Array<{ cylinderTypeId: string; emptyDepositPrice: number | null }>;
    const target = types.find((t) => t.cylinderTypeId === cylinderTypeId);
    expect(target).toBeDefined();
    expect(target!.emptyDepositPrice).toBe(1500);
  });

  it('rejects a negative deposit price with 400', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/empty-prices')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST)
      .send({ cylinderTypeId, emptyCylinderPrice: -10 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('forbids finance from editing the deposit price (403)', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/empty-prices')
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Distributor-Id', DIST)
      .send({ cylinderTypeId, emptyCylinderPrice: 9000 });

    expect(res.status).toBe(403);
  });

  it('forbids inventory from editing the deposit price (403)', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/empty-prices')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({ cylinderTypeId, emptyCylinderPrice: 8500 });

    expect(res.status).toBe(403);
  });
});
