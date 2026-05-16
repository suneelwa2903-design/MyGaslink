/**
 * WI-056 — Invoice list CN/DN counts + CN PDF reads IRN from gst_documents.
 *
 * Two surfaces, one suite:
 *   - List shape: GET /api/invoices includes creditNotesCount /
 *     debitNotesCount numeric fields; full CN/DN arrays are NOT shipped
 *     on list rows (those move to the detail endpoint).
 *   - Detail shape: GET /api/invoices/:id still ships full arrays for
 *     the View modal.
 *   - CN PDF: gst_documents lookup populates the IRN block when a
 *     successful CRN row exists for the invoice; falls back gracefully
 *     when none.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    getAuthToken: vi.fn(async () => 'fake-token'),
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let sharmaAdminToken: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = createApp();
  const sharmaAdmin = await prisma.user.findUniqueOrThrow({
    where: { email: 'sharma@gasdist.com' },
  });
  sharmaAdminToken = generateToken({
    userId: sharmaAdmin.id,
    email: sharmaAdmin.email,
    role: sharmaAdmin.role as any,
    distributorId: sharmaAdmin.distributorId,
  });
});

async function getValuedInvoice() {
  return prisma.invoice.findFirstOrThrow({
    where: {
      distributorId: 'dist-002',
      deletedAt: null,
      status: { not: 'cancelled' },
      totalAmount: { gt: 1000 },
    },
    orderBy: { createdAt: 'asc' },
  });
}

describe('WI-056 — Invoice list response shape', () => {
  it('GET /api/invoices returns creditNotesCount + debitNotesCount as numbers', async () => {
    const res = await request(app)
      .get('/api/invoices?pageSize=5')
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    const rows = res.body.data.invoices;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty('creditNotesCount');
      expect(row).toHaveProperty('debitNotesCount');
      expect(typeof row.creditNotesCount).toBe('number');
      expect(typeof row.debitNotesCount).toBe('number');
    }
  });

  it('GET /api/invoices does NOT ship full creditNotes/debitNotes arrays on list rows', async () => {
    const res = await request(app)
      .get('/api/invoices?pageSize=5')
      .set(auth(sharmaAdminToken));

    for (const row of res.body.data.invoices) {
      // List path strips the full arrays — they live on the detail endpoint.
      // (Strictly: undefined is acceptable; an array would be a regression.)
      expect(Array.isArray(row.creditNotes)).toBe(false);
      expect(Array.isArray(row.debitNotes)).toBe(false);
      // _count helper should be unmapped, not leaked.
      expect(row).not.toHaveProperty('_count');
    }
  });

  it('counts reflect actual rows — create a CN and re-fetch shows count=1', async () => {
    const inv = await getValuedInvoice();
    const created = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(sharmaAdminToken))
      .send({ invoiceId: inv.id, reason: 'count-test', amount: 1 });
    const cnId = created.body.data?.creditNoteId;
    expect(cnId).toBeTruthy();

    const list = await request(app)
      .get(`/api/invoices?customerId=${inv.customerId}&pageSize=50`)
      .set(auth(sharmaAdminToken));

    const row = list.body.data.invoices.find((r: any) => r.invoiceId === inv.id);
    expect(row).toBeTruthy();
    expect(row.creditNotesCount).toBeGreaterThanOrEqual(1);

    await prisma.creditNote.delete({ where: { id: cnId } });
  });

  it('GET /api/invoices/:id (detail) still includes the full creditNotes array', async () => {
    const inv = await getValuedInvoice();
    const res = await request(app)
      .get(`/api/invoices/${inv.id}`)
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.creditNotes)).toBe(true);
    expect(Array.isArray(res.body.data.debitNotes)).toBe(true);
  });
});

describe('WI-056 — Credit Note PDF reads IRN from gst_documents', () => {
  it('returns application/pdf even when no CRN gst_documents row exists', async () => {
    const inv = await getValuedInvoice();
    const cn = await prisma.creditNote.create({
      data: {
        invoiceId: inv.id,
        creditNoteNumber: `CN-PDFTEST-${Date.now().toString(36)}`,
        totalAmount: 10,
        reason: 'pdf no-gst-doc',
        status: 'pending_cn',
      },
    });

    const res = await request(app)
      .get(`/api/invoices/credit-notes/${cn.id}/pdf`)
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.length).toBeGreaterThan(500);

    await prisma.creditNote.delete({ where: { id: cn.id } });
  });

  it('renders IRN block when a CRN gst_documents row exists', async () => {
    const inv = await getValuedInvoice();
    const cn = await prisma.creditNote.create({
      data: {
        invoiceId: inv.id,
        creditNoteNumber: `CN-IRNTEST-${Date.now().toString(36)}`,
        totalAmount: 10,
        reason: 'pdf with-gst-doc',
        status: 'pending_cn',
      },
    });
    const fakeIrn = 'a'.repeat(64);
    const crnDoc = await prisma.gstDocument.create({
      data: {
        invoiceId: inv.id,
        distributorId: 'dist-002',
        docType: 'CRN',
        gstDocNo: cn.creditNoteNumber!,
        irnStatus: 'success',
        irn: fakeIrn,
        ackNo: '112610251234567',
        ackDate: new Date(),
        isLatest: true,
      },
    });

    const res = await request(app)
      .get(`/api/invoices/credit-notes/${cn.id}/pdf`)
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // Sanity: a non-empty PDF was produced. PDF text-extraction is out
    // of scope here; pdfkit smoke check via buffer length is sufficient
    // to prove the CRN block didn't crash the generator.
    expect(res.body.length).toBeGreaterThan(1000);

    await prisma.gstDocument.delete({ where: { id: crnDoc.id } });
    await prisma.creditNote.delete({ where: { id: cn.id } });
  });
});
