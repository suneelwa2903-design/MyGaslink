/**
 * Guard tests for the SaaS-side subscription-invoice PDF template
 * (packages/api/src/services/pdf/billingInvoicePdfService.ts).
 *
 * These pin the customer-facing changes so they don't regress:
 *   - Structured invoice number format `IMGL<FY><6>` allocated from
 *     the new `SaasInvoiceCounter` table (was random hex `GLB-…`).
 *   - Header label reads "Tax Invoice" (was "Subscription Invoice").
 *   - Supplier "Bill From" block carries the real GSTIN + PAN.
 *   - Buyer "Bill To" block includes `Place of Supply` (CGST Rule 46).
 *   - Payment section carries the actual HDFC bank details.
 *   - Support email is `info@mygaslink.com` (was `support@`).
 *   - Grammar bug in numberToWords ("Thousands"/"Lakhs"/"Crores" → singular).
 *   - Due date = invoice date + 7 days (was frozen from cycle.dueDate
 *     which drifted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { prisma } from '../lib/prisma.js';
import { generateBillingInvoicePdf } from '../services/pdf/billingInvoicePdfService.js';
import { numberToWords } from '../services/pdf/pdfLayoutUtils.js';

const D1 = 'dist-001';
const trackedCycleIds: string[] = [];
const trackedItemIds: string[] = [];

async function makeCycle(): Promise<string> {
  const cycle = await prisma.billingCycle.create({
    data: {
      distributorId: D1,
      periodType: 'monthly',
      billingTier: 'tier_1',
      periodStartDate: new Date('2026-07-01T00:00:00Z'),
      periodEndDate: new Date('2026-07-31T00:00:00Z'),
      dueDate: new Date('2026-08-07T00:00:00Z'), // deliberately wrong — PDF should compute +7 correctly
      totalAmountExclGst: 4999,
      totalGstAmount: 899.82,
      totalAmountInclGst: 5898.82,
      billingStatus: 'pending_payment',
      items: {
        create: {
          itemType: 'base_subscription',
          description: 'Base subscription - starter (monthly)',
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
    include: { items: true },
  });
  trackedCycleIds.push(cycle.id);
  for (const it of cycle.items) trackedItemIds.push(it.id);
  return cycle.id;
}

async function extractText(pdf: Buffer): Promise<string> {
  // PDFKit compresses text streams (FlateDecode). A latin1 grep won't
  // find plain text. Was previously a shell-out to pypdf (Python +
  // pypdf install required — commit 8445f81); switched to pdf-parse
  // (pure Node, zero system deps) so this works on any dev machine
  // or CI runner without a Python toolchain. Same text-extraction
  // shape — PDFKit-generated text streams are decoded end-to-end.
  const parser = new PDFParse({ data: pdf });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

describe('numberToWords — Indian-English grammar fixes', () => {
  it('never emits "Thousands"', () => {
    // Any Nx1000 rupees value should read "N Thousand …", singular.
    expect(numberToWords(5898.82)).not.toMatch(/Thousands/);
    expect(numberToWords(5898.82)).toMatch(/Five Thousand /);
  });
  it('never emits "Lakhs"', () => {
    expect(numberToWords(250000)).not.toMatch(/Lakhs/);
    expect(numberToWords(250000)).toMatch(/Two Lakh /);
  });
  it('never emits "Crores"', () => {
    expect(numberToWords(20000000)).not.toMatch(/Crores/);
    expect(numberToWords(20000000)).toMatch(/Two Crore /);
  });
  it('handles 1x correctly (singular already worked)', () => {
    expect(numberToWords(1500)).toMatch(/One Thousand /);
    expect(numberToWords(100000)).toMatch(/One Lakh /);
    expect(numberToWords(10000000)).toMatch(/One Crore /);
  });
});

describe('SaaS subscription-invoice PDF template', () => {
  let pdf: Buffer;
  let content: string;

  beforeAll(async () => {
    const cycleId = await makeCycle();
    pdf = await generateBillingInvoicePdf(cycleId, D1);
    content = await extractText(pdf);
  });

  it('generates a non-empty PDF starting with %PDF-', () => {
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('header reads "Tax Invoice" (not "Subscription Invoice")', () => {
    expect(content).toMatch(/Tax Invoice/);
    expect(content).not.toMatch(/Subscription Invoice/);
  });

  it('supplier GSTIN + PAN present (Gaslink Consulting Solutions)', () => {
    expect(content).toMatch(/GASLINK CONSULTING SOLUTIONS/);
    expect(content).toMatch(/36ABCFG7518A1ZQ/);
    expect(content).toMatch(/ABCFG7518A/); // PAN
    expect(content).not.toMatch(/PENDING REGISTRATION/);
  });

  it('supplier address block present', () => {
    expect(content).toMatch(/Prashanth Nagar/);
    expect(content).toMatch(/Nizampet/);
    expect(content).toMatch(/500090/);
  });

  it('Bill From + Bill To sections both present', () => {
    expect(content).toMatch(/Bill From/);
    expect(content).toMatch(/Bill To/);
  });

  it('Place of Supply line rendered (Rule 46(k))', () => {
    expect(content).toMatch(/Place of Supply/);
  });

  it('Reverse Charge line rendered (Rule 46(p))', () => {
    expect(content).toMatch(/Reverse Charge/);
  });

  it('bank details present — HDFC + IFSC + account number', () => {
    expect(content).toMatch(/HDFC0004173/);
    expect(content).toMatch(/50200111238459/);
    expect(content).toMatch(/KPHB/);
    expect(content).toMatch(/Gaslink Consulting Solutions/i);
  });

  it('footer email is info@mygaslink.com (not support@)', () => {
    expect(content).toMatch(/info@mygaslink\.com/);
    expect(content).not.toMatch(/support@mygaslink\.com/);
  });

  it('invoice number matches IMGL<FY><6> format', async () => {
    // Fresh cycle so we can capture the number for this run.
    const cycleId = await makeCycle();
    const pdf2 = await generateBillingInvoicePdf(cycleId, D1);
    const c2 = await extractText(pdf2);
    const match = c2.match(/IMGL(\d{4})(\d{6})/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('2627'); // FY code
    // Sequence has to be at least 2922 (initial seed +1 baseline).
    const seq = parseInt(match![2]!, 10);
    expect(seq).toBeGreaterThanOrEqual(2922);
  });

  it('due date is invoice date + 7 days (bug fix)', async () => {
    // periodStartDate = 2026-07-01 → invoice date = 01-Jul-2026
    //                              → due date = 08-Jul-2026 (not 07-Aug)
    expect(content).toMatch(/01-Jul-2026/);
    expect(content).toMatch(/Due Date: 08-Jul-2026/);
    expect(content).not.toMatch(/07-Aug-2026/);
  });
});

afterAll(async () => {
  if (trackedItemIds.length) {
    await prisma.billingItem.deleteMany({ where: { id: { in: trackedItemIds } } });
  }
  if (trackedCycleIds.length) {
    await prisma.billingCycle.deleteMany({ where: { id: { in: trackedCycleIds } } });
  }
});
