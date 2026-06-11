/**
 * Phase 5 — GSTR-1 export columns.
 *
 * Three surfaces under test:
 *
 *  1. STATE_CODE_BY_NAME + deriveStateCode helper — covers GSTIN-prefix
 *     wins over billingState, billingState fallback, and the genuine
 *     "can't tell" → null path. Pure unit tests.
 *
 *  2. Schema migration — every new column is readable on the Prisma
 *     client (regression guard so a future schema edit can't silently
 *     drop them). Uses a fresh in-test Invoice / InvoiceItem / CreditNote
 *     trio rather than seed data so the test is self-contained.
 *
 *  3. Backfill script source guards — pins the dry-run-by-default
 *     contract + the customerGstinSnapshot opt-out clause. The script
 *     itself runs against a shared dev DB so we don't exercise it here;
 *     the contract pins protect the user-visible safety guarantees.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../lib/prisma.js';
import {
  STATE_CODE_BY_NAME,
  deriveStateCode,
} from '@gaslink/shared';

const TEST_DIST = 'dist-001';

describe('Phase 5 — shared STATE_CODE_BY_NAME', () => {
  it('contains every well-known Indian state with a 2-digit code', () => {
    expect(STATE_CODE_BY_NAME['Karnataka']).toBe('29');
    expect(STATE_CODE_BY_NAME['Maharashtra']).toBe('27');
    expect(STATE_CODE_BY_NAME['Telangana']).toBe('36');
    // Andhra Pradesh appears twice in INDIAN_STATES (codes 28 + 37);
    // the canonical post-2014 code wins (lower number).
    expect(STATE_CODE_BY_NAME['Andhra Pradesh']).toBe('28');
  });

  it('returns valid 2-digit codes for every entry', () => {
    for (const code of Object.values(STATE_CODE_BY_NAME)) {
      expect(code).toMatch(/^\d{2}$/);
    }
  });
});

describe('Phase 5 — deriveStateCode helper', () => {
  it('prefers GSTIN-prefix over billingState (the GSTIN is the legal source of truth)', () => {
    expect(deriveStateCode('36AAACA1234A1Z5', 'Karnataka')).toBe('36');
  });

  it('falls back to billingState when GSTIN is absent', () => {
    expect(deriveStateCode(null, 'Karnataka')).toBe('29');
    expect(deriveStateCode(undefined, 'Telangana')).toBe('36');
  });

  it('falls back to billingState when GSTIN is malformed (no leading digits)', () => {
    expect(deriveStateCode('URP', 'Maharashtra')).toBe('27');
  });

  it('returns null when neither input determines the place of supply', () => {
    expect(deriveStateCode(null, null)).toBeNull();
    expect(deriveStateCode(undefined, undefined)).toBeNull();
    expect(deriveStateCode('', '')).toBeNull();
  });

  it('returns null for unknown billingState names rather than guessing', () => {
    expect(deriveStateCode(null, 'Atlantis')).toBeNull();
  });
});

describe('Phase 5 — schema columns reachable from Prisma client', () => {
  // Use a fresh row in a far-future test bucket (anti-pattern #7) so
  // we don't touch real seed/test invoices.
  let invoiceId: string;
  const FAR_FUTURE = new Date('2099-12-30');

  beforeAll(async () => {
    // Use a real seeded customer to satisfy the FK.
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: TEST_DIST, deletedAt: null },
    });
    const created = await prisma.invoice.create({
      data: {
        invoiceNumber: `PHASE5-TEST-${Date.now()}`,
        distributorId: TEST_DIST,
        customerId: cust.id,
        issueDate: FAR_FUTURE,
        dueDate: FAR_FUTURE,
        totalAmount: 1180,
        outstandingAmount: 1180,
        status: 'issued',
        cgstValue: 90,
        sgstValue: 90,
        igstValue: 0,
        // Phase 5 columns — directly assigned to prove every one round-trips.
        taxableValue: 1000,
        placeOfSupplyCode: '29',
        reverseCharge: false,
        customerGstinSnapshot: '29AAACA1234A1Z5',
        items: {
          create: [{
            description: 'Phase 5 test line',
            quantity: 1,
            unitPrice: 1180,
            gstRate: 18,
            totalPrice: 1180,
            taxableValue: 1000,
            // uom inherits the schema default 'NOS' when omitted; explicitly
            // assigning it here proves the column accepts custom values too.
            uom: 'NOS',
          }],
        },
      },
    });
    invoiceId = created.id;
  });

  afterAll(async () => {
    await prisma.invoice.delete({ where: { id: invoiceId } });
  });

  it('Invoice round-trips taxableValue / placeOfSupplyCode / reverseCharge / customerGstinSnapshot', async () => {
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: {
        taxableValue: true,
        placeOfSupplyCode: true,
        reverseCharge: true,
        customerGstinSnapshot: true,
      },
    });
    expect(Number(inv.taxableValue)).toBe(1000);
    expect(inv.placeOfSupplyCode).toBe('29');
    expect(inv.reverseCharge).toBe(false);
    expect(inv.customerGstinSnapshot).toBe('29AAACA1234A1Z5');
  });

  it('InvoiceItem round-trips taxableValue + uom', async () => {
    const item = await prisma.invoiceItem.findFirstOrThrow({
      where: { invoiceId },
      select: { taxableValue: true, uom: true },
    });
    expect(Number(item.taxableValue)).toBe(1000);
    expect(item.uom).toBe('NOS');
  });

  it('CreditNote accepts and round-trips taxableValue / cgst / sgst / igst / reasonCode', async () => {
    const cn = await prisma.creditNote.create({
      data: {
        invoiceId,
        creditNoteNumber: `PHASE5-CN-${Date.now()}`,
        totalAmount: 590,
        reason: 'Phase 5 test return',
        taxableValue: 500,
        cgstValue: 45,
        sgstValue: 45,
        igstValue: 0,
        reasonCode: 'R',
        status: 'pending_cn',
      },
    });
    const read = await prisma.creditNote.findUniqueOrThrow({
      where: { id: cn.id },
      select: {
        taxableValue: true, cgstValue: true, sgstValue: true, igstValue: true, reasonCode: true,
      },
    });
    expect(Number(read.taxableValue)).toBe(500);
    expect(Number(read.cgstValue)).toBe(45);
    expect(Number(read.sgstValue)).toBe(45);
    expect(Number(read.igstValue)).toBe(0);
    expect(read.reasonCode).toBe('R');
    await prisma.creditNote.delete({ where: { id: cn.id } });
  });
});

describe('Phase 5 — backfill script source guards', () => {
  const script = readFileSync(
    resolve(__dirname, '../../scripts/gstr1-backfill.ts'),
    'utf-8',
  );

  it('opts in to writes via --commit (dry-run is the default safe path)', () => {
    expect(script).toContain("process.argv.includes('--commit')");
  });

  it('does NOT default to writes when no flag is passed', () => {
    // The phrase "DRY RUN" must appear so the script's status banner
    // tells the operator they're in safe mode.
    expect(script).toContain('DRY RUN');
  });

  it('explicitly refuses to backfill customerGstinSnapshot (drift risk per spec)', () => {
    // The comment block calling out the customerGstinSnapshot opt-out is
    // the human-readable contract. Pin it so it can't be silently removed.
    expect(script).toContain('customerGstinSnapshot');
    expect(script).toContain('drift risk');
  });

  it('uses deriveStateCode rather than re-implementing the GSTIN-prefix logic', () => {
    expect(script).toMatch(/import.*deriveStateCode.*from\s*['"]@gaslink\/shared['"]/);
  });
});
