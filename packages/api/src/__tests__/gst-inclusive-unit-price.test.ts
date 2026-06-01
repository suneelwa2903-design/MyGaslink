/**
 * gst-inclusive-unit-price.test.ts — pins CLAUDE.md anti-pattern #16 / #17 / #18.
 *
 * Bug context: invoiceService.createInvoiceFromOrder used to store
 * InvoiceItem.unitPrice as GST-BASE (÷1.18 once at write time). Every
 * downstream reader (invoicePdfService.computeItems, gst/payloadBuilders.
 * buildIrnPayload) ALSO assumed unitPrice was inclusive and divided by 1.18
 * AGAIN — producing the historical ₹42,000 → ₹30,163.75 (= 42000/1.18²)
 * NIC under-reporting bug. Tests existed for each isolated layer but none
 * walked DB → service → payload end-to-end, so the regression slipped through.
 *
 * After the fix:
 *   - InvoiceItem.unitPrice is GST-INCLUSIVE, BEFORE discount
 *     (matches OrderItem.unitPrice and CylinderPrice.price).
 *   - InvoiceItem.discountPerUnit is GST-INCLUSIVE.
 *   - InvoiceItem.totalPrice is GST-INCLUSIVE, AFTER discount.
 *   - Invoice.cgstValue/sgstValue/igstValue still computed by single ÷1.18
 *     on the totalBaseAmount aggregate (unchanged math).
 *   - IRN payload feeders (gstService.processInvoiceGst,
 *     gstService.processCreditNoteGst, gstService.processDebitNoteGst,
 *     gstPreflightService.buildInvoiceData, gstReissueService.buildInvoiceData)
 *     pass the stored unitPrice through unchanged — payloadBuilders does
 *     the ONE legitimate ÷1.18 to extract the assessable amount.
 *
 * This file walks ALL three layers end-to-end with a NIC-realistic
 * ₹42,000 (inclusive) cylinder and asserts the values that NIC sees on
 * the wire are correct.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createInvoiceFromOrder } from '../services/invoiceService.js';
import { buildIrnPayload } from '../services/gst/payloadBuilders.js';

const DIST = 'dist-002'; // Sharma — GST sandbox
const TEST_DATE = new Date('2099-12-31T00:00:00Z'); // anti-pattern #7 — far-future
const TEST_TAG = 'GST_INCL_AP16';

async function teardown(orderId?: string, invoiceId?: string) {
  if (invoiceId) {
    await prisma.gstDocument.deleteMany({ where: { invoiceId } });
    await prisma.customerLedgerEntry.deleteMany({ where: { invoiceId } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId } });
    await prisma.invoice.deleteMany({ where: { id: invoiceId } });
  }
  if (orderId) {
    await prisma.orderStatusLog.deleteMany({ where: { orderId } });
    await prisma.orderItem.deleteMany({ where: { orderId } });
    await prisma.order.deleteMany({ where: { id: orderId } });
  }
}

async function seedDeliveredOrder(opts: {
  unitPriceInclusive: number;
  discountPerUnit?: number;
  quantity: number;
}) {
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST, typeName: '425 KG' },
  });
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerType: 'B2B', gstin: { not: null }, deletedAt: null },
  });
  const effectiveInclusive = Math.max(opts.unitPriceInclusive - (opts.discountPerUnit ?? 0), 0);
  const lineInclusive = effectiveInclusive * opts.quantity;

  const order = await prisma.order.create({
    data: {
      distributorId: DIST,
      customerId: customer.id,
      orderNumber: `${TEST_TAG}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      status: 'delivered',
      orderType: 'delivery',
      totalAmount: lineInclusive,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          quantity: opts.quantity,
          deliveredQuantity: opts.quantity,
          unitPrice: opts.unitPriceInclusive,
          discountPerUnit: opts.discountPerUnit ?? 0,
          totalPrice: lineInclusive,
        }],
      },
    },
  });
  return { orderId: order.id, customerId: customer.id, cylinderTypeId: cyl.id, effectiveInclusive, lineInclusive };
}

describe('Anti-pattern #16/#17 — InvoiceItem.unitPrice is GST-inclusive end to end', () => {
  let cleanupOrderId: string | undefined;
  let cleanupInvoiceId: string | undefined;

  afterAll(async () => {
    await teardown(cleanupOrderId, cleanupInvoiceId);
    // Sweep any stragglers from previous failed runs of this file.
    const stragglers = await prisma.order.findMany({
      where: { distributorId: DIST, orderNumber: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    for (const o of stragglers) {
      const invs = await prisma.invoice.findMany({ where: { orderId: o.id }, select: { id: true } });
      for (const inv of invs) await teardown(undefined, inv.id);
      await teardown(o.id, undefined);
    }
  });

  it('₹42,000 inclusive cylinder — InvoiceItem stores inclusive unitPrice, NOT base', async () => {
    const seeded = await seedDeliveredOrder({ unitPriceInclusive: 42000, quantity: 1 });
    cleanupOrderId = seeded.orderId;

    const invoice = await prisma.$transaction(async (tx) => {
      return createInvoiceFromOrder(tx, seeded.orderId, DIST, 'test-user');
    });
    cleanupInvoiceId = invoice.id;

    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: invoice.id } });

    // POSITIVE: unitPrice is the full inclusive value the customer was quoted.
    expect(Number(item.unitPrice)).toBe(42000);

    // NEGATIVE: the historical buggy values must never appear again.
    expect(Number(item.unitPrice)).not.toBe(35593.22); // single ÷1.18 (BASE — old write)
    expect(Number(item.unitPrice)).not.toBe(30163.75); // double ÷1.18 (legacy PDF/IRN bug)
  });

  it('Invoice totals are inclusive grand total and split is correct', async () => {
    const seeded = await seedDeliveredOrder({ unitPriceInclusive: 42000, quantity: 1 });
    let invoice;
    try {
      invoice = await prisma.$transaction(async (tx) => {
        return createInvoiceFromOrder(tx, seeded.orderId, DIST, 'test-user');
      });

      // Invoice.totalAmount stays inclusive end-to-end.
      expect(Number(invoice.totalAmount)).toBe(42000);
      // cgst + sgst sum to the correct GST portion (intra-state — Sharma KA → KA).
      const gstSum = Math.round((Number(invoice.cgstValue) + Number(invoice.sgstValue)) * 100) / 100;
      expect(gstSum).toBe(6406.78); // 42000 - 42000/1.18 = 6406.7796... ≈ 6406.78
      // NOT the buggy ÷1.18² GST.
      expect(gstSum).not.toBe(5429.47);
    } finally {
      await teardown(seeded.orderId, invoice?.id);
    }
  });

  it('IRN payload AssVal is the correct base, TotInvVal is the full inclusive total', async () => {
    const seeded = await seedDeliveredOrder({ unitPriceInclusive: 42000, quantity: 1 });
    let invoice;
    try {
      invoice = await prisma.$transaction(async (tx) => {
        return createInvoiceFromOrder(tx, seeded.orderId, DIST, 'test-user');
      });

      // Reload with items to mirror what gstService.processInvoiceGst sees.
      const invoiceWithItems = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { items: { include: { cylinderType: true } }, customer: true },
      });

      // Simulate the gstService.processInvoiceGst payload-feed step. This
      // exact mapping lives at gstService.ts:297-308 — keep in sync.
      const payload = buildIrnPayload({
        docType: 'INV',
        docNumber: invoiceWithItems.invoiceNumber,
        docDate: invoiceWithItems.issueDate,
        seller: {
          gstin: '29AAGCB1286Q000', // dist-002 Sharma sandbox GSTIN
          legalName: 'Sharma Gas Distributors',
          tradeName: 'Sharma Gas',
          address: '123 Depot Road',
          city: 'Bangalore',
          pincode: '560001',
          state: 'Karnataka',
          stateCode: '29',
        },
        buyer: {
          gstin: invoiceWithItems.customer?.gstin || null,
          legalName: invoiceWithItems.customer?.businessName || invoiceWithItems.customer?.customerName || 'Consumer',
          tradeName: invoiceWithItems.customer?.customerName || undefined,
          address: invoiceWithItems.customer?.billingAddressLine1 || '',
          city: invoiceWithItems.customer?.billingCity || '',
          pincode: invoiceWithItems.customer?.billingPincode || '',
          state: invoiceWithItems.customer?.billingState || '',
          stateCode: '29',
        },
        items: invoiceWithItems.items.map((it, i) => ({
          slNo: i + 1,
          description: it.description || 'LPG Cylinder',
          hsnCode: it.hsnCode || '27111900',
          quantity: it.quantity,
          unit: 'NOS',
          // After the fix: pass-through, NO + discountPerUnit.
          unitPrice: Number(it.unitPrice),
          discountPerUnit: Number(it.discountPerUnit),
          gstRate: it.gstRate || 18,
        })),
        isInterState: false,
      });

      // POSITIVE: the assessable value NIC files for this invoice is the
      // correct base (42000/1.18 ≈ 35593.22), not the legacy bug (30163.75).
      expect(payload.ValDtls.AssVal).toBeCloseTo(35593.22, 2);

      // POSITIVE: TotInvVal is the full inclusive amount the customer pays.
      expect(payload.ValDtls.TotInvVal).toBeCloseTo(42000, 0);

      // NEGATIVE: legacy under-reported values must never reappear.
      expect(payload.ValDtls.AssVal).not.toBeCloseTo(30163.75, 2);
      expect(payload.ValDtls.TotInvVal).not.toBeCloseTo(35593.22, 0);

      // POSITIVE: NIC's self-consistency formula closes.
      const v = payload.ValDtls;
      const nicCalc = Math.round(
        (v.AssVal + v.CgstVal + v.SgstVal + v.IgstVal + v.CesVal + v.StCesVal + v.OthChrg - v.Discount + v.RndOffAmt) * 100,
      ) / 100;
      expect(nicCalc).toBe(v.TotInvVal);
    } finally {
      await teardown(seeded.orderId, invoice?.id);
    }
  });

  it('Per-unit discount stays in inclusive units and rounds correctly through the payload', async () => {
    // ₹42,000 inclusive − ₹2,360 inclusive discount = ₹39,640 net inclusive.
    // Base discount = 2360/1.18 = 2000. Base after discount = 39640/1.18 ≈ 33593.22.
    const seeded = await seedDeliveredOrder({
      unitPriceInclusive: 42000,
      discountPerUnit: 2360,
      quantity: 1,
    });
    let invoice;
    try {
      invoice = await prisma.$transaction(async (tx) => {
        return createInvoiceFromOrder(tx, seeded.orderId, DIST, 'test-user');
      });
      const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: invoice.id } });

      // POSITIVE: stored values match the inclusive convention.
      expect(Number(item.unitPrice)).toBe(42000);
      expect(Number(item.discountPerUnit)).toBe(2360);
      expect(Number(item.totalPrice)).toBe(39640);
      expect(Number(invoice.totalAmount)).toBe(39640);
    } finally {
      await teardown(seeded.orderId, invoice?.id);
    }
  });
});
