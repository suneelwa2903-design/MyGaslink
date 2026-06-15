/**
 * Phase B — inventory mobile parity (server-contract layer).
 *
 * B1 (opening stock entry) — pins POST /api/inventory/initial-balance:
 *   accepts inventory role, returns 409 with structured conflict
 *   payload on duplicate, replaceExisting:true succeeds.
 * B2 (customers list + balance detail) — pins:
 *   GET /api/customers is accessible to inventory
 *   GET /api/customers/:id/balance is accessible to inventory
 * B3 (reports gating) — pins:
 *   GET /api/reports/:type accepts inventory for the 3 keys that
 *   inventory's reports surface uses operationally (regression
 *   guard — server permits all 7, the screen-side surface is now
 *   the full admin reports component via re-export).
 *
 * 2026-06-15 — the mobile source guards from the prior B1/B2/B3
 * wave were retired. The (inventory)/* screens are now thin
 * re-exports of (admin)/*; the source-file invariants that block
 * pinned the standalone code are no longer valid. The replacement
 * mobile guards live in phaseB-inventory-reexport-parity.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsInventory } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import type { Express } from 'express';

let app: Express;
let invToken: string;
// Test fixture cylinder types for the initial-balance flow — Bhargava's
// seed.
const TEST_DIST = 'dist-001';
let cylinderTypeIds: string[] = [];
const originalEvents: { cylinderTypeId: string; eventDate: Date }[] = [];

beforeAll(async () => {
  app = createApp();
  invToken = (await loginAsInventory()).token;
  const types = await prisma.cylinderType.findMany({
    where: { distributorId: TEST_DIST, isActive: true },
    select: { id: true },
    take: 2,
  });
  cylinderTypeIds = types.map((t) => t.id);
  // Capture any pre-existing initial_balance events for these types so
  // we can restore them in afterAll. The conflict test needs a known
  // empty state for these cylinder types — pre-existing events would
  // make the first test's 200 surprising and the second's 409
  // unreachable. Hard-delete here; restore in afterAll.
  const existing = await prisma.inventoryEvent.findMany({
    where: {
      distributorId: TEST_DIST,
      eventType: 'initial_balance',
      cylinderTypeId: { in: cylinderTypeIds },
    },
    select: { cylinderTypeId: true, eventDate: true, id: true, fullsChange: true, emptiesChange: true },
  });
  // Cast to the originalEvents shape — id + payload kept so we can
  // re-insert in afterAll if anything was there.
  for (const e of existing) {
    originalEvents.push({ cylinderTypeId: e.cylinderTypeId, eventDate: e.eventDate });
  }
  await prisma.inventoryEvent.deleteMany({
    where: { id: { in: existing.map((e) => e.id) } },
  });
});

afterAll(async () => {
  // Clean up any initial_balance events the tests wrote for the
  // fixture cylinder types. Preserve the seed state.
  await prisma.inventoryEvent.deleteMany({
    where: {
      distributorId: TEST_DIST,
      eventType: 'initial_balance',
      cylinderTypeId: { in: cylinderTypeIds },
      eventDate: { gte: new Date('2099-01-01') },
    },
  });
});

describe('Phase B1 — POST /api/inventory/initial-balance (mobile entry endpoint)', () => {
  it('accepts inventory role + writes opening stock', async () => {
    const res = await request(app)
      .post('/api/inventory/initial-balance')
      .set('Authorization', `Bearer ${invToken}`)
      .send({
        entries: [
          { cylinderTypeId: cylinderTypeIds[0], openingFulls: 10, openingEmpties: 5 },
        ],
        eventDate: '2099-06-01',
      });
    expect(res.status).toBe(200);
  });

  it('returns 409 with structured conflict payload when re-submitted', async () => {
    const res = await request(app)
      .post('/api/inventory/initial-balance')
      .set('Authorization', `Bearer ${invToken}`)
      .send({
        entries: [
          { cylinderTypeId: cylinderTypeIds[0], openingFulls: 20, openingEmpties: 10 },
        ],
        eventDate: '2099-06-01',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPENING_STOCK_CONFLICT');
    expect(res.body.details?.requiresConfirmation).toBe(true);
    expect(Array.isArray(res.body.details?.conflicts)).toBe(true);
    expect(res.body.details.conflicts.length).toBeGreaterThan(0);
    // Wire shape: routes/inventory.ts forwards InitialBalanceConflictError
    // .conflicts verbatim. Each conflict has cylinderTypeId + fulls +
    // empties + eventDate. The cylinder type NAME is looked up by the
    // mobile UI from the /cylinder-types query.
    const c = res.body.details.conflicts[0];
    expect(typeof c.cylinderTypeId).toBe('string');
    expect(typeof c.fulls).toBe('number');
    expect(typeof c.empties).toBe('number');
    expect(typeof c.eventDate).toBe('string');
  });

  it('replaceExisting:true succeeds on a conflicted entry', async () => {
    const res = await request(app)
      .post('/api/inventory/initial-balance')
      .set('Authorization', `Bearer ${invToken}`)
      .send({
        entries: [
          { cylinderTypeId: cylinderTypeIds[0], openingFulls: 30, openingEmpties: 15 },
        ],
        eventDate: '2099-06-01',
        replaceExisting: true,
      });
    expect(res.status).toBe(200);
  });
});

describe('Phase B2 — endpoints the inventory customer screens hit', () => {
  it('GET /api/customers returns 200 for inventory', async () => {
    const res = await request(app)
      .get('/api/customers')
      .set('Authorization', `Bearer ${invToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/customers/:id/balance returns 200 for inventory', async () => {
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: TEST_DIST, deletedAt: null },
      select: { id: true },
    });
    const res = await request(app)
      .get(`/api/customers/${cust.id}/balance`)
      .set('Authorization', `Bearer ${invToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.balances)).toBe(true);
  });
});

describe('Phase B3 — reports route gating for inventory', () => {
  // Inventory should still be able to hit the 3 whitelisted endpoints
  // (the server requireRole allows all 4 internal roles for /reports,
  // so this is a regression check).
  const INV_REPORTS = ['inventory-movement', 'delivery-performance', 'sales-summary'];
  it.each(INV_REPORTS)('GET /api/reports/%s is reachable for inventory', async (key) => {
    const res = await request(app)
      .get(`/api/reports/${key}`)
      .set('Authorization', `Bearer ${invToken}`);
    expect(res.status).not.toBe(403);
  });
});

// Mobile source guards moved to phaseB-inventory-reexport-parity.test.ts
// after the (inventory)/* → (admin)/* re-export wave on 2026-06-15.
