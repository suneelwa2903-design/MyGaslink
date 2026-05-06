import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;

const TEST_TAG = 'TEST-PENDING-ACTION';
const trackedActionIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;

  // Pre-seed three pending actions to drive list / approve / resolve / reject.
  for (const i of [0, 1, 2]) {
    const action = await prisma.pendingAction.create({
      data: {
        distributorId: 'dist-001',
        module: 'inventory',
        entityType: 'manual_test',
        entityId: `entity-${i}`,
        actionType: 'review',
        description: `${TEST_TAG} ${i}`,
        severity: 'medium',
        requiresApproval: true,
        slaDeadline: new Date(Date.now() + 86_400_000), // tomorrow
      },
    });
    trackedActionIds.push(action.id);
  }
});

afterAll(async () => {
  await prisma.pendingAction.deleteMany({
    where: { id: { in: trackedActionIds } },
  });
  // Plus any dist-002 we made
  await prisma.pendingAction.deleteMany({
    where: { description: { startsWith: TEST_TAG } },
  });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('PendingActions — Auth', () => {
  it('rejects unauthenticated GET / with 401', async () => {
    const res = await request(app).get('/api/pending-actions');
    expect(res.status).toBe(401);
  });

  it('rejects PUT /:id/approve for finance role (403)', async () => {
    const res = await request(app)
      .put(`/api/pending-actions/${trackedActionIds[0]}/approve`)
      .set(auth(financeToken));
    expect(res.status).toBe(403);
  });
});

describe('PendingActions — List', () => {
  it('GET / lists actions scoped to caller distributor', async () => {
    const res = await request(app).get('/api/pending-actions').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.actions)).toBe(true);
    for (const a of res.body.data.actions) {
      expect(a.distributorId).toBe('dist-001');
    }
    // Our seeded test rows should appear
    const ids = res.body.data.actions.map((a: { actionId: string }) => a.actionId);
    expect(ids).toContain(trackedActionIds[0]);
  });

  it('GET /?module=inventory filters by module', async () => {
    const res = await request(app)
      .get('/api/pending-actions?module=inventory')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    for (const a of res.body.data.actions) {
      expect(a.module).toBe('inventory');
    }
  });

  it('GET /overdue returns array', async () => {
    const res = await request(app)
      .get('/api/pending-actions/overdue')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('PendingActions — Approve / Resolve / Reject', () => {
  it('approves a pending action — status moves to in_progress', async () => {
    const res = await request(app)
      .put(`/api/pending-actions/${trackedActionIds[0]}/approve`)
      .set(auth(adminToken));
    if (res.status !== 200) console.log('approve error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');
  });

  it('resolves a pending action — status moves to resolved', async () => {
    const res = await request(app)
      .put(`/api/pending-actions/${trackedActionIds[1]}/resolve`)
      .set(auth(adminToken))
      .send({ notes: 'TEST-PENDING-ACTION resolved manually' });
    if (res.status !== 200) console.log('resolve error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('resolved');
  });

  it('rejects a pending action — status moves to skipped', async () => {
    const res = await request(app)
      .put(`/api/pending-actions/${trackedActionIds[2]}/reject`)
      .set(auth(adminToken))
      .send({ notes: 'No longer relevant' });
    if (res.status !== 200) console.log('reject error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('skipped');
  });

  it('returns 404 for an action that does not exist', async () => {
    const res = await request(app)
      .put(`/api/pending-actions/00000000-0000-0000-0000-000000000000/approve`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});

describe('PendingActions — Tenant Isolation', () => {
  it('cannot approve a pending action from another distributor', async () => {
    const dist2Action = await prisma.pendingAction.create({
      data: {
        distributorId: 'dist-002',
        module: 'inventory',
        entityType: 'manual_test',
        entityId: 'dist2-tenant-leak-test',
        actionType: 'review',
        description: `${TEST_TAG} dist-002`,
        severity: 'medium',
        requiresApproval: true,
        slaDeadline: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await request(app)
      .put(`/api/pending-actions/${dist2Action.id}/approve`)
      .set(auth(adminToken)); // dist-001 admin
    // Service returns null when the action isn't in caller's distributor →
    // route returns 404. Either way, the action must remain untouched.
    expect([403, 404]).toContain(res.status);

    const after = await prisma.pendingAction.findUniqueOrThrow({ where: { id: dist2Action.id } });
    expect(after.status).toBe('open'); // unchanged

    // cleanup is via afterAll TAG match
  });

  it('list does NOT include another distributor\'s actions', async () => {
    const res = await request(app).get('/api/pending-actions').set(auth(adminToken));
    expect(res.status).toBe(200);
    for (const a of res.body.data.actions) {
      expect(a.distributorId).toBe('dist-001');
    }
  });
});
