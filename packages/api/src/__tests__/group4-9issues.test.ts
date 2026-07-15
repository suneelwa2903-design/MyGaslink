/**
 * 9-issues Group 4 — customer-statement PDF Pay To layout (Issue 7).
 *
 * The original Phase 3 block rendered Pay To left-aligned BELOW the
 * distributor letterhead. Suneel asked for it right-aligned BESIDE
 * the customer name/details block, with the account holder name
 * (auto-filled from distributor.businessName) as the first line so
 * the customer immediately sees WHO they're paying.
 *
 * Tested by source-file shape (PDFKit output is binary — exercising
 * the byte layout would need a PDF parser dependency for marginal
 * payoff). The render path is covered by the existing Phase 3 PDF
 * integration tests; this group locks in the LAYOUT contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '..', 'services', 'pdf', 'customerLedgerPdfService.ts'),
  'utf-8',
);

describe('Issue 7 — Pay To layout in customer ledger PDF', () => {
  it('legacy left-aligned Pay To block (below letterhead) has been removed', () => {
    // The old block read `doc.text(`Pay To: ${bankPrefix}${bankBranch}`,
    // MARGIN.left, leftY, ...)`. The new block has the literal
    // `'Pay To:'` and right-alignment instead. A regression catch: if
    // the old left-aligned text comes back, it would have the bankPrefix
    // template literal alongside MARGIN.left.
    expect(src).not.toMatch(/`Pay To: \$\{bankPrefix\}/);
    // Also: the comment that documents the old position is preserved
    // but the actual `leftY` write at the letterhead level is gone.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The phrase "leftY += 11" still appears for the GSTIN+Phone line
    // but NOT inside an `if (distributor.bankAccountNumber && distributor.ifscCode)`
    // block at the letterhead level. Pin: two bumps per letterhead
    // (sellerAddr + GSTIN+Phone). Feature A (2026-07-15) added a
    // second letterhead in generateGroupLedgerPdf that legitimately
    // repeats the same two bumps, hence the ≤4 cap. The original
    // Phase 3 Pay-To block would have added TWO MORE inside a
    // bankAccountNumber gate — the ≤4 cap still fails if that regresses.
    const leftYBumps = (codeOnly.match(/leftY\s*\+=\s*11/g) || []).length;
    expect(leftYBumps).toBeLessThanOrEqual(4);
  });

  it('renders a right-aligned Pay To block starting at customerBlockStartY', () => {
    expect(src).toContain('customerBlockStartY');
    // The new block computes `payToX = rightEdge - payToWidth` and uses
    // `align: 'right'` repeatedly.
    expect(src).toMatch(/payToX\s*=\s*rightEdge\s*-\s*payToWidth/);
    expect(src).toMatch(/align:\s*['"]right['"]/);
  });

  it('first content line is "Pay To:" heading', () => {
    expect(src).toMatch(/doc\.text\(['"]Pay To:['"],\s*payToX/);
  });

  it('second content line is the account holder name (distributor.businessName)', () => {
    // The render sequence is: "Pay To:" → businessName (fallback
    // legalName) → bank/branch → A/C → IFSC[+UPI]. The businessName
    // text call must appear right after the heading call, both
    // anchored at payToX with align: 'right'.
    expect(src).toMatch(/distributor\.businessName\s*\|\|\s*distributor\.legalName[\s\S]{0,200}align:\s*['"]right['"]/);
  });

  it('renders bank name + branch + A/C + IFSC and conditionally UPI', () => {
    expect(src).toContain('distributor.bankName');
    expect(src).toContain('distributor.bankBranchName');
    expect(src).toContain('distributor.bankAccountNumber');
    expect(src).toContain('distributor.ifscCode');
    expect(src).toContain('distributor.upiId');
  });

  it('still gates on bank account + IFSC (omits block when either is missing)', () => {
    expect(src).toMatch(/if\s*\(\s*distributor\.bankAccountNumber\s*&&\s*distributor\.ifscCode\s*\)/);
  });

  it('main cursor Y is bumped past the Pay To block so the table does not overlap', () => {
    // `y = Math.max(y, payToY)` — pin the layout invariant.
    expect(src).toMatch(/y\s*=\s*Math\.max\(y,\s*payToY\)/);
  });
});
