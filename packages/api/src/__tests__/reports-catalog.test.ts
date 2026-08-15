// 2026-08-05 F2 Step 2 — Wire-shape + role-filter guard for the new
// GET /api/reports/catalog endpoint that drives the Reports left-nav.
//
// Anti-pattern #9: the frontend consumes this shape directly to build
// the nav tree. Any silent field rename / removal here breaks the UI
// with no compile error. This file pins the response contract.
//
// Tests cover:
//   - Positive: distributor_admin gets all 11 v1 entries across 7 buckets
//   - Positive: finance gets same (finance is in ROLES_ALL_STAFF)
//   - Negative: inventory does NOT see gst-filing-export (FINANCE_ONLY)
//   - Negative: driver hitting catalog → 403 (role gate blocks)
//   - Regression: existing /api/reports/vehicle-ledger STILL WORKS
//     (proves the new catalog route didn't shadow the /:reportType handler)
//   - Wire-shape: buckets array has expected 7 keys in order 1..7;
//     every entry has required fields (slug/label/bucket/description/
//     kind/outputs/roles).

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsFinance, loginAsInventory, loginAsDriver } from './helpers.js';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;
let driverToken: string;

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
  inventoryToken = (await loginAsInventory()).token;
  driverToken = (await loginAsDriver()).token;
});

describe('GET /api/reports/catalog', () => {
  it('POSITIVE — distributor_admin gets 7 buckets + all 37 catalog entries', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const { buckets, entries } = res.body.data;
    expect(Array.isArray(buckets)).toBe(true);
    expect(Array.isArray(entries)).toBe(true);
    expect(buckets).toHaveLength(7);
    // Update this count alongside every REPORT_CATALOG append/remove.
    // 2026-08-12: 38 = 37 + 1 (corp-batch-cost-vs-price, FIFO cost layers).
    // 2026-08-16: 37 = 38 − 1 (delivery-challan-pdf hidden per Suneel).
    expect(entries).toHaveLength(37);
  });

  it('POSITIVE — 7 buckets appear in canonical order 1..7', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const bucketKeys = res.body.data.buckets.map((b: { key: string; order: number }) => b.key);
    expect(bucketKeys).toEqual([
      'daily-book',
      'invoicing-payments',
      'inventory',
      'customers',
      'corporation',
      'expenses',
      'month-end',
    ]);
    // Also assert `order` is strictly ascending.
    const orders = res.body.data.buckets.map((b: { order: number }) => b.order);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]);
    }
  });

  it('POSITIVE — finance role sees the same 37 entries as distributor_admin', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(37); // 2026-08-16: −1 delivery-challan-pdf hidden
    // GST filing IS in finance's view (finance is in ROLES_FINANCE_ONLY).
    const slugs = res.body.data.entries.map((e: { slug: string }) => e.slug);
    expect(slugs).toContain('gst-filing-export');
  });

  it('NEGATIVE — inventory role does NOT see gst-filing-export (finance-only entry)', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${inventoryToken}`);
    expect(res.status).toBe(200);
    const slugs = res.body.data.entries.map((e: { slug: string }) => e.slug);
    expect(slugs).not.toContain('gst-filing-export');
    // Inventory sees everything EXCEPT the 3 finance-only entries.
    // 2026-08-16: 34 = 37 (total for admin) − 3 (gst-filing-export, gst-reconciliation, gstr-3b-preview).
    expect(res.body.data.entries).toHaveLength(34);
  });

  it('NEGATIVE — driver role hitting /catalog → 403 (route-level role gate blocks)', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
  });

  it('REGRESSION — existing /api/reports/vehicle-ledger still resolves (catalog did not shadow /:reportType)', async () => {
    const res = await request(app)
      .get('/api/reports/vehicle-ledger')
      .query({ dateFrom: '2099-01-01', dateTo: '2099-01-02' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('columns');
    expect(res.body.data).toHaveProperty('rows');
  });

  it('WIRE-SHAPE — every entry has slug/label/bucket/description/kind/outputs/roles fields', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const entry of res.body.data.entries) {
      expect(typeof entry.slug).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.bucket).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(['inline', 'download', 'external']).toContain(entry.kind);
      expect(Array.isArray(entry.outputs)).toBe(true);
      expect(entry.outputs.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.roles)).toBe(true);
      expect(entry.roles.length).toBeGreaterThan(0);
    }
  });

  it('WIRE-SHAPE — every entry.bucket is one of the 7 declared bucket keys', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const bucketKeys = new Set(res.body.data.buckets.map((b: { key: string }) => b.key));
    for (const entry of res.body.data.entries) {
      expect(bucketKeys.has(entry.bucket)).toBe(true);
    }
  });

  it('WIRE-SHAPE — download entries have `href`, inline entries do NOT need href', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const entry of res.body.data.entries) {
      if (entry.kind === 'download' || entry.kind === 'external') {
        expect(typeof entry.href).toBe('string');
        expect(entry.href.length).toBeGreaterThan(0);
      }
    }
  });
});
