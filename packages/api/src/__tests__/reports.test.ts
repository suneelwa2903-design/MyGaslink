import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import type { Express } from 'express';
import { reportToCsv, type ReportResult, type ReportColumn } from '../services/reportsService.js';
import type { UserRole } from '@gaslink/shared';

let app: Express;
let token: string;

beforeAll(async () => {
  app = createApp();
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  token = generateToken({ userId: admin.id, email: admin.email, role: admin.role as UserRole, distributorId: admin.distributorId });
});

const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Distributor-Id': 'dist-002' });

describe('GET /api/reports/:reportType', () => {
  const types = ['sales-summary', 'outstanding-aging', 'gst-summary', 'delivery-performance', 'inventory-movement'];

  for (const t of types) {
    it(`${t} returns the standard envelope with date range`, async () => {
      const res = await request(app)
        .get(`/api/reports/${t}`)
        .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31' })
        .set(auth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.columns)).toBe(true);
      expect(res.body.data.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.data.rows)).toBe(true);
      // every row has every column key
      for (const r of res.body.data.rows.slice(0, 3)) {
        for (const c of res.body.data.columns) expect(r).toHaveProperty(c.key);
      }
    });
  }

  it('unknown report type → 404', async () => {
    const res = await request(app).get('/api/reports/nonsense').set(auth());
    expect(res.status).toBe(404);
  });

  it('customer-statement requires customerId → 400 without it', async () => {
    const res = await request(app).get('/api/reports/customer-statement').query({ dateFrom: '2026-05-01', dateTo: '2026-05-31' }).set(auth());
    expect(res.status).toBe(400);
  });

  it('customer-statement returns rows with a running balance for a real customer', async () => {
    const cust = await prisma.customer.findFirstOrThrow({ where: { distributorId: 'dist-002', deletedAt: null } });
    const res = await request(app)
      .get('/api/reports/customer-statement')
      .query({ customerId: cust.id, dateFrom: '2026-01-01', dateTo: '2026-12-31' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.columns.map((c: ReportColumn) => c.key)).toContain('balance');
  });

  it('format=csv returns text/csv attachment with a header row', async () => {
    const res = await request(app)
      .get('/api/reports/gst-summary')
      .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31', format: 'csv' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('gst-summary.csv');
    expect(res.text.split('\n')[0]).toContain('Invoice No');
  });

  it('date range filter narrows results (empty far-future window → no rows)', async () => {
    const res = await request(app)
      .get('/api/reports/sales-summary')
      .query({ dateFrom: '2099-01-01', dateTo: '2099-01-02' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBe(0);
  });

  it('cross-tenant isolation: dist-001 admin cannot read dist-002 via body spoof', async () => {
    const other = await prisma.user.findFirst({ where: { email: 'bhargava@gasagency.com' } });
    if (!other) return;
    const otherTok = generateToken({ userId: other.id, email: other.email, role: other.role as UserRole, distributorId: other.distributorId });
    const res = await request(app)
      .get('/api/reports/gst-summary')
      .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31' })
      .set({ Authorization: `Bearer ${otherTok}` });
    // resolves to dist-001 from JWT — must not include dist-002 invoice numbers (ISHD/RSHD are dist-002 series)
    expect(res.status).toBe(200);
    const nums = res.body.data.rows.map((r: Record<string, unknown>) => r.invoiceNumber as string);
    expect(nums.some((n: string) => /SHD/.test(n))).toBe(false);
  });
});

describe('reportToCsv', () => {
  it('escapes commas/quotes and appends totals row', () => {
    const r: ReportResult = {
      columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
      rows: [{ a: 'x,y', b: 'he"llo' }],
      totals: { a: 'TOTAL', b: 5 },
    };
    const csv = reportToCsv(r);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('A,B');
    expect(lines[1]).toBe('"x,y","he""llo"');
    expect(lines[2]).toBe('TOTAL,5');
  });
});
