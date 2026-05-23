/**
 * WI-108 — structured invoice/order numbering.
 *
 * Covers: FY calc, format, atomic + FY-reset sequencing, tenant isolation,
 * docCode-null fallback, truncateDocNumber throw, transaction rollback, and
 * the end-to-end number → NIC docNo path.
 *
 * Uses dedicated throwaway distributors (TESTW108-*) so the counters never
 * touch real tenants. GST mode stays 'disabled' so createManualInvoice's
 * fire-and-forget processInvoiceGst is a no-op (no sandbox calls).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { allocateNumber, getFinancialYear } from '../services/numberingService.js';
import { buildIrnPayload } from '../services/gst/payloadBuilders.js';
import { createManualInvoice } from '../services/invoiceService.js';

const D1 = 'TESTW108-D1';
const D2 = 'TESTW108-D2';
// 2026-05-23 is May 2026 → Indian FY 2026-27 → "2627" (April-start).
// (The WI brief's "→2526" example was a typo; its own algorithm + the
// 2026-04-01→2627 example confirm 2627 is correct.)
const DATE = new Date('2026-05-23');
const FY = '2627';

async function lastSeq(distributorId: string, type: string, fy: string): Promise<number> {
  const row = await prisma.invoiceCounter.findUnique({
    where: { distributorId_type_financialYear: { distributorId, type, financialYear: fy } },
    select: { lastSequence: true },
  });
  return row?.lastSequence ?? 0;
}

beforeAll(async () => {
  for (const [id, code] of [[D1, 'WAA'], [D2, 'WBB']] as const) {
    await prisma.distributor.upsert({
      where: { id },
      create: { id, businessName: `Test W108 ${id}`, legalName: `Test W108 ${id} Ltd`, gstMode: 'disabled', docCode: code },
      update: { docCode: code, gstMode: 'disabled' },
    });
  }
});

afterAll(async () => {
  await prisma.invoiceCounter.deleteMany({ where: { distributorId: { in: [D1, D2] } } });
  await prisma.customerLedgerEntry.deleteMany({ where: { distributorId: { in: [D1, D2] } } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId: { in: [D1, D2] } } } });
  await prisma.invoice.deleteMany({ where: { distributorId: { in: [D1, D2] } } });
  await prisma.customer.deleteMany({ where: { distributorId: { in: [D1, D2] } } });
  await prisma.distributor.deleteMany({ where: { id: { in: [D1, D2] } } });
});

describe('getFinancialYear (Apr–Mar Indian FY)', () => {
  it('2026-05-23 → 2627 (May 2026 = FY 2026-27)', () => expect(getFinancialYear(new Date('2026-05-23'))).toBe('2627'));
  it('2026-03-31 → 2526 (still FY 2025-26)', () => expect(getFinancialYear(new Date('2026-03-31'))).toBe('2526'));
  it('2026-04-01 → 2627 (new FY begins)', () => expect(getFinancialYear(new Date('2026-04-01'))).toBe('2627'));
  it('2027-01-15 → 2627', () => expect(getFinancialYear(new Date('2027-01-15'))).toBe('2627'));
});

describe('allocateNumber — format', () => {
  it('type I, code WAA, FY 2627, seq 1 → IWAA2627000001 (14 chars)', async () => {
    const n = await prisma.$transaction((tx) => allocateNumber(tx, D1, 'I', DATE, 'WAA'));
    expect(n).toBe('IWAA2627000001');
    expect(n).toHaveLength(14);
  });

  it('all 5 types produce a valid 14-char structured number', async () => {
    for (const t of ['R', 'C', 'D', 'O'] as const) {
      const n = await prisma.$transaction((tx) => allocateNumber(tx, D1, t, DATE, 'WAA'));
      expect(n).toMatch(/^[IRCDO]WAA2627\d{6}$/);
      expect(n).toHaveLength(14);
      expect(n[0]).toBe(t);
    }
  });

  it('rejects an invalid docCode (loud failure)', async () => {
    await expect(prisma.$transaction((tx) => allocateNumber(tx, D1, 'I', DATE, 'XX')))
      .rejects.toThrow(/3 uppercase letters/);
  });
});

describe('allocateNumber — sequencing', () => {
  it('increments atomically and resets for a new financial year', async () => {
    // Fresh type 'O' bucket already used above (seq 1); next is 2.
    const a = await prisma.$transaction((tx) => allocateNumber(tx, D1, 'O', DATE, 'WAA'));
    const b = await prisma.$transaction((tx) => allocateNumber(tx, D1, 'O', DATE, 'WAA'));
    expect(parseInt(b.slice(-6), 10)).toBe(parseInt(a.slice(-6), 10) + 1);

    // A different FY → sequence resets to 1 (prior-year date, fresh bucket).
    const nextFy = await prisma.$transaction((tx) => allocateNumber(tx, D1, 'O', new Date('2025-12-01'), 'WAA'));
    expect(nextFy).toBe('OWAA2526000001');
  });

  it('concurrent allocations yield distinct sequence numbers (no duplicates)', async () => {
    // Pre-seed the counter row so all concurrent calls hit the atomic update
    // path (the steady-state behaviour the counter guarantees).
    await prisma.$transaction((tx) => allocateNumber(tx, D2, 'I', DATE, 'WBB'));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => prisma.$transaction((tx) => allocateNumber(tx, D2, 'I', DATE, 'WBB'))),
    );
    expect(new Set(results).size).toBe(results.length); // all distinct
  });
});

describe('allocateNumber — tenant isolation', () => {
  it('two distributors keep independent sequences for the same type+FY', async () => {
    // Both D1 and D2 already have type 'I' rows; their sequences are unrelated.
    const seqD1 = await lastSeq(D1, 'I', FY);
    const seqD2 = await lastSeq(D2, 'I', FY);
    const nextD1 = await prisma.$transaction((tx) => allocateNumber(tx, D1, 'I', DATE, 'WAA'));
    // D2's counter is untouched by D1's allocation.
    expect(await lastSeq(D2, 'I', FY)).toBe(seqD2);
    expect(parseInt(nextD1.slice(-6), 10)).toBe(seqD1 + 1);
    expect(nextD1.startsWith('IWAA')).toBe(true);
  });
});

describe('allocateNumber — transaction rollback', () => {
  it('does NOT increment the counter when the surrounding transaction fails', async () => {
    const before = await lastSeq(D1, 'C', FY);
    await expect(
      prisma.$transaction(async (tx) => {
        await allocateNumber(tx, D1, 'C', DATE, 'WAA');
        throw new Error('boom — simulated invoice create failure');
      }),
    ).rejects.toThrow('boom');
    const after = await lastSeq(D1, 'C', FY);
    expect(after).toBe(before); // counter rolled back with the transaction
  });
});

describe('truncateDocNumber throws on > 16 chars (via buildIrnPayload)', () => {
  const minimalInvoiceData = (docNumber: string) => ({
    docType: 'INV' as const,
    docNumber,
    docDate: new Date('2026-05-23'),
    seller: { gstin: '29AAGCB1286Q000', legalName: 'S', tradeName: 'S', address: 'A', city: 'C', pincode: '560001', state: 'Karnataka', stateCode: '29' },
    buyer: { gstin: '29AWGPV7107B1Z1', legalName: 'B', tradeName: 'B', address: 'A', city: 'C', pincode: '560041', state: 'Karnataka', stateCode: '29' },
    items: [{ slNo: 1, description: 'LPG', hsnCode: '27111900', quantity: 1, unit: 'NOS', unitPrice: 2000, discountPerUnit: 0, gstRate: 18 }],
    isInterState: false,
  });

  it('a 14-char structured number is accepted', () => {
    const p = buildIrnPayload(minimalInvoiceData('IWAA2526000001'));
    expect(p.DocDtls.No).toBe('IWAA2526000001');
  });

  it('a 17-char number throws instead of silently truncating', () => {
    expect(() => buildIrnPayload(minimalInvoiceData('INV-TOOLONG-12345'))).toThrow(/16-char limit/);
  });
});

describe('end-to-end via createManualInvoice', () => {
  it('docCode set → structured number IWAA2627xxxxxx and it lands in the NIC docNo', async () => {
    const customer = await prisma.customer.create({
      data: { distributorId: D1, customerName: 'W108 Cust', phone: '9914208001', billingState: 'Karnataka', customerType: 'B2C' },
    });
    const inv = await createManualInvoice(D1, 'test-user', {
      customerId: customer.id,
      issueDate: '2026-05-23',
      dueDate: '2026-06-23',
      items: [{ description: '19 KG', quantity: 1, unitPrice: 2000, gstRate: 18 }],
    });
    expect(inv.invoiceNumber).toMatch(/^IWAA2627\d{6}$/);
    expect(inv.invoiceNumber).toHaveLength(14);

    // The structured number flows verbatim into NIC DocDtls.No.
    const payload = buildIrnPayload({
      docType: 'INV', docNumber: inv.invoiceNumber, docDate: new Date('2026-05-23'),
      seller: { gstin: '29AAGCB1286Q000', legalName: 'S', tradeName: 'S', address: 'A', city: 'C', pincode: '560001', state: 'Karnataka', stateCode: '29' },
      buyer: { gstin: '29AWGPV7107B1Z1', legalName: 'B', tradeName: 'B', address: 'A', city: 'C', pincode: '560041', state: 'Karnataka', stateCode: '29' },
      items: [{ slNo: 1, description: 'LPG', hsnCode: '27111900', quantity: 1, unit: 'NOS', unitPrice: 2000, discountPerUnit: 0, gstRate: 18 }],
      isInterState: false,
    });
    expect(payload.DocDtls.No).toBe(inv.invoiceNumber);
  });

  it('docCode null → legacy INV- format (structured numbering not activated)', async () => {
    await prisma.distributor.update({ where: { id: D2 }, data: { docCode: null } });
    const customer = await prisma.customer.create({
      data: { distributorId: D2, customerName: 'W108 Legacy Cust', phone: '9914208002', billingState: 'Karnataka', customerType: 'B2C' },
    });
    const inv = await createManualInvoice(D2, 'test-user', {
      customerId: customer.id,
      issueDate: '2026-05-23',
      dueDate: '2026-06-23',
      items: [{ description: '19 KG', quantity: 1, unitPrice: 2000, gstRate: 18 }],
    });
    expect(inv.invoiceNumber).toMatch(/^INV-/);
  });
});
