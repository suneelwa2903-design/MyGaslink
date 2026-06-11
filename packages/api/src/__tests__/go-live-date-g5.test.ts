/**
 * Group 5 (2026-06-11) — Distributor goLiveDate.
 *
 *   5a/5b: schema + super-admin write endpoint + readable via GET /settings
 *   5d:    outstanding-aging honours dateFrom (no longer ignored — K9)
 *          reports route defaults dateFrom to distributor.goLiveDate
 *          when the caller didn't supply one.
 *   5e:    importOpeningBalances backdates new OB invoices to
 *          goLiveDate - 1 day when goLiveDate is set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { prisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { importOpeningBalances } from '../services/customerService.js';
import { outstandingAging } from '../services/reportsService.js';
import { loginAsDistAdmin, loginAsSuperAdmin } from './helpers.js';
import type { Express } from 'express';

const TRACK = 'G5-Test';
let app: Express;
let distributorId: string;
let userId: string;
let adminToken: string;
let saToken: string;
let originalGoLive: Date | null = null;

async function cleanup() {
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: { startsWith: TRACK } } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: { startsWith: TRACK } },
  });
  await prisma.distributor.update({
    where: { id: distributorId },
    data: { goLiveDate: originalGoLive },
  });
}

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  distributorId = admin.distributorId;
  userId = admin.user.id;
  saToken = (await loginAsSuperAdmin()).token;
  // Capture the original so cleanup() restores it.
  const d = await prisma.distributor.findUniqueOrThrow({
    where: { id: distributorId },
    select: { goLiveDate: true },
  });
  originalGoLive = d.goLiveDate;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  await prisma.distributor.update({
    where: { id: distributorId },
    data: { goLiveDate: null },
  });
});

// ─── 5a/5b — write + read ──────────────────────────────────────────────────

describe('G5.5a/5b — goLiveDate field', () => {
  it('positive: super-admin can set goLiveDate via PUT /distributors/:id/go-live-date', async () => {
    const res = await request(app)
      .put(`/api/distributors/${distributorId}/go-live-date`)
      .set('Authorization', `Bearer ${saToken}`)
      .send({ goLiveDate: '2026-06-01' });
    expect(res.status).toBe(200);
    expect(res.body.data.goLiveDate).toBe('2026-06-01');

    const d = await prisma.distributor.findUniqueOrThrow({
      where: { id: distributorId },
      select: { goLiveDate: true },
    });
    expect(d.goLiveDate?.toISOString().split('T')[0]).toBe('2026-06-01');
  });

  it('positive: distributor admin can READ goLiveDate via GET /settings', async () => {
    await prisma.distributor.update({
      where: { id: distributorId }, data: { goLiveDate: new Date('2026-06-01') },
    });
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.goLiveDate).toBe('2026-06-01');
  });

  it('negative: distributor admin CANNOT write goLiveDate (super-admin only)', async () => {
    const res = await request(app)
      .put(`/api/distributors/${distributorId}/go-live-date`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ goLiveDate: '2026-06-01' });
    expect(res.status).toBe(403);
  });
});

// ─── 5d — Reports honour dateFrom + default from goLiveDate ───────────────

describe('G5.5d — outstanding-aging dateFrom now respected', () => {
  async function seedTwoCustomersWithDebt() {
    const c1 = await prisma.customer.create({
      data: {
        distributorId, customerName: `${TRACK} Pre-Live`, phone: '9100000500',
        customerType: 'B2C', creditPeriodDays: 30,
      },
    });
    const c2 = await prisma.customer.create({
      data: {
        distributorId, customerName: `${TRACK} Post-Live`, phone: '9100000501',
        customerType: 'B2C', creditPeriodDays: 30,
      },
    });
    // Pre-go-live invoice (issueDate=2026-05-30)
    await prisma.invoice.create({
      data: {
        invoiceNumber: `${TRACK}-PRE-${Date.now()}`,
        distributorId, customerId: c1.id,
        issueDate: new Date('2026-05-30'), dueDate: new Date('2026-05-30'),
        totalAmount: 5000, outstandingAmount: 5000, amountPaid: 0,
        status: 'overdue', isOpeningBalance: true,
      },
    });
    // Post-go-live invoice (issueDate=2026-06-15)
    await prisma.invoice.create({
      data: {
        invoiceNumber: `${TRACK}-POST-${Date.now()}`,
        distributorId, customerId: c2.id,
        issueDate: new Date('2026-06-15'), dueDate: new Date('2026-06-15'),
        totalAmount: 3000, outstandingAmount: 3000, amountPaid: 0,
        status: 'overdue',
      },
    });
    return { c1, c2 };
  }

  it('positive: dateFrom=2026-06-01 excludes the pre-go-live invoice', async () => {
    await seedTwoCustomersWithDebt();
    const res = await outstandingAging(distributorId, { dateFrom: '2026-06-01' });
    const names = (res.rows as Array<{ customer: string }>).map((r) => r.customer);
    expect(names).toContain(`${TRACK} Post-Live`);
    expect(names).not.toContain(`${TRACK} Pre-Live`);
  });

  it('positive: without dateFrom, both invoices show (legacy behaviour)', async () => {
    await seedTwoCustomersWithDebt();
    const res = await outstandingAging(distributorId, {});
    const names = (res.rows as Array<{ customer: string }>).map((r) => r.customer);
    expect(names).toContain(`${TRACK} Post-Live`);
    expect(names).toContain(`${TRACK} Pre-Live`);
  });

  it('positive: route layer auto-defaults dateFrom to goLiveDate when caller omits it', async () => {
    await seedTwoCustomersWithDebt();
    await prisma.distributor.update({
      where: { id: distributorId }, data: { goLiveDate: new Date('2026-06-01') },
    });
    const res = await request(app)
      .get('/api/reports/outstanding-aging')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const names = (res.body.data.rows as Array<{ customer: string }>).map((r) => r.customer);
    expect(names).toContain(`${TRACK} Post-Live`);
    expect(names).not.toContain(`${TRACK} Pre-Live`);
  });
});

// ─── 5e — OB import backdates to goLiveDate-1 ─────────────────────────────

describe('G5.5e — importOpeningBalances backdates to goLiveDate-1', () => {
  it('positive: with goLiveDate set, OB invoice issueDate = goLiveDate - 1 day', async () => {
    await prisma.distributor.update({
      where: { id: distributorId }, data: { goLiveDate: new Date('2026-06-01') },
    });
    const cust = await prisma.customer.create({
      data: {
        distributorId, customerName: `${TRACK} Backdate`, phone: '9100000510',
        customerType: 'B2C', creditPeriodDays: 30,
      },
    });
    const r = await importOpeningBalances(distributorId, userId, [
      { customerName: cust.customerName, openingBalance: 7777 },
    ]);
    expect(r.imported).toBe(1);

    const inv = await prisma.invoice.findFirstOrThrow({
      where: { distributorId, customerId: cust.id, isOpeningBalance: true },
      select: { issueDate: true, dueDate: true },
    });
    expect(inv.issueDate.toISOString().split('T')[0]).toBe('2026-05-31');
    expect(inv.dueDate.toISOString().split('T')[0]).toBe('2026-05-31');
  });

  it('positive: per-row asOfDate still WINS over goLiveDate', async () => {
    await prisma.distributor.update({
      where: { id: distributorId }, data: { goLiveDate: new Date('2026-06-01') },
    });
    const cust = await prisma.customer.create({
      data: {
        distributorId, customerName: `${TRACK} AsOfWins`, phone: '9100000511',
        customerType: 'B2C', creditPeriodDays: 30,
      },
    });
    await importOpeningBalances(distributorId, userId, [
      { customerName: cust.customerName, openingBalance: 7777, asOfDate: '2026-05-15' },
    ]);
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { distributorId, customerId: cust.id, isOpeningBalance: true },
      select: { issueDate: true },
    });
    expect(inv.issueDate.toISOString().split('T')[0]).toBe('2026-05-15');
  });
});
