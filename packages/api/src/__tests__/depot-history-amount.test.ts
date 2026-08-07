// 2026-08-05 — Wire-shape + read-path guard for the Amount column
// added to Inventory → Depot History (packages/web/src/pages/InventoryPage.tsx).
//
// The Prisma model has always had InventoryEvent.amount (Decimal?)
// but the shared TS type did not surface it and the web UI never
// displayed it. This test pins:
//   - Positive: amount round-trips through GET /api/inventory/depot-history
//   - Negative: null amount stays null (not 0, not '')
//   - Wire-shape: response.events[].amount property is present on every row
//
// Anti-pattern #7 — TEST_DATE=2099-12-28 far-future.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { getSeedData, loginAsDistAdmin } from './helpers.js';

const TEST_DATE = new Date('2099-12-28T00:00:00.000Z');
const TEST_DATE_STR = '2099-12-28';

let app: Express;
let token: string;
let distributorId: string;
let cylinderTypeId: string;
const eventIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  const login = await loginAsDistAdmin();
  token = login.token;
  distributorId = login.distributorId;
  const seed = await getSeedData();
  cylinderTypeId = seed.cylinderTypes[0].id;

  // Seed a depot-history event WITH amount set, and one WITHOUT (null).
  const withAmount = await prisma.inventoryEvent.create({
    data: {
      distributorId,
      cylinderTypeId,
      eventType: 'incoming_fulls',
      fullsChange: 100,
      emptiesChange: 0,
      eventDate: TEST_DATE,
      documentNumber: 'DEPOT-AMT-WITH',
      amount: '15250.75',
      createdBy: 'test-depot-amt',
    },
  });
  const withoutAmount = await prisma.inventoryEvent.create({
    data: {
      distributorId,
      cylinderTypeId,
      eventType: 'outgoing_empties',
      fullsChange: 0,
      emptiesChange: -50,
      eventDate: TEST_DATE,
      documentNumber: 'DEPOT-AMT-NULL',
      // amount omitted — should be null
      createdBy: 'test-depot-amt',
    },
  });
  eventIds.push(withAmount.id, withoutAmount.id);
});

afterAll(async () => {
  if (eventIds.length) {
    await prisma.inventoryEvent.deleteMany({ where: { id: { in: eventIds } } });
  }
});

describe('GET /api/inventory/depot-history — Amount column wire-shape', () => {
  it('POSITIVE — event with amount=15250.75 returns amount as string on response', async () => {
    const res = await request(app)
      .get('/api/inventory/depot-history')
      .query({ dateFrom: TEST_DATE_STR, dateTo: TEST_DATE_STR, eventType: 'incoming_fulls', pageSize: 50 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const events = res.body.data.events as Array<Record<string, unknown>>;
    const row = events.find((e) => e.documentNumber === 'DEPOT-AMT-WITH');
    expect(row).toBeDefined();
    // Prisma Decimal may serialize as string OR number depending on
    // driver + adapter. Coerce to Number for a format-agnostic assert.
    expect(Number(row!.amount)).toBe(15250.75);
  });

  it('POSITIVE — event with no amount returns amount=null (not undefined, not 0, not "")', async () => {
    const res = await request(app)
      .get('/api/inventory/depot-history')
      .query({ dateFrom: TEST_DATE_STR, dateTo: TEST_DATE_STR, eventType: 'outgoing_empties', pageSize: 50 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const events = res.body.data.events as Array<Record<string, unknown>>;
    const row = events.find((e) => e.documentNumber === 'DEPOT-AMT-NULL');
    expect(row).toBeDefined();
    expect(row!.amount).toBeNull();
  });

  it('WIRE-SHAPE — every returned event object has an `amount` property (even when null)', async () => {
    const res = await request(app)
      .get('/api/inventory/depot-history')
      .query({ dateFrom: TEST_DATE_STR, dateTo: TEST_DATE_STR, pageSize: 50 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const events = res.body.data.events as Array<Record<string, unknown>>;
    // Both our fixtures should appear.
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const ev of events) {
      expect(ev).toHaveProperty('amount');
    }
  });
});
