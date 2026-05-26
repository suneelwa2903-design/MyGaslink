/**
 * gst-reissue-2278.test.ts — WI-064
 *
 * Bug context: during live manual testing on 2026-05-19, invoice
 * INV-MPC38K5UZGB went through cancel→regenerate inside the reissue
 * flow and WhiteBooks came back with NIC error 2278 ("IRN was
 * generated and cancelled — doc number is burned"). The legacy
 * reissue code only caught 2150 and threw 2278 unhandled, leaving
 * the invoice in a half-state (quantities revised but `irnStatus`
 * still pointing at the cancelled IRN).
 *
 * The fix:
 *   1. Bump invoice number BEFORE the first regenerate call so NIC
 *      always sees a fresh doc number. The cancel step before this
 *      retires the original; reusing it is guaranteed to fail
 *      (2278 if NIC remembered the cancel, 2150 if not).
 *   2. Update outstandingAmount when revising totalAmount so the
 *      finance ledger doesn't drift.
 *   3. Catch both 2150 AND 2278 on the retry (handles the rare case
 *      where the bumped suffix collides with another already-cancelled
 *      doc).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original = await orig<typeof import('../services/gst/whitebooksClient.js')>();
  return {
    ...original,
    apiCall: vi.fn(),
    getCredentials: vi.fn(async () => ({
      clientId: 'EINS-test',
      clientSecret: 'EINS-test-secret',
      username: 'BVMGSP',
      password: 'Wbooks@0142',
      gstin: '29AAGCB1286Q000',
      email: 'test@test.com',
      baseUrl: 'https://apisandbox.whitebooks.in',
    })),
  };
});

import { prisma } from '../lib/prisma.js';
import * as whitebooksClient from '../services/gst/whitebooksClient.js';

const TEST_DATE = '2099-12-31';
const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

function irnSuccess(over: Record<string, unknown> = {}) {
  return {
    status_cd: '1',
    data: {
      Irn: 'irn_' + Math.random().toString(36).slice(2, 10),
      AckNo: '112610000099999',
      AckDt: '15/05/2026 12:00:00 PM',
      SignedQRCode: 'eyJhbGciOi',
      ...over,
    },
  };
}
function irnCancelOk() {
  return { status_cd: '1', data: { CancelDate: '15/05/2026 01:00:00 PM' } };
}
function whitebooksError(code: string, message: string) {
  return new whitebooksClient.GstError(message, code);
}

/**
 * Build a short fixture invoice number. bumpInvoiceNumber caps the
 * result at 16 chars (NIC DocDtls.No limit) — long names get trimmed
 * from the base, which makes exact-string assertions brittle. Keeping
 * the prefix short here means `${original}-R1` and `${original}-R2`
 * both fit within the cap unchanged.
 */
function shortInvoiceNumber(prefix: string): string {
  // e.g. "INV-2278-AB12" (13 chars) → bump → "INV-2278-AB12-R1" (16 chars).
  return `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function seedB2bFixture(opts: { orderedQty: number; deliveredQty: number }) {
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: 'dist-002', typeName: '19 KG' },
  });
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', customerType: 'B2B', gstin: { not: null }, deletedAt: null },
  });

  const order = await prisma.order.create({
    data: {
      distributorId: 'dist-002',
      customerId: customer.id,
      orderNumber: `RIS2278-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: new Date(),
      deliveryDate: new Date(TEST_DATE),
      status: 'delivered',
      orderType: 'delivery',
      totalAmount: opts.deliveredQty * 2000,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          quantity: opts.orderedQty,
          deliveredQuantity: opts.deliveredQty,
          unitPrice: 2000,
          discountPerUnit: 0,
          totalPrice: opts.orderedQty * 2000,
        }],
      },
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: shortInvoiceNumber('INV-2278'),
      distributorId: 'dist-002',
      customerId: customer.id,
      orderId: order.id,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: opts.orderedQty * 2000,
      outstandingAmount: opts.orderedQty * 2000,
      irnStatus: 'success',
      ewbStatus: 'not_attempted',
      irn: 'irn_seed_' + Math.random().toString(36).slice(2, 8),
      ackNo: '11261000099',
      cgstValue: opts.orderedQty * 100,
      sgstValue: opts.orderedQty * 100,
      igstValue: 0,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          description: '19 KG',
          quantity: opts.orderedQty,
          unitPrice: 2000,
          discountPerUnit: 0,
          gstRate: 18,
          totalPrice: opts.orderedQty * 2000,
        }],
      },
    },
  });
  await prisma.gstDocument.create({
    data: {
      invoiceId: invoice.id,
      orderId: order.id,
      distributorId: 'dist-002',
      docType: 'INV',
      gstDocNo: invoice.invoiceNumber,
      irnStatus: 'success',
      irn: invoice.irn,
      ackNo: '11261000099',
      ewbStatus: 'not_attempted',
      isLatest: true,
    },
  });
  return { invoiceId: invoice.id, orderId: order.id, originalNumber: invoice.invoiceNumber };
}

async function teardown(orderId: string) {
  const invoices = await prisma.invoice.findMany({ where: { orderId }, select: { id: true } });
  const ids = invoices.map((i) => i.id);
  await prisma.invoiceRevision.deleteMany({ where: { invoiceId: { in: ids } } });
  await prisma.gstDocument.deleteMany({ where: { invoiceId: { in: ids } } });
  await prisma.pendingAction.deleteMany({ where: { entityId: { in: [orderId, ...ids] } } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } });
  await prisma.invoice.deleteMany({ where: { id: { in: ids } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
}

beforeEach(() => apiCallMock.mockReset());

describe('gstReissueService — WI-064 — 2278 trap + outstandingAmount + pre-bump', () => {
  let reissue: typeof import('../services/gst/gstReissueService.js').reissueForDeliveryMismatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstReissueService.js');
    reissue = mod.reissueForDeliveryMismatch;
  });

  it('Invoice number is bumped to -R1 BEFORE first regenerate (no NIC error)', async () => {
    const f = await seedB2bFixture({ orderedQty: 10, deliveredQty: 8 });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk()) // cancelIrn
        .mockResolvedValueOnce(irnSuccess()); // regen (sees fresh -R1 doc)
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      // WI-108: dist-002 has a docCode (SHD), so reissue allocates a fresh
      // STRUCTURED reissue number (e.g. RSHD2627000021) rather than the legacy
      // `${original}-R1` suffix bump. The invariant is unchanged — the number
      // is reallocated to something distinct from the original before regen.
      expect(inv.invoiceNumber).toMatch(/^R[A-Z]+\d+$/);
      expect(inv.invoiceNumber).not.toBe(f.originalNumber);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('2278 on first regen: catches and bumps again to -R2', async () => {
    const f = await seedB2bFixture({ orderedQty: 10, deliveredQty: 6 });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk())                                   // cancelIrn
        .mockRejectedValueOnce(whitebooksError('2278', 'IRN already generated and cancelled'))
        .mockResolvedValueOnce(irnSuccess());                                   // retry succeeds
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      // WI-108: structured reissue numbering — the pre-regen step allocates one
      // RSHD… number and the 2278 retry allocates another; the final number is a
      // fresh structured number distinct from the original (the legacy `-R2`
      // suffix no longer applies when the distributor has a docCode). The 2278
      // recovery is proven by the successful retry (irnStatus success + new irn).
      expect(inv.invoiceNumber).toMatch(/^R[A-Z]+\d+$/);
      expect(inv.invoiceNumber).not.toBe(f.originalNumber);
      expect(inv.irnStatus).toBe('success');
      expect(inv.irn).toMatch(/^irn_/);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('outstandingAmount is updated alongside totalAmount in reissue', async () => {
    const f = await seedB2bFixture({ orderedQty: 12, deliveredQty: 8 });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk())
        .mockResolvedValueOnce(irnSuccess());
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      // Delivered 8 × ₹2000 = ₹16,000
      expect(Number(inv.totalAmount)).toBe(16000);
      expect(Number(inv.outstandingAmount)).toBe(16000);
      // Sanity — without the fix, outstandingAmount would still equal
      // the ORDERED-quantity figure of 24000.
      expect(Number(inv.outstandingAmount)).not.toBe(24000);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Second 2278 after retry: surfaces as a HIGH pending action (no infinite loop)', async () => {
    const f = await seedB2bFixture({ orderedQty: 10, deliveredQty: 4 });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk())
        .mockRejectedValueOnce(whitebooksError('2278', 'cancelled'))
        .mockRejectedValueOnce(whitebooksError('2278', 'cancelled again'));
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      // Reissue returns ok:true because the revision row is still
      // written (the qty mutation is already committed before the regen
      // call; a HIGH pending action covers the IRN gap).
      expect(result.ok).toBe(true);
      const pa = await prisma.pendingAction.findFirst({
        where: { entityId: f.invoiceId, actionType: 'IRN_REGENERATION_FAILED' },
      });
      expect(pa).toBeTruthy();
      expect(pa?.severity).toBe('high');
      // outstandingAmount still updated to delivered total.
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      expect(Number(inv.totalAmount)).toBe(8000);
      expect(Number(inv.outstandingAmount)).toBe(8000);
    } finally {
      await teardown(f.orderId);
    }
  });
});
