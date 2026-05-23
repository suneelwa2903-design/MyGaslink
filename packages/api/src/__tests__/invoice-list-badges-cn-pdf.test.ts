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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

// Self-seeded fixture invoice — avoids reliance on pre-existing DB data
// (anti-pattern #7 fix). Created in beforeAll, deleted in afterAll.
let fixtureInvoiceId: string | null = null;

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

  // Seed a fixture invoice so getValuedInvoice() always finds one regardless
  // of whether cleanup-dist002-seed.ts has been run.
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', deletedAt: null },
  });
  const fixture = await prisma.invoice.create({
    data: {
      invoiceNumber: `WI056-FIXTURE-${Date.now()}`,
      distributorId: 'dist-002',
      customerId: customer.id,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: 5000,
      amountPaid: 0,
      outstandingAmount: 5000,
      status: 'issued',
    },
  });
  fixtureInvoiceId = fixture.id;
});

afterAll(async () => {
  // Clean up credit/debit notes and gst_documents created by the tests,
  // then remove the fixture invoice.
  if (fixtureInvoiceId) {
    await prisma.gstDocument.deleteMany({ where: { invoiceId: fixtureInvoiceId } });
    await prisma.creditNote.deleteMany({ where: { invoiceId: fixtureInvoiceId } });
    await prisma.debitNote.deleteMany({ where: { invoiceId: fixtureInvoiceId } });
    await prisma.invoice.delete({ where: { id: fixtureInvoiceId } }).catch(() => {});
    fixtureInvoiceId = null;
  }
});

async function getValuedInvoice() {
  // Returns the self-seeded fixture invoice — no longer depends on pre-existing
  // DB data (anti-pattern #7 fix).
  return prisma.invoice.findUniqueOrThrow({ where: { id: fixtureInvoiceId! } });
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

  it('WI-077 — skips the IRN block entirely when no CRN gst_documents row exists (B2C credit note)', async () => {
    // WI-077: B2C credit notes never get an IRN — the recipient
    // shouldn't see a "Pending" status line on the PDF that will never
    // resolve. The CN PDF mirrors the invoice PDF pattern and omits the
    // compliance section entirely when no IRN/EWB exists on the row.
    //
    // PDFKit deflate-compresses content streams, so the rendered text
    // can't be regex-searched on the raw buffer. Spy on the prototype
    // `text` method instead — captures every string the service draws
    // BEFORE compression, which is what we actually want to assert.
    const PDFDocument = (await import('pdfkit')).default;
    const drawnStrings: string[] = [];
    const originalText = PDFDocument.prototype.text;
    const spy = vi.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(
      function (this: any, str: any, ...rest: any[]) {
        if (typeof str === 'string') drawnStrings.push(str);
        return originalText.call(this, str, ...rest);
      },
    );

    const inv = await getValuedInvoice();
    const cn = await prisma.creditNote.create({
      data: {
        invoiceId: inv.id,
        creditNoteNumber: `CN-NOIRN-${Date.now().toString(36)}`,
        totalAmount: 10,
        reason: 'WI-077 b2c-no-irn-block',
        status: 'pending_cn',
      },
    });
    try {
      const res = await request(app)
        .get(`/api/invoices/credit-notes/${cn.id}/pdf`)
        .set(auth(sharmaAdminToken));

      expect(res.status).toBe(200);
      // No "Pending", no "Failed" — the compliance block is gone.
      expect(drawnStrings.some((s) => /e-Invoice: Pending/.test(s))).toBe(false);
      expect(drawnStrings.some((s) => /e-Invoice: Failed/.test(s))).toBe(false);
      // CRN-Details / IRN labels from drawCrnDetailsBox also absent.
      expect(drawnStrings.some((s) => /CRN Details/i.test(s))).toBe(false);
    } finally {
      spy.mockRestore();
      await prisma.creditNote.delete({ where: { id: cn.id } });
    }
  });

  it('WI-077 — skips the IRN block entirely when a CRN row exists with irnStatus=failed and no IRN/EWB on it', async () => {
    const PDFDocument = (await import('pdfkit')).default;
    const drawnStrings: string[] = [];
    const originalText = PDFDocument.prototype.text;
    const spy = vi.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(
      function (this: any, str: any, ...rest: any[]) {
        if (typeof str === 'string') drawnStrings.push(str);
        return originalText.call(this, str, ...rest);
      },
    );

    const inv = await getValuedInvoice();
    const cn = await prisma.creditNote.create({
      data: {
        invoiceId: inv.id,
        creditNoteNumber: `CN-FAIL-${Date.now().toString(36)}`,
        totalAmount: 10,
        reason: 'pdf failed text',
        status: 'pending_cn',
      },
    });
    // gst_documents row with irnStatus='failed' AND no irn/ackNo/signedQr
    // — exactly the shape processCreditNoteGst writes after NIC rejects.
    const crnDoc = await prisma.gstDocument.create({
      data: {
        invoiceId: inv.id,
        distributorId: 'dist-002',
        docType: 'CRN',
        gstDocNo: cn.creditNoteNumber!,
        irnStatus: 'failed',
        isLatest: true,
      },
    });
    try {
      const res = await request(app)
        .get(`/api/invoices/credit-notes/${cn.id}/pdf`)
        .set(auth(sharmaAdminToken));

      expect(res.status).toBe(200);
      // WI-077: the failed-IRN status line is no longer rendered. The
      // recipient PDF stays clean; the issuer learns about the failure
      // via the Billing page badge + pending action, not the PDF.
      expect(drawnStrings.some((s) => /e-Invoice: Failed/.test(s))).toBe(false);
      expect(drawnStrings.some((s) => /retry from Billing page/.test(s))).toBe(false);
    } finally {
      spy.mockRestore();
      await prisma.gstDocument.delete({ where: { id: crnDoc.id } });
      await prisma.creditNote.delete({ where: { id: cn.id } });
    }
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

  it('WI-092 — retries the gst_documents lookup after a miss and renders the IRN block when the row lands on the 2nd attempt', async () => {
    // Proves the fire-and-forget timing fix: the CN IRN is generated ~2s
    // after approval, so the first lookup can miss. The service retries once
    // (after 2s) and must then render the IRN block. We mock the lookup to
    // return null on the 1st call and a populated CRN row on the 2nd.
    const PDFDocument = (await import('pdfkit')).default;
    const drawnStrings: string[] = [];
    const originalText = PDFDocument.prototype.text;
    const textSpy = vi.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(
      function (this: any, str: any, ...rest: any[]) {
        if (typeof str === 'string') drawnStrings.push(str);
        return originalText.call(this, str, ...rest);
      },
    );

    const inv = await getValuedInvoice();
    const cn = await prisma.creditNote.create({
      data: {
        invoiceId: inv.id,
        creditNoteNumber: `CN-RETRY-${Date.now().toString(36)}`,
        totalAmount: 10,
        reason: 'WI-092 retry',
        status: 'pending_cn',
      },
    });

    const fakeCrnDoc = {
      id: 'wi092-fake-crn-doc',
      invoiceId: inv.id,
      distributorId: 'dist-002',
      docType: 'CRN',
      irn: 'c'.repeat(64),
      ackNo: '112610259999999',
      ackDate: new Date(),
      signedQr: null,
      ewbNo: null,
      irnStatus: 'success',
      isLatest: true,
    };

    // Manual save/restore rather than vi.spyOn: Prisma model delegates don't
    // restore reliably via mockRestore (they're proxy-backed), and a leaked
    // findFirst override would break every later test that reads gst_documents.
    const originalFindFirst = prisma.gstDocument.findFirst;
    let crnLookupCalls = 0;
    (prisma.gstDocument as any).findFirst = async (...args: any[]) => {
      crnLookupCalls++;
      // 1st lookup misses (IRN hasn't landed yet); 2nd (post-retry) finds it.
      return crnLookupCalls === 1 ? null : fakeCrnDoc;
    };

    try {
      const res = await request(app)
        .get(`/api/invoices/credit-notes/${cn.id}/pdf`)
        .set(auth(sharmaAdminToken));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      // The retry fired (exactly 2 lookups) and the IRN block rendered.
      expect(crnLookupCalls).toBe(2);
      expect(drawnStrings.some((s) => /CRN Details/i.test(s))).toBe(true);
    } finally {
      (prisma.gstDocument as any).findFirst = originalFindFirst;
      textSpy.mockRestore();
      await prisma.creditNote.delete({ where: { id: cn.id } });
    }
  });
});

describe('WI-077 — Debit Note PDF skips IRN block for B2C-style (no IRN/EWB) DBN', () => {
  it('skips the IRN block on the DN PDF when no DBN gst_documents row exists', async () => {
    const PDFDocument = (await import('pdfkit')).default;
    const drawnStrings: string[] = [];
    const originalText = PDFDocument.prototype.text;
    const spy = vi.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(
      function (this: any, str: any, ...rest: any[]) {
        if (typeof str === 'string') drawnStrings.push(str);
        return originalText.call(this, str, ...rest);
      },
    );

    const inv = await getValuedInvoice();
    const dn = await prisma.debitNote.create({
      data: {
        invoiceId: inv.id,
        debitNoteNumber: `DN-NOIRN-${Date.now().toString(36)}`,
        totalAmount: 10,
        reason: 'WI-077 b2c-no-irn-block',
        status: 'pending_dn',
      },
    });
    try {
      const res = await request(app)
        .get(`/api/invoices/debit-notes/${dn.id}/pdf`)
        .set(auth(sharmaAdminToken));

      expect(res.status).toBe(200);
      // "Pending generation" / "Generation failed" labels gone.
      expect(drawnStrings.some((s) => /Pending generation/.test(s))).toBe(false);
      expect(drawnStrings.some((s) => /Generation failed/.test(s))).toBe(false);
      // "DBN Details - IRN" header from drawCrnDetailsBox also absent.
      expect(drawnStrings.some((s) => /DBN Details/i.test(s))).toBe(false);
    } finally {
      spy.mockRestore();
      await prisma.debitNote.delete({ where: { id: dn.id } });
    }
  });

  it('still renders the DBN IRN block when a DBN gst_documents row carries a real IRN (B2B parity)', async () => {
    const PDFDocument = (await import('pdfkit')).default;
    const drawnStrings: string[] = [];
    const originalText = PDFDocument.prototype.text;
    const spy = vi.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(
      function (this: any, str: any, ...rest: any[]) {
        if (typeof str === 'string') drawnStrings.push(str);
        return originalText.call(this, str, ...rest);
      },
    );

    const inv = await getValuedInvoice();
    const dn = await prisma.debitNote.create({
      data: {
        invoiceId: inv.id,
        debitNoteNumber: `DN-IRN-${Date.now().toString(36)}`,
        totalAmount: 10,
        reason: 'WI-077 b2b-irn-block-present',
        status: 'pending_dn',
      },
    });
    const dbnDoc = await prisma.gstDocument.create({
      data: {
        invoiceId: inv.id,
        distributorId: 'dist-002',
        docType: 'DBN',
        gstDocNo: dn.debitNoteNumber!,
        irnStatus: 'success',
        irn: 'b'.repeat(64),
        ackNo: '112610251234999',
        ackDate: new Date(),
        isLatest: true,
      },
    });
    try {
      const res = await request(app)
        .get(`/api/invoices/debit-notes/${dn.id}/pdf`)
        .set(auth(sharmaAdminToken));

      expect(res.status).toBe(200);
      // drawCrnDetailsBox renders this header when invoked with label='DBN Details - IRN'.
      expect(drawnStrings.some((s) => /DBN Details/i.test(s))).toBe(true);
    } finally {
      spy.mockRestore();
      await prisma.gstDocument.delete({ where: { id: dbnDoc.id } });
      await prisma.debitNote.delete({ where: { id: dn.id } });
    }
  });
});
