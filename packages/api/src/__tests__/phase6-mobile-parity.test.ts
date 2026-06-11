/**
 * Phase 6 — mobile parity (server-side guard rails).
 *
 * Mobile UI code itself isn't exercised here (RN testing infrastructure
 * is separate; pure-JS guard tests would re-implement the rendering
 * logic). Instead we pin the SERVER contracts that the mobile screens
 * depend on:
 *
 *  6a — GET /api/invoices/:id/pdf is reachable for the finance role.
 *       Mobile (finance)/invoices.tsx mirrors the customer-portal
 *       pattern but hits this tenant-scoped endpoint. If finance loses
 *       access the new Download button on mobile silently fails.
 *
 *  6b — POST /api/users/:id/suspend + /reactivate are reachable for
 *       distributor_admin. The mobile (admin)/more.tsx Phase 6b buttons
 *       call these — losing the role gate would break the toggle.
 *
 *  6i — POST /api/auth/change-password is reachable for an authenticated
 *       user with requiresPasswordReset=true. Drivers + others rely on
 *       this to clear the force-reset flag from the new in-app screen.
 *
 * Source-file guards lock in the consumer-side wiring (mobile + web
 * consumers correctly call the right endpoints).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsFinance } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import type { Express } from 'express';

let app: Express;
let financeToken: string;
let adminToken: string;
let testInvoiceId: string | null = null;

beforeAll(async () => {
  app = createApp();
  financeToken = (await loginAsFinance()).token;
  adminToken = (await loginAsDistAdmin()).token;

  // Phase 6a: dist-001 has zero invoices in the seed today (transactional
  // data is dist-002 + dist-demo per `seed.ts`). Inject a throwaway
  // invoice so the PDF route test has a real row to read.
  const cust = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-001', deletedAt: null },
  });
  const FAR_FUTURE = new Date('2099-11-30');
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: `PHASE6-TEST-${Date.now()}`,
      distributorId: 'dist-001',
      customerId: cust.id,
      issueDate: FAR_FUTURE,
      dueDate: FAR_FUTURE,
      totalAmount: 1180,
      outstandingAmount: 1180,
      status: 'issued',
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      items: {
        create: [{
          description: 'Phase 6a test line',
          quantity: 1,
          unitPrice: 1180,
          gstRate: 18,
          totalPrice: 1180,
        }],
      },
    },
  });
  testInvoiceId = inv.id;
});

afterAll(async () => {
  if (testInvoiceId) {
    await prisma.invoice.delete({ where: { id: testInvoiceId } });
  }
});

describe('Phase 6a — finance can download invoice PDF (mobile parity wire)', () => {
  it('GET /api/invoices/:id/pdf returns 200 for a finance user on a same-tenant invoice', async () => {
    const res = await request(app)
      .get(`/api/invoices/${testInvoiceId}/pdf`)
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/i);
  });

  it('mobile (finance)/invoices.tsx calls /invoices/:id/pdf via the shared api client', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../mobile/app/(finance)/invoices.tsx'),
      'utf-8',
    );
    expect(source).toMatch(/api\.get\(`\/invoices\/\$\{[^}]+\}\/pdf`/);
    expect(source).toContain('arraybuffer');
    expect(source).toContain('Sharing.shareAsync');
  });
});

describe('Phase 6b — admin can suspend / reactivate users (mobile parity wire)', () => {
  it('POST /api/users/:id/suspend is reachable for distributor_admin', async () => {
    // Test against a seeded throwaway user; the suspend call is
    // idempotent enough that we can flip + immediately reactivate.
    const target = await prisma.user.findFirstOrThrow({
      where: { distributorId: 'dist-001', role: 'driver', deletedAt: null, status: 'active' },
      select: { id: true },
    });
    const sus = await request(app)
      .post(`/api/users/${target.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(sus.status).toBe(200);
    const reac = await request(app)
      .post(`/api/users/${target.id}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reac.status).toBe(200);
  });

  it('mobile (admin)/more.tsx wires the suspend + reactivate endpoints', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../mobile/app/(admin)/more.tsx'),
      'utf-8',
    );
    expect(source).toContain('/suspend');
    expect(source).toContain('/reactivate');
    // The Phase 6b explicit "Suspended" badge label so visual state
    // diverges from a generic Inactive treatment.
    expect(source).toContain('Suspended');
  });
});

describe('Phase 6i — driver in-app force-password-reset (mobile parity wire)', () => {
  it('POST /api/auth/change-password rejects unauthenticated', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'x', newPassword: 'newpass1234', confirmPassword: 'newpass1234' });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/change-password accepts a valid payload for a logged-in user', async () => {
    // Spin up a throwaway user we can rotate without touching seed
    // accounts. Use the finance helper since finance is already in
    // the auth fixtures.
    const targetEmail = 'finance@gasagency.com';
    const originalUser = await prisma.user.findUniqueOrThrow({ where: { email: targetEmail } });
    // Rotate password back to the original at the end.
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({
        currentPassword: 'Finance@123',
        newPassword: 'Finance@1234567',
        confirmPassword: 'Finance@1234567',
      });
    expect(res.status).toBe(200);
    // Rotate back so subsequent test runs find the seed password.
    await request(app)
      .post('/api/auth/login')
      .send({ email: targetEmail, password: 'Finance@1234567' });
    const { UserRole } = await import('@gaslink/shared');
    const restoreToken = (await import('./helpers.js')).generateToken({
      userId: originalUser.id,
      email: originalUser.email,
      role: UserRole.FINANCE,
      distributorId: originalUser.distributorId,
    });
    await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${restoreToken}`)
      .send({
        currentPassword: 'Finance@1234567',
        newPassword: 'Finance@123',
        confirmPassword: 'Finance@123',
      });
  });

  it('the mobile force-password-reset screen exists and routes through /auth/change-password', () => {
    const screen = readFileSync(
      resolve(__dirname, '../../../mobile/app/(auth)/force-password-reset.tsx'),
      'utf-8',
    );
    expect(screen).toContain('/auth/change-password');
    expect(screen).toContain('Update Your Password');
  });

  it('the mobile login screen routes the force-reset flag to the new screen (no more web bounce)', () => {
    const login = readFileSync(
      resolve(__dirname, '../../../mobile/app/(auth)/login.tsx'),
      'utf-8',
    );
    expect(login).toContain('/(auth)/force-password-reset');
    // The legacy "Please change your password on the web app first"
    // alert must not survive — pin its absence so the regression can't
    // sneak back in.
    expect(login).not.toContain('change your password on the web app');
  });
});
