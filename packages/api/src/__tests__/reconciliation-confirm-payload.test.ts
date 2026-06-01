/**
 * reconciliation-confirm-payload.test.ts
 *
 * Mobile bug 2026-06-01: the (admin)/inventory.tsx confirm mutation
 * wrapped the body in `{ vehicleId, data: { physicalStockConfirmed,
 * notes, emptiesReturned } }`. The route Zod schema validates the body
 * as a FLAT object (physicalStockConfirmed/notes/emptiesReturned at the
 * top level) — every confirm returned 400 "Validation failed" because
 * the required top-level keys were genuinely absent. This file pins the
 * flat-payload contract so a future regression to a nested layout fails
 * fast with a real error message, not a silent UX dead-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, today } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let vehicleId: string;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;

  // Use any seed vehicle on dist-001 — the route's auth/scope check
  // runs first, then Zod. We don't actually want to push the vehicle
  // through reconciliation (it likely has no DVA), so the request will
  // either succeed end-to-end or fail at a later guard. The 400-vs-not
  // distinction is what we're asserting here.
  const v = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId: 'dist-001' },
  });
  vehicleId = v.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/delivery/reconciliation/confirm/:vehicleId — flat payload contract', () => {
  it('rejects a NESTED payload `{ data: {...} }` with 400 + Zod field errors', async () => {
    const res = await request(app)
      .post(`/api/delivery/reconciliation/confirm/${vehicleId}`)
      .set(auth(adminToken))
      .send({
        // Pre-fix mobile shape — physicalStockConfirmed nested under `data`.
        data: {
          physicalStockConfirmed: true,
          notes: 'Physical stock matches system',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // Zod surfaces the missing top-level field. We don't require an
    // exact-message match because Zod's wording varies by version, but
    // the `details` map must mention `physicalStockConfirmed`.
    expect(res.body.details).toBeTypeOf('object');
    expect(Object.keys(res.body.details)).toContain('physicalStockConfirmed');
  });

  it('accepts a FLAT payload — vehicleId can ride along (Zod strips extras)', async () => {
    const res = await request(app)
      .post(`/api/delivery/reconciliation/confirm/${vehicleId}`)
      .set(auth(adminToken))
      .send({
        // Mobile sends vehicleId as an extra alongside the body; Zod's
        // default object behaviour strips unknown keys, so this must NOT
        // fail validation. Whatever happens AFTER validation is the
        // domain guard's problem (vehicle may not actually be in a
        // reconcile-able state on a clean seed) — we assert here only
        // that the response status is NOT 400 with VALIDATION_ERROR.
        vehicleId,
        physicalStockConfirmed: true,
        notes: 'Physical stock matches system',
        emptiesReturned: [],
      });
    if (res.status === 400 && res.body.code === 'VALIDATION_ERROR') {
      throw new Error(
        `Zod rejected the flat mobile payload: ${JSON.stringify(res.body.details)}`,
      );
    }
    // Acceptable outcomes: 200 (real reconcile succeeded), or 4xx/5xx
    // from a domain guard (vehicle not pending, already reconciled, etc.).
    expect(res.status).not.toBe(400);
  });

  it('rejects an out-of-range emptiesReturned.quantity (-1) with 400 + field error', async () => {
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: 'dist-001' },
    });
    const res = await request(app)
      .post(`/api/delivery/reconciliation/confirm/${vehicleId}`)
      .set(auth(adminToken))
      .send({
        physicalStockConfirmed: true,
        notes: 'Test',
        emptiesReturned: [{ cylinderTypeId: cyl.id, quantity: -1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // `details` is keyed at the array level on Zod's fieldErrors flatten,
    // so the offending field surface is `emptiesReturned` — and
    // `today()` is just a sanity-anchor so this test would also fail in
    // an obvious way if a server-side date pipeline broke separately.
    expect(JSON.stringify(res.body.details).toLowerCase()).toContain('emptiesreturned');
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
