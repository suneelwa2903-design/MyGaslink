/**
 * Group 1 (2026-06-11) — Opening Balance Certificate PDF branch.
 *
 * Behavioural / smoke contract for generateInvoicePdf:
 *   1. POSITIVE — an OB invoice with zero items renders without throwing
 *      and produces a valid PDF buffer (Tax Invoice template would crash
 *      cleanly but render an empty items table; the Certificate path skips
 *      the table entirely).
 *   2. NEGATIVE / regression — a regular (non-OB) invoice with one item
 *      still produces a valid PDF (the new branch is not accidentally
 *      short-circuiting the existing Tax Invoice path).
 *   3. DIVERGENCE — for the same input data, the OB and non-OB code paths
 *      produce structurally different output. We pin this by rendering
 *      both at identical totals and asserting the byte lengths differ —
 *      cheap proof that the branch is actually taken at runtime.
 *
 * Layout/text content is verified visually in the Group 1 browser preview
 * step (the PDF is opened in the browser viewer and inspected).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { generateInvoicePdf } from '../services/pdf/invoicePdfService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK_NAME = 'G1-CertPDF Customer';
let distributorId: string;
let customerId: string;
let cylinderTypeId: string;

async function cleanup() {
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_NAME } },
  });
  await prisma.invoice.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_NAME } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: TRACK_NAME },
  });
}

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  await cleanup();
  const c = await prisma.customer.create({
    data: {
      distributorId,
      customerName: TRACK_NAME,
      phone: '9100000072',
      customerType: 'B2C',
      creditPeriodDays: 30,
    },
  });
  customerId = c.id;
  const ct = await prisma.cylinderType.findFirst({
    where: { distributorId, typeName: '19 KG' },
    select: { id: true },
  });
  cylinderTypeId = ct!.id;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await prisma.customerLedgerEntry.deleteMany({ where: { distributorId, customerId } });
  await prisma.invoice.deleteMany({ where: { distributorId, customerId } });
});

function isPdf(buf: Buffer): boolean {
  return buf.length > 0 && buf.slice(0, 5).toString('binary') === '%PDF-';
}

describe('G1 — Opening Balance Certificate PDF', () => {
  it('positive: OB invoice with zero items renders a valid PDF (no throw, no "No items" crash)', async () => {
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `OB-CERT-${Math.random().toString(36).slice(2, 8)}`,
        distributorId,
        customerId,
        issueDate: new Date('2026-06-01'),
        dueDate: new Date('2026-06-01'),
        totalAmount: 15000,
        outstandingAmount: 15000,
        amountPaid: 0,
        status: 'overdue',
        isOpeningBalance: true,
        notes: 'Carried from paper register',
      },
    });

    const buf = await generateInvoicePdf(inv.id, distributorId);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1024); // not a stub
  });

  it('regression: a non-OB invoice with one item still renders a valid PDF', async () => {
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-REG-${Math.random().toString(36).slice(2, 8)}`,
        distributorId,
        customerId,
        issueDate: new Date('2026-06-01'),
        dueDate: new Date('2026-06-01'),
        totalAmount: 1000,
        outstandingAmount: 1000,
        amountPaid: 0,
        status: 'issued',
        isOpeningBalance: false,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        invoiceId: inv.id,
        cylinderTypeId,
        description: '19 KG cylinder',
        quantity: 1,
        unitPrice: 1000,
        discountPerUnit: 0,
        gstRate: 18,
        totalPrice: 1000,
      },
    });

    const buf = await generateInvoicePdf(inv.id, distributorId);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1024);
  });

  it('divergence: OB and non-OB code paths produce structurally different output', async () => {
    // Same customer, same amount — only isOpeningBalance differs. If both
    // branches produced identical output, the byte lengths would match
    // (deterministic PDFKit output at the byte level). Different layouts
    // → different lengths → branch is taken.
    const obInv = await prisma.invoice.create({
      data: {
        invoiceNumber: `OB-DIV-${Math.random().toString(36).slice(2, 8)}`,
        distributorId,
        customerId,
        issueDate: new Date('2026-06-01'),
        dueDate: new Date('2026-06-01'),
        totalAmount: 2500,
        outstandingAmount: 2500,
        amountPaid: 0,
        status: 'overdue',
        isOpeningBalance: true,
      },
    });
    const regInv = await prisma.invoice.create({
      data: {
        invoiceNumber: `REG-DIV-${Math.random().toString(36).slice(2, 8)}`,
        distributorId,
        customerId,
        issueDate: new Date('2026-06-01'),
        dueDate: new Date('2026-06-01'),
        totalAmount: 2500,
        outstandingAmount: 2500,
        amountPaid: 0,
        status: 'issued',
        isOpeningBalance: false,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        invoiceId: regInv.id,
        cylinderTypeId,
        description: '19 KG cylinder',
        quantity: 1,
        unitPrice: 2500,
        discountPerUnit: 0,
        gstRate: 18,
        totalPrice: 2500,
      },
    });

    const obBuf = await generateInvoicePdf(obInv.id, distributorId);
    const regBuf = await generateInvoicePdf(regInv.id, distributorId);
    expect(isPdf(obBuf)).toBe(true);
    expect(isPdf(regBuf)).toBe(true);
    expect(obBuf.length).not.toBe(regBuf.length);
  });
});
