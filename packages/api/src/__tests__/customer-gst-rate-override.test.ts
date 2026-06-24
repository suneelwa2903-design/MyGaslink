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
