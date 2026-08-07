/**
 * F8 v2 Landed Cost Service (2026-08-06)
 *
 * Computes per-cyl-type × per-month landed cost from the corporation-side
 * financials. Per Suneel A1 — landed cost is a first-class output; it's
 * how the distributor knows their true per-cyl cost so they can price
 * customer sales for target margin.
 *
 * FORMULA (per cyl type, per month):
 *   Line total    = Σ (PurchaseEntryItem.unitPrice × fullsReceived)
 *                   across regular-invoice PurchaseEntries where item
 *                   references this cyl type
 *   Freight       = Σ PurchaseEntryCharge.amount (chargeType='freight')
 *                   attributed pro-rata by qty per cyl type
 *   CN offset     = Σ PurchaseCreditNoteAllocation.amount attributed to
 *                   PurchaseEntries containing this cyl type, pro-rated
 *                   by qty when the entry has multiple cyl types
 *   DN offset     = Σ PurchaseDebitNoteAllocation.amount (adds to cost)
 *   Cyl received  = Σ PurchaseEntryItem.fullsReceived (this type)
 *
 *   Landed / cyl  = (Line + Freight + DN − CN) ÷ Cyl received
 *
 * GST-MODE AWARE (per Suneel Q2):
 *   • gstMode = 'live' | 'sandbox' → distributor claims ITC → tax refunded
 *     → landed cost uses GST-EXCLUSIVE line totals.
 *   • gstMode = 'disabled' → no ITC → tax is real cost
 *     → landed cost uses GST-INCLUSIVE line totals (as-stored).
 *   The switch happens automatically at read time; the caller sees the
 *   final ₹/cyl + a `gstMode` field so the UI can render a footnote.
 *
 * EXCLUDED: PurchaseEntry rows with documentType='deposit_invoice' are
 * NOT part of landed cost — deposit is a refundable container fee, not
 * a gas cost.
 *
 * Tenant-scoped: every query filters on distributorId (anti-pattern #13).
 */
import type { Prisma } from '@prisma/client';
import { localTodayISO, localDateISO } from '@gaslink/shared';
import { prisma } from '../lib/prisma.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function toNum(d: Prisma.Decimal | number | null | undefined): number {
  if (d == null) return 0;
  return typeof d === 'number' ? d : Number(d);
}

// yyyy-mm from a yyyy-mm-dd string (local calendar month). Purchase dates
// are stored as yyyy-mm-dd strings (see PurchaseEntry.purchaseDate docstring)
// so we slice deterministically without touching timezone.
function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

export interface LandedCostRow {
  month: string; // 'YYYY-MM'
  cylinderTypeId: string;
  cylinderTypeName: string;
  cylindersReceived: number;
  lineTotal: number; // Σ items pre-freight, pre-CN
  freightAllocated: number; // pro-rata attributable to this cyl type
  cnOffset: number; // pro-rata CN allocation
  dnOffset: number; // pro-rata DN allocation (increases cost)
  landedTotal: number; // Line + Freight + DN − CN
  landedPerCyl: number;
  gstMode: 'live' | 'sandbox' | 'disabled';
}

export interface LandedCostResult {
  rows: LandedCostRow[];
  summary: {
    /** Total unique cyl types seen in this window */
    cylTypes: number;
    /** Total months covered */
    months: number;
    /** Fleet-wide totals for the window */
    totalCylsReceived: number;
    totalLineValue: number;
    totalFreight: number;
    totalCnOffset: number;
    totalDnOffset: number;
    grandLanded: number;
  };
  filters: { from: string | null; to: string | null; sourceDistributorId: string | null };
  gstMode: 'live' | 'sandbox' | 'disabled';
}

/**
 * Compute landed cost per cyl type per month for a tenant.
 * Optional filters narrow the window and (optionally) a single supplier.
 * When no rows match, returns { rows: [], summary: zeros } — never throws.
 */
export async function computeLandedCost(
  distributorId: string,
  filters: { from?: string; to?: string; sourceDistributorId?: string } = {},
): Promise<LandedCostResult> {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true },
  });
  const gstMode = (distributor?.gstMode ?? 'disabled') as 'live' | 'sandbox' | 'disabled';
  const excludeGst = gstMode === 'live' || gstMode === 'sandbox';

  // Pull all PurchaseEntry rows for the window, INVOICE type only (deposit
  // invoices excluded). Include items + charges + CN allocations + DN
  // allocations in one shot so we don't N+1 the DB.
  const entries = await prisma.purchaseEntry.findMany({
    where: {
      distributorId,
      deletedAt: null,
      documentType: 'invoice', // F8 v2 — deposit_invoice EXCLUDED from landed cost
      ...(filters.sourceDistributorId ? { sourceDistributorId: filters.sourceDistributorId } : {}),
      ...(filters.from || filters.to
        ? {
            purchaseDate: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      purchaseDate: true,
      items: {
        select: {
          cylinderTypeId: true,
          fullsReceived: true,
          unitPrice: true,
          gstRate: true,
          cylinderType: { select: { typeName: true } },
        },
      },
      charges: {
        select: { chargeType: true, amount: true },
      },
      cnAllocations: {
        where: { purchaseCreditNote: { deletedAt: null } },
        select: { amount: true },
      },
      dnAllocations: {
        where: { purchaseDebitNote: { deletedAt: null } },
        select: { amount: true },
      },
    },
  });

  // Accumulator keyed by month|cylTypeId
  interface AccRow {
    month: string;
    cylinderTypeId: string;
    cylinderTypeName: string;
    cylindersReceived: number;
    lineTotal: number;
    freightAllocated: number;
    cnOffset: number;
    dnOffset: number;
  }
  const acc = new Map<string, AccRow>();
  const key = (month: string, cylTypeId: string) => `${month}|${cylTypeId}`;

  for (const entry of entries) {
    const month = monthKey(entry.purchaseDate);

    // Total cyls in this entry (across all cyl types) — used to pro-rate
    // freight + CN + DN which apply to the entry as a whole.
    const entryCylTotal = entry.items.reduce((s, it) => s + it.fullsReceived, 0);
    if (entryCylTotal === 0) continue; // movement-only or all-zero entry — skip

    const entryFreight = entry.charges
      .filter((c) => c.chargeType === 'freight')
      .reduce((s, c) => s + toNum(c.amount), 0);
    // NOTE — non-freight charges (handling/testing/insurance/other) are
    // NOT added to landed cost per Suneel's minimal-scope guidance. If a
    // future requirement includes them, add them here with the same pro-rata.

    const entryCn = entry.cnAllocations.reduce((s, a) => s + toNum(a.amount), 0);
    const entryDn = entry.dnAllocations.reduce((s, a) => s + toNum(a.amount), 0);

    for (const item of entry.items) {
      if (item.fullsReceived === 0) continue;
      const cylTypeId = item.cylinderTypeId;
      const cylTypeName = item.cylinderType?.typeName ?? '—';

      // Line total for this cyl type on this entry.
      const raw = toNum(item.unitPrice) * item.fullsReceived;
      // GST-mode adjustment: unitPrice is stored GST-INCLUSIVE per the
      // existing convention (see PurchaseEntryItem.unitPrice docstring).
      // If tenant claims ITC, strip the tax to get the true cost.
      const gstRate = toNum(item.gstRate);
      const lineTotal = excludeGst && gstRate > 0 ? raw / (1 + gstRate / 100) : raw;

      // Pro-rata attribution by cyl count.
      const ratio = item.fullsReceived / entryCylTotal;
      const attribFreight = entryFreight * ratio;
      const attribCn = entryCn * ratio;
      const attribDn = entryDn * ratio;

      const k = key(month, cylTypeId);
      const existing = acc.get(k);
      if (existing) {
        existing.cylindersReceived += item.fullsReceived;
        existing.lineTotal = round2(existing.lineTotal + lineTotal);
        existing.freightAllocated = round2(existing.freightAllocated + attribFreight);
        existing.cnOffset = round2(existing.cnOffset + attribCn);
        existing.dnOffset = round2(existing.dnOffset + attribDn);
      } else {
        acc.set(k, {
          month,
          cylinderTypeId: cylTypeId,
          cylinderTypeName: cylTypeName,
          cylindersReceived: item.fullsReceived,
          lineTotal: round2(lineTotal),
          freightAllocated: round2(attribFreight),
          cnOffset: round2(attribCn),
          dnOffset: round2(attribDn),
        });
      }
    }
  }

  const rows: LandedCostRow[] = Array.from(acc.values())
    .map((r): LandedCostRow => {
      const landedTotal = round2(r.lineTotal + r.freightAllocated + r.dnOffset - r.cnOffset);
      const landedPerCyl = r.cylindersReceived > 0 ? round2(landedTotal / r.cylindersReceived) : 0;
      return { ...r, landedTotal, landedPerCyl, gstMode };
    })
    .sort((a, b) => {
      if (a.month !== b.month) return a.month.localeCompare(b.month);
      return a.cylinderTypeName.localeCompare(b.cylinderTypeName);
    });

  const summary = {
    cylTypes: new Set(rows.map((r) => r.cylinderTypeId)).size,
    months: new Set(rows.map((r) => r.month)).size,
    totalCylsReceived: rows.reduce((s, r) => s + r.cylindersReceived, 0),
    totalLineValue: round2(rows.reduce((s, r) => s + r.lineTotal, 0)),
    totalFreight: round2(rows.reduce((s, r) => s + r.freightAllocated, 0)),
    totalCnOffset: round2(rows.reduce((s, r) => s + r.cnOffset, 0)),
    totalDnOffset: round2(rows.reduce((s, r) => s + r.dnOffset, 0)),
    grandLanded: round2(rows.reduce((s, r) => s + r.landedTotal, 0)),
  };

  return {
    rows,
    summary,
    filters: {
      from: filters.from ?? null,
      to: filters.to ?? null,
      sourceDistributorId: filters.sourceDistributorId ?? null,
    },
    gstMode,
  };
}

/**
 * Convenience: last-N-days rolling landed cost as a quick chip on the
 * Corporation Ledger page. Returns a single ₹/cyl figure averaged across
 * all cyl types for the requested window (default 30 days).
 */
export async function computeAverageLandedCost(
  distributorId: string,
  sourceDistributorId: string | undefined,
  days = 30,
): Promise<{ avgPerCyl: number; totalCyls: number; windowDays: number }> {
  // Anti-pattern #21 (2026-06-25 extension): use local-TZ helpers instead
  // of `.toISOString().slice(0, 10)` — the CI guard bans the UTC form
  // repo-wide, even for server-only computations.
  const to = localTodayISO();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const from = localDateISO(fromDate);

  const { rows } = await computeLandedCost(distributorId, {
    from,
    to,
    sourceDistributorId,
  });
  const totalCyls = rows.reduce((s, r) => s + r.cylindersReceived, 0);
  const totalLanded = rows.reduce((s, r) => s + r.landedTotal, 0);
  const avgPerCyl = totalCyls > 0 ? round2(totalLanded / totalCyls) : 0;
  return { avgPerCyl, totalCyls, windowDays: days };
}
