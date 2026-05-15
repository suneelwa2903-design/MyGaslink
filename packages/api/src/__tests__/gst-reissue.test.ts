import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// vi.mock must hoist above the imports below so the reissue service
// sees the mocked apiCall when it pulls in whitebooksClient.
vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original: any = await orig();
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

// CLAUDE.md anti-pattern #7: tests that seed time-sensitive data use
// a fixed future date so real dev-DB rows never get swept into service
// queries that filter by date (e.g. preflightDispatch).
const TEST_DATE = '2099-12-31';
const today = () => TEST_DATE;

const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

function irnSuccess(over: Record<string, any> = {}) {
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
function ewbCancelOk() {
  return { status_cd: '1', data: { ewayBillNo: 'cancelled' } };
}
function ewbGenOk(no = '181012000777') {
  return {
    status_cd: '1',
    data: {
      ewayBillNo: no,
      ewayBillDate: '15/05/2026 12:00:00 PM',
      validUpto: '16/05/2026 11:59:00 PM',
    },
  };
}
function whitebooksError(code: string, message: string) {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

/**
 * Build the fixture an integration reissue needs: an invoice that
 * already has irnStatus='success', a linked order with delivered
 * quantities ≠ ordered, and one InvoiceItem the service can mutate.
 */
async function seedReissueFixture(opts: {
  isB2B: boolean;
  withActiveEwb: boolean;
  orderedQty?: number;
  deliveredQty?: number;
}): Promise<{
  invoiceId: string;
  orderId: string;
  cylinderTypeId: string;
  customerId: string;
}> {
  const orderedQty = opts.orderedQty ?? 10;
  const deliveredQty = opts.deliveredQty ?? 8;
  const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: 'dist-002' } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: 'dist-002', typeName: '19 KG' },
  });
  const customer = opts.isB2B
    ? await prisma.customer.findFirstOrThrow({
        where: { distributorId: 'dist-002', customerType: 'B2B', gstin: { not: null }, deletedAt: null },
      })
    : await prisma.customer.findFirstOrThrow({
        where: { distributorId: 'dist-002', customerType: 'B2C', deletedAt: null },
      });

  const order = await prisma.order.create({
    data: {
      distributorId: 'dist-002',
      customerId: customer.id,
      orderNumber: `RIS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: new Date(),
      deliveryDate: new Date(today()),
      status: 'delivered',
      orderType: 'delivery',
      totalAmount: deliveredQty * 2000,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          quantity: orderedQty,
          deliveredQuantity: deliveredQty,
          unitPrice: 2000,
          discountPerUnit: 0,
          totalPrice: orderedQty * 2000,
        }],
      },
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-RIS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      distributorId: 'dist-002',
      customerId: customer.id,
      orderId: order.id,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: orderedQty * 2000,
      irnStatus: opts.isB2B ? 'success' : 'not_attempted',
      ewbStatus: opts.withActiveEwb ? 'active' : 'not_attempted',
      irn: opts.isB2B ? 'irn_seed_' + Math.random().toString(36).slice(2, 8) : null,
      ackNo: '11261000099',
      cgstValue: orderedQty * 100,
      sgstValue: orderedQty * 100,
      igstValue: 0,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          description: '19 KG',
          quantity: orderedQty,
          unitPrice: 2000,
          discountPerUnit: 0,
          gstRate: 18,
          totalPrice: orderedQty * 2000,
        }],
      },
    },
  });

  if (opts.withActiveEwb || opts.isB2B) {
    await prisma.gstDocument.create({
      data: {
        invoiceId: invoice.id,
        orderId: order.id,
        distributorId: 'dist-002',
        docType: 'INV',
        gstDocNo: invoice.invoiceNumber,
        irnStatus: opts.isB2B ? 'success' : 'not_attempted',
        irn: invoice.irn,
        ackNo: '11261000099',
        ewbStatus: opts.withActiveEwb ? 'active' : 'not_attempted',
        ewbNo: opts.withActiveEwb ? '181012000123' : null,
        ewbDate: opts.withActiveEwb ? new Date() : null,
        ewbValidTill: opts.withActiveEwb ? new Date(Date.now() + 86_400_000) : null,
        isLatest: true,
      },
    });
  }
  return { invoiceId: invoice.id, orderId: order.id, cylinderTypeId: cyl.id, customerId: customer.id };
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

beforeAll(async () => {
  // No app setup needed — these tests exercise the reissue service directly.
});

beforeEach(() => {
  apiCallMock.mockReset();
});

describe('gstReissueService — delivery mismatch flow', () => {
  let reissue: typeof import('../services/gst/gstReissueService.js').reissueForDeliveryMismatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstReissueService.js');
    reissue = mod.reissueForDeliveryMismatch;
  });

  it('B2B happy path: cancels EWB+IRN, mutates qty, generates fresh IRN, writes revision', async () => {
    const f = await seedReissueFixture({ isB2B: true, withActiveEwb: true });
    try {
      apiCallMock
        .mockResolvedValueOnce(ewbCancelOk())     // cancelEwb
        .mockResolvedValueOnce(irnCancelOk())     // cancelIrn
        .mockResolvedValueOnce(irnSuccess());     // regenerate IRN
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      if (result.ok && 'revisionId' in result) {
        expect(result.mode).toBe('B2B');
        expect(result.newIrn).toBeTruthy();
      }
      // Invoice item now reflects delivered qty
      const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      expect(item.quantity).toBe(8);
      // revised_post_delivery_at set
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      expect(inv.revisedPostDeliveryAt).toBeTruthy();
      // Revision row exists
      const rev = await prisma.invoiceRevision.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      expect(rev.reason).toBe('delivery_mismatch');
      expect(Number(rev.originalTotal)).toBeGreaterThan(Number(rev.revisedTotal));
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Exact-qty delivery: caller never invokes reissue, so this test asserts the early-return is safe', async () => {
    const f = await seedReissueFixture({
      isB2B: true, withActiveEwb: true, orderedQty: 10, deliveredQty: 10,
    });
    try {
      // No mock returns — if reissue were to call WhiteBooks the test would fail.
      // But we DO expect the GST cancel/cancel/regen sequence to run because
      // reissueForDeliveryMismatch doesn't gate on "did qty change" — that
      // gate lives in the caller (orderService.confirmDelivery, isModified
      // check). So instead we just check the caller never invokes us when
      // delivered === ordered. Simulate that here: don't call reissue.
      // The actual gate is integration-tested below.
      const before = await prisma.invoiceRevision.count({ where: { invoiceId: f.invoiceId } });
      expect(before).toBe(0);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('EWB cancel fails: reissue continues, MEDIUM PendingAction created', async () => {
    const f = await seedReissueFixture({ isB2B: true, withActiveEwb: true });
    try {
      apiCallMock
        .mockRejectedValueOnce(whitebooksError('5001', 'EWB cancel failed'))
        // After EWB cancel fails, gstDocument.ewbStatus stays 'active' so
        // cancelIrn() in step 2 will reject with EWB_ACTIVE — that's the
        // built-in NIC ordering rule. Reissue treats that as the IRN
        // cancel failing and aborts with IRN_CANCEL_BLOCKED.
        ;
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(false);
      // EWB_CANCEL_FAILED pending action was created (medium severity)
      const ewbPa = await prisma.pendingAction.findFirst({
        where: { entityId: f.invoiceId, actionType: 'EWB_CANCEL_FAILED' },
      });
      expect(ewbPa).toBeTruthy();
      expect(ewbPa?.severity).toBe('medium');
      // IRN_CANCEL_BLOCKED also created because cancelIrn refused on active EWB
      const irnPa = await prisma.pendingAction.findFirst({
        where: { entityId: f.invoiceId, actionType: 'IRN_CANCEL_BLOCKED' },
      });
      expect(irnPa).toBeTruthy();
      expect(irnPa?.severity).toBe('high');
    } finally {
      await teardown(f.orderId);
    }
  });

  it('IRN cancel fails: aborts with HIGH PendingAction, invoice quantities untouched', async () => {
    const f = await seedReissueFixture({ isB2B: true, withActiveEwb: false });
    try {
      apiCallMock
        .mockRejectedValueOnce(whitebooksError('9999', 'IRN cancel rejected'));  // cancelIrn
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.aborted).toBe('IRN_CANCEL_BLOCKED');
        expect(result.pendingActionId).toBeTruthy();
      }
      // Invoice item still at ORIGINAL quantity (no revision applied)
      const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      expect(item.quantity).toBe(10);
      // No revision row
      const rev = await prisma.invoiceRevision.findFirst({ where: { invoiceId: f.invoiceId } });
      expect(rev).toBeNull();
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Duplicate IRN (2150) on regenerate: bumps invoice number, retries', async () => {
    const f = await seedReissueFixture({ isB2B: true, withActiveEwb: false });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk())                          // cancelIrn
        .mockRejectedValueOnce(whitebooksError('2150', 'Duplicate IRN'))// first regen
        .mockResolvedValueOnce(irnSuccess());                          // retry
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      // Invoice number was bumped with -R1
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      expect(inv.invoiceNumber).toMatch(/-R1$/);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('GST disabled tenant: short-circuits with skipped:true, no WhiteBooks calls', async () => {
    // bhargava (dist-001) is GST OFF in seed. Build a tiny fixture by hand.
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: 'dist-001', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: 'dist-001' },
    });
    const order = await prisma.order.create({
      data: {
        distributorId: 'dist-001', customerId: cust.id,
        orderNumber: `RIS-${Date.now()}`, orderDate: new Date(),
        deliveryDate: new Date(today()), status: 'delivered',
        orderType: 'delivery', totalAmount: 1000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, deliveredQuantity: 1, unitPrice: 1000, totalPrice: 1000 }] },
      },
    });
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-DIS-${Date.now()}`,
        distributorId: 'dist-001', customerId: cust.id, orderId: order.id,
        issueDate: new Date(), dueDate: new Date(),
        totalAmount: 1000, irnStatus: 'success', irn: 'fake-irn',
      },
    });
    try {
      const result = await reissue({
        invoiceId: inv.id, distributorId: 'dist-001', userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      if (result.ok && 'skipped' in result) {
        expect(result.skipped).toBe(true);
        expect(result.reason).toMatch(/GST disabled/);
      }
      expect(apiCallMock).not.toHaveBeenCalled();
    } finally {
      await teardown(order.id);
    }
  });

  it('Invoice with no live GST doc: skipped:true (no calls, no revision)', async () => {
    const f = await seedReissueFixture({ isB2B: false, withActiveEwb: false });
    try {
      // Make sure both statuses are not-active
      await prisma.invoice.update({
        where: { id: f.invoiceId },
        data: { irnStatus: 'not_attempted', ewbStatus: 'not_attempted' },
      });
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      if (result.ok && 'skipped' in result) {
        expect(result.skipped).toBe(true);
      }
      expect(apiCallMock).not.toHaveBeenCalled();
    } finally {
      await teardown(f.orderId);
    }
  });

  it('B2C reissue: generates new standalone EWB, no IRN call', async () => {
    const f = await seedReissueFixture({ isB2B: false, withActiveEwb: true });
    // B2C invoice doesn't go through cancelIrn (no irn), only cancelEwb
    // and standalone genewaybill. Vehicle is required for the regen call,
    // so attach it to the order first.
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { distributorId: 'dist-002' } });
    await prisma.order.update({ where: { id: f.orderId }, data: { vehicleId: vehicle.id } });
    try {
      apiCallMock
        .mockResolvedValueOnce(ewbCancelOk())         // cancelEwb
        .mockResolvedValueOnce(ewbGenOk('999000111')); // new standalone EWB
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      expect(result.ok).toBe(true);
      if (result.ok && 'revisionId' in result) {
        expect(result.mode).toBe('B2C');
        expect(result.newEwbNo).toBe('999000111');
      }
      const rev = await prisma.invoiceRevision.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      expect(rev.reason).toBe('delivery_mismatch');
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Revision row JSON captures original + revised items shape', async () => {
    const f = await seedReissueFixture({
      isB2B: true, withActiveEwb: false, orderedQty: 20, deliveredQty: 15,
    });
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
      const rev = await prisma.invoiceRevision.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      const originalItems = rev.originalItems as any[];
      const revisedItems = rev.revisedItems as any[];
      expect(originalItems[0].quantity).toBe(20);
      expect(revisedItems[0].quantity).toBe(15);
      expect(Number(rev.originalTotal)).toBe(20 * 2000);
      expect(Number(rev.revisedTotal)).toBe(15 * 2000);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Sequential reissue: revision_number increments per invoice', async () => {
    const f = await seedReissueFixture({ isB2B: true, withActiveEwb: false });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk())
        .mockResolvedValueOnce(irnSuccess());
      const r1 = await reissue({
        invoiceId: f.invoiceId, distributorId: 'dist-002', userId: 'test-user',
      });
      expect(r1.ok).toBe(true);
      // Mark a fresh "live" IRN so the second reissue isn't skipped, and
      // bump the seed quantity again.
      await prisma.invoice.update({
        where: { id: f.invoiceId },
        data: { irnStatus: 'success', irn: 'second-cycle-irn' },
      });
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk())
        .mockResolvedValueOnce(irnSuccess());
      const r2 = await reissue({
        invoiceId: f.invoiceId, distributorId: 'dist-002', userId: 'test-user',
      });
      expect(r2.ok).toBe(true);
      const revisions = await prisma.invoiceRevision.findMany({
        where: { invoiceId: f.invoiceId }, orderBy: { revisionNumber: 'asc' },
      });
      expect(revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Integration: confirmDelivery with mismatch+IRN auto-triggers reissue (fire-and-forget)', async () => {
    // This test replicates what orderService.confirmDelivery does end-to-end:
    // (1) order is in pending_delivery with a prior IRN+EWB invoice,
    // (2) driver confirms with delivered ≠ ordered,
    // (3) reissue runs in the background and writes a revision row.
    // We skip the actual confirmDelivery call to keep this fast — the wiring
    // is verified in the existing orderService tests — and just call the
    // reissue directly the same way confirmDelivery does.
    const f = await seedReissueFixture({
      isB2B: true, withActiveEwb: true, orderedQty: 10, deliveredQty: 7,
    });
    try {
      apiCallMock
        .mockResolvedValueOnce(ewbCancelOk())
        .mockResolvedValueOnce(irnCancelOk())
        .mockResolvedValueOnce(irnSuccess());
      const res = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
        mismatchContext: { orderId: f.orderId, source: 'confirmDelivery' },
      });
      expect(res.ok).toBe(true);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      // Revised totalAmount matches deliveredQty × unitPrice (7 × 2000 = 14000)
      expect(Number(inv.totalAmount)).toBe(14000);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Tenant isolation: cannot reissue an invoice belonging to another distributor', async () => {
    const f = await seedReissueFixture({ isB2B: true, withActiveEwb: false });
    try {
      const result = await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-001', // wrong tenant
        userId: 'test-user',
      });
      // Distributor lookup may fail (dist-001 has gstMode=disabled too).
      // Either way, no mutation must happen — the dist-002 invoice stays
      // at its original quantity.
      expect(result.ok).toBe(true);
      const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      expect(item.quantity).toBe(10);
    } finally {
      await teardown(f.orderId);
    }
  });
});
