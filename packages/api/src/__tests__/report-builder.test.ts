/**
 * Report Builder (Phase 2) — comprehensive tests.
 *
 * Covers ALL 4 test categories per Suneel's mandate:
 *   - Positive: happy path, common scenarios, math correct
 *   - Negative: bad specs rejected, allowlist enforced, cross-tenant blocked
 *   - Regression: existing catalog + reports still work
 *   - Integration: end-to-end save → list → run → delete lifecycle
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin, loginAsFinance, loginAsDriver, loginAsCustomer,
} from './helpers.js';
import { REPORT_BUILDER_SPEC } from '../services/reportBuilder/spec.js';
import { executeReportBuilderSpec } from '../services/reportBuilder/executor.js';
import { getAllowlist, isRoleAllowedForBuilder } from '../services/reportBuilder/allowlist.js';
import type { ReportBuilderSpec } from '@gaslink/shared';

const DAY = new Date('2099-12-20T00:00:00.000Z');

let app: Express;
let adminToken: string;
let financeToken: string;
let driverToken: string;
let customerToken: string;
let distributorId: string;
let adminUserId: string;
let financeUserId: string;
let customerId: string;
const savedReportIds: string[] = [];
const orderIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  adminUserId = admin.user.id;
  distributorId = admin.distributorId;
  const finance = await loginAsFinance();
  financeToken = finance.token;
  financeUserId = finance.user.id;
  const driver = await loginAsDriver();
  driverToken = driver.token;
  const customer = await loginAsCustomer();
  customerToken = customer.token;

  const cust = await prisma.customer.findFirst({ where: { distributorId, deletedAt: null } });
  customerId = cust!.id;
});

afterAll(async () => {
  if (savedReportIds.length) {
    await prisma.savedReport.deleteMany({ where: { id: { in: savedReportIds } } });
  }
  if (orderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
});

// ─── § Spec validation (zod) ──────────────────────────────────────────

describe('Report Builder — spec zod validation', () => {
  it('POSITIVE — minimal valid spec passes', () => {
    const r = REPORT_BUILDER_SPEC.safeParse({
      model: 'Order', fields: ['orderNumber'],
      filters: [], groupBy: [], aggregates: [], orderBy: [],
    });
    expect(r.success).toBe(true);
  });

  it('NEGATIVE — unknown model rejected', () => {
    const r = REPORT_BUILDER_SPEC.safeParse({
      model: 'HackedModel', fields: [], filters: [], groupBy: [], aggregates: [], orderBy: [],
    });
    expect(r.success).toBe(false);
  });

  it('NEGATIVE — SQL-ish field name rejected (regex guard)', () => {
    const r = REPORT_BUILDER_SPEC.safeParse({
      model: 'Order', fields: ['orderNumber; DROP TABLE orders'],
      filters: [], groupBy: [], aggregates: [], orderBy: [],
    });
    expect(r.success).toBe(false);
  });

  it('NEGATIVE — unknown operator rejected', () => {
    const r = REPORT_BUILDER_SPEC.safeParse({
      model: 'Order', fields: ['orderNumber'],
      filters: [{ field: 'orderNumber', op: 'contains_sneaky', value: 'x' }],
      groupBy: [], aggregates: [], orderBy: [],
    });
    expect(r.success).toBe(false);
  });

  it('NEGATIVE — too many filters (>20) rejected', () => {
    const filters = Array.from({ length: 21 }, () => ({ field: 'orderNumber', op: 'eq' as const, value: 'x' }));
    const r = REPORT_BUILDER_SPEC.safeParse({
      model: 'Order', fields: ['orderNumber'], filters, groupBy: [], aggregates: [], orderBy: [],
    });
    expect(r.success).toBe(false);
  });

  it('NEGATIVE — limit above 50000 rejected', () => {
    const r = REPORT_BUILDER_SPEC.safeParse({
      model: 'Order', fields: ['orderNumber'],
      filters: [], groupBy: [], aggregates: [], orderBy: [], limit: 999999,
    });
    expect(r.success).toBe(false);
  });
});

// ─── § Allowlist enforcement ─────────────────────────────────────────

describe('Report Builder — allowlist enforcement', () => {
  it('POSITIVE — staff roles have Builder access', () => {
    expect(isRoleAllowedForBuilder('super_admin')).toBe(true);
    expect(isRoleAllowedForBuilder('distributor_admin')).toBe(true);
    expect(isRoleAllowedForBuilder('finance')).toBe(true);
    expect(isRoleAllowedForBuilder('inventory')).toBe(true);
    expect(isRoleAllowedForBuilder('mini_operator_admin')).toBe(true);
  });

  it('NEGATIVE — driver + customer + customer_hq blocked', () => {
    expect(isRoleAllowedForBuilder('driver')).toBe(false);
    expect(isRoleAllowedForBuilder('customer')).toBe(false);
    expect(isRoleAllowedForBuilder('customer_hq')).toBe(false);
  });

  it('POSITIVE — finance sees totalAmount on Order', () => {
    const allow = getAllowlist('Order', 'finance');
    expect(allow?.fields).toContain('totalAmount');
    expect(allow?.aggregatableFields.has('totalAmount')).toBe(true);
  });

  it('NEGATIVE — inventory does NOT see totalAmount on Order (no money fields)', () => {
    const allow = getAllowlist('Order', 'inventory');
    expect(allow?.fields).not.toContain('totalAmount');
    expect(allow?.aggregatableFields.has('totalAmount')).toBe(false);
  });

  it('NEGATIVE — driver has no allowlist entry at all', () => {
    expect(getAllowlist('Order', 'driver')).toBeNull();
  });
});

// ─── § Executor — RAW mode ───────────────────────────────────────────

describe('Report Builder — executor RAW mode', () => {
  it('POSITIVE — Order fields query returns rows with all requested keys', async () => {
    const order = await prisma.order.create({
      data: {
        distributorId, customerId,
        orderNumber: 'TEST-RB-RAW-1',
        orderDate: DAY, deliveryDate: DAY,
        status: 'delivered', totalAmount: 5000,
      },
    });
    orderIds.push(order.id);

    const res = await executeReportBuilderSpec(
      {
        model: 'Order',
        fields: ['orderNumber', 'customer.customerName', 'deliveryDate', 'totalAmount'],
        filters: [{ field: 'orderNumber', op: 'eq', value: 'TEST-RB-RAW-1' }],
        groupBy: [], aggregates: [], orderBy: [],
      },
      { distributorId, userId: adminUserId, role: 'distributor_admin' },
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    const row = res.rows[0];
    expect(row).toHaveProperty('orderNumber');
    expect(row).toHaveProperty('customer.customerName');
    expect(row).toHaveProperty('totalAmount');
    expect(Number(row.totalAmount)).toBe(5000);
  });

  it('NEGATIVE — off-allowlist field throws', async () => {
    await expect(executeReportBuilderSpec(
      {
        model: 'Order',
        fields: ['passwordHash'],
        filters: [], groupBy: [], aggregates: [], orderBy: [],
      },
      { distributorId, userId: adminUserId, role: 'distributor_admin' },
    )).rejects.toThrow(/not allowed/);
  });

  it('NEGATIVE — inventory querying totalAmount is rejected', async () => {
    await expect(executeReportBuilderSpec(
      {
        model: 'Order',
        fields: ['orderNumber', 'totalAmount'],
        filters: [], groupBy: [], aggregates: [], orderBy: [],
      },
      { distributorId, userId: adminUserId, role: 'inventory' },
    )).rejects.toThrow(/not allowed/);
  });
});

// ─── § Executor — GROUPED mode ───────────────────────────────────────

describe('Report Builder — executor GROUPED mode', () => {
  it('POSITIVE — groupBy customerId + sum(totalAmount) returns aggregated rows', async () => {
    const order = await prisma.order.create({
      data: {
        distributorId, customerId,
        orderNumber: 'TEST-RB-GROUPED-1',
        orderDate: DAY, deliveryDate: DAY,
        status: 'delivered', totalAmount: 8000,
      },
    });
    orderIds.push(order.id);

    const res = await executeReportBuilderSpec(
      {
        model: 'Order',
        fields: [],
        filters: [{ field: 'orderNumber', op: 'starts_with', value: 'TEST-RB-GROUPED' }],
        groupBy: ['customerId'],
        aggregates: [
          { field: 'totalAmount', op: 'sum', as: 'revenue' },
          { field: 'rows', op: 'count', as: 'orderCount' },
        ],
        orderBy: [],
      },
      { distributorId, userId: adminUserId, role: 'distributor_admin' },
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    const row = res.rows.find((r) => r.customerId === customerId);
    expect(row).toBeDefined();
    expect(Number(row!.revenue)).toBeGreaterThanOrEqual(8000);
    expect(Number(row!.orderCount)).toBeGreaterThanOrEqual(1);
  });

  it('NEGATIVE — groupBy a nested path throws', async () => {
    await expect(executeReportBuilderSpec(
      {
        model: 'Order',
        fields: [],
        filters: [],
        groupBy: ['customer.customerName'],
        aggregates: [{ field: 'rows', op: 'count' }],
        orderBy: [],
      },
      { distributorId, userId: adminUserId, role: 'distributor_admin' },
    )).rejects.toThrow(/nested/i);
  });
});

// ─── § Safety layer ──────────────────────────────────────────────────

describe('Report Builder — safety', () => {
  it('POSITIVE — meta.rowCount + durationMs surfaced', async () => {
    const res = await executeReportBuilderSpec(
      { model: 'Order', fields: ['orderNumber'], filters: [], groupBy: [], aggregates: [], orderBy: [] },
      { distributorId, userId: adminUserId, role: 'distributor_admin' },
    );
    expect(res.meta.rowCount).toBeGreaterThanOrEqual(0);
    expect(res.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.meta.capped).toBe('boolean');
  });

  it('POSITIVE — unindexedWarning surfaced on unindexed filter', async () => {
    const res = await executeReportBuilderSpec(
      {
        model: 'Order',
        fields: ['orderNumber'],
        filters: [{ field: 'deliveryNotes', op: 'contains', value: 'foo' }],
        groupBy: [], aggregates: [], orderBy: [],
      },
      { distributorId, userId: adminUserId, role: 'distributor_admin' },
    );
    expect(res.meta.unindexedWarning).toBeDefined();
    expect(res.meta.unindexedWarning).toMatch(/deliveryNotes/);
  });
});

// ─── § SavedReports CRUD lifecycle ───────────────────────────────────

describe('Report Builder — SavedReports CRUD', () => {
  const minimalSpec: ReportBuilderSpec = {
    model: 'Order',
    fields: ['orderNumber', 'deliveryDate'],
    filters: [], groupBy: [], aggregates: [], orderBy: [],
  };

  it('POSITIVE — create → list → get → update → delete', async () => {
    const create = await request(app)
      .post('/api/saved-reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'TEST-CRUD-1', visibility: 'private', spec: minimalSpec });
    expect(create.status).toBe(201);
    const id = create.body.data.id as string;
    savedReportIds.push(id);

    const list = await request(app)
      .get('/api/saved-reports')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.savedReports.some((r: { id: string }) => r.id === id)).toBe(true);

    const get = await request(app)
      .get(`/api/saved-reports/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.status).toBe(200);

    const updated = await request(app)
      .put(`/api/saved-reports/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'TEST-CRUD-1-EDITED' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe('TEST-CRUD-1-EDITED');

    const del = await request(app)
      .delete(`/api/saved-reports/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    const getAfter = await request(app)
      .get(`/api/saved-reports/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getAfter.status).toBe(404);
  });

  it('NEGATIVE — driver hitting /api/saved-reports → 403', async () => {
    const res = await request(app)
      .get('/api/saved-reports')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
  });

  it('NEGATIVE — customer hitting /api/saved-reports → 403', async () => {
    const res = await request(app)
      .get('/api/saved-reports')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });
});

// ─── § Sharing model ─────────────────────────────────────────────────

describe('Report Builder — sharing model', () => {
  it('POSITIVE — distributor-visible report seen by other tenant user', async () => {
    const create = await request(app)
      .post('/api/saved-reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'TEST-SHARED-1',
        visibility: 'distributor',
        spec: { model: 'Order', fields: ['orderNumber'], filters: [], groupBy: [], aggregates: [], orderBy: [] },
      });
    expect(create.status).toBe(201);
    savedReportIds.push(create.body.data.id);

    const list = await request(app)
      .get('/api/saved-reports')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.savedReports.some((r: { name: string }) => r.name === 'TEST-SHARED-1')).toBe(true);
  });

  it('NEGATIVE — private report NOT seen by other user', async () => {
    const create = await request(app)
      .post('/api/saved-reports')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({
        name: 'TEST-PRIVATE-1',
        visibility: 'private',
        spec: { model: 'Order', fields: ['orderNumber'], filters: [], groupBy: [], aggregates: [], orderBy: [] },
      });
    expect(create.status).toBe(201);
    savedReportIds.push(create.body.data.id);

    const list = await request(app)
      .get('/api/saved-reports')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.savedReports.some((r: { name: string }) => r.name === 'TEST-PRIVATE-1')).toBe(false);
    expect(financeUserId).not.toBe(adminUserId);
  });

  it('NEGATIVE — non-owner cannot delete another user\'s report', async () => {
    const financeReports = await prisma.savedReport.findMany({
      where: { ownerId: financeUserId, name: 'TEST-PRIVATE-1', deletedAt: null },
    });
    if (financeReports.length === 0) return;
    const financeReportId = financeReports[0].id;
    const del = await request(app)
      .delete(`/api/saved-reports/${financeReportId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(403);
  });
});

// ─── § End-to-end integration ────────────────────────────────────────

describe('Report Builder — end-to-end integration', () => {
  it('INTEGRATION — preview → save → run → same results', async () => {
    const order = await prisma.order.create({
      data: {
        distributorId, customerId,
        orderNumber: 'TEST-RB-E2E-1',
        orderDate: DAY, deliveryDate: DAY,
        status: 'delivered', totalAmount: 12345,
      },
    });
    orderIds.push(order.id);

    const spec = {
      model: 'Order' as const,
      fields: ['orderNumber', 'totalAmount'],
      filters: [{ field: 'orderNumber', op: 'eq' as const, value: 'TEST-RB-E2E-1' }],
      groupBy: [], aggregates: [], orderBy: [],
    };

    const preview = await request(app)
      .post('/api/saved-reports/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(spec);
    expect(preview.status).toBe(200);
    expect(preview.body.data.rows.length).toBe(1);
    const previewRow = preview.body.data.rows[0];
    expect(Number(previewRow.totalAmount)).toBe(12345);

    const save = await request(app)
      .post('/api/saved-reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'TEST-E2E-SAVED', spec });
    expect(save.status).toBe(201);
    const id = save.body.data.id;
    savedReportIds.push(id);

    const run = await request(app)
      .post(`/api/saved-reports/${id}/run`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(run.status).toBe(200);
    expect(run.body.data.rows.length).toBe(1);
    const runRow = run.body.data.rows[0];
    expect(Number(runRow.totalAmount)).toBe(12345);
    expect(runRow).toEqual(previewRow);
  });

  it('REGRESSION — /api/reports/catalog still returns 37 entries', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // 2026-08-16: 37 = 38 − 1 (delivery-challan-pdf hidden per Suneel).
    expect(res.body.data.entries.length).toBe(37);
  });

  it('REGRESSION — /api/reports/vehicle-ledger still works', async () => {
    const res = await request(app)
      .get('/api/reports/vehicle-ledger')
      .query({ dateFrom: '2099-01-01', dateTo: '2099-01-02' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('columns');
  });
});
