/**
 * #30 — IDOR fix: GET /api/invoices/:id/gst-documents must be tenant-scoped.
 *
 * Before the fix the route queried gst_documents by invoiceId alone, so any
 * authenticated tenant could read another tenant's IRN/EWB numbers + NIC
 * payloads by guessing an invoiceId. The fix adds the same invoice-ownership
 * pre-check the credit-notes/debit-notes routes use (404 on cross-tenant).
 *
 * Self-seeded fixture invoice + gst_document under dist-001 (anti-pattern #7:
 * synthetic invoice number, cleaned up in afterAll). dist-002 admin (sharma)
 * is the cross-tenant attacker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, generateToken } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let dist1Token: string;   // owns the fixture invoice (dist-001)
let dist2Token: string;   // cross-tenant attacker (dist-002)
let fixtureInvoiceId: string | null = null;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const INV_NO = `IDOR-FIXTURE-${Date.now()}`;

beforeAll(async () => {
  app = createApp();

  const dist1 = await loginAsDistAdmin();
  dist1Token = dist1.token;

  const sharma = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  dist2Token = generateToken({
    userId: sharma.id, email: sharma.email, role: sharma.role as any, distributorId: sharma.distributorId,
  });

  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-001', deletedAt: null },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: INV_NO,
      distributorId: 'dist-001',
      customerId: customer.id,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: 5000,
      amountPaid: 0,
      outstandingAmount: 5000,
      status: 'issued',
      irnStatus: 'success',
      ewbStatus: 'active',
      irn: 'idor-fixture-irn-0000000000000000000000000000000000000000000000000000',
    },
  });
  fixtureInvoiceId = invoice.id;
  await prisma.gstDocument.create({
    data: {
      invoiceId: invoice.id,
      distributorId: 'dist-001',
      docType: 'INV',
      gstDocNo: INV_NO,
      isLatest: true,
      irnStatus: 'success',
      irn: invoice.irn,
      ewbStatus: 'active',
      ewbNo: '999999999999',
    },
  });
});

afterAll(async () => {
  if (fixtureInvoiceId) {
    await prisma.gstDocument.deleteMany({ where: { invoiceId: fixtureInvoiceId } });
    await prisma.invoice.delete({ where: { id: fixtureInvoiceId } }).catch(() => {});
    fixtureInvoiceId = null;
  }
});

describe('#30 — GET /invoices/:id/gst-documents tenant isolation', () => {
  it('✅ owner (dist-001) gets the gst_documents for its own invoice', async () => {
    const res = await request(app)
      .get(`/api/invoices/${fixtureInvoiceId}/gst-documents`)
      .set(auth(dist1Token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((d: any) => d.ewbNo === '999999999999')).toBe(true);
  });

  it('❌ cross-tenant (dist-002) gets 404, not the other tenant\'s GST docs', async () => {
    const res = await request(app)
      .get(`/api/invoices/${fixtureInvoiceId}/gst-documents`)
      .set(auth(dist2Token));
    expect(res.status).toBe(404);
    // never leak the IRN/EWB payload
    expect(JSON.stringify(res.body)).not.toContain('999999999999');
  });

  it('❌ unauthenticated request is rejected 401', async () => {
    const res = await request(app).get(`/api/invoices/${fixtureInvoiceId}/gst-documents`);
    expect(res.status).toBe(401);
  });
});
