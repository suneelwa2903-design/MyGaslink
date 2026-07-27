/**
 * Mini-op #7 (2026-07-27) — Quotation service guard tests.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import * as service from '../services/quotationService.js';
import { generateQuotationPdf } from '../services/pdf/quotationPdfService.js';

const DIST_ID = 'dist-001';
const OTHER_DIST_ID = 'dist-002';
const TEST_DATE = '2099-12-31';
const TEST_DATE_2 = '2099-12-30';

async function getUser(distributorId: string): Promise<string> {
  const u = await prisma.user.findFirst({
    where: { distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!u) throw new Error(`no user for ${distributorId}`);
  return u.id;
}

function samplePayload(overrides: Partial<Parameters<typeof service.createQuotation>[2]> = {}) {
  return {
    quotationDate: TEST_DATE,
    validUntil: TEST_DATE,
    customerId: null,
    recipientName: 'Test Recipient',
    recipientEmail: 'test@example.com',
    recipientContactPerson: null,
    recipientAddress: null,
    recipientCity: null,
    recipientState: null,
    recipientPincode: undefined,
    recipientPhone: null,
    recipientGstin: undefined,
    subject: 'Test subject',
    coverText: 'Test cover text',
    footerNotes: null,
    terms: ['Test term 1', 'Test term 2'],
    creditTerms: '30 days from date of invoice',
    gstRate: 0.05,
    items: [
      { kind: 'per_cylinder' as const, itemName: 'Test cyl', hsnCode: '27111900', unitPrice: 2150, discountPerUnit: 50 },
    ],
    ...overrides,
  } satisfies Parameters<typeof service.createQuotation>[2];
}

describe('Quotations (mini-op #7)', () => {
  let createdId = '';

  beforeAll(async () => {
    // Clean any leftovers from prior runs.
    await prisma.quotation.deleteMany({
      where: { distributorId: DIST_ID, subject: { in: ['Test subject', 'Test subject 2', 'Sample for PDF'] } },
    });
  });

  it('T1 — creates a quotation with auto-generated QUO-YYYY-NNN number', async () => {
    const userId = await getUser(DIST_ID);
    const q = await service.createQuotation(DIST_ID, userId, samplePayload());
    expect(q.quotationNumber).toMatch(/^QUO-\d{4}-\d{3}$/);
    expect(q.status).toBe('draft');
    expect(q.mode).toBe('per_cylinder');
    expect(q.items).toHaveLength(1);
    createdId = q.quotationId;
  });

  it('T2 — cross-tenant customerId rejected', async () => {
    const userId = await getUser(DIST_ID);
    const otherCust = await prisma.customer.findFirst({
      where: { distributorId: OTHER_DIST_ID, deletedAt: null },
      select: { id: true },
    });
    if (!otherCust) return; // skip when other tenant has no customers
    await expect(service.createQuotation(DIST_ID, userId,
      samplePayload({ customerId: otherCust.id }),
    )).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('T3 — mixed mode is derived when items span kinds', async () => {
    const userId = await getUser(DIST_ID);
    const q = await service.createQuotation(DIST_ID, userId, samplePayload({
      quotationDate: TEST_DATE_2,
      subject: 'Test subject 2',
      items: [
        { kind: 'per_cylinder', itemName: 'A', hsnCode: '27111900', unitPrice: 100, discountPerUnit: 0 },
        { kind: 'per_kg', itemName: 'B', hsnCode: '27111900', cylinderCapacityKg: 19, basicPricePerKg: 100, discountPerKg: 10 },
      ],
    }));
    expect(q.mode).toBe('mixed');
  });

  it('T4 — duplicate clones items + resets to draft with a fresh number', async () => {
    const userId = await getUser(DIST_ID);
    const clone = await service.duplicateQuotation(DIST_ID, userId, createdId, TEST_DATE);
    expect(clone.status).toBe('draft');
    expect(clone.duplicateFromId).toBe(createdId);
    expect(clone.quotationNumber).not.toBe('QUO-2099-001');
    expect(clone.items.length).toBeGreaterThan(0);
  });

  it('T5 — cannot edit or delete after mark-sent', async () => {
    const userId = await getUser(DIST_ID);
    const q = await service.createQuotation(DIST_ID, userId, samplePayload({ subject: 'Sample for PDF' }));
    await service.markSent(DIST_ID, q.quotationId);
    await expect(service.updateQuotation(DIST_ID, q.quotationId, { subject: 'edit' }))
      .rejects.toMatchObject({ code: 'NOT_EDITABLE' });
    await expect(service.deleteQuotation(DIST_ID, q.quotationId))
      .rejects.toMatchObject({ code: 'NOT_DELETABLE' });
  });

  it('T6 — PDF service returns a valid Buffer', async () => {
    const buf = await generateQuotationPdf(DIST_ID, createdId);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(2000);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
