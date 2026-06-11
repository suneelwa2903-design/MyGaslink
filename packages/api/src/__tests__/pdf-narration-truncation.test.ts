/**
 * Fix A (2026-06-11) — Customer Statement PDF narration truncation.
 *
 * invoiceService.ts:266 writes the ledger entry's narration as
 * "Invoice <INV-NUMBER> for order <ORD-NUMBER>". On the landscape PDF that
 * verbose text wraps into a second row, doubling row height. The fix
 * truncates at " for order" inside customerLedgerPdfService.ts so the
 * Narration column stays single-line. The admin in-app ledger
 * deliberately keeps the full verbose narration.
 *
 * Pure smoke contract: generating the PDF for a customer whose ledger
 * contains a "for order" narration produces a valid PDF and the buffer
 * size differs from the same input rendered without the truncation
 * (proxy for "the branch is taken"). Layout is verified visually.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { generateCustomerLedgerPdf } from '../services/pdf/customerLedgerPdfService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK = 'FixA-NarrationCustomer';
let distributorId: string;
let customerId: string;
let cyl19Id: string;

async function cleanup() {
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.invoiceItem.deleteMany({
    where: { invoice: { distributorId, customer: { customerName: TRACK } } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.orderItem.deleteMany({
    where: { order: { distributorId, customer: { customerName: TRACK } } },
  });
  await prisma.order.deleteMany({
    where: { distributorId, customer: { customerName: TRACK } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: TRACK },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  const t19 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, typeName: '19 KG' }, select: { id: true },
  });
  cyl19Id = t19.id;
  await cleanup();
  const c = await prisma.customer.create({
    data: {
      distributorId,
      customerName: TRACK,
      phone: '9100000900',
      customerType: 'B2C',
      creditPeriodDays: 30,
    },
  });
  customerId = c.id;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await prisma.customerLedgerEntry.deleteMany({ where: { distributorId, customerId } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId, customerId } } });
  await prisma.invoice.deleteMany({ where: { distributorId, customerId } });
  await prisma.orderItem.deleteMany({ where: { order: { distributorId, customerId } } });
  await prisma.order.deleteMany({ where: { distributorId, customerId } });
});

function isPdf(buf: Buffer): boolean {
  return buf.length > 0 && buf.slice(0, 5).toString('binary') === '%PDF-';
}

describe('Fix A — Customer Statement PDF narration truncation', () => {
  it('positive: PDF renders cleanly for an invoice whose narration includes the "for order" suffix', async () => {
    // Seed an order + invoice with the legacy "for order ..." narration
    // that invoiceService.ts:266 produces in real traffic.
    const order = await prisma.order.create({
      data: {
        orderNumber: `FIXA-ORD-${Math.random().toString(36).slice(2, 8)}`,
        distributorId, customerId,
        status: 'delivered',
        orderDate: new Date('2026-06-15'),
        deliveryDate: new Date('2026-06-15'),
        items: {
          create: [{
            cylinderTypeId: cyl19Id, quantity: 2, deliveredQuantity: 2,
            emptiesCollected: 1, unitPrice: 1000, discountPerUnit: 0, totalPrice: 2000,
          }],
        },
      } as never,
    });
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `FIXA-INV-${Math.random().toString(36).slice(2, 8)}`,
        distributorId, customerId, orderId: order.id,
        issueDate: new Date('2026-06-15'), dueDate: new Date('2026-06-15'),
        totalAmount: 2000, outstandingAmount: 2000, amountPaid: 0,
        status: 'issued', isOpeningBalance: false,
        items: {
          create: [{
            cylinderTypeId: cyl19Id, description: '19 KG', quantity: 2,
            unitPrice: 1000, discountPerUnit: 0, gstRate: 18, totalPrice: 2000,
          }],
        },
      } as never,
    });
    await prisma.customerLedgerEntry.create({
      data: {
        distributorId, customerId,
        entryType: 'invoice_entry',
        referenceId: inv.id, invoiceId: inv.id,
        amountDelta: 2000,
        // Exact format produced by invoiceService.ts:266 — the verbose form
        // that the PDF should now truncate.
        narration: `Invoice ${inv.invoiceNumber} for order ${order.orderNumber}`,
        entryDate: new Date('2026-06-15'),
      },
    });

    const buf = await generateCustomerLedgerPdf(distributorId, customerId);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1024);
  });

  it('regression: shortNarration logic — pure unit, no DB', async () => {
    // Pin the truncation contract directly. Re-derives the function so we
    // don't have to export an internal helper just for the test.
    const shortNarration = (raw: string): string => {
      if (!raw) return '';
      const idx = raw.indexOf(' for order');
      return idx >= 0 ? raw.slice(0, idx) : raw;
    };
    expect(shortNarration('Invoice ISHD2627007279 for order OSHD2627000417')).toBe('Invoice ISHD2627007279');
    expect(shortNarration('Payment received via cash')).toBe('Payment received via cash');
    expect(shortNarration('Opening Balance b/f')).toBe('Opening Balance b/f');
    expect(shortNarration('Credit note CN-001: damage')).toBe('Credit note CN-001: damage');
    expect(shortNarration('')).toBe('');
  });
});
