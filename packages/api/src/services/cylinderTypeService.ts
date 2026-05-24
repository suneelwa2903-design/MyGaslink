import { prisma } from '../lib/prisma.js';
import { toNum } from '../utils/decimal.js';

export async function listCylinderTypes(distributorId: string) {
  return prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    include: {
      prices: { orderBy: { effectiveDate: 'desc' }, take: 1 },
      emptyPrices: true,
      thresholds: true,
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
  const where: any = { distributorId };
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
export async function listEmptyPrices(distributorId: string) {
  return prisma.emptyCylinderPrice.findMany({
    where: { distributorId },
    include: { cylinderType: { select: { typeName: true } } },
  });
}

export async function upsertEmptyPrice(distributorId: string, data: {
  cylinderTypeId: string;
  emptyCylinderPrice: number;
}) {
  return prisma.emptyCylinderPrice.upsert({
    where: { distributorId_cylinderTypeId: { distributorId, cylinderTypeId: data.cylinderTypeId } },
    create: {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      emptyCylinderPrice: data.emptyCylinderPrice,
    },
    update: { emptyCylinderPrice: data.emptyCylinderPrice },
    include: { cylinderType: { select: { typeName: true } } },
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
