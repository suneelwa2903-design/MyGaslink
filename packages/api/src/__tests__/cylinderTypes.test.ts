import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;

const TEST_TYPE_NAME = 'TEST 12 KG';

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
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

  it('rejects POST for finance role (403)', async () => {
    const res = await request(app)
      .post('/api/cylinder-types')
      .set(auth(financeToken))
      .send({ typeName: 'X', capacity: 5 });
    expect(res.status).toBe(403);
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
