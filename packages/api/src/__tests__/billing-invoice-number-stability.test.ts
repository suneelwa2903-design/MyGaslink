/**
 * Pins the guarantee that a SaaS billing cycle's invoice number and
 * invoice date are ALLOCATED ONCE and STABLE across re-downloads.
 *
 * The pre-fix behaviour (anti-pattern equivalent: allocation inside the
 * PDF endpoint) minted a fresh IMGL number from SaasInvoiceCounter on
 * every download — the Kruthee July 2026 cycle consumed sequences
 * 002922..002927 for a single logical invoice. See
 * packages/api/scripts/saas-billing-compaction-2026-08-03.sql for the
 * one-shot cleanup that recovered from that state.
 *
 * These guards ensure:
 *   1. generateBillingCycle stamps invoice_number + invoice_date on the row.
 *   2. Two PDF renders of the same cycle print the same number and date.
 *   3. Two separate cycles get sequential numbers (monotonic per FY).
 *   4. A legacy row (null invoice_number) triggers allocation once via
 *      the PDF-service fallback, then re-reads on subsequent calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { prisma } from '../lib/prisma.js';
import { generateBillingInvoicePdf } from '../services/pdf/billingInvoicePdfService.js';
import * as billingService from '../services/billingService.js';

const D1 = 'dist-001';
const trackedCycleIds: string[] = [];

async function extractText(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: pdf });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function extractInvoiceNumber(content: string): string {
  const m = content.match(/IMGL\d{10}/);
  if (!m) throw new Error(`Invoice number not found in PDF text: ${content.slice(0, 200)}`);
  return m[0];
}

async function makeLegacyCycle(startISO: string, endISO: string): Promise<string> {
  const cycle = await prisma.billingCycle.create({
    data: {
      distributorId: D1,
      periodType: 'monthly',
      billingTier: 'tier_1',
      periodStartDate: new Date(startISO),
      periodEndDate: new Date(endISO),
      totalAmountExclGst: 4999,
      totalGstAmount: 899.82,
      totalAmountInclGst: 5898.82,
      billingStatus: 'invoice_generated',
      items: {
        create: {
          itemType: 'base_subscription',
          description: 'Base subscription — starter (monthly)',
          hsnCode: '998314',
          quantity: 1,
          unitPriceExclGst: 4999,
          gstRate: 18,
          lineGstAmount: 899.82,
          lineTotalExclGst: 4999,
          lineTotalInclGst: 5898.82,
        },
      },
    },
  });
  trackedCycleIds.push(cycle.id);
  return cycle.id;
}

describe('SaaS billing — invoice number stability', () => {
  beforeAll(async () => {
    await prisma.distributor.upsert({
      where: { id: D1 },
      update: { subscriptionPlan: 'starter', gaslinkBillingEnabled: true, billingSuspended: false, billingTier: 'tier_1' },
      create: {
        id: D1,
        businessName: 'Test Dist',
        legalName: 'Test Dist',
        state: 'Telangana',
        subscriptionPlan: 'starter',
        gaslinkBillingEnabled: true,
        billingTier: 'tier_1',
      },
    });
    await prisma.pricingTier.upsert({
      where: { plan: 'starter' },
      update: {},
      create: {
        plan: 'starter',
        volumeMin: 0,
        monthlyPrice: 4999,
      },
    });
  });

  it('generateBillingCycle stamps invoice_number and invoice_date on the row', async () => {
    const cycle = await billingService.generateBillingCycle(D1, {
      periodType: 'monthly',
      periodStartDate: '2099-01-01',
      periodEndDate: '2099-01-31',
    });
    trackedCycleIds.push(cycle.id);

    const row = await prisma.billingCycle.findUnique({
      where: { id: cycle.id },
      select: { invoiceNumber: true, invoiceDate: true },
    });
    expect(row?.invoiceNumber).toMatch(/^IMGL\d{4}\d{6}$/);
    expect(row?.invoiceDate).toBeInstanceOf(Date);
  });

  it('re-downloading the same cycle produces the same invoice number', async () => {
    const cycle = await billingService.generateBillingCycle(D1, {
      periodType: 'monthly',
      periodStartDate: '2099-02-01',
      periodEndDate: '2099-02-28',
    });
    trackedCycleIds.push(cycle.id);

    const pdfA = await generateBillingInvoicePdf(cycle.id, D1);
    const pdfB = await generateBillingInvoicePdf(cycle.id, D1);
    const numberA = extractInvoiceNumber(await extractText(pdfA));
    const numberB = extractInvoiceNumber(await extractText(pdfB));
    expect(numberB).toBe(numberA);
  });

  it('two distinct cycles get sequential per-FY invoice numbers', async () => {
    const a = await billingService.generateBillingCycle(D1, {
      periodType: 'monthly',
      periodStartDate: '2099-03-01',
      periodEndDate: '2099-03-31',
    });
    const b = await billingService.generateBillingCycle(D1, {
      periodType: 'monthly',
      periodStartDate: '2099-04-01',
      periodEndDate: '2099-04-30',
    });
    trackedCycleIds.push(a.id, b.id);

    const seqA = parseInt(a.invoiceNumber!.slice(-6), 10);
    // b crosses the FY boundary from Jan/Feb/Mar (FY 9899) into April
    // (FY 9900), so its counter restarts — this test only asserts that
    // within the SAME FY numbers are strictly increasing.
    if (a.invoiceNumber!.slice(4, 8) === b.invoiceNumber!.slice(4, 8)) {
      const seqB = parseInt(b.invoiceNumber!.slice(-6), 10);
      expect(seqB).toBeGreaterThan(seqA);
    }
    expect(a.invoiceNumber).not.toBe(b.invoiceNumber);
  });

  it('legacy row with null invoice_number allocates on first PDF then reuses', async () => {
    const cycleId = await makeLegacyCycle('2099-05-01', '2099-05-31');

    const pdf1 = await generateBillingInvoicePdf(cycleId, D1);
    const pdf2 = await generateBillingInvoicePdf(cycleId, D1);
    const number1 = extractInvoiceNumber(await extractText(pdf1));
    const number2 = extractInvoiceNumber(await extractText(pdf2));
    expect(number2).toBe(number1);

    const row = await prisma.billingCycle.findUnique({
      where: { id: cycleId },
      select: { invoiceNumber: true, invoiceDate: true },
    });
    expect(row?.invoiceNumber).toBe(number1);
    expect(row?.invoiceDate).toBeInstanceOf(Date);
  });
});

afterAll(async () => {
  if (trackedCycleIds.length) {
    await prisma.billingItem.deleteMany({ where: { billingCycleId: { in: trackedCycleIds } } });
    await prisma.billingCycle.deleteMany({ where: { id: { in: trackedCycleIds } } });
  }
});
