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
      // FLOAT-001 (2026-06-18): identify which ID failed AND why so the UI /
      // future debugging can act on the message directly. Three failure modes
      // collapse into INVALID_CYLINDER_TYPE: (a) ID doesn't exist for any
      // tenant, (b) belongs to a different tenant, (c) is_active=false.
      const orphan = await prisma.cylinderType.findUnique({
        where: { id: item.cylinderTypeId },
        select: { id: true, distributorId: true, isActive: true, typeName: true },
      });
      const detail = !orphan
        ? `cylinder type ${item.cylinderTypeId} does not exist`
        : orphan.distributorId !== distributorId
          ? `cylinder type ${item.cylinderTypeId} (${orphan.typeName}) belongs to another tenant`
          : `cylinder type ${item.cylinderTypeId} (${orphan.typeName}) is inactive`;
      throw new ManifestError(
        `Invalid cylinder type: ${detail}`,
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
 *
 * Use this for audit / history views, and from preflight where the just-
 * confirmed manifest is the only row anyway. For the web dispatch panel's
 * "is there a manifest for the trip I'm about to dispatch?" question, use
 * [[getManifestForDVATripCurrent]] instead — it scopes to the DVA's CURRENT
 * tripNumber so a rolled DVA doesn't echo back trip-1's snapshot.
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
 * Manifest rows for a DVA scoped to its CURRENT tripNumber. The web dispatch
 * panel's source of truth — without this, a DVA that rolled trip 1 → trip 2
 * shows trip 1's confirmed manifest in the panel, hides the input fields
 * behind read-only mode, and uses trip 1's orderedQty snapshot for any new
 * totalLoaded computation. See user repro 2026-06-18 ~08:25 IST (dist-002).
 *
 * Returns [] when DVA not found OR no manifest at the current trip.
 * Cross-tenant safe: DVA tenant check before manifest read.
 */
export async function getManifestForDVATripCurrent(
  distributorId: string,
  dvaId: string,
) {
  const dva = await prisma.driverVehicleAssignment.findFirst({
    where: { id: dvaId, distributorId },
    select: { tripNumber: true },
  });
  if (!dva) {
    throw new ManifestError('DVA not found', 'DVA_NOT_FOUND', 404);
  }
  return prisma.dVALoadManifest.findMany({
    where: { dvaId, distributorId, tripNumber: dva.tripNumber },
    include: { cylinderType: { select: { id: true, typeName: true } } },
    orderBy: { confirmedAt: 'asc' },
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
    select: { id: true, status: true, isReconciled: true },
  });
  if (!dva) return 0;
  if (dva.isReconciled || dva.status === 'cancelled') return 0;

  // FLOAT-001 (2026-06-18 #4): availability is per-DVA, NOT per-trip.
  // One DVA = one truck = one float pool that persists across every trip
  // the DVA serves until reconciliation. The original code keyed the
  // manifest lookup on `tripNumber: effectiveTrip` which broke the moment
  // the DVA rolled to a new trip mid-day — manifest stayed at trip 1,
  // lookup at trip 2 returned null, availability collapsed to 0, driver
  // could not create walk-ins despite physical fulls still on the truck.
  // Same bug class as the Step 2.5 rolled-trip fix earlier today.
  //
  // New formula: availableFulls = Σ manifest.floatQty (any trip) − Σ
  // walk-in cylinders already taken from the pool (any trip, any status
  // that consumed the cylinder OUT of the float pool).
  //
  // Why floatQty (not totalLoaded): mid-trip regular orders (added after
  // manifest confirm and dispatched fresh) have their own per-order
  // dispatch event AND are reserved for specific customers. They don't
  // come out of the float pool. The float pool is only for un-named
  // walk-in capacity.
  //
  // Why quantity (not deliveredQuantity): the float pool is debited by
  // what the driver TAKES OUT for a walk-in, regardless of whether the
  // customer ultimately accepted it. Shortfalls flow through the
  // CancelledStockEvent path. Same logic as Step 2.5 fix #3.
  // Earliest (= original) manifest for this DVA + cylinderType. In normal
  // flow there's exactly one row because manifests can only be confirmed
  // when DVA.status='dispatch_ready' (pre-dispatch); the unique key includes
  // tripNumber only because reconciliation could in theory loop you back to
  // dispatch_ready for a fresh load. Take the lowest tripNumber so a
  // hypothetical second manifest after a reconcile-and-redispatch wouldn't
  // accidentally count both pools.
  const manifestRow = await prisma.dVALoadManifest.findFirst({
    where: {
      dvaId: dva.id,
      cylinderTypeId,
      distributorId,
    },
    orderBy: { tripNumber: 'asc' },
    select: { floatQty: true },
  });
  if (!manifestRow) return 0;
  const totalFloat = manifestRow.floatQty;
  if (totalFloat <= 0) return 0;

  const walkInAgg = await prisma.orderItem.aggregate({
    where: {
      cylinderTypeId,
      order: {
        distributorId,
        driverId,
        deliveryDate: today,
        orderSource: 'walk_in',
        status: {
          in: [
            'pending_dispatch',
            'preflight_in_progress',
            'pending_delivery',
            'delivered',
            'modified_delivered',
          ],
        },
        deletedAt: null,
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
    },
    _sum: { quantity: true },
  });
  const walkInTaken = walkInAgg._sum.quantity ?? 0;
  return Math.max(0, totalFloat - walkInTaken);
}
