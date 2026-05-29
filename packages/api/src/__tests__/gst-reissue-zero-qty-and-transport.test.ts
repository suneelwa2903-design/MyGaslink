/**
 * gst-reissue-zero-qty-and-transport.test.ts
 *
 * Three guards against bugs surfaced live on 2026-05-28 (Maruthi
 * RSHD2627000659 + Bangalore Foods RSHD2627000660):
 *
 * 1. createInvoiceFromOrder MUST NOT push an invoice line for an order
 *    item with deliveredQuantity=0. A qty=0 line is visual noise on the
 *    PDF and a junk row in the IRN ItemList.
 *
 * 2. The reissue update loop MUST delete invoice items whose updated
 *    qty=0 (driver delivered nothing for that cylinder type).
 *
 * 3. The reissue update loop MUST recompute the transport-charge line
 *    (cylinderTypeId=null, HSN 996511) based on the revised delivered
 *    cylinder qty sum — not leave it stuck at the original ordered total.
 *    Live bug: order had 4 cylinders ordered → 3 delivered, but transport
 *    line stayed at qty=4 charging ₹200 for a cylinder never delivered.
 *
 * 4. The B2C reissue path MUST treat a NIC status_cd=1-without-ewayBillNo
 *    response as a failure (mark ewbStatus='failed', raise pending action).
 *    Live bug: same response shape produced an "active" green badge with
 *    ewbNo=NULL. Dispatch path got this guard in WI-091; the reissue path
 *    was missing it until this fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

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
import { createInvoiceFromOrder } from '../services/invoiceService.js';
import * as whitebooksClient from '../services/gst/whitebooksClient.js';

const DIST = 'dist-002';
const TEST_DATE = new Date('2099-12-31T00:00:00.000Z');
const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

const createdCustomerIds: string[] = [];
const createdOrderIds: string[] = [];

beforeEach(() => apiCallMock.mockReset());

afterAll(async () => {
  const invoices = await prisma.invoice.findMany({
    where: { orderId: { in: createdOrderIds } },
    select: { id: true },
  });
  const invoiceIds = invoices.map((i) => i.id);
  await prisma.invoiceRevision.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.gstDocument.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.pendingAction.deleteMany({ where: { entityId: { in: [...createdOrderIds, ...invoiceIds] } } });
  await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
});

async function makeCustomer(opts: { isB2C: boolean; transportRate?: number }) {
  const distributor = await prisma.distributor.findUniqueOrThrow({ where: { id: DIST }, select: { state: true } });
  const c = await prisma.customer.create({
    data: {
      distributorId: DIST,
      customerName: `ZeroQtyTest ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      phone: `9${String(Date.now()).slice(-9)}`,
      billingState: distributor.state,
      gstin: opts.isB2C ? null : '29AWGPV7107B1Z1',
      customerType: opts.isB2C ? 'B2C' : 'B2B',
      transportChargePerCylinder: opts.transportRate ?? 0,
    },
  });
  createdCustomerIds.push(c.id);
  return c;
}

async function makeOrder(opts: {
  customerId: string;
  lines: Array<{ typeName: string; ordered: number; delivered: number; unitPrice: number }>;
}) {
  const cylsByName = new Map<string, { id: string }>();
  for (const l of opts.lines) {
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: DIST, typeName: l.typeName },
      select: { id: true },
    });
    cylsByName.set(l.typeName, ct);
  }
  const orderTotal = opts.lines.reduce((s, l) => s + l.delivered * l.unitPrice, 0);
  const order = await prisma.order.create({
    data: {
      distributorId: DIST,
      customerId: opts.customerId,
      orderNumber: `ZQT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      status: 'delivered',
      orderType: 'delivery',
      totalAmount: orderTotal,
      items: {
        create: opts.lines.map((l) => ({
          cylinderTypeId: cylsByName.get(l.typeName)!.id,
          quantity: l.ordered,
          deliveredQuantity: l.delivered,
          unitPrice: l.unitPrice,
          discountPerUnit: 0,
          totalPrice: l.ordered * l.unitPrice,
        })),
      },
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

describe('createInvoiceFromOrder — zero-delivery line filter', () => {
  it('skips order items where deliveredQuantity=0 (no invoice line, no IRN row)', async () => {
    const customer = await makeCustomer({ isB2C: false, transportRate: 0 });
    const order = await makeOrder({
      customerId: customer.id,
      lines: [
        { typeName: '19 KG', ordered: 2, delivered: 2, unitPrice: 2000 },
        { typeName: '5 KG',  ordered: 2, delivered: 0, unitPrice: 600 }, // ← zero delivery
      ],
    });
    const invoice = await prisma.$transaction((tx) => createInvoiceFromOrder(tx, order.id, DIST, 'test-user'));
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id } });
    // Only the 19 KG line should exist; the 5 KG line should be filtered out.
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('19 KG');
    expect(items[0].quantity).toBe(2);
    // totalAmount must reflect ONLY the delivered line (2 × 2000 = 4000 inclusive).
    expect(Number(invoice.totalAmount)).toBeCloseTo(4000, 2);
  });

  it('transport line qty mirrors sum of delivered cylinder qtys (not ordered)', async () => {
    // Customer with transport ₹50/cyl. Ordered 4 total (3 of 19KG + 2 of 5KG = 5)
    // but driver delivers 2 of 19KG + 1 of 5KG = 3. Transport must be qty=3.
    const customer = await makeCustomer({ isB2C: false, transportRate: 50 });
    const order = await makeOrder({
      customerId: customer.id,
      lines: [
        { typeName: '19 KG', ordered: 3, delivered: 2, unitPrice: 2000 },
        { typeName: '5 KG',  ordered: 2, delivered: 1, unitPrice: 600 },
      ],
    });
    const invoice = await prisma.$transaction((tx) => createInvoiceFromOrder(tx, order.id, DIST, 'test-user'));
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id } });
    const transport = items.find((i) => i.hsnCode === '996511');
    expect(transport).toBeDefined();
    expect(transport!.quantity).toBe(3); // 2 + 1 delivered, not 3 + 2 ordered
    expect(Number(transport!.totalPrice)).toBeCloseTo(150, 2); // 3 × ₹50 inclusive
  });
});

describe('reissueForDeliveryMismatch — zero-qty deletion + transport recompute', () => {
  let reissue: typeof import('../services/gst/gstReissueService.js').reissueForDeliveryMismatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstReissueService.js');
    reissue = mod.reissueForDeliveryMismatch;
  });

  function irnCancelOk() { return { status_cd: '1', data: { CancelDate: '15/05/2026 01:00:00 PM' } }; }
  function ewbCancelOk() { return { status_cd: '1', data: { cancelDate: '15/05/2026 01:00:00 PM' } }; }
  function irnGenOk()    {
    return {
      status_cd: '1',
      data: {
        Irn: 'irn_' + Math.random().toString(36).slice(2, 10),
        AckNo: '11261000099',
        AckDt: '15/05/2026 12:00:00 PM',
        SignedQRCode: 'eyJhbGciOi',
      },
    };
  }
  function ewbGenOk(ewbNo: string) {
    return { status_cd: '1', data: { ewayBillNo: ewbNo, validUpto: '01/06/2026 11:59:00 PM' } };
  }
  /**
   * Seed a delivered order + ISHD invoice + gst_documents row in the
   * "post-dispatch, pre-reissue" state. Cylinder unitPrice stored as
   * GST-base (matches createInvoiceFromOrder convention for GST-enabled
   * tenants).
   */
  async function seedB2bReissueFixture(opts: {
    cylinderLines: Array<{ typeName: string; ordered: number; delivered: number; inclusiveUnitPrice: number }>;
    transportRate?: number;
  }) {
    const customer = await makeCustomer({ isB2C: false, transportRate: opts.transportRate ?? 0 });
    const ctByName = new Map<string, { id: string }>();
    for (const l of opts.cylinderLines) {
      ctByName.set(l.typeName, await prisma.cylinderType.findFirstOrThrow({
        where: { distributorId: DIST, typeName: l.typeName }, select: { id: true },
      }));
    }
    const orderedTotal = opts.cylinderLines.reduce((s, l) => s + l.ordered * l.inclusiveUnitPrice, 0)
      + (opts.transportRate ?? 0) * opts.cylinderLines.reduce((s, l) => s + l.ordered, 0);
    const order = await prisma.order.create({
      data: {
        distributorId: DIST,
        customerId: customer.id,
        orderNumber: `ZQT-RIS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: TEST_DATE,
        deliveryDate: TEST_DATE,
        status: 'delivered',
        orderType: 'delivery',
        totalAmount: orderedTotal,
        items: {
          create: opts.cylinderLines.map((l) => ({
            cylinderTypeId: ctByName.get(l.typeName)!.id,
            quantity: l.ordered,
            deliveredQuantity: l.delivered,
            unitPrice: l.inclusiveUnitPrice,
            discountPerUnit: 0,
            totalPrice: l.ordered * l.inclusiveUnitPrice,
          })),
        },
      },
    });
    createdOrderIds.push(order.id);

    // Build the ISHD invoice items (ordered-qty snapshot, pre-reissue).
    const totalOrderedQty = opts.cylinderLines.reduce((s, l) => s + l.ordered, 0);
    const invoiceItems = opts.cylinderLines.map((l) => ({
      cylinderTypeId: ctByName.get(l.typeName)!.id,
      description: l.typeName,
      hsnCode: '27111900',
      quantity: l.ordered,
      // unitPrice = BASE (matches createInvoiceFromOrder convention)
      unitPrice: Math.round((l.inclusiveUnitPrice / 1.18) * 100) / 100,
      discountPerUnit: 0,
      gstRate: 18,
      // totalPrice = INCLUSIVE
      totalPrice: l.ordered * l.inclusiveUnitPrice,
    }));
    if (opts.transportRate) {
      invoiceItems.push({
        cylinderTypeId: null as unknown as string, // transport line has null cylinderTypeId
        description: 'Inward Transportation Charges',
        hsnCode: '996511',
        quantity: totalOrderedQty, // ← ordered total (the bug we're fixing)
        unitPrice: Math.round((opts.transportRate / 1.18) * 100) / 100,
        discountPerUnit: 0,
        gstRate: 18,
        totalPrice: opts.transportRate * totalOrderedQty,
      });
    }
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-ZQT-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        distributorId: DIST,
        customerId: customer.id,
        orderId: order.id,
        issueDate: new Date(),
        dueDate: new Date(),
        totalAmount: orderedTotal,
        outstandingAmount: orderedTotal,
        irnStatus: 'success',
        ewbStatus: 'active',
        irn: 'irn_seed_' + Math.random().toString(36).slice(2, 8),
        ackNo: '11261000099',
        cgstValue: Math.round((orderedTotal * 9 / 118) * 100) / 100,
        sgstValue: Math.round((orderedTotal * 9 / 118) * 100) / 100,
        igstValue: 0,
        items: { create: invoiceItems },
      },
    });
    await prisma.gstDocument.create({
      data: {
        invoiceId: invoice.id, orderId: order.id, distributorId: DIST,
        docType: 'INV', gstDocNo: invoice.invoiceNumber,
        irnStatus: 'success', irn: invoice.irn,
        ewbStatus: 'active', ewbNo: 'EWB_SEED_' + Math.random().toString(36).slice(2, 6),
        isLatest: true,
      },
    });
    return { invoiceId: invoice.id, orderId: order.id };
  }

  it('Zero-delivery line on a cylinder type is DELETED from the invoice on reissue', async () => {
    // Ordered: 19KG × 2, 5KG × 2. Delivered: 19KG × 2, 5KG × 0.
    // Expected after reissue: invoice has the 19 KG line; 5 KG line is gone.
    const f = await seedB2bReissueFixture({
      cylinderLines: [
        { typeName: '19 KG', ordered: 2, delivered: 2, inclusiveUnitPrice: 2000 },
        { typeName: '5 KG',  ordered: 2, delivered: 0, inclusiveUnitPrice: 600 },
      ],
    });
    apiCallMock
      .mockResolvedValueOnce(ewbCancelOk())  // cancelEwb
      .mockResolvedValueOnce(irnCancelOk())  // cancelIrn
      .mockResolvedValueOnce(irnGenOk())     // regenerate IRN
      .mockResolvedValueOnce(ewbGenOk('EWB_NEW_1')); // regenerate EWB
    const result = await reissue({ invoiceId: f.invoiceId, distributorId: DIST, userId: 'test-user' });
    expect(result.ok).toBe(true);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: f.invoiceId } });
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('19 KG');
    expect(items[0].quantity).toBe(2);
    // No 5 KG line should remain.
    expect(items.find((i) => i.description === '5 KG')).toBeUndefined();
  });

  it('Transport-charge line qty recomputes to delivered cylinder total on reissue', async () => {
    // Ordered 5 cylinders, delivered 3. Transport at ₹50/cyl inclusive.
    // Pre-reissue invoice: transport qty=5 (ordered), totalPrice=250.
    // Post-reissue: transport qty=3 (delivered), totalPrice=150.
    const f = await seedB2bReissueFixture({
      transportRate: 50,
      cylinderLines: [
        { typeName: '19 KG', ordered: 3, delivered: 2, inclusiveUnitPrice: 2000 },
        { typeName: '5 KG',  ordered: 2, delivered: 1, inclusiveUnitPrice: 600 },
      ],
    });
    apiCallMock
      .mockResolvedValueOnce(ewbCancelOk())
      .mockResolvedValueOnce(irnCancelOk())
      .mockResolvedValueOnce(irnGenOk())
      .mockResolvedValueOnce(ewbGenOk('EWB_NEW_2'));
    const result = await reissue({ invoiceId: f.invoiceId, distributorId: DIST, userId: 'test-user' });
    expect(result.ok).toBe(true);
    const transport = await prisma.invoiceItem.findFirst({
      where: { invoiceId: f.invoiceId, hsnCode: '996511' },
    });
    expect(transport).toBeDefined();
    expect(transport!.quantity).toBe(3); // 2 + 1 delivered, NOT 3 + 2 = 5 ordered
    expect(Number(transport!.totalPrice)).toBeCloseTo(150, 2); // 3 × ₹50
  });

  it('Transport line is DELETED if every cylinder line was zero-delivered (defensive)', async () => {
    // Edge case: one cylinder type ordered, zero delivered, transport on customer.
    // Note: real zero-delivery hits the WI-112 void path BEFORE pass 2 runs,
    // so this guards the defensive transport-delete branch if any code path
    // ever bypasses that void. Seed with one cylinder line at qty=1 ordered,
    // 1 delivered — keep that — then add a SECOND line at 1 ordered / 0
    // delivered to exercise the partial-delete path together with transport
    // recompute.
    const f = await seedB2bReissueFixture({
      transportRate: 50,
      cylinderLines: [
        { typeName: '19 KG', ordered: 1, delivered: 1, inclusiveUnitPrice: 2000 },
        { typeName: '5 KG',  ordered: 1, delivered: 0, inclusiveUnitPrice: 600 },
      ],
    });
    apiCallMock
      .mockResolvedValueOnce(ewbCancelOk())
      .mockResolvedValueOnce(irnCancelOk())
      .mockResolvedValueOnce(irnGenOk())
      .mockResolvedValueOnce(ewbGenOk('EWB_NEW_3'));
    const result = await reissue({ invoiceId: f.invoiceId, distributorId: DIST, userId: 'test-user' });
    expect(result.ok).toBe(true);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: f.invoiceId }, orderBy: { description: 'asc' } });
    // Expect 2 lines: 19 KG (qty=1), and transport (qty=1 — only the delivered cyl).
    const desc = items.map((i) => i.description).sort();
    expect(desc).toEqual(['19 KG', 'Inward Transportation Charges']);
    const transport = items.find((i) => i.hsnCode === '996511');
    expect(transport!.quantity).toBe(1);
    expect(Number(transport!.totalPrice)).toBeCloseTo(50, 2);
  });
});

describe('B2C reissue EWB — phantom-active guard (WI-091-equivalent)', () => {
  let reissue: typeof import('../services/gst/gstReissueService.js').reissueForDeliveryMismatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstReissueService.js');
    reissue = mod.reissueForDeliveryMismatch;
  });
  function ewbCancelOk() { return { status_cd: '1', data: { cancelDate: '15/05/2026 01:00:00 PM' } }; }
  function ewbGenPhantomSuccess() {
    return { status_cd: '1', status_desc: 'Sucess', data: {} };
  }

  async function seedB2cReissueFixture() {
    const customer = await makeCustomer({ isB2C: true });
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: DIST, typeName: '19 KG' }, select: { id: true },
    });
    const order = await prisma.order.create({
      data: {
        distributorId: DIST, customerId: customer.id,
        orderNumber: `ZQT-B2C-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: TEST_DATE, deliveryDate: TEST_DATE, status: 'delivered', orderType: 'delivery',
        totalAmount: 1800,
        items: {
          create: [{
            cylinderTypeId: ct.id, quantity: 2, deliveredQuantity: 1,
            unitPrice: 1800, discountPerUnit: 0, totalPrice: 3600,
          }],
        },
      },
    });
    createdOrderIds.push(order.id);
    // Need a vehicle on the order for B2C EWB reissue (it reads vehicleNumber).
    // Pin to valid plate KA01-MN-9999 so vehicle-plate regex (payloadBuilders)
    // doesn't reject stale TEST-XX rows in shared dev DB.
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { distributorId: DIST, vehicleNumber: 'KA01-MN-9999' }, select: { id: true } });
    await prisma.order.update({ where: { id: order.id }, data: { vehicleId: vehicle.id } });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `ISHD-B2C-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        distributorId: DIST, customerId: customer.id, orderId: order.id,
        issueDate: new Date(), dueDate: new Date(),
        totalAmount: 3600, outstandingAmount: 3600,
        irnStatus: 'not_attempted', // B2C: no IRN
        ewbStatus: 'active',
        cgstValue: 0, sgstValue: 0, igstValue: 0,
        items: {
          create: [{
            cylinderTypeId: ct.id, description: '19 KG', hsnCode: '27111900',
            quantity: 2, unitPrice: Math.round((1800 / 1.18) * 100) / 100,
            discountPerUnit: 0, gstRate: 18, totalPrice: 3600,
          }],
        },
      },
    });
    await prisma.gstDocument.create({
      data: {
        invoiceId: invoice.id, orderId: order.id, distributorId: DIST,
        docType: 'INV', gstDocNo: invoice.invoiceNumber,
        irnStatus: 'not_attempted',
        ewbStatus: 'active', ewbNo: 'EWB_OLD_B2C',
        isLatest: true,
      },
    });
    return { invoiceId: invoice.id, orderId: order.id };
  }

  it('Phantom-success (status_cd=1, no ewayBillNo): invoice ewbStatus=failed, pending action raised', async () => {
    const f = await seedB2cReissueFixture();
    apiCallMock
      .mockResolvedValueOnce(ewbCancelOk())          // cancel old EWB
      .mockResolvedValueOnce(ewbGenPhantomSuccess()); // regenerate B2C EWB returns no number
    const result = await reissue({ invoiceId: f.invoiceId, distributorId: DIST, userId: 'test-user' });
    expect(result.ok).toBe(true);

    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
    // The phantom-active guard MUST flip ewbStatus to 'failed' and not write a NIC number.
    expect(inv.ewbStatus).toBe('failed');

    // The new latest gst_documents row reflects the phantom failure.
    const latest = await prisma.gstDocument.findFirst({
      where: { invoiceId: f.invoiceId, isLatest: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest).toBeDefined();
    expect(latest!.ewbStatus).toBe('failed');
    expect(latest!.ewbNo).toBeNull();

    // Exactly one gst_documents row should have isLatest=true (atomic-cutover guard).
    const latestCount = await prisma.gstDocument.count({
      where: { invoiceId: f.invoiceId, isLatest: true },
    });
    expect(latestCount).toBe(1);

    // A pending EWB_GENERATION action must exist for this invoice.
    const pa = await prisma.pendingAction.findFirst({
      where: { entityId: f.invoiceId, actionType: 'EWB_GENERATION', status: 'open' },
    });
    expect(pa).toBeDefined();
    expect(pa!.severity).toBe('high');
  });
});
