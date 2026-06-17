/**
 * FLOAT-001 (2026-06-17): vehicle load manifest service.
 *
 * Three responsibilities:
 *  1. createOrUpdateManifest — admin/inventory/finance confirms per-cylinder-type
 *     loaded quantities BEFORE dispatch. Snapshots orderedQty at confirm time so
 *     reconciliation reads the value as-at-confirm without re-querying orders.
 *  2. getManifestForDVA — reads all manifest rows for a DVA (any trip).
 *  3. getAvailableFullsForDriver — single number per (driver, cylinderType) used by
 *     POST /drivers/me/orders to hard-block over-allocation of walk-in orders.
 *
 * Cross-tenant: every DVA + customer lookup re-checks distributorId. Service
 * never trusts a caller-supplied distributorId — it always comes from JWT
 * (req.user.distributorId) in the route layer.
 *
 * Trip-number awareness: the @@unique on dva_load_manifests is
 * (dvaId, cylinderTypeId, tripNumber). The service stamps tripNumber from
 * DVA.tripNumber at the moment of confirm — preserving per-trip audit when the
 * same DVA rolls forward to trip 2.
 */
import { prisma } from '../lib/prisma.js';
import {
  resolveEffectiveTripNumber,
  TRIP_CONTENT_STATUSES,
} from '../routes/driversVehicles.js';
import type { Prisma } from '@prisma/client';

export class ManifestError extends Error {
  constructor(
    public override message: string,
    public code: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

export interface ManifestItemInput {
  cylinderTypeId: string;
  totalLoaded: number;
}

/**
 * Create or update a manifest for a DVA. One row per cylinder type per
 * tripNumber. orderedQty is computed at confirm time from pending_dispatch
 * orders on (driverId, assignmentDate). floatQty = totalLoaded - orderedQty.
 *
 * Throws ManifestError on any of:
 *   - DVA not found / wrong tenant (404)
 *   - DVA.status not dispatch_ready (400)
 *   - cylinderTypeId not active / wrong tenant (400)
 *   - totalLoaded < orderedQty (400)
 */
export async function createOrUpdateManifest(
  distributorId: string,
  dvaId: string,
  items: ManifestItemInput[],
  confirmedByUserId: string,
) {
  if (items.length === 0) {
    throw new ManifestError(
      'At least one cylinder type entry is required',
      'NO_ITEMS',
      400,
    );
  }

  const dva = await prisma.driverVehicleAssignment.findFirst({
    where: { id: dvaId, distributorId },
    select: {
      id: true,
      driverId: true,
      assignmentDate: true,
      tripNumber: true,
      status: true,
    },
  });
  if (!dva) {
    throw new ManifestError('DVA not found', 'DVA_NOT_FOUND', 404);
  }
  if (dva.status !== 'dispatch_ready') {
    throw new ManifestError(
      'Cannot modify manifest after dispatch has started',
      'DVA_NOT_DISPATCH_READY',
      400,
    );
  }

  // Validate every cylinder type belongs to this distributor + is active.
  const cylinderTypeIds = items.map((i) => i.cylinderTypeId);
  const cylinderTypes = await prisma.cylinderType.findMany({
    where: {
      id: { in: cylinderTypeIds },
      distributorId,
      isActive: true,
    },
    select: { id: true, typeName: true },
  });
  const validIds = new Set(cylinderTypes.map((ct) => ct.id));
  for (const item of items) {
    if (!validIds.has(item.cylinderTypeId)) {
      throw new ManifestError(
        `Invalid cylinder type: ${item.cylinderTypeId}`,
        'INVALID_CYLINDER_TYPE',
        400,
      );
    }
  }

  // Pull all pending_dispatch order items for (driver, assignmentDate) — used to
  // compute orderedQty per cylinder type. Snapshot at confirm time.
  const pendingItems = await prisma.orderItem.findMany({
    where: {
      cylinderTypeId: { in: cylinderTypeIds },
      order: {
        distributorId,
        driverId: dva.driverId,
        deliveryDate: dva.assignmentDate,
        status: 'pending_dispatch',
        deletedAt: null,
      },
    },
    select: { cylinderTypeId: true, quantity: true },
  });
  const orderedQtyByType = new Map<string, number>();
  for (const oi of pendingItems) {
    orderedQtyByType.set(
      oi.cylinderTypeId,
      (orderedQtyByType.get(oi.cylinderTypeId) ?? 0) + oi.quantity,
    );
  }

  // Validate totalLoaded >= orderedQty for every entry BEFORE writing anything.
  for (const item of items) {
    const orderedQty = orderedQtyByType.get(item.cylinderTypeId) ?? 0;
    if (item.totalLoaded < orderedQty) {
      const typeName =
        cylinderTypes.find((ct) => ct.id === item.cylinderTypeId)?.typeName ??
        item.cylinderTypeId;
      throw new ManifestError(
        `Total loaded (${item.totalLoaded}) cannot be less than already ordered quantity (${orderedQty}) for ${typeName}`,
        'TOTAL_BELOW_ORDERED',
        400,
      );
    }
  }

  // Upsert each row inside a single transaction so partial writes can't leak.
  const writes: Array<Promise<Prisma.BatchPayload | unknown>> = [];
  const upserted = await prisma.$transaction(async (tx) => {
    const rows = [] as Awaited<ReturnType<typeof tx.dVALoadManifest.upsert>>[];
    for (const item of items) {
      const orderedQty = orderedQtyByType.get(item.cylinderTypeId) ?? 0;
      const floatQty = item.totalLoaded - orderedQty;
      const row = await tx.dVALoadManifest.upsert({
        where: {
          dvaId_cylinderTypeId_tripNumber: {
            dvaId,
            cylinderTypeId: item.cylinderTypeId,
            tripNumber: dva.tripNumber,
          },
        },
        create: {
          distributorId,
          dvaId,
          cylinderTypeId: item.cylinderTypeId,
          tripNumber: dva.tripNumber,
          totalLoaded: item.totalLoaded,
          orderedQty,
          floatQty,
          confirmedBy: confirmedByUserId,
        },
        update: {
          totalLoaded: item.totalLoaded,
          orderedQty,
          floatQty,
          confirmedBy: confirmedByUserId,
          confirmedAt: new Date(),
        },
      });
      rows.push(row);
    }
    return rows;
  });
  void writes;
  return upserted;
}

/**
 * All manifest rows for a DVA, across all trip numbers. Includes cylinderType.
 * Empty array if no manifest entered yet.
 */
export async function getManifestForDVA(distributorId: string, dvaId: string) {
  // Verify tenant via DVA first — refuse cross-tenant reads even before hitting
  // the manifest table.
  const dva = await prisma.driverVehicleAssignment.findFirst({
    where: { id: dvaId, distributorId },
    select: { id: true },
  });
  if (!dva) {
    throw new ManifestError('DVA not found', 'DVA_NOT_FOUND', 404);
  }
  return prisma.dVALoadManifest.findMany({
    where: { dvaId, distributorId },
    include: { cylinderType: { select: { id: true, typeName: true } } },
    orderBy: [{ tripNumber: 'asc' }, { confirmedAt: 'asc' }],
  });
}

/**
 * Available fulls for a driver on their current active trip.
 *
 *   availableFulls(type) =
 *       manifest.totalLoaded(type)
 *     − Σ OrderItem.quantity  WHERE order.tripNumber = effectiveTrip
 *                              ∧ status ∈ {pending_dispatch, preflight_in_progress, pending_delivery}
 *     − Σ OrderItem.deliveredQuantity WHERE order.tripNumber = effectiveTrip
 *                              ∧ status ∈ {delivered, modified_delivered}
 *
 * Returns 0 if there's no active DVA, no manifest for the active trip, or no
 * manifest row for the requested cylinderType. NEVER returns a negative number
 * (clamped at 0).
 *
 * `excludeOrderId` skips that order's contribution to the in-flight sums (used
 * when checking availability for an existing-order edit).
 */
export async function getAvailableFullsForDriver(
  distributorId: string,
  driverId: string,
  cylinderTypeId: string,
  excludeOrderId?: string,
): Promise<number> {
  // Resolve "today" to the same UTC day boundary the DVA filter uses elsewhere
  // (driversVehicles.ts:411 uses startOfUtcDay). We inline it here to avoid
  // importing yet another helper from routes.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const dva = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId,
      distributorId,
      assignmentDate: today,
      status: { not: 'cancelled' },
    },
    orderBy: { tripNumber: 'desc' },
    select: { id: true, tripNumber: true, status: true, isReconciled: true },
  });
  if (!dva) return 0;
  if (dva.isReconciled || dva.status === 'cancelled') return 0;

  const effectiveTrip = await resolveEffectiveTripNumber(
    distributorId,
    driverId,
    today,
    dva.tripNumber,
  );

  const manifestRow = await prisma.dVALoadManifest.findUnique({
    where: {
      dvaId_cylinderTypeId_tripNumber: {
        dvaId: dva.id,
        cylinderTypeId,
        tripNumber: effectiveTrip,
      },
    },
    select: { totalLoaded: true },
  });
  if (!manifestRow) return 0;

  // In-flight: pending_dispatch / preflight_in_progress / pending_delivery
  const IN_FLIGHT_STATUSES = [
    'pending_dispatch',
    'preflight_in_progress',
    'pending_delivery',
  ] as const;
  const pending = await prisma.orderItem.aggregate({
    where: {
      cylinderTypeId,
      order: {
        distributorId,
        driverId,
        tripNumber: effectiveTrip,
        deliveryDate: today,
        status: { in: [...IN_FLIGHT_STATUSES] },
        deletedAt: null,
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
    },
    _sum: { quantity: true },
  });

  // Delivered: TRIP_CONTENT_STATUSES drops pending_delivery, leaving the
  // terminal {delivered, modified_delivered} set we want here.
  const DELIVERED_STATUSES = TRIP_CONTENT_STATUSES.filter(
    (s) => s !== 'pending_delivery',
  );
  const delivered = await prisma.orderItem.aggregate({
    where: {
      cylinderTypeId,
      order: {
        distributorId,
        driverId,
        tripNumber: effectiveTrip,
        deliveryDate: today,
        status: { in: [...DELIVERED_STATUSES] },
        deletedAt: null,
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
    },
    _sum: { deliveredQuantity: true },
  });

  const pendingSum = pending._sum.quantity ?? 0;
  const deliveredSum = delivered._sum.deliveredQuantity ?? 0;
  const available = manifestRow.totalLoaded - pendingSum - deliveredSum;
  return Math.max(0, available);
}
