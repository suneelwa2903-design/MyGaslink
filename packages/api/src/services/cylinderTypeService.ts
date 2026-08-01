import type { Prisma } from '@prisma/client';
import { localTodayISO } from '@gaslink/shared';
import { prisma } from '../lib/prisma.js';
import { toNum } from '../utils/decimal.js';

export async function listCylinderTypes(distributorId: string) {
  return prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    include: {
      prices: { orderBy: { effectiveDate: 'desc' }, take: 1 },
      emptyPrices: true,
      thresholds: true,
      // Mini-Operator (2026-07-16): include the provider catalog row so the
      // frontend can render "HPCL 19KG Commercial" in the purchase-entry
      // dropdown. Nullable — legacy custom types without a catalog link
      // just show typeName as before.
      providerCatalog: {
        select: { providerCode: true, shortName: true, weight: true },
      },
    },
    orderBy: { typeName: 'asc' },
  });
}

export async function getCylinderTypeById(id: string, distributorId: string) {
  return prisma.cylinderType.findFirst({
    where: { id, distributorId },
    include: {
      prices: { orderBy: { effectiveDate: 'desc' } },
      emptyPrices: true,
      thresholds: true,
    },
  });
}

export async function createCylinderType(distributorId: string, data: {
  typeName: string;
  capacity: number;
  unit?: string;
  hsnCode?: string;
}) {
  return prisma.cylinderType.create({
    data: {
      distributorId,
      typeName: data.typeName,
      capacity: data.capacity,
      unit: data.unit || 'KG',
      hsnCode: data.hsnCode || '27111900',
    },
  });
}

export async function updateCylinderType(id: string, distributorId: string, data: {
  typeName?: string;
  capacity?: number;
  unit?: string;
  hsnCode?: string;
  isActive?: boolean;
}) {
  const existing = await prisma.cylinderType.findFirst({ where: { id, distributorId } });
  if (!existing) return null;
  return prisma.cylinderType.update({ where: { id }, data });
}

export async function deleteCylinderType(id: string, distributorId: string) {
  const existing = await prisma.cylinderType.findFirst({ where: { id, distributorId } });
  if (!existing) return null;
  return prisma.cylinderType.update({ where: { id }, data: { isActive: false } });
}

// Cylinder Prices
export async function listPrices(distributorId: string, cylinderTypeId?: string) {
  const where: Prisma.CylinderPriceWhereInput = { distributorId };
  if (cylinderTypeId) where.cylinderTypeId = cylinderTypeId;
  return prisma.cylinderPrice.findMany({
    where,
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { effectiveDate: 'desc' },
  });
}

export async function createPrice(distributorId: string, data: {
  cylinderTypeId: string;
  price: number;
  effectiveDate: string;
}) {
  const effectiveDate = new Date(data.effectiveDate);
  // WI-133 Fix 2: there is no DB unique constraint on
  // (distributorId, cylinderTypeId, effectiveDate), so a re-submit of the
  // same date used to pile up duplicate rows — which then made
  // getEffectivePrice non-deterministic. Find-or-update instead: setting a
  // price for a date that already has one overwrites it rather than
  // duplicating. (Upsert avoided because there is no unique key to target.)
  const existing = await prisma.cylinderPrice.findFirst({
    where: { distributorId, cylinderTypeId: data.cylinderTypeId, effectiveDate },
  });
  if (existing) {
    return prisma.cylinderPrice.update({
      where: { id: existing.id },
      data: { price: data.price },
      include: { cylinderType: { select: { typeName: true } } },
    });
  }
  return prisma.cylinderPrice.create({
    data: {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      price: data.price,
      effectiveDate,
    },
    include: { cylinderType: { select: { typeName: true } } },
  });
}

export async function deletePrice(id: string, distributorId: string) {
  const existing = await prisma.cylinderPrice.findFirst({ where: { id, distributorId } });
  if (!existing) return null;
  return prisma.cylinderPrice.delete({ where: { id } });
}

export async function getEffectivePrice(
  distributorId: string,
  cylinderTypeId: string,
  date: Date
): Promise<number> {
  const price = await prisma.cylinderPrice.findFirst({
    where: {
      distributorId,
      cylinderTypeId,
      effectiveDate: { lte: date },
    },
    // WI-133 Fix 1: deterministic tie-break. Two prices can share the same
    // effective_date (it's @db.Date — day granularity). Without a secondary
    // sort, Postgres returns an arbitrary one of the duplicates, so the
    // effective price flickers between requests. createdAt desc picks the
    // most recently entered price for that date.
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });
  return toNum(price?.price);
}

// Empty Cylinder Prices
//
// 2026-08-01 — parity with CylinderPrice:
//   - listEmptyPrices returns the *latest effective* row per type (one per type)
//   - createEmptyPrice appends a new row (was: upsert overwrite)
//   - getEffectiveEmptyPrice mirrors getEffectivePrice
//   - listEmptyPriceHistory returns full history for the Price History modal
//
// Historical rows persist forever now. The mini-op / distributor Prices
// UI reads only the latest via listEmptyPrices; the "View History"
// button calls listEmptyPriceHistory.
export async function listEmptyPrices(distributorId: string) {
  // "Latest effective row per (distributor, type)" — join against a
  // grouped subselect. Prisma doesn't compose DISTINCT ON cleanly, so
  // fetch all rows ordered by (type, effectiveDate desc, createdAt desc)
  // and dedupe in memory. Volume is tiny (≤ N types × N price changes),
  // so the in-memory dedupe is fine.
  const rows = await prisma.emptyCylinderPrice.findMany({
    where: { distributorId },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });
  const seen = new Set<string>();
  const latest = [] as typeof rows;
  for (const r of rows) {
    if (seen.has(r.cylinderTypeId)) continue;
    seen.add(r.cylinderTypeId);
    latest.push(r);
  }
  return latest;
}

export async function listEmptyPriceHistory(
  distributorId: string,
  cylinderTypeId?: string,
) {
  const where: Prisma.EmptyCylinderPriceWhereInput = { distributorId };
  if (cylinderTypeId) where.cylinderTypeId = cylinderTypeId;
  return prisma.emptyCylinderPrice.findMany({
    where,
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: [{ cylinderTypeId: 'asc' }, { effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function createEmptyPrice(distributorId: string, data: {
  cylinderTypeId: string;
  emptyCylinderPrice: number;
  effectiveDate: string;
}) {
  const effectiveDate = new Date(data.effectiveDate);
  // Same "find-or-update on exact same date" pattern as cylinderPrice
  // (WI-133 Fix 2) — a re-submit of the same effective date OVERWRITES
  // rather than piling up duplicates. Different date → new history row.
  const existing = await prisma.emptyCylinderPrice.findFirst({
    where: { distributorId, cylinderTypeId: data.cylinderTypeId, effectiveDate },
  });
  if (existing) {
    return prisma.emptyCylinderPrice.update({
      where: { id: existing.id },
      data: { emptyCylinderPrice: data.emptyCylinderPrice },
      include: { cylinderType: { select: { typeName: true } } },
    });
  }
  return prisma.emptyCylinderPrice.create({
    data: {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      emptyCylinderPrice: data.emptyCylinderPrice,
      effectiveDate,
    },
    include: { cylinderType: { select: { typeName: true } } },
  });
}

/**
 * Effective empty-cylinder deposit price on `date`. Mirrors
 * getEffectivePrice — most-recent row whose effectiveDate is on-or-before
 * the target date; tie-break by createdAt desc.
 */
export async function getEffectiveEmptyPrice(
  distributorId: string,
  cylinderTypeId: string,
  date: Date,
): Promise<number> {
  const row = await prisma.emptyCylinderPrice.findFirst({
    where: {
      distributorId,
      cylinderTypeId,
      effectiveDate: { lte: date },
    },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });
  return toNum(row?.emptyCylinderPrice);
}

/**
 * @deprecated 2026-08-01 — use createEmptyPrice instead. Kept as a thin
 * shim so any lingering callers that pass no effectiveDate still work
 * (uses today). Remove once callers are migrated.
 */
export async function upsertEmptyPrice(distributorId: string, data: {
  cylinderTypeId: string;
  emptyCylinderPrice: number;
}) {
  return createEmptyPrice(distributorId, {
    cylinderTypeId: data.cylinderTypeId,
    emptyCylinderPrice: data.emptyCylinderPrice,
    effectiveDate: localTodayISO(),
  });
}

// Thresholds
export async function upsertThreshold(distributorId: string, data: {
  cylinderTypeId: string;
  warningLevel: number;
  criticalLevel: number;
  alertEnabled?: boolean;
}) {
  return prisma.cylinderThreshold.upsert({
    where: { distributorId_cylinderTypeId: { distributorId, cylinderTypeId: data.cylinderTypeId } },
    create: {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      warningLevel: data.warningLevel,
      criticalLevel: data.criticalLevel,
      alertEnabled: data.alertEnabled ?? true,
    },
    update: {
      warningLevel: data.warningLevel,
      criticalLevel: data.criticalLevel,
      alertEnabled: data.alertEnabled ?? true,
    },
  });
}
