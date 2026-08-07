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

beforeAll(async () => {
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
