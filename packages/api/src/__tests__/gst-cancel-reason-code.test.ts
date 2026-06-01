/**
 * gst-cancel-reason-code.test.ts — GROUP-7S
 *
 * Server-side guards for the new cancellation context that NIC requires:
 *   - reasonCode: explicit '1'|'2'|'3'|'4' (Duplicate / Data Entry
 *     Mistake / Order Cancelled / Others). Required on every cancel.
 *   - reason: free-text remarks (≤100 chars). Already required.
 *
 * Before GROUP-7S the route accepted free text only and the service
 * guessed the code from keyword-matching the reason. After:
 *   1. The Zod schema rejects missing or out-of-range reasonCode (400).
 *   2. The persisted gst_documents row carries cancel_reason +
 *      cancel_reason_code + cancelled_by_user_id (queryable from the
 *      domain row instead of buried in gst_api_logs).
 *
 * We don't exercise the real NIC sandbox; we test the route layer
 * (validation + DB persistence path) by mocking the upstream callWithLog.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// Stub the NIC HTTP call so the test never goes off-network. Both
// cancel routes call through whitebooksClient.callWithLog via apiCall.
vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original = (await orig()) as typeof import('../services/gst/whitebooksClient.js');
  return {
    ...original,
    apiCall: vi.fn(async () => ({ status_cd: '1', data: { Status: 1 } })),
    clearTokenCache: vi.fn(),
    getCredentials: vi.fn(async () => ({ email: 'test@test.com' })),
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;

function auth(token: string) { return { Authorization: `Bearer ${token}` }; }

async function seedInvoiceWithIrnSuccess() {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-001', deletedAt: null },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-GRP7S-${Math.random().toString(36).slice(2, 8)}`,
      distributorId: 'dist-001',
      customerId: customer.id,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: 1000,
      outstandingAmount: 1000,
      status: 'issued',
      irnStatus: 'success',
      ewbStatus: 'not_attempted',
      irn: 'irn_grp7s_' + Math.random().toString(36).slice(2, 10),
      ackNo: '11261000099',
    },
  });
  await prisma.gstDocument.create({
    data: {
      invoiceId: invoice.id,
      distributorId: 'dist-001',
      docType: 'INV',
      gstDocNo: invoice.invoiceNumber,
      irnStatus: 'success',
      irn: invoice.irn,
      ackNo: '11261000099',
      ewbStatus: 'not_attempted',
      isLatest: true,
    },
  });
  return invoice.id;
}

async function teardown(invoiceId: string) {
  await prisma.gstDocument.deleteMany({ where: { invoiceId } });
  await prisma.invoice.deleteMany({ where: { id: invoiceId } });
}

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
});

describe('POST /api/invoices/:id/cancel-irn — reasonCode validation + persistence', () => {
  it('rejects missing reasonCode with 400', async () => {
    const invoiceId = await seedInvoiceWithIrnSuccess();
    try {
      const res = await request(app)
        .post(`/api/invoices/${invoiceId}/cancel-irn`)
        .set(auth(adminToken))
        .send({ reason: 'oops' });
      expect(res.status).toBe(400);
    } finally {
      await teardown(invoiceId);
    }
  });

  it('rejects out-of-range reasonCode with 400', async () => {
    const invoiceId = await seedInvoiceWithIrnSuccess();
    try {
      const res = await request(app)
        .post(`/api/invoices/${invoiceId}/cancel-irn`)
        .set(auth(adminToken))
        .send({ reason: 'oops', reasonCode: '5' });
      expect(res.status).toBe(400);
    } finally {
      await teardown(invoiceId);
    }
  });

  it('rejects empty reason with 400', async () => {
    const invoiceId = await seedInvoiceWithIrnSuccess();
    try {
      const res = await request(app)
        .post(`/api/invoices/${invoiceId}/cancel-irn`)
        .set(auth(adminToken))
        .send({ reason: '', reasonCode: '1' });
      expect(res.status).toBe(400);
    } finally {
      await teardown(invoiceId);
    }
  });

  it('accepts a valid call and persists reason + code + user on gst_documents', async () => {
    const invoiceId = await seedInvoiceWithIrnSuccess();
    try {
      const res = await request(app)
        .post(`/api/invoices/${invoiceId}/cancel-irn`)
        .set(auth(adminToken))
        .send({ reason: 'Duplicate of INV-999', reasonCode: '1' });
      expect(res.status).toBe(200);
      // Read back the gst_documents row via raw SQL — the typed Prisma
      // client may not have the new columns in its generated index.d.ts
      // until `pnpm prisma generate` runs after the engine .dll is free.
      const rows = await prisma.$queryRawUnsafe<{
        cancel_reason: string | null;
        cancel_reason_code: string | null;
        cancelled_by_user_id: string | null;
      }[]>(
        `SELECT cancel_reason, cancel_reason_code, cancelled_by_user_id
           FROM gst_documents
          WHERE invoice_id = $1 AND is_latest = true
          LIMIT 1`,
        invoiceId,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].cancel_reason).toBe('Duplicate of INV-999');
      expect(rows[0].cancel_reason_code).toBe('1');
      expect(rows[0].cancelled_by_user_id).toBeTruthy();
    } finally {
      await teardown(invoiceId);
    }
  });
});
