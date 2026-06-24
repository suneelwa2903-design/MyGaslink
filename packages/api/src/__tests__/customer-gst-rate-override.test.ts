/**
 * Customer-level GST rate override (5% / 18%).
 *
 * Covers the per-customer-eligibility model: a 5%-eligible food-service
 * customer (hotel/restaurant/canteen) has Customer.gstRateOverride=5; their
 * invoices price every line at 5% (CGST 2.5 + SGST 2.5 intra, IGST 5 inter).
 * Default customers carry gstRateOverride=null and bill at 18%.
 *
 * Tests use dist-002 (Sharma — Karnataka, GST-LIVE) because createInvoiceFromOrder's
 * GST-aware path only fires when distributor.gstMode is sandbox or live.
 * Per-invoice cleanup at afterAll keeps the dev DB tidy (CLAUDE.md anti-pattern #7
 * — fixtures use far-future TEST_DATE so they never sweep into real-data buckets).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createCustomerSchema } from '@gaslink/shared';
import { createManualInvoice, createInvoiceFromOrder } from '../services/invoiceService.js';
import { buildIrnPayload, buildEwbPayload } from '../services/gst/payloadBuilders.js';
import { getCustomerLedger } from '../services/paymentService.js';

const D2 = 'dist-002';
const TEST_DATE = '2099-12-31';

// Track everything we create so afterAll can hard-clean — no leakage into
// the shared dev DB which the manual testing track also uses.
const trackedCustomerIds: string[] = [];
const trackedInvoiceIds: string[] = [];
const trackedOrderIds: string[] = [];

async function makeCustomer(
  name: string,
  overrides: { gstRateOverride?: number | null; billingState?: string } = {},
) {
  const c = await prisma.customer.create({
    data: {
      distributorId: D2,
      customerName: name,
      phone: `9${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, '0')}`,
      customerType: 'B2C',
      billingState: overrides.billingState ?? 'Karnataka',
      gstRateOverride: overrides.gstRateOverride ?? null,
    },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

beforeAll(async () => {
  // Ensure dist-002 has GST enabled and is in Karnataka (matches seed).
  const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: D2 } });
  if (dist.gstMode === 'disabled' || dist.state !== 'Karnataka') {
    await prisma.distributor.update({
      where: { id: D2 },
      data: { gstMode: dist.gstMode === 'disabled' ? 'sandbox' : dist.gstMode, state: 'Karnataka' },
    });
  }
});

afterAll(async () => {
  if (trackedInvoiceIds.length) {
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
    await prisma.customerLedgerEntry.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: trackedInvoiceIds } } });
  }
  if (trackedOrderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedCustomerIds.length) {
    await prisma.customer.deleteMany({ where: { id: { in: trackedCustomerIds } } });
  }
});

describe('createManualInvoice — customer GST rate override fallback', () => {
  it('customer with no override → item gstRate falls back to 18', async () => {
    const customer = await makeCustomer('OvrTest A — default');
    const inv = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      items: [{ description: '19 KG', quantity: 1, unitPrice: 1000 }], // no per-item rate
    });
    trackedInvoiceIds.push(inv.id);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
    expect(items).toHaveLength(1);
    expect(items[0]!.gstRate).toBe(18);
  });

  it('customer with gstRateOverride=5 → item gstRate falls back to 5', async () => {
    const customer = await makeCustomer('OvrTest B — 5pct fallback', { gstRateOverride: 5 });
    const inv = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      items: [{ description: '19 KG', quantity: 1, unitPrice: 1000 }],
    });
    trackedInvoiceIds.push(inv.id);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
    expect(items[0]!.gstRate).toBe(5);
  });

  it('customer 5%, intra-state → CGST 2.5 + SGST 2.5, IGST 0', async () => {
    // distributor in Karnataka, customer in Karnataka → intra.
    const customer = await makeCustomer('OvrTest C — 5pct intra', {
      gstRateOverride: 5,
      billingState: 'Karnataka',
    });
    const inv = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      // 1000 base × 5% = 50 total tax → CGST 25 + SGST 25.
      items: [{ description: '19 KG', quantity: 1, unitPrice: 1000 }],
    });
    trackedInvoiceIds.push(inv.id);
    expect(Number(inv.cgstValue)).toBe(25);
    expect(Number(inv.sgstValue)).toBe(25);
    expect(Number(inv.igstValue)).toBe(0);
  });

  it('customer 5%, inter-state → IGST 5, CGST 0, SGST 0', async () => {
    // distributor in Karnataka, customer in Telangana → inter.
    const customer = await makeCustomer('OvrTest D — 5pct inter', {
      gstRateOverride: 5,
      billingState: 'Telangana',
    });
    const inv = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      items: [{ description: '19 KG', quantity: 1, unitPrice: 1000 }],
    });
    trackedInvoiceIds.push(inv.id);
    expect(Number(inv.cgstValue)).toBe(0);
    expect(Number(inv.sgstValue)).toBe(0);
    expect(Number(inv.igstValue)).toBe(50);
  });

  it('customer 5%, manual invoice with explicit item rate 18 → caller wins (line stored at 18)', async () => {
    const customer = await makeCustomer('OvrTest E — caller wins', { gstRateOverride: 5 });
    const inv = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      items: [{ description: '19 KG', quantity: 1, unitPrice: 1000, gstRate: 18 }],
    });
    trackedInvoiceIds.push(inv.id);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
    expect(items[0]!.gstRate).toBe(18);
    // Aggregate reflects the per-line rate, not the customer override.
    expect(Number(inv.cgstValue)).toBe(90);
    expect(Number(inv.sgstValue)).toBe(90);
  });
});

describe('createInvoiceFromOrder — customer GST rate override drives item rate', () => {
  it('customer with gstRateOverride=5 → all delivered-order invoice items carry gstRate=5', async () => {
    // Pick any cylinder type belonging to dist-002.
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D2, isActive: true },
    });
    const customer = await makeCustomer('OvrTest F — 5pct order', {
      gstRateOverride: 5,
      billingState: 'Karnataka',
    });
    // Build a delivered order with one line.
    const order = await prisma.order.create({
      data: {
        distributorId: D2,
        customerId: customer.id,
        orderNumber: `ORDOVR-${Date.now().toString(36)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'delivered',
        totalAmount: 1180,
        items: {
          create: [{
            cylinderTypeId: ct.id, quantity: 1, deliveredQuantity: 1,
            unitPrice: 1050, discountPerUnit: 0, totalPrice: 1050,
          }],
        },
      },
    });
    trackedOrderIds.push(order.id);

    const inv = await prisma.$transaction((tx) =>
      createInvoiceFromOrder(tx, order.id, D2, 'test-user'),
    );
    trackedInvoiceIds.push(inv.id);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.gstRate).toBe(5);
    }
    // 1050 inclusive / 1.05 = 1000 base; CGST 25 + SGST 25 intra.
    expect(Number(inv.cgstValue)).toBeCloseTo(25, 1);
    expect(Number(inv.sgstValue)).toBeCloseTo(25, 1);
    expect(Number(inv.igstValue)).toBe(0);
  });
});

describe('createCustomerSchema — gstRateOverride validation', () => {
  const validBody = {
    customerName: 'X',
    phone: '9876543210',
  };

  it('rejects gstRateOverride: 12 (not in ALLOWED_GST_RATES)', () => {
    const res = createCustomerSchema.safeParse({ ...validBody, gstRateOverride: 12 });
    expect(res.success).toBe(false);
  });

  it('accepts gstRateOverride: null (omitted / explicit default)', () => {
    const res = createCustomerSchema.safeParse({ ...validBody, gstRateOverride: null });
    expect(res.success).toBe(true);
  });

  it('accepts gstRateOverride: 5', () => {
    const res = createCustomerSchema.safeParse({ ...validBody, gstRateOverride: 5 });
    expect(res.success).toBe(true);
  });

  it('accepts gstRateOverride: 18', () => {
    const res = createCustomerSchema.safeParse({ ...validBody, gstRateOverride: 18 });
    expect(res.success).toBe(true);
  });
});

// ─── End-to-end payload assertions ──────────────────────────────────────────
//
// These cover the silent-bug class fixed in Phase 3.5: payloadBuilders.ts
// previously hardcoded CGST_RATE=9 / SGST_RATE=9 / GST_RATE=18 inside the
// IRN's CgstAmt/SgstAmt calc, so a 5%-line would have shipped the wrong
// rate label AND the wrong tax amount to NIC. Asserting both directly
// prevents a re-regression.

describe('IRN payload — per-line rate flows through end-to-end', () => {
  const seller = {
    gstin: '29AAGCB1286Q000', legalName: 'Sharma Gas', tradeName: 'Sharma',
    address: 'Depot Road', city: 'Bangalore', pincode: '560001',
    state: 'Karnataka', stateCode: '29',
  };
  const buyerIntra = {
    gstin: '29AWGPV7107B1Z1', legalName: 'Royal Kitchen', tradeName: 'Royal',
    address: '5 Brigade Rd', city: 'Bangalore', pincode: '560041',
    state: 'Karnataka', stateCode: '29',
  };
  const buyerInter = {
    gstin: '36AAMFH8885N1ZA', legalName: 'Hyd Caterer', tradeName: 'HC',
    address: '12 Ameerpet', city: 'Hyderabad', pincode: '500016',
    state: 'Telangana', stateCode: '36',
  };
  const makeItem = (gstRate: number) => ({
    slNo: 1, description: '19 KG', hsnCode: '27111900', quantity: 1,
    unit: 'NOS', unitPrice: 1000 * (1 + gstRate / 100), discountPerUnit: 0,
    gstRate,
  });

  it('5% intra-state IRN: GstRt=5, CgstAmt=base×0.025, SgstAmt=base×0.025, IgstAmt=0', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TEST5INTRA1', docDate: new Date('2099-12-31'),
      seller, buyer: buyerIntra, items: [makeItem(5)], isInterState: false,
    });
    const it0 = p.ItemList[0]!;
    expect(it0.GstRt).toBe(5);
    expect(it0.AssAmt).toBeCloseTo(1000, 1);
    expect(it0.CgstAmt).toBeCloseTo(25, 1); // 1000 × 2.5%
    expect(it0.SgstAmt).toBeCloseTo(25, 1);
    expect(it0.IgstAmt).toBe(0);
  });

  it('5% inter-state IRN: GstRt=5, IgstAmt=base×0.05, CGST=SGST=0', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TEST5INTER1', docDate: new Date('2099-12-31'),
      seller, buyer: buyerInter, items: [makeItem(5)], isInterState: true,
    });
    const it0 = p.ItemList[0]!;
    expect(it0.GstRt).toBe(5);
    expect(it0.IgstAmt).toBeCloseTo(50, 1); // 1000 × 5%
    expect(it0.CgstAmt).toBe(0);
    expect(it0.SgstAmt).toBe(0);
  });

  it('18% intra-state IRN (regression): GstRt=18, CGST=base×0.09, SGST=base×0.09', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TEST18INTRA', docDate: new Date('2099-12-31'),
      seller, buyer: buyerIntra, items: [makeItem(18)], isInterState: false,
    });
    const it0 = p.ItemList[0]!;
    expect(it0.GstRt).toBe(18);
    expect(it0.AssAmt).toBeCloseTo(1000, 1);
    expect(it0.CgstAmt).toBeCloseTo(90, 1);
    expect(it0.SgstAmt).toBeCloseTo(90, 1);
  });
});

describe('EWB payload — per-line rate labels flow through end-to-end', () => {
  const seller = {
    gstin: '29AAGCB1286Q000', legalName: 'Sharma Gas', tradeName: 'Sharma',
    address: 'Depot Road', city: 'Bangalore', pincode: '560001',
    state: 'Karnataka', stateCode: '29',
  };
  const buyerIntra = {
    gstin: '29AWGPV7107B1Z1', legalName: 'Royal Kitchen', tradeName: 'Royal',
    address: '5 Brigade Rd', city: 'Bangalore', pincode: '560041',
    state: 'Karnataka', stateCode: '29',
  };

  it('5% intra-state EWB itemList: cgstRate=2.5, sgstRate=2.5, igstRate=0', () => {
    const irn = buildIrnPayload({
      docType: 'INV', docNumber: 'TEST5EWB1', docDate: new Date('2099-12-31'),
      seller, buyer: buyerIntra,
      items: [{ slNo: 1, description: '19 KG', hsnCode: '27111900', quantity: 1, unit: 'NOS', unitPrice: 1050, discountPerUnit: 0, gstRate: 5 }],
      isInterState: false,
    });
    const ewb = buildEwbPayload(irn, { vehicleNumber: 'KA01AB1234', transportMode: '1', distance: 5 });
    const line0 = (ewb as unknown as { itemList: { cgstRate: number; sgstRate: number; igstRate: number }[] }).itemList[0]!;
    expect(line0.cgstRate).toBe(2.5);
    expect(line0.sgstRate).toBe(2.5);
    expect(line0.igstRate).toBe(0);
  });

  it('18% intra-state EWB (regression): cgstRate=9, sgstRate=9, igstRate=0', () => {
    const irn = buildIrnPayload({
      docType: 'INV', docNumber: 'TEST18EWB', docDate: new Date('2099-12-31'),
      seller, buyer: buyerIntra,
      items: [{ slNo: 1, description: '19 KG', hsnCode: '27111900', quantity: 1, unit: 'NOS', unitPrice: 1180, discountPerUnit: 0, gstRate: 18 }],
      isInterState: false,
    });
    const ewb = buildEwbPayload(irn, { vehicleNumber: 'KA01AB1234', transportMode: '1', distance: 5 });
    const line0 = (ewb as unknown as { itemList: { cgstRate: number; sgstRate: number; igstRate: number }[] }).itemList[0]!;
    expect(line0.cgstRate).toBe(9);
    expect(line0.sgstRate).toBe(9);
    expect(line0.igstRate).toBe(0);
  });
});

describe('Snapshot semantics — mid-life rate change does NOT affect historic invoices', () => {
  it('customer billed at 18%, then flipped to 5% → next invoice is 5%, prior invoice stays 18%', async () => {
    const customer = await makeCustomer('OvrTest G — mid-life switch', {
      gstRateOverride: null,
      billingState: 'Karnataka',
    });
    // 1st invoice while customer is at default 18%.
    const inv1 = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      items: [{ description: '19 KG', quantity: 1, unitPrice: 1000 }],
    });
    trackedInvoiceIds.push(inv1.id);
    const items1 = await prisma.invoiceItem.findMany({ where: { invoiceId: inv1.id } });
    expect(items1[0]!.gstRate).toBe(18);

    // Operator flips the customer to 5%.
    await prisma.customer.update({
      where: { id: customer.id },
      data: { gstRateOverride: 5 },
    });

    // 2nd invoice should pick up the new rate.
    const inv2 = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      items: [{ description: '19 KG', quantity: 1, unitPrice: 1000 }],
    });
    trackedInvoiceIds.push(inv2.id);
    const items2 = await prisma.invoiceItem.findMany({ where: { invoiceId: inv2.id } });
    expect(items2[0]!.gstRate).toBe(5);

    // 1st invoice's line MUST still be 18 — the snapshot semantics rule.
    const items1Refetch = await prisma.invoiceItem.findMany({ where: { invoiceId: inv1.id } });
    expect(items1Refetch[0]!.gstRate).toBe(18);
  });
});

describe('Ledger narration — shows live invoice number, not stale text', () => {
  it('reissue path: ledger narration uses CURRENT invoice.invoiceNumber, not the frozen string', async () => {
    const customer = await makeCustomer('OvrTest H — ledger live num', {
      billingState: 'Karnataka',
    });
    // Issue an invoice via the order path so a customerLedgerEntry exists.
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D2, isActive: true },
    });
    const order = await prisma.order.create({
      data: {
        distributorId: D2,
        customerId: customer.id,
        orderNumber: `ORDLNUM-${Date.now().toString(36)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'delivered',
        totalAmount: 1180,
        items: {
          create: [{
            cylinderTypeId: ct.id, quantity: 1, deliveredQuantity: 1,
            unitPrice: 1180, discountPerUnit: 0, totalPrice: 1180,
          }],
        },
      },
    });
    trackedOrderIds.push(order.id);
    const inv = await prisma.$transaction((tx) =>
      createInvoiceFromOrder(tx, order.id, D2, 'test-user'),
    );
    trackedInvoiceIds.push(inv.id);

    const originalNumber = inv.invoiceNumber;
    // Sanity: ledger row shows the original number.
    const ledger0 = await getCustomerLedger(D2, customer.id);
    const invoiceRow0 = ledger0.rows.find((r) => r.kind === 'invoice');
    expect(invoiceRow0?.narration).toBe(`Invoice ${originalNumber}`);

    // Simulate a reissue: flip invoice.invoiceNumber from ISHD… → RSHD…
    // exactly the way gstReissueService.freshRevisionNumber does it.
    const newNumber = originalNumber.startsWith('I')
      ? 'R' + originalNumber.slice(1)
      : originalNumber + '-R1';
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { invoiceNumber: newNumber },
    });

    // Ledger MUST now reflect the new number — even though
    // customerLedgerEntry.narration is still the frozen original.
    const ledger1 = await getCustomerLedger(D2, customer.id);
    const invoiceRow1 = ledger1.rows.find((r) => r.kind === 'invoice');
    expect(invoiceRow1?.narration).toBe(`Invoice ${newNumber}`);
    expect(invoiceRow1?.narration).not.toContain(originalNumber);
  });
});
