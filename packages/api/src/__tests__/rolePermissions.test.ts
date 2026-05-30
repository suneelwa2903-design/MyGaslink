/**
 * STEP-1A — Role permission matrix guards.
 *
 * Strategy: every gated endpoint runs `requireRole` BEFORE Zod validate and
 * before the handler, so we can hit a fake UUID and assert only the role
 * outcome:
 *   - allowed role  → status !== 403 (the gate let the request through; the
 *                     downstream 404 / 400 / 200 doesn't matter for this test)
 *   - blocked role  → status === 403 (the gate rejected before anything else)
 *   - missing token → status === 401
 *
 * Why this shape: no fixtures, no DB writes, no anti-pattern #7 risk (no
 * time-sensitive data on the shared dev DB). Failures here will be loud:
 * either the role list drifted, or middleware order changed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import {
  loginAsDistAdmin,
  loginAsFinance,
  loginAsInventory,
  loginAsSuperAdmin,
} from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;
let superToken: string;

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
  inventoryToken = (await loginAsInventory()).token;
  superToken = (await loginAsSuperAdmin()).token;
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// ─── CN approve / reject — admin + finance only (Step 1A: dropped inventory) ─

describe('STEP-1A: Credit Note approve/reject — admin + finance only', () => {
  for (const action of ['approve', 'reject'] as const) {
    describe(`PUT /api/invoices/credit-notes/:id/${action}`, () => {
      const url = `/api/invoices/credit-notes/${FAKE_UUID}/${action}`;

      it('super_admin passes the role gate', async () => {
        const res = await request(app).put(url).set(auth(superToken));
        expect(res.status).not.toBe(403);
      });

      it('distributor_admin passes the role gate', async () => {
        const res = await request(app).put(url).set(auth(adminToken));
        expect(res.status).not.toBe(403);
      });

      it('finance passes the role gate', async () => {
        const res = await request(app).put(url).set(auth(financeToken));
        expect(res.status).not.toBe(403);
      });

      it('inventory is rejected with 403 (Step 1A tightening)', async () => {
        const res = await request(app).put(url).set(auth(inventoryToken));
        expect(res.status).toBe(403);
      });

      it('unauthenticated is rejected with 401', async () => {
        const res = await request(app).put(url);
        expect(res.status).toBe(401);
      });
    });
  }
});

// ─── DN approve / reject — admin + finance only (Step 1A: dropped inventory) ─

describe('STEP-1A: Debit Note approve/reject — admin + finance only', () => {
  for (const action of ['approve', 'reject'] as const) {
    describe(`PUT /api/invoices/debit-notes/:id/${action}`, () => {
      const url = `/api/invoices/debit-notes/${FAKE_UUID}/${action}`;

      it('super_admin passes the role gate', async () => {
        const res = await request(app).put(url).set(auth(superToken));
        expect(res.status).not.toBe(403);
      });

      it('distributor_admin passes the role gate', async () => {
        const res = await request(app).put(url).set(auth(adminToken));
        expect(res.status).not.toBe(403);
      });

      it('finance passes the role gate', async () => {
        const res = await request(app).put(url).set(auth(financeToken));
        expect(res.status).not.toBe(403);
      });

      it('inventory is rejected with 403 (Step 1A tightening)', async () => {
        const res = await request(app).put(url).set(auth(inventoryToken));
        expect(res.status).toBe(403);
      });

      it('unauthenticated is rejected with 401', async () => {
        const res = await request(app).put(url);
        expect(res.status).toBe(401);
      });
    });
  }
});

// ─── Cylinder Types DELETE — opened to ops (Step 1A) ────────────────────────

describe('STEP-1A: DELETE /api/cylinder-types/:id — opened to ops', () => {
  const url = `/api/cylinder-types/${FAKE_UUID}`;

  it('super_admin passes the role gate', async () => {
    const res = await request(app).delete(url).set(auth(superToken));
    expect(res.status).not.toBe(403);
  });

  it('distributor_admin passes the role gate', async () => {
    const res = await request(app).delete(url).set(auth(adminToken));
    expect(res.status).not.toBe(403);
  });

  it('finance passes the role gate (Step 1A opened)', async () => {
    const res = await request(app).delete(url).set(auth(financeToken));
    expect(res.status).not.toBe(403);
  });

  it('inventory passes the role gate (Step 1A opened)', async () => {
    const res = await request(app).delete(url).set(auth(inventoryToken));
    expect(res.status).not.toBe(403);
  });

  it('unauthenticated is rejected with 401', async () => {
    const res = await request(app).delete(url);
    expect(res.status).toBe(401);
  });
});

// ─── Vehicle returned — driver + admin + inventory only (Step 1A: dropped finance) ─

describe('STEP-1A: POST /api/delivery/driver/vehicle-returned — finance dropped', () => {
  const url = '/api/delivery/driver/vehicle-returned';
  const body = { vehicleId: FAKE_UUID };

  it('distributor_admin passes the role gate', async () => {
    const res = await request(app).post(url).set(auth(adminToken)).send(body);
    expect(res.status).not.toBe(403);
  });

  it('inventory passes the role gate', async () => {
    const res = await request(app).post(url).set(auth(inventoryToken)).send(body);
    expect(res.status).not.toBe(403);
  });

  it('finance is rejected with 403 (Step 1A — UI hides for finance, API tightened to match)', async () => {
    const res = await request(app).post(url).set(auth(financeToken)).send(body);
    expect(res.status).toBe(403);
  });

  it('unauthenticated is rejected with 401', async () => {
    const res = await request(app).post(url).send(body);
    expect(res.status).toBe(401);
  });
});

// ─── Customers stop / resume supply — admin + inventory only (Step 1A: dropped finance) ─

describe('STEP-1A: Customers stop/resume supply — finance dropped', () => {
  for (const action of ['stop-supply', 'resume-supply'] as const) {
    describe(`POST /api/customers/:id/${action}`, () => {
      const url = `/api/customers/${FAKE_UUID}/${action}`;

      it('super_admin passes the role gate', async () => {
        const res = await request(app).post(url).set(auth(superToken));
        expect(res.status).not.toBe(403);
      });

      it('distributor_admin passes the role gate', async () => {
        const res = await request(app).post(url).set(auth(adminToken));
        expect(res.status).not.toBe(403);
      });

      it('inventory passes the role gate', async () => {
        const res = await request(app).post(url).set(auth(inventoryToken));
        expect(res.status).not.toBe(403);
      });

      it('finance is rejected with 403 (Step 1A — UI hides via canManage; API tightened)', async () => {
        const res = await request(app).post(url).set(auth(financeToken));
        expect(res.status).toBe(403);
      });

      it('unauthenticated is rejected with 401', async () => {
        const res = await request(app).post(url);
        expect(res.status).toBe(401);
      });
    });
  }
});

// ─── REGRESSION GUARDS — endpoints the plan thought were broken but weren't ─

describe('GUARD: Cylinder Prices — already open to ops (regression catch)', () => {
  it('finance can POST /api/cylinder-types/prices', async () => {
    const res = await request(app)
      .post('/api/cylinder-types/prices')
      .set(auth(financeToken))
      .send({});
    expect(res.status).not.toBe(403);
  });

  it('inventory can POST /api/cylinder-types/prices', async () => {
    const res = await request(app)
      .post('/api/cylinder-types/prices')
      .set(auth(inventoryToken))
      .send({});
    expect(res.status).not.toBe(403);
  });

  it('finance can DELETE /api/cylinder-types/prices/:id', async () => {
    const res = await request(app)
      .delete(`/api/cylinder-types/prices/${FAKE_UUID}`)
      .set(auth(financeToken));
    expect(res.status).not.toBe(403);
  });

  it('inventory can DELETE /api/cylinder-types/prices/:id', async () => {
    const res = await request(app)
      .delete(`/api/cylinder-types/prices/${FAKE_UUID}`)
      .set(auth(inventoryToken));
    expect(res.status).not.toBe(403);
  });
});

describe('GUARD: Cylinder Thresholds — already open to ops (regression catch)', () => {
  it('finance can PUT /api/cylinder-types/thresholds', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/thresholds')
      .set(auth(financeToken))
      .send({});
    expect(res.status).not.toBe(403);
  });

  it('inventory can PUT /api/cylinder-types/thresholds', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/thresholds')
      .set(auth(inventoryToken))
      .send({});
    expect(res.status).not.toBe(403);
  });
});

describe('GUARD: Pending Actions approve/reject — already admin-only', () => {
  for (const action of ['approve', 'reject'] as const) {
    describe(`PUT /api/pending-actions/:id/${action}`, () => {
      const url = `/api/pending-actions/${FAKE_UUID}/${action}`;

      it('distributor_admin passes the role gate', async () => {
        const res = await request(app).put(url).set(auth(adminToken));
        expect(res.status).not.toBe(403);
      });

      it('finance is rejected with 403', async () => {
        const res = await request(app).put(url).set(auth(financeToken));
        expect(res.status).toBe(403);
      });

      it('inventory is rejected with 403', async () => {
        const res = await request(app).put(url).set(auth(inventoryToken));
        expect(res.status).toBe(403);
      });
    });
  }
});

// ─── ANCHOR — keep this assertion last so the file is never silently empty ──

describe('STEP-1A: anchor', () => {
  it('all role tokens loaded', () => {
    expect(adminToken).toBeTruthy();
    expect(financeToken).toBeTruthy();
    expect(inventoryToken).toBeTruthy();
    expect(superToken).toBeTruthy();
  });
});
