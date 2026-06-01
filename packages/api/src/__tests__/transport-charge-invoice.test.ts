import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createInvoiceFromOrder } from '../services/invoiceService.js';

/**
 * Feature 1 — Inward Transport Charges (HSN 996511).
 *
 * createInvoiceFromOrder appends a second invoice line "Inward Transportation
 * Charges" when the customer has transportChargePerCylinder > 0. The fee is
 * GST-inclusive (mirrors cylinder rates) and 18% (SAC 996511). When the rate is
 * 0 no extra line is produced.
 *
 * dist-002 is the GST-sandbox tenant, so the invoice gets a CGST/SGST breakup
 * (intra-state when the customer billing state matches the distributor state).
 *
 * Anti-pattern #7: time-sensitive fixtures use a fixed far-future date so they
 * never collide with manual-test data on the shared dev DB.
 */
const DIST = 'dist-002';
const TEST_DATE = new Date('2099-12-31T00:00:00.000Z');
const createdCustomerIds: string[] = [];
const createdOrderIds: string[] = [];

async function makeDeliveredOrder(transportCharge: number, qty: number, unitPriceInclusive: number) {
  const distributor = await prisma.distributor.findUniqueOrThrow({ where: { id: DIST }, select: { state: true } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
  const customer = await prisma.customer.create({
    data: {
      distributorId: DIST,
      customerName: `TXP Test ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      phone: `9${String(Date.now()).slice(-9)}`,
      billingState: distributor.state, // intra-state ⇒ CGST/SGST
      transportChargePerCylinder: transportCharge,
    },
  });
  createdCustomerIds.push(customer.id);

  const order = await prisma.order.create({
    data: {
      orderNumber: `TXP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      distributorId: DIST,
      customerId: customer.id,
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      status: 'delivered',
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          quantity: qty,
          deliveredQuantity: qty,
          unitPrice: unitPriceInclusive,
          discountPerUnit: 0,
          totalPrice: unitPriceInclusive * qty,
        }],
      },
    },
  });
  createdOrderIds.push(order.id);
  return { order, customer, cyl };
}

afterAll(async () => {
  await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { orderId: { in: createdOrderIds } } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
});

describe('Feature 1 — transport charge on invoice', () => {
  it('zero transport charge → single cylinder line, no transport line', async () => {
    const { order } = await makeDeliveredOrder(0, 5, 1180);
    const invoice = await prisma.$transaction((tx) => createInvoiceFromOrder(tx, order.id, DIST, 'test-user'));
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id } });
    expect(items).toHaveLength(1);
    expect(items.some((i) => i.hsnCode === '996511')).toBe(false);
    // 5 × 1180 inclusive = 5900
    expect(Number(invoice.totalAmount)).toBeCloseTo(5900, 2);
  });

  it('non-zero transport charge → two lines, correct GST aggregates', async () => {
    // cylinder: 5 × 1180 incl (base 1000) ; transport: 118/cyl × 5 = 590 incl (base 100)
    const { order } = await makeDeliveredOrder(118, 5, 1180);
    const invoice = await prisma.$transaction((tx) => createInvoiceFromOrder(tx, order.id, DIST, 'test-user'));
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id } });
    expect(items).toHaveLength(2);

    const transport = items.find((i) => i.hsnCode === '996511');
    expect(transport).toBeDefined();
    expect(transport!.cylinderTypeId).toBeNull();
    expect(transport!.quantity).toBe(5);
    expect(Number(transport!.gstRate)).toBe(18);
    expect(Number(transport!.totalPrice)).toBeCloseTo(590, 2);
    // CLAUDE.md anti-pattern #16: InvoiceItem.unitPrice is GST-INCLUSIVE
    // (the customer-facing per-cylinder transport rate). Base = 100 is
    // derived by readers via a single /1.18, not stored.
    expect(Number(transport!.unitPrice)).toBeCloseTo(118, 2);

    // totals: inclusive 5900 + 590 = 6490
    expect(Number(invoice.totalAmount)).toBeCloseTo(6490, 2);
    // base 5000 + 500 = 5500 → CGST/SGST each 9% = 495
    expect(Number(invoice.cgstValue)).toBeCloseTo(495, 2);
    expect(Number(invoice.sgstValue)).toBeCloseTo(495, 2);
    expect(Number(invoice.igstValue)).toBeCloseTo(0, 2);
  });
});

describe('Feature 1 — payload IsServc for SAC services (HSN 996511)', () => {
  it("buildIrnPayload sets IsServc='Y' for 99xxxx HSN, 'N' otherwise", async () => {
    const { buildIrnPayload } = await import('../services/gst/payloadBuilders.js');
    const payload = buildIrnPayload({
      docType: 'INV',
      docNumber: 'INV-TXP-SHAPE',
      docDate: new Date('2026-05-15T00:00:00Z'),
      seller: { gstin: '29AAGCB1286Q000', legalName: 'Sharma Gas Distributors', tradeName: 'Sharma Gas', address: '123 Depot Road', city: 'Bangalore', pincode: '560001', state: 'Karnataka', stateCode: '29', phone: '9800000000', email: 'sharma@gasdist.com' },
      buyer: { gstin: '29AWGPV7107B1Z1', legalName: 'Maruthi Agencies', tradeName: 'Maruthi', address: '45 Customer Lane', city: 'Bangalore', pincode: '560041', state: 'Karnataka', stateCode: '29', phone: '9800000001', email: 'maruthi@example.com' },
      items: [
        { slNo: 1, description: '19 KG LPG Cylinder', hsnCode: '27111900', quantity: 5, unit: 'NOS', unitPrice: 1000, discountPerUnit: 0, gstRate: 18 },
        { slNo: 2, description: 'Inward Transportation Charges', hsnCode: '996511', quantity: 5, unit: 'NOS', unitPrice: 100, discountPerUnit: 0, gstRate: 18 },
      ],
      isInterState: false,
    });
    const cylItem = payload.ItemList.find((i) => i.HsnCd === '27111900');
    const transportItem = payload.ItemList.find((i) => i.HsnCd === '996511');
    expect(cylItem?.IsServc).toBe('N');
    expect(transportItem?.IsServc).toBe('Y');
  });
});
