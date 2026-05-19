/**
 * gst-reissue-inclusive-total.test.ts — WI-066
 *
 * Bug context: live invoices INV-MPC7ZDLXA-R1 and INV-MPC5L9751-R1
 * (created 2026-05-19) showed totalAmount=₹71,186.44 instead of the
 * expected GST-inclusive ₹84,000. Symptom: ₹84,000 / 1.18 = ₹71,186.44.
 *
 * Root cause: gstReissueService computed `lineTotal = newQty × (unitPrice − discount)`,
 * but for GST-enabled tenants invoiceService.createInvoiceFromOrder
 * stores the GST-BASE price in invoiceItem.unitPrice
 * (basePrice = inclusivePrice / 1.18). Multiplying base × qty produced
 * the BASE total instead of the customer-facing INCLUSIVE total.
 *
 * Fix (WI-066): derive lineTotal proportionally from the original
 * `item.totalPrice` (which is already inclusive at issue time):
 *   perUnitInclusive = originalTotalPrice / originalQty
 *   lineTotal        = newQty × perUnitInclusive
 *
 * This file uses a fixture that mirrors REAL PRODUCTION: unitPrice is
 * BASE, totalPrice is INCLUSIVE — distinct values, both verifiable. The
 * fixture in gst-reissue.test.ts / gst-reissue-2278.test.ts treats
 * unitPrice and totalPrice as unit-agnostic equal values; those tests
 * are correct as written but don't catch the unit-mismatch path.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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

const TEST_DATE = '2099-12-31';
const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

function irnSuccess() {
  return {
    status_cd: '1',
    data: {
      Irn: 'irn_' + Math.random().toString(36).slice(2, 10),
      AckNo: '112610000099999',
      AckDt: '15/05/2026 12:00:00 PM',
      SignedQRCode: 'eyJhbGciOi',
    },
  };
}
function irnCancelOk() {
  return { status_cd: '1', data: { CancelDate: '15/05/2026 01:00:00 PM' } };
}

function shortInvoiceNumber(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * Production-style fixture: GST-enabled tenant, unitPrice stored as
 * BASE, totalPrice stored as INCLUSIVE, distinct values you can eyeball
 * the arithmetic on. Mirrors what invoiceService.createInvoiceFromOrder
 * actually writes for a GST-enabled invoice.
 *
 *   inclusiveUnitPrice = 4200  (customer-facing per cylinder)
 *   basePriceUnit      = 4200 / 1.18 = 3559.32  (stored in unitPrice)
 *   totalPriceLine     = orderedQty * 4200      (stored in totalPrice)
 *   invoice.total      = orderedQty * 4200      (stored in totalAmount)
 *
 * Numbers chosen so 1.18 multiplier produces clean values:
 *   20 × 4200 = 84000 (inclusive grand total)
 *   84000 / 1.18 ≈ 71186.44 (the LIVE bug symptom)
 */
async function seedProductionStyleFixture(opts: { orderedQty: number; deliveredQty: number }) {
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: 'dist-002', typeName: '47.5 KG' },
  });
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', customerType: 'B2B', gstin: { not: null }, deletedAt: null },
  });
  const INCLUSIVE_UNIT = 4200;
  const BASE_UNIT = Math.round((INCLUSIVE_UNIT / 1.18) * 100) / 100; // 3559.32
  const lineInclusive = opts.orderedQty * INCLUSIVE_UNIT;
  const lineBase = Math.round(opts.orderedQty * BASE_UNIT * 100) / 100;
  const gst18 = Math.round((lineInclusive - lineBase) * 100) / 100;
  const cgst = Math.round((gst18 / 2) * 100) / 100;
  const sgst = gst18 - cgst;

  const order = await prisma.order.create({
    data: {
      distributorId: 'dist-002',
      customerId: customer.id,
      orderNumber: `RIS66-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: new Date(),
      deliveryDate: new Date(TEST_DATE),
      status: 'delivered',
      orderType: 'delivery',
      totalAmount: opts.deliveredQty * INCLUSIVE_UNIT,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          quantity: opts.orderedQty,
          deliveredQuantity: opts.deliveredQty,
          unitPrice: INCLUSIVE_UNIT, // order.unitPrice is the customer-facing inclusive price
          discountPerUnit: 0,
          totalPrice: opts.orderedQty * INCLUSIVE_UNIT,
        }],
      },
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: shortInvoiceNumber('INV-WI66'),
      distributorId: 'dist-002',
      customerId: customer.id,
      orderId: order.id,
      issueDate: new Date(),
      dueDate: new Date(),
      // CRITICAL: invoice.totalAmount is INCLUSIVE at issue time —
      // this is what invoiceService writes, and what the customer pays.
      totalAmount: lineInclusive,
      outstandingAmount: lineInclusive,
      irnStatus: 'success',
      ewbStatus: 'not_attempted',
      irn: 'irn_seed_' + Math.random().toString(36).slice(2, 8),
      ackNo: '11261000099',
      cgstValue: cgst,
      sgstValue: sgst,
      igstValue: 0,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          description: '47.5 KG',
          quantity: opts.orderedQty,
          // CRITICAL: invoiceItem.unitPrice is BASE (the bug-trigger).
          unitPrice: BASE_UNIT,
          discountPerUnit: 0,
          gstRate: 18,
          // CRITICAL: invoiceItem.totalPrice is INCLUSIVE.
          totalPrice: lineInclusive,
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
  return {
    invoiceId: invoice.id,
    orderId: order.id,
    INCLUSIVE_UNIT,
    BASE_UNIT,
    expectedInclusiveOnFullDelivery: lineInclusive,
  };
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

describe('gstReissueService — WI-066 — invoice.totalAmount stays GST-inclusive after reissue', () => {
  let reissue: typeof import('../services/gst/gstReissueService.js').reissueForDeliveryMismatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstReissueService.js');
    reissue = mod.reissueForDeliveryMismatch;
  });

  it('Full-quantity delivery: invoice.totalAmount equals INCLUSIVE × qty (₹84,000 for 20 × ₹4,200)', async () => {
    // Production scenario from the live bug: 20 cylinders ordered,
    // 20 delivered, inclusive per-cylinder ₹4,200 → inclusive grand
    // total ₹84,000. The legacy code wrote ₹71,186.44 (= ₹84,000 /
    // 1.18) because it multiplied the BASE unitPrice by qty.
    const f = await seedProductionStyleFixture({ orderedQty: 20, deliveredQty: 20 });
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
      expect(Number(inv.totalAmount)).toBe(84000);
      // The legacy BASE total ₹71,186.44 must NOT appear.
      expect(Number(inv.totalAmount)).not.toBe(71186.44);
      // outstandingAmount mirrors totalAmount (WI-064 invariant).
      expect(Number(inv.outstandingAmount)).toBe(84000);
      // invoiceItem.totalPrice also stays INCLUSIVE.
      const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      expect(Number(item.totalPrice)).toBe(84000);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Modified delivery (15 of 20): inclusive total scales proportionally to ₹63,000', async () => {
    // Same fixture, but driver delivers 15 of 20. Inclusive per-cyl =
    // ₹4,200, so revised total = 15 × ₹4,200 = ₹63,000. Legacy code
    // would have written 15 × ₹3,559.32 = ₹53,389.83 (BASE).
    const f = await seedProductionStyleFixture({ orderedQty: 20, deliveredQty: 15 });
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
      expect(Number(inv.totalAmount)).toBe(63000);
      expect(Number(inv.outstandingAmount)).toBe(63000);
      const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: f.invoiceId } });
      expect(Number(item.totalPrice)).toBe(63000);
      expect(item.quantity).toBe(15);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('GST split scales proportionally with inclusive total (no unit mismatch in CGST/SGST)', async () => {
    // 20 ordered, 12 delivered. Original CGST+SGST sum was the GST
    // portion of ₹84,000 inclusive. Revised split = original × (12/20).
    const f = await seedProductionStyleFixture({ orderedQty: 20, deliveredQty: 12 });
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
      // Total now ₹50,400 (12 × ₹4,200).
      expect(Number(inv.totalAmount)).toBe(50400);
      // GST split scaled by 12/20 = 0.6:
      //   originalCGST + originalSGST = 84000 - (20 × 3559.32) = 84000 − 71186.40 = 12813.60
      //   revisedCGST + revisedSGST ≈ 12813.60 × 0.6 = 7688.16
      const newCgst = Number(inv.cgstValue);
      const newSgst = Number(inv.sgstValue);
      const totalGst = newCgst + newSgst;
      // Allow ±1 paise for rounding across the two halves.
      expect(totalGst).toBeGreaterThan(7687);
      expect(totalGst).toBeLessThan(7690);
      // Importantly: base + GST ≈ inclusive total (within rounding).
      //   base for 12 cyl = 12 × 3559.32 = 42711.84
      //   base + GST     = 42711.84 + ~7688.16 = ~50400.00
      expect(totalGst + 12 * f.BASE_UNIT).toBeCloseTo(50400, 0);
    } finally {
      await teardown(f.orderId);
    }
  });

  it('Regression — production fixture would have stored ₹71,186.44 before the WI-066 fix', async () => {
    // This is a "white-box" regression: it documents the LEGACY
    // arithmetic so a future refactor that re-introduces the
    // multiply-by-base-unitPrice path is caught explicitly.
    //
    // legacy lineTotal = newQty × (BASE_UNIT - 0) = 20 × 3559.32 = 71186.40
    // The fix must NOT regress to that value when totalPrice is the
    // inclusive figure.
    const f = await seedProductionStyleFixture({ orderedQty: 20, deliveredQty: 20 });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnCancelOk())
        .mockResolvedValueOnce(irnSuccess());
      await reissue({
        invoiceId: f.invoiceId,
        distributorId: 'dist-002',
        userId: 'test-user',
      });
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
      // The diagnostic guard. If this fires, gstReissueService has
      // regressed to the unit-mismatch math.
      const stored = Number(inv.totalAmount);
      const legacyBaseTotal = Math.round(20 * f.BASE_UNIT * 100) / 100; // 71186.40
      expect(stored).not.toBe(legacyBaseTotal);
      expect(stored).toBe(84000);
    } finally {
      await teardown(f.orderId);
    }
  });
});
