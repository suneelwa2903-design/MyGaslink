/**
 * Purchase-charge unit convention (2026-08-15).
 *
 * `PurchaseEntryCharge.amount` is the GST-EXCLUSIVE (taxable) base of a charge
 * (e.g. GoGas freight ₹9,600); its GST lives in `PurchaseEntryCharge.gstRate`.
 *
 * There are TWO legitimate readings, and mixing them is anti-pattern #16:
 *
 *   • COST side (COGS / FIFO cost-layers / landed cost): use the BASE only —
 *     freight GST is reclaimable ITC, NOT a cost. Cost readers (cogsService,
 *     landedCostService) sum `amount` directly. Do NOT use this helper there.
 *
 *   • PAYABLES side (what you owe the OMC — supplier balances, aging,
 *     Corporation Statement Register, purchase-payment allocation totals): use
 *     the GST-INCLUSIVE figure — you pay the supplier the full invoice. That is
 *     what THIS helper returns.
 *
 * Legacy rows (pre-2026-08-15) carry gstRate = 0, so base == inclusive and this
 * helper is a no-op for them — behaviour is unchanged for historical data.
 */
export function sumChargesIncl(
  charges: ReadonlyArray<{ amount: number | { toString(): string }; gstRate?: number | { toString(): string } | null }>,
): number {
  return charges.reduce((s, c) => {
    const base = Number(c.amount) || 0;
    const gst = Number(c.gstRate ?? 0) || 0;
    return s + base * (1 + gst / 100);
  }, 0);
}
