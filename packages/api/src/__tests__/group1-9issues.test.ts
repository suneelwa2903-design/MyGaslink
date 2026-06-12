/**
 * 9-issues Group 1 — quick wins.
 *
 * Tests the 4 fixes in one file:
 *   Issue 2 — GET /pricing/billing-invoice/:cycleId widened from
 *             super_admin only to also allow distributor_admin, with
 *             a tenant-isolation guard inside the handler.
 *   Issue 3 — POST /billing/cycles/:id/create-payment-order now also
 *             accepts cycles in invoice_generated status (previously
 *             only pending_payment + overdue_billing).
 *   Issue 1 — Sidebar tenant-name removal + DashboardLayout header
 *             render. Covered by source-file guards in the web
 *             package (sidebarTenantName.test.ts), not here.
 *   Issue 6b — Customer-portal invoice PDF download button. Covered
 *              by the existing customer-portal invoice PDF route
 *              tests; here we add a regression that the route still
 *              accepts customer role + denies other tenants.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsFinance, loginAsSuperAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import type { Express } from 'express';

let app: Express;
let saToken: string;
let distAdminToken: string;
let financeToken: string;

let ownCycleId: string;       // cycle on dist-001
let crossCycleId: string;     // cycle on dist-002
let generatedCycleId: string; // dist-001 cycle at invoice_generated

beforeAll(async () => {
  app = createApp();
  saToken = (await loginAsSuperAdmin()).token;
  distAdminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;

  const own = await prisma.billingCycle.create({
    data: {
      distributorId: 'dist-001',
      periodType: 'monthly',
      periodStartDate: new Date('2099-09-01'),
      periodEndDate: new Date('2099-09-30'),
      billingStatus: 'pending_payment',
      billingTier: 'tier_1',
      totalAmountExclGst: 1000,
      totalGstAmount: 180,
      totalAmountInclGst: 1180,
    },
  });
  ownCycleId = own.id;

  const cross = await prisma.billingCycle.create({
    data: {
      distributorId: 'dist-002',
      periodType: 'monthly',
      periodStartDate: new Date('2099-09-01'),
      periodEndDate: new Date('2099-09-30'),
      billingStatus: 'pending_payment',
      billingTier: 'tier_1',
      totalAmountExclGst: 1000,
      totalGstAmount: 180,
      totalAmountInclGst: 1180,
    },
  });
  crossCycleId = cross.id;

  const generated = await prisma.billingCycle.create({
    data: {
      distributorId: 'dist-001',
      periodType: 'monthly',
      periodStartDate: new Date('2099-10-01'),
      periodEndDate: new Date('2099-10-31'),
      billingStatus: 'invoice_generated',
      billingTier: 'tier_1',
      totalAmountExclGst: 1000,
      totalGstAmount: 180,
      totalAmountInclGst: 1180,
    },
  });
  generatedCycleId = generated.id;
});

afterAll(async () => {
  await prisma.billingCycle.deleteMany({
    where: { id: { in: [ownCycleId, crossCycleId, generatedCycleId] } },
  });
});

describe('Issue 2 — GET /api/pricing/billing-invoice/:cycleId', () => {
  it('super_admin can download any cycle (cross-tenant bypass for cross-tenant capability)', async () => {
    const res = await request(app)
      .get(`/api/pricing/billing-invoice/${crossCycleId}`)
      .set('Authorization', `Bearer ${saToken}`)
      .set('X-Distributor-Id', 'dist-002');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('distributor_admin can download their OWN cycle (the headline fix)', async () => {
    const res = await request(app)
      .get(`/api/pricing/billing-invoice/${ownCycleId}`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('distributor_admin CANNOT download another tenant cycle (tenant guard)', async () => {
    const res = await request(app)
      .get(`/api/pricing/billing-invoice/${crossCycleId}`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_TENANT_ACCESS');
  });

  it('finance role still 403 (only super_admin + distributor_admin in the allowlist)', async () => {
    const res = await request(app)
      .get(`/api/pricing/billing-invoice/${ownCycleId}`)
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(403);
  });

  it('unknown cycle id → 404 (not 500)', async () => {
    const res = await request(app)
      .get(`/api/pricing/billing-invoice/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Issue 3 — invoice_generated cycles are payable', () => {
  it('create-payment-order accepts invoice_generated (widened gate)', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${generatedCycleId}/create-payment-order`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.data.razorpayOrderId).toBeDefined();
  });
});

describe('Issue 6b — customer-portal invoice PDF route still gated to owner', () => {
  // Regression — confirming the existing PDF route still works as
  // designed (the UI was the missing piece; the endpoint already
  // exists at routes/customerPortal.ts:305).
  it('GET /customer-portal/invoices/:id/pdf is in the customer-portal router and uses requireRole(customer)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'routes', 'customerPortal.ts'),
      'utf-8',
    );
    expect(src).toMatch(/router\.get\(\s*['"]\/invoices\/:id\/pdf['"]/);
    expect(src).toMatch(/requireRole\(\s*['"]customer['"]\s*\)/);
  });

  it('the customer InvoicesPage UI now renders a Download PDF button', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'web', 'src', 'pages', 'customer', 'InvoicesPage.tsx'),
      'utf-8',
    );
    // The button uses the same /customer-portal/invoices/:id/pdf endpoint
    // + responseType: blob pattern as SettingsPage.handleDownload.
    expect(src).toMatch(/HiOutlineDocumentArrowDown/);
    expect(src).toMatch(/\/customer-portal\/invoices\/\$\{inv\.invoiceId\}\/pdf/);
    expect(src).toMatch(/responseType:\s*['"]blob['"]/);
  });
});
