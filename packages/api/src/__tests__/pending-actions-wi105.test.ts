import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// WI-105 PART 3 — resolvePendingAction dynamically imports whitebooksClient and
// calls pingEinvoiceSession. Mock that single seam so the NIC pre-flight is
// controllable without real network / token state. Spread the original so the
// rest of the GST layer keeps working.
vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original = await orig<typeof import('../services/gst/whitebooksClient.js')>();
  return {
    ...original,
    pingEinvoiceSession: vi.fn(async () => undefined),
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin } from './helpers.js';
import { createPendingAction } from '../services/gst/gstService.js';
import * as wb from '../services/gst/whitebooksClient.js';
import type { Express } from 'express';

const pingMock = wb.pingEinvoiceSession as unknown as ReturnType<typeof vi.fn>;

let app: Express;
let adminToken: string;
let distributorId: string;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Unique entity id per run so dedup assertions aren't polluted by prior rows.
const ENTITY_ID = `WI105-ENTITY-${Date.now()}`;

async function cleanup() {
  await prisma.pendingAction.deleteMany({
    where: { distributorId, OR: [{ entityId: ENTITY_ID }, { actionType: { startsWith: 'WI105-' } }] },
  });
}

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  distributorId = admin.distributorId;
  await cleanup();
});

afterEach(() => {
  pingMock.mockClear();
  pingMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WI-105 PART 2 — createPendingAction deduplicates open actions', () => {
  it('reuses the same open row for repeated (entityId, actionType)', async () => {
    const first = await createPendingAction(distributorId, ENTITY_ID, 'EWB_GENERATION', 'crash one');
    const second = await createPendingAction(distributorId, ENTITY_ID, 'EWB_GENERATION', 'crash two');

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);

    const rows = await prisma.pendingAction.findMany({
      where: { distributorId, entityId: ENTITY_ID, actionType: 'EWB_GENERATION', status: 'open' },
    });
    expect(rows.length).toBe(1);
  });

  it('creates a separate row for a different actionType on the same entity', async () => {
    await createPendingAction(distributorId, ENTITY_ID, 'IRN_GENERATION', 'irn crash');
    const rows = await prisma.pendingAction.findMany({
      where: { distributorId, entityId: ENTITY_ID, status: 'open' },
    });
    // EWB_GENERATION (from prior test) + IRN_GENERATION = 2 distinct rows.
    expect(rows.length).toBe(2);
  });

  it('classifies a 2150 error into a readable duplicate-IRN message + code', async () => {
    const pa = await createPendingAction(distributorId, `${ENTITY_ID}-DUP`, 'IRN_GENERATION', 'NIC 2150 Duplicate IRN');
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: pa!.id } });
    expect(row.description).toMatch(/duplicate IRN/i);
    expect(row.errorCode).toBe('DUPLICATE_IRN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WI-105 PART 3 — resolve runs NIC pre-flight for NIC-bound actions', () => {
  // INVESTIGATION-JUL09: use a fresh entityId per seed so the partial unique
  // index on (distributor_id, entity_id, action_type) WHERE status='open'
  // doesn't reject the second/third seed. The prior tests in PART 2 leave
  // open rows for ENTITY_ID; PART 3 doesn't care about their state so use
  // isolated entities.
  let seedCounter = 0;
  async function seedAction(actionType: string) {
    seedCounter += 1;
    return prisma.pendingAction.create({
      data: {
        distributorId,
        module: 'gst_compliance',
        entityType: 'invoice',
        entityId: `${ENTITY_ID}-P3-${seedCounter}`,
        actionType,
        description: 'seed',
        severity: 'high',
        status: 'open',
      },
      select: { id: true },
    });
  }

  it('returns 503 and does NOT resolve when NIC is down', async () => {
    pingMock.mockRejectedValueOnce(new Error('NIC session dead'));
    const action = await seedAction('IRN_GENERATION');

    const res = await request(app)
      .put(`/api/pending-actions/${action.id}/resolve`)
      .set(auth(adminToken))
      .send({ notes: 'retry' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
    expect(pingMock).toHaveBeenCalledTimes(1);

    // Action must remain open — the retry never reached NIC.
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe('open');
  });

  it('resolves normally when NIC is healthy', async () => {
    pingMock.mockResolvedValueOnce(undefined);
    const action = await seedAction('EWB_GENERATION');

    const res = await request(app)
      .put(`/api/pending-actions/${action.id}/resolve`)
      .set(auth(adminToken))
      .send({ notes: 'retried ok' });

    expect(res.status).toBe(200);
    expect(pingMock).toHaveBeenCalledTimes(1);
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe('resolved');
  });

  it('resolves a non-NIC action WITHOUT calling the health check', async () => {
    const action = await seedAction('STOCK_MISMATCH');

    const res = await request(app)
      .put(`/api/pending-actions/${action.id}/resolve`)
      .set(auth(adminToken))
      .send({ notes: 'manual fix' });

    expect(res.status).toBe(200);
    expect(pingMock).not.toHaveBeenCalled();
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe('resolved');
  });
});
