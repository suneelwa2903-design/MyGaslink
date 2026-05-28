/**
 * WI-3 — Adjust Stock: empties bucket + history + manualEmpties summary.
 *
 * Covers:
 *   POSITIVE
 *     • +5 empties via /inventory/manual-adjustment immediately raises
 *       closingEmpties by 5 in the summary (manualEmpties bucket lands
 *       inside the new closingEmpties formula).
 *     • GET /inventory/manual-adjustments lists adjustments with
 *       pagination, filters on bucket / cylinderTypeId / date range, and
 *       hydrates the cylinder + entered-by columns.
 *
 *   NEGATIVE
 *     • Finance cannot PATCH another user's adjustment notes (PATCH is
 *       admin-only per the WI-3 RBAC tightening).
 *     • Admin PATCH after the 24h window returns 400 with a clear
 *       message.
 *
 * Anti-pattern #7: uses a far-future date (2099-12-31) so seeded test
 * fixtures never collide with manual-test data on the shared dev DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';

const DIST = 'dist-002';
const TEST_DATE = '2099-12-31';

let app: Express;
let adminToken: string;
let financeToken: string;
let cylinderTypeId: string;
const createdEventIds: string[] = [];

beforeAll(async () => {
  app = createApp();

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

  // Dedicated cylinder type so the manualEmpties closing math is
  // independent of any other in-flight fixtures.
  const ct = await prisma.cylinderType.create({
    data: {
      distributorId: DIST,
      typeName: `WI3-TEST-${Date.now()}`,
      capacity: 1,
    },
  });
  cylinderTypeId = ct.id;
});

afterAll(async () => {
  // Clean up everything we created (events + summary rows + cylinder
  // type). Order matters: events first so the summary recompute on
  // delete doesn't blow up.
  await prisma.inventoryEvent.deleteMany({
    where: { id: { in: createdEventIds } },
  });
  await prisma.inventorySummary.deleteMany({
    where: { distributorId: DIST, cylinderTypeId },
  });
  await prisma.cylinderType.delete({ where: { id: cylinderTypeId } }).catch(() => undefined);
});

describe('WI-3 — Adjust Stock empties + history', () => {
  it('POSITIVE — +5 empties immediately raises closingEmpties by 5', async () => {
    // Baseline: today's closing for this fresh cylinder type is 0/0.
    const beforeRes = await request(app)
      .get(`/api/inventory/summary/${TEST_DATE}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST);
    expect(beforeRes.status).toBe(200);
    const beforeRow = (beforeRes.body.data as Array<{ cylinderTypeId: string; closingEmpties: number }>)
      .find((r) => r.cylinderTypeId === cylinderTypeId);
    const baselineClosing = beforeRow?.closingEmpties ?? 0;

    const postRes = await request(app)
      .post('/api/inventory/manual-adjustment')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        cylinderTypeId,
        bucket: 'empties',
        adjustmentType: 'add',
        quantity: 5,
        reason: 'Cycle count correction (WI-3 test)',
        adjustmentDate: TEST_DATE,
      });
    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
    createdEventIds.push(postRes.body.data.eventId);

    const afterRes = await request(app)
      .get(`/api/inventory/summary/${TEST_DATE}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST);
    const afterRow = (afterRes.body.data as Array<{ cylinderTypeId: string; closingEmpties: number }>)
      .find((r) => r.cylinderTypeId === cylinderTypeId);
    expect(afterRow).toBeDefined();
    expect(afterRow!.closingEmpties).toBe(baselineClosing + 5);
  });

  it('POSITIVE — history endpoint returns the new row with pagination meta', async () => {
    const res = await request(app)
      .get(`/api/inventory/manual-adjustments?cylinderTypeId=${cylinderTypeId}&bucket=empties&page=1&pageSize=10`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST);

    expect(res.status).toBe(200);
    const body = res.body.data as {
      data: Array<{ bucket: 'fulls' | 'empties'; quantity: number; cylinderTypeName: string; enteredByName: string }>;
      meta: { page: number; pageSize: number; total: number; totalPages: number };
    };
    expect(body.meta.page).toBe(1);
    expect(body.meta.pageSize).toBe(10);
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const target = body.data.find((r) => r.quantity === 5);
    expect(target).toBeDefined();
    expect(target!.bucket).toBe('empties');
    expect(target!.cylinderTypeName).toContain('WI3-TEST-');
    expect(target!.enteredByName).toBeTruthy();
  });

  it('NEGATIVE — finance cannot PATCH adjustment notes (admin-only)', async () => {
    const eventId = createdEventIds[0];
    expect(eventId).toBeTruthy();
    const res = await request(app)
      .patch(`/api/inventory/manual-adjustments/${eventId}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Distributor-Id', DIST)
      .send({ notes: 'Finance attempting unauthorised edit' });
    expect(res.status).toBe(403);
  });

  it('NEGATIVE — admin PATCH after 24h is rejected with 400', async () => {
    // Backdate the event row directly so it's > 24h old; admin patch
    // should still be rejected by the service-side guard.
    const eventId = createdEventIds[0];
    const oldCreatedAt = new Date(Date.now() - 25 * 3600 * 1000);
    await prisma.inventoryEvent.update({
      where: { id: eventId },
      data: { createdAt: oldCreatedAt },
    });

    const res = await request(app)
      .patch(`/api/inventory/manual-adjustments/${eventId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST)
      .send({ notes: 'Late correction attempt' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/24 hours/i);

    // Bring the timestamp back so the row's afterAll cleanup is normal.
    await prisma.inventoryEvent.update({
      where: { id: eventId },
      data: { createdAt: new Date() },
    });
  });

  it('POSITIVE — admin PATCH inside 24h updates only the notes field', async () => {
    const eventId = createdEventIds[0];
    const res = await request(app)
      .patch(`/api/inventory/manual-adjustments/${eventId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST)
      .send({ notes: 'Updated reason — corrected by admin' });
    expect(res.status).toBe(200);
    const updated = await prisma.inventoryEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(updated.notes).toBe('Updated reason — corrected by admin');
    expect(updated.emptiesChange).toBe(5); // qty immutable
    expect(updated.fullsChange).toBe(0);
  });
});
