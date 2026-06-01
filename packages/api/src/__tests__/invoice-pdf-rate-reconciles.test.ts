/**
 * 2026-06-01 — Invoice PDF Rate column must reconcile with per-line Amount.
 *
 * Bug found during live PDF inspection on 2026-06-01: ISHD2627007431
 * (Bangalore Foods) and ISHD2627007353 (Maruthi Agencies) showed
 * `Rate × Qty × 1.18 ≠ Amount` on every line that carried a customer
 * discount.
 *
 * Root cause was in invoicePdfService.ts computeItems():
 *     baseRate = unit_price / 1.18        ← PRE-discount, ignored discount_per_unit
 *     taxable  = (unit_price - discount) × qty / 1.18   ← POST-discount
 *     gstAmt   = afterDiscount − taxable                ← POST-discount
 *     amount   = total_price (from DB)                  ← POST-discount
 * So the Rate column rendered pre-discount, while GST and Amount rendered
 * post-discount. For Bangalore 425 KG (up=42000, disc=4500, qty=1):
 *     Rate ₹35,593.22 + GST ₹5,720.34 = ₹41,313.56  vs  Amount ₹37,500
 * The subtotal row inherited the same drift: `totalGst = grandTotal −
 * Σ(pre_discount_baseRate × qty)` came out at ₹2,335.59 vs the real
 * CGST+SGST of ₹6,742.38.
 *
 * The IRN payload (payloadBuilders.buildIrnPayload) was UNAFFECTED — it
 * sends UnitPrice and Discount as separate fields and computes
 * AssAmt = TotAmt − Discount internally. NIC always saw the correct
 * post-discount taxable. The bug was purely in the PDF read-side.
 *
 * Fix: `baseRate = (unit_price - discount_per_unit) / 1.18`.
 *
 * This file pins the reconciliation contract for computeItems():
 *   - Per row: baseRate × qty × (1+gstRate/100) ≈ totalPrice (1¢ tolerance)
 *   - Per row: baseRate × qty + gstAmount       ≈ totalPrice
 *   - Subtotal: Σ baseRate × qty + Σ gstAmount  ≈ grandTotal
 *   - Negative pin: baseRate must NOT equal unit_price / 1.18 on a
 *     discounted line — that's the exact PRE-fix behaviour we're locking out.
 *
 * Pure unit test — no DB, no HTTP. Calls computeItems directly with
 * synthetic line data mirroring the DB rows for ISHD2627007431.
 */
import { describe, it, expect } from 'vitest';
import { computeItems } from '../services/pdf/invoicePdfService.js';

// Mirrors InvoiceForPdf['items']. The shape is the only contract — we don't
// need real id/description strings, but we do need the numeric fields.
function line(opts: {
  unitPrice: number;
  discountPerUnit: number;
  quantity: number;
  totalPrice: number;
  gstRate?: number;
  description?: string;
  cylinderTypeName?: string;
}) {
  return {
    id: 'test-item',
    description: opts.description ?? 'Test cylinder',
    hsnCode: '27111900',
    quantity: opts.quantity,
    unitPrice: opts.unitPrice,
    discountPerUnit: opts.discountPerUnit,
    gstRate: opts.gstRate ?? 18,
    totalPrice: opts.totalPrice,
    cylinderType: opts.cylinderTypeName ? { typeName: opts.cylinderTypeName } : null,
  };
}

// Tolerance is 2¢ — slightly looser than 1¢ because each input has already
// been rounded to 2 dp by round2(), so multiplying back through (1+gstRate)
// can drift by up to ~1¢/term. For qty=2 cases that's 2¢ worst case.
const close = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

describe('invoicePdfService.computeItems — Rate × Qty × (1+gst) ≈ Amount reconciliation', () => {
  it('Bangalore Foods 425 KG (up=42000, disc=4500, qty=1) — per-row math reconciles', async () => {
    // The exact DB row that exposed the bug.
    const items = [line({ unitPrice: 42000, discountPerUnit: 4500, quantity: 1, totalPrice: 37500 })];
    const { computed } = computeItems(items);
    const row = computed[0];

    // baseRate must reflect the POST-discount taxable rate per unit.
    // (42000 - 4500) / 1.18 = 31779.66
    expect(close(row.baseRate, 31779.66)).toBe(true);

    // Per-row reconciliation 1: Rate × Qty × (1 + gstRate/100) ≈ Amount.
    expect(close(row.baseRate * row.quantity * 1.18, row.totalPrice)).toBe(true);

    // Per-row reconciliation 2: Rate × Qty + GST ≈ Amount.
    expect(close(row.baseRate * row.quantity + row.gstAmount, row.totalPrice)).toBe(true);

    // Negative pin: baseRate must NOT equal pre-discount unit_price / 1.18.
    // 42000 / 1.18 = 35593.22 — locking out the exact pre-fix bug.
    expect(close(row.baseRate, 35593.22)).toBe(false);
  });

  it('Maruthi 425 KG (up=42000, disc=6000, qty=2) — qty > 1 also reconciles', async () => {
    // disc=6000/unit × 2 = 12000 discount; total = 84000 - 12000 = 72000.
    const items = [line({ unitPrice: 42000, discountPerUnit: 6000, quantity: 2, totalPrice: 72000 })];
    const { computed } = computeItems(items);
    const row = computed[0];

    // (42000 - 6000) / 1.18 = 30508.47
    expect(close(row.baseRate, 30508.47)).toBe(true);
    expect(close(row.baseRate * row.quantity * 1.18, row.totalPrice)).toBe(true);
    expect(close(row.baseRate * row.quantity + row.gstAmount, row.totalPrice)).toBe(true);
  });

  it('zero-discount line (5 KG, up=600, disc=0) — no regression to undiscounted lines', async () => {
    // Pre-fix this line worked by coincidence (pre = post when discount=0).
    // Lock the contract so the new code path produces the same numbers.
    const items = [line({ unitPrice: 600, discountPerUnit: 0, quantity: 1, totalPrice: 600 })];
    const { computed } = computeItems(items);
    const row = computed[0];

    // 600 / 1.18 = 508.47
    expect(close(row.baseRate, 508.47)).toBe(true);
    expect(close(row.baseRate * row.quantity + row.gstAmount, row.totalPrice)).toBe(true);
  });

  it('subtotal row math: Σ baseRate × qty + Σ gstAmount ≈ Σ totalPrice (Bangalore full invoice)', async () => {
    // All four DB lines from ISHD2627007431.
    const items = [
      line({ unitPrice: 2000,  discountPerUnit: 200,  quantity: 1, totalPrice: 1800,  description: '19 KG' }),
      line({ unitPrice: 42000, discountPerUnit: 4500, quantity: 1, totalPrice: 37500, description: '425 KG' }),
      line({ unitPrice: 4800,  discountPerUnit: 500,  quantity: 1, totalPrice: 4300,  description: '47.5 KG' }),
      line({ unitPrice: 600,   discountPerUnit: 0,    quantity: 1, totalPrice: 600,   description: '5 KG' }),
    ];
    const { computed, totalTaxable, totalInclusive } = computeItems(items);

    const sumBaseRateTimesQty = computed.reduce((s, r) => s + r.baseRate * r.quantity, 0);
    const sumGst = computed.reduce((s, r) => s + r.gstAmount, 0);
    const grandTotal = computed.reduce((s, r) => s + r.totalPrice, 0);

    // Σ baseRate × qty MUST equal Σ taxable (within rounding) — i.e. baseRate
    // is the per-unit taxable rate, summed across the invoice = the taxable
    // subtotal. Pre-fix this came out at 41864.41; post-fix it's 37457.62.
    expect(close(sumBaseRateTimesQty, totalTaxable, 0.05)).toBe(true);

    // grandTotal − Σ baseRate × qty MUST equal Σ gstAmount — the subtotal
    // row's `totalGst = grandTotal − totalRate` formula now produces the
    // real CGST+SGST (₹6,742.37) instead of the pre-fix mush (₹2,335.59).
    expect(close(grandTotal - sumBaseRateTimesQty, sumGst, 0.05)).toBe(true);
    expect(close(grandTotal, totalInclusive, 0.05)).toBe(true);

    // Real CGST+SGST for this invoice: ₹6,742.38 (within 1¢ rounding).
    expect(close(sumGst, 6742.37, 0.05)).toBe(true);
  });

  // (GST-disabled tenants are out of scope for this guard — the PDF
  // currently coerces gstRate=0 → 18 via `item.gstRate || 18` at line 165,
  // which is pre-existing behaviour unrelated to the discount fix. A
  // separate WI can address that fallback.)
});
