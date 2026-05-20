import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance, loginAsInventory } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;

const TEST_TYPE_NAME = 'TEST 12 KG';

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
  inventoryToken = (await loginAsInventory()).token;
});

afterAll(async () => {
  // Cleanup any cylinder types we created (cascade-delete prices first).
  const types = await prisma.cylinderType.findMany({
    where: { distributorId: 'dist-001', typeName: TEST_TYPE_NAME },
    select: { id: true },
  });
  if (types.length > 0) {
    const typeIds = types.map((t) => t.id);
    await prisma.cylinderPrice.deleteMany({ where: { cylinderTypeId: { in: typeIds } } });
    await prisma.emptyCylinderPrice.deleteMany({ where: { cylinderTypeId: { in: typeIds } } });
    await prisma.cylinderThreshold.deleteMany({ where: { cylinderTypeId: { in: typeIds } } });
    await prisma.cylinderType.deleteMany({ where: { id: { in: typeIds } } });
  }
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('CylinderTypes — Auth', () => {
  it('rejects unauthenticated GET / with 401', async () => {
    const res = await request(app).get('/api/cylinder-types');
    expect(res.status).toBe(401);
  });

  // WI-080: finance + inventory now have full edit access to cylinder
  // config. They pass the role gate (a missing-field body 400s on
  // validation rather than 403'ing on the role).
  it('WI-080: finance passes the POST role gate (400 validation, not 403)', async () => {
    const res = await request(app)
      .post('/api/cylinder-types')
      .set(auth(financeToken))
      .send({ typeName: 'X' }); // missing capacity → validation 400
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it('WI-080: inventory passes the POST role gate (400 validation, not 403)', async () => {
    const res = await request(app)
      .post('/api/cylinder-types')
      .set(auth(inventoryToken))
      .send({ typeName: 'X' });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });
});

describe('CylinderTypes — CRUD', () => {
  let typeId: string;

  it('creates a cylinder type', async () => {
    const res = await request(app)
      .post('/api/cylinder-types')
      .set(auth(adminToken))
      .send({
        typeName: TEST_TYPE_NAME,
        capacity: 12,
        unit: 'KG',
        hsnCode: '27111900',
      });
    if (res.status !== 201) console.log('create cyl type error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.typeName).toBe(TEST_TYPE_NAME);
    expect(res.body.data.distributorId).toBe('dist-001');
    typeId = res.body.data.cylinderTypeId;
  });

  it('rejects POST with missing capacity (400)', async () => {
    const res = await request(app)
      .post('/api/cylinder-types')
      .set(auth(adminToken))
      .send({ typeName: 'orphan' });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate typeName within same distributor (409)', async () => {
    const res = await request(app)
      .post('/api/cylinder-types')
      .set(auth(adminToken))
      .send({ typeName: TEST_TYPE_NAME, capacity: 12 });
    expect(res.status).toBe(409);
  });

  it('lists cylinder types scoped to caller distributor', async () => {
    const res = await request(app).get('/api/cylinder-types').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.cylinderTypes)).toBe(true);
    for (const t of res.body.data.cylinderTypes) {
      expect(t.distributorId).toBe('dist-001');
    }
  });

  it('fetches a cylinder type by id', async () => {
    const res = await request(app).get(`/api/cylinder-types/${typeId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.cylinderTypeId).toBe(typeId);
  });

  it('updates a cylinder type', async () => {
    const res = await request(app)
      .put(`/api/cylinder-types/${typeId}`)
      .set(auth(adminToken))
      .send({ hsnCode: '27111910' });
    expect(res.status).toBe(200);
    expect(res.body.data.hsnCode).toBe('27111910');
  });

  it('soft-deletes a cylinder type', async () => {
    const res = await request(app).delete(`/api/cylinder-types/${typeId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
  });
});

describe('CylinderTypes — Tenant Isolation', () => {
  it('cannot fetch a cylinder type from another distributor (404)', async () => {
    const dist2Type = await prisma.cylinderType.findFirst({
      where: { distributorId: 'dist-002' },
    });
    if (!dist2Type) throw new Error('Seed expected a dist-002 cylinder type');

    const res = await request(app)
      .get(`/api/cylinder-types/${dist2Type.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('cannot update a cylinder type from another distributor', async () => {
    const dist2Type = await prisma.cylinderType.findFirst({
      where: { distributorId: 'dist-002' },
    });
    if (!dist2Type) throw new Error('Seed expected a dist-002 cylinder type');

    const res = await request(app)
      .put(`/api/cylinder-types/${dist2Type.id}`)
      .set(auth(adminToken))
      .send({ hsnCode: '99999999' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('CylinderTypes — Prices & thresholds', () => {
  it('GET /prices/list returns array', async () => {
    const res = await request(app)
      .get('/api/cylinder-types/prices/list')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /empty-prices/list returns array', async () => {
    const res = await request(app)
      .get('/api/cylinder-types/empty-prices/list')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ─── WI-080: inventory + finance config access ───────────────────────────────

describe('WI-080 — inventory & finance can read + edit cylinder config', () => {
  // GET routes are open to any authenticated tenant user.
  it('inventory can GET cylinder-types', async () => {
    const res = await request(app).get('/api/cylinder-types').set(auth(inventoryToken));
    expect(res.status).toBe(200);
  });
  it('finance can GET cylinder-types', async () => {
    const res = await request(app).get('/api/cylinder-types').set(auth(financeToken));
    expect(res.status).toBe(200);
  });

  it('inventory can GET cylinder-prices', async () => {
    const res = await request(app).get('/api/cylinder-types/prices/list').set(auth(inventoryToken));
    expect(res.status).toBe(200);
  });
  it('finance can GET cylinder-prices', async () => {
    const res = await request(app).get('/api/cylinder-types/prices/list').set(auth(financeToken));
    expect(res.status).toBe(200);
  });

  // PUT/POST mutations: pass the role gate (not 403). A malformed body
  // 400s on validation, proving the role itself is allowed.
  it('inventory passes PUT /:id role gate (not 403)', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/00000000-0000-0000-0000-000000000000')
      .set(auth(inventoryToken))
      .send({ typeName: 'Renamed' });
    expect(res.status).not.toBe(403);
  });
  it('finance passes PUT /:id role gate (not 403)', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/00000000-0000-0000-0000-000000000000')
      .set(auth(financeToken))
      .send({ typeName: 'Renamed' });
    expect(res.status).not.toBe(403);
  });

  it('inventory passes POST /prices role gate (not 403)', async () => {
    const res = await request(app)
      .post('/api/cylinder-types/prices')
      .set(auth(inventoryToken))
      .send({}); // invalid → 400, not 403
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });
  it('finance passes POST /prices role gate (not 403)', async () => {
    const res = await request(app)
      .post('/api/cylinder-types/prices')
      .set(auth(financeToken))
      .send({});
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it('inventory passes PUT /thresholds role gate (not 403)', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/thresholds')
      .set(auth(inventoryToken))
      .send({}); // invalid → 400, not 403
    expect(res.status).not.toBe(403);
  });
  it('finance passes PUT /thresholds role gate (not 403)', async () => {
    const res = await request(app)
      .put('/api/cylinder-types/thresholds')
      .set(auth(financeToken))
      .send({});
    expect(res.status).not.toBe(403);
  });
});

describe('WI-080 — customer-balances returns cylinderPrice + lastDeliveryDate', () => {
  it('GET /inventory/customer-balances rows carry cylinderPrice and lastDeliveryDate keys', async () => {
    const res = await request(app)
      .get('/api/inventory/customer-balances')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(row).toHaveProperty('cylinderPrice');
      expect(row).toHaveProperty('emptyCylinderPrice');
      expect(row).toHaveProperty('lastDeliveryDate');
    }
  });

  it('inventory + finance can read customer-balances (WI-080)', async () => {
    const inv = await request(app).get('/api/inventory/customer-balances').set(auth(inventoryToken));
    const fin = await request(app).get('/api/inventory/customer-balances').set(auth(financeToken));
    expect(inv.status).toBe(200);
    expect(fin.status).toBe(200);
  });
});
