/**
 * Suneel's standing rule, made permanent:
 *   "only what's present on those challans or invoices should be shown —
 *    why are you assigning something new???"
 *
 * Internal auto-numbers we generate for OMC-side documents —
 *   PSHD… (PurchaseEntry.purchaseNumber)
 *   FSHD… (DefectiveReturnBatch.batchNumber)
 * — are DB handles. They must never reach a user-facing surface: not the
 * Corporation Ledger rows, not the narration text, not reports, not PDFs.
 * Only the corporation's own reference (supplierDocumentNumber /
 * challanNumber) is user-facing; when the operator captured none, the field
 * is blank.
 *
 * This has now regressed twice. The first fix cleaned the `documentNumber`
 * column but left `narration` falling back to `purchaseNumber`, so PSHD kept
 * appearing in the ledger description. These assertions cover BOTH fields on
 * EVERY row kind, so a future partial fix fails here instead of shipping.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getSupplierLedger } from '../services/purchasePaymentService.js';
import { prisma } from '../lib/prisma.js';

const D1 = 'dist-001';
const D2 = 'dist-002';

// PSHD / FSHD / CSHD-style internal sequence: 4 uppercase letters + digits.
const INTERNAL_REF = /\b[A-Z]{4}\d{6,}\b/;

type LedgerRow = {
  kind: string;
  documentNumber: string | null;
  narration: string;
};

async function allRows(distributorId: string): Promise<LedgerRow[]> {
  const suppliers = await prisma.sourceDistributor.findMany({
    where: { distributorId },
    select: { id: true },
  });
  const out: LedgerRow[] = [];
  for (const s of suppliers) {
    const res = await getSupplierLedger(distributorId, s.id, {});
    out.push(...(res.rows as unknown as LedgerRow[]));
  }
  return out;
}

let d1Rows: LedgerRow[] = [];
let d2Rows: LedgerRow[] = [];

// The seed creates real corp rows (ERV events + source distributors) for
// dist-001, but the suite runs against a SHARED dev DB and sibling test files
// delete dist-001 inventory events / source distributors mid-run — which used
// to make the POSITIVE ("guard is not vacuous") assertion flake to zero. To
// pin determinism we plant ONE guaranteed clean row here: a purchase PAYMENT
// against a guard source distributor. A payment row surfaces with
// documentNumber=null and narration "PAYMENT (cash)" (no referenceNumber), so
// it satisfies the POSITIVE check while the NEGATIVE checks still hold — it
// carries no internal PSHD/FSHD sequence anywhere.
async function seedGuardRow(): Promise<void> {
  const GUARD_NAME = 'NOREF-GUARD-OMC';
  let src = await prisma.sourceDistributor.findFirst({
    where: { distributorId: D1, name: GUARD_NAME },
    select: { id: true },
  });
  if (!src) {
    src = await prisma.sourceDistributor.create({
      data: { distributorId: D1, name: GUARD_NAME },
      select: { id: true },
    });
  }
  // Idempotent across reruns on the shared DB.
  await prisma.purchasePayment.deleteMany({
    where: { distributorId: D1, sourceDistributorId: src.id, notes: 'noref-guard' },
  });
  await prisma.purchasePayment.create({
    data: {
      distributorId: D1,
      sourceDistributorId: src.id,
      transactionDate: '2026-08-01',
      amount: 1,
      paymentMethod: 'cash',
      notes: 'noref-guard',
      createdBy: 'test-guard',
    },
  });
}

beforeAll(async () => {
  await seedGuardRow();
  d1Rows = await allRows(D1);
  d2Rows = await allRows(D2);
});

describe('Corporation Ledger — no internal auto-numbers surfaced', () => {
  it('POSITIVE — the fixtures actually produce rows (guard is not vacuous)', () => {
    expect(d1Rows.length + d2Rows.length).toBeGreaterThan(0);
  });

  it('NEGATIVE — no documentNumber is an internal PSHD/FSHD sequence', () => {
    for (const row of [...d1Rows, ...d2Rows]) {
      if (!row.documentNumber) continue;
      expect(
        INTERNAL_REF.test(row.documentNumber),
        `row kind="${row.kind}" leaked internal ref in documentNumber: ${row.documentNumber}`,
      ).toBe(false);
    }
  });

  it('NEGATIVE — no narration embeds an internal PSHD/FSHD sequence', () => {
    // This is the assertion the first fix was missing.
    for (const row of [...d1Rows, ...d2Rows]) {
      expect(
        INTERNAL_REF.test(row.narration),
        `row kind="${row.kind}" leaked internal ref in narration: ${row.narration}`,
      ).toBe(false);
    }
  });

  it('STRUCTURAL — Report Builder cannot expose purchaseNumber as a field', async () => {
    // Without this, a user could build a custom report surfacing PSHD.
    // Client field list and server allowlist must BOTH exclude it, or the
    // two drift and either leak or 400 on use.
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(
      new URL('../services/reportBuilder/allowlist.ts', import.meta.url),
      'utf8',
    );
    // Strip comments first — the file DOCUMENTS why purchaseNumber is
    // excluded, and that prose must not be mistaken for a live entry.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/'purchaseNumber'/);
    expect(code).toMatch(/'supplierDocumentNumber'/);
  });

  it('STRUCTURAL — purchase-ledger PDF prints the OMC ref, not PSHD', async () => {
    const { readFileSync } = await import('node:fs');
    const pdf = readFileSync(
      new URL('../services/pdf/purchaseLedgerPdfService.ts', import.meta.url),
      'utf8',
    );
    // The rendered row must use docNumber (OMC ref), never purchaseNumber.
    expect(pdf).toMatch(/r\.docNumber/);
    expect(pdf).not.toMatch(/r\.purchaseNumber/);
  });

  it('STRUCTURAL — ledger reader has no `?? purchaseNumber` fallback left', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../services/purchasePaymentService.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/\?\?\s*\w+\.row\.purchaseNumber/);
    expect(src).not.toMatch(/\?\?\s*row\.purchaseNumber/);
  });
});
