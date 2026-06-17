/**
 * FLOAT-001 — float-unsold reconciliation credit step (Phase 5).
 *
 * Pins the Step 2.5 wiring in confirmVehicleReconciliation:
 *   - Walk-in orders identified by Order.orderSource='walk_in' (NOT createdAt
 *     heuristic — Issue 3 in pre-flight).
 *   - For each manifest row with floatQty > 0:
 *       soldFromFloat = min(Σ walkIn.deliveredQuantity, floatQty)
 *       unsoldFloat   = floatQty - soldFromFloat
 *     When unsoldFloat > 0: write `cancellation_return` InventoryEvent with
 *     referenceType='dva_load_manifest', eventDate=DVA.assignmentDate.
 *   - Recompute affected cylinder types from assignmentDate (closes
 *     dispatched − returned on the same daily summary row).
 *   - Skip the whole step when INVENTORY_DISPATCH_DEBIT is OFF (no dispatch
 *     event was written → no credit needed; symmetric).
 *
 * Setup uses Bhargava (dist-001, gstMode='disabled') so we sidestep WhiteBooks
 * mocks. Orders are created in pending_dispatch then driven through preflight
 * which (under flag ON) writes the float dispatch event AND transitions orders
 * to pending_delivery. Tests then patch orders → delivered directly to avoid
 * pulling in the full confirmDelivery flow (which also writes delivery
 * events keyed on order — not what we're testing here).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { preflightDispatch } from '../../services/gst/gstPreflightService.js';
import {
  markVehicleReturned,
  confirmVehicleReconciliation,
} from '../../services/deliveryWorkflowService.js';
import { createOrUpdateManifest } from '../../services/dvaManifestService.js';
import { recalculateSummariesFromDate } from '../../services/inventoryService.js';
import { prisma } from '../../lib/prisma.js';
import { ensureDriverVehicleMapping, getOrCreateTestVehicle } from '../helpers.js';
import { startOfUtcDay } from '../../utils/dateOnly.js';

// markVehicleReturned + confirmVehicleReconciliation look up the DVA via
// `assignmentDate: startOfUtcDay()` — hard-coded to TODAY's UTC date.
// helpers.today() uses LOCAL date which can disagree with UTC in IST during
// the late-night/early-morning window. Derive TEST_DATE from startOfUtcDay()
// so every layer (preflight assignmentDate, DVA assignmentDate, deliveryDate,
// eventDate, summaryDate) lives on the SAME UTC calendar day.
const todayMidnight = startOfUtcDay();
const TEST_DATE = `${todayMidnight.getUTCFullYear()}-${String(todayMidnight.getUTCMonth() + 1).padStart(2, '0')}-${String(todayMidnight.getUTCDate()).padStart(2, '0')}`;
const priorMidnight = new Date(todayMidnight);
priorMidnight.setUTCDate(priorMidnight.getUTCDate() - 1);
const nextMidnight = new Date(todayMidnight);
nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
const DIST = 'dist-001';
const TEST_VEHICLE = 'TEST-FLOAT-RECON-D1';

describe('FLOAT-001 — float-unsold reconciliation credit', () => {
  let driverId: string;
  let vehicleId: string;
  let dvaId: string;
  let cylinderTypeId: string;
  let cylinderTypeId2: string;
  let adminUserId: string;
  let customerId: string;

  // Flip flag inside each test (setup.ts deletes it globally per beforeEach).
  beforeEach(() => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'true';
  });

  beforeAll(async () => {
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, status: 'active' },
      select: { id: true },
    });
    driverId = driver.id;
    const vehicle = await getOrCreateTestVehicle(DIST, TEST_VEHICLE);
    vehicleId = vehicle.id;
    const dva = await ensureDriverVehicleMapping({
      distributorId: DIST,
      driverId,
      vehicleId,
      date: TEST_DATE,
    });
    dvaId = dva.id;
    const cts = await prisma.cylinderType.findMany({
      where: { distributorId: DIST, isActive: true },
      select: { id: true },
      take: 2,
    });
    cylinderTypeId = cts[0].id;
    cylinderTypeId2 = cts[1]?.id ?? cts[0].id;
    const admin = await prisma.user.findFirstOrThrow({
      where: { distributorId: DIST, role: 'distributor_admin' },
      select: { id: true },
    });
    adminUserId = admin.id;
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    customerId = customer.id;
  });

  afterEach(async () => {
    const dates = [todayMidnight, priorMidnight, nextMidnight];
    await prisma.inventoryEvent.deleteMany({
      where: { distributorId: DIST, eventDate: { in: dates } },
    });
    await prisma.inventorySummary.deleteMany({
      where: { distributorId: DIST, summaryDate: { in: dates } },
    });
    await prisma.dVALoadManifest.deleteMany({ where: { dvaId } });
    await prisma.cancelledStockEvent.deleteMany({
      where: { distributorId: DIST, vehicleId },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.orderStatusLog.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.order.deleteMany({
      where: { distributorId: DIST, deliveryDate: todayMidnight },
    });
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: {
        status: 'dispatch_ready',
        tripNumber: 1,
        dispatchedAt: null,
        returnedAt: null,
        reconciledAt: null,
        isReconciled: false,
        tripSheetNo: null,
        tripSheetGeneratedAt: null,
        tripSheetNo2: null,
        tripSheetNo2GeneratedAt: null,
      },
    });
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { status: 'idle' },
    });
  });

  /** Helper: dispatch + mark all delivered + return + reconcile in one go. */
  async function fullCycle(opts: {
    manifest: Array<{ cylinderTypeId: string; totalLoaded: number }>;
    walkInOrders?: Array<{ cylinderTypeId: string; quantity: number; deliveredQuantity: number }>;
  }) {
    await createOrUpdateManifest(DIST, dvaId, opts.manifest, adminUserId);
    for (const wi of opts.walkInOrders ?? []) {
      await prisma.order.create({
        data: {
          orderNumber: `TEST-WI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          distributorId: DIST,
          customerId,
          driverId,
          vehicleId,
          orderDate: todayMidnight,
          deliveryDate: todayMidnight,
          status: 'pending_dispatch',
          orderSource: 'walk_in',
          totalAmount: wi.quantity * 500,
          items: {
            create: [
              {
                cylinderTypeId: wi.cylinderTypeId,
                quantity: wi.quantity,
                unitPrice: 500,
                totalPrice: wi.quantity * 500,
              },
            ],
          },
        },
      });
    }
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    // Walk-in orders are now pending_delivery. Mark each as delivered with
    // deliveredQuantity stamped — sidesteps the full confirmDelivery flow
    // (which writes its own delivery events keyed on order; not under test
    // here). The float-unsold computation reads OrderItem.deliveredQuantity
    // directly via the orderSource='walk_in' filter.
    for (const wi of opts.walkInOrders ?? []) {
      const order = await prisma.order.findFirstOrThrow({
        where: {
          distributorId: DIST,
          driverId,
          deliveryDate: todayMidnight,
          status: 'pending_delivery',
          orderSource: 'walk_in',
          items: { some: { cylinderTypeId: wi.cylinderTypeId, quantity: wi.quantity } },
        },
        include: { items: true },
      });
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'delivered', deliveredAt: new Date() },
      });
      for (const item of order.items) {
        if (item.cylinderTypeId === wi.cylinderTypeId) {
          await prisma.orderItem.update({
            where: { id: item.id },
            data: { deliveredQuantity: wi.deliveredQuantity },
          });
        }
      }
    }
    await markVehicleReturned(vehicleId, driverId, DIST);
    return confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });
  }

  it('Float-only trip, all walk-ins delivered → cancellation_return for remaining float', async () => {
    // Loaded 10 fulls; walk-in sold 4 → 6 returned to depot
    await fullCycle({
      manifest: [{ cylinderTypeId, totalLoaded: 10 }],
      walkInOrders: [{ cylinderTypeId, quantity: 4, deliveredQuantity: 4 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(1);
    expect(returnEvents[0].fullsChange).toBe(6);
    expect(returnEvents[0].cylinderTypeId).toBe(cylinderTypeId);
  });

  it('Float-only trip, ALL unsold (no walk-ins) → full floatQty returned', async () => {
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 7 }] });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(1);
    expect(returnEvents[0].fullsChange).toBe(7);
  });

  it('Float-only trip, walk-ins fully consume float → NO cancellation_return event', async () => {
    await fullCycle({
      manifest: [{ cylinderTypeId, totalLoaded: 5 }],
      walkInOrders: [{ cylinderTypeId, quantity: 5, deliveredQuantity: 5 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(0);
  });

  it('Float-only trip, walk-ins exceed float → soldFromFloat clamps at floatQty', async () => {
    // Manifest 5, walk-in delivered 8 (impossible in real flow but tests the
    // Math.min(...) clamp). soldFromFloat = 5, unsoldFloat = 0 → no event.
    await fullCycle({
      manifest: [{ cylinderTypeId, totalLoaded: 5 }],
      walkInOrders: [{ cylinderTypeId, quantity: 8, deliveredQuantity: 8 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(0);
  });

  it('Float-only trip: closingFulls balances after reconciliation (no leakage)', async () => {
    // Pure float, no walk-ins → dispatched=10 then fully returned=10. Closing
    // should equal opening; no fulls leaked from depot accounting.
    // Daily formula (flag ON):
    //   closingFulls = opening − dispatched + returned
    //                = 100 − 10 + 10 = 100
    await prisma.inventoryEvent.create({
      data: {
        distributorId: DIST,
        cylinderTypeId,
        eventType: 'initial_balance',
        fullsChange: 100,
        emptiesChange: 0,
        eventDate: priorMidnight,
        createdBy: adminUserId,
      },
    });
    await recalculateSummariesFromDate(DIST, cylinderTypeId, priorMidnight);

    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 10 }] });
    const summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: DIST,
          cylinderTypeId,
          summaryDate: todayMidnight,
        },
      },
    });
    expect(summary).not.toBeNull();
    expect(summary!.openingFulls).toBe(100);
    expect(summary!.dispatchedQty).toBe(10);
    expect(summary!.cancelledStockQty).toBe(10);
    expect(summary!.closingFulls).toBe(100);
  });

  it('Multi-type manifest: per-type unsold tracked separately', async () => {
    // CT1: loaded 4, walk-in 1 → unsold 3
    // CT2: loaded 6, no walk-in → unsold 6
    await fullCycle({
      manifest: [
        { cylinderTypeId, totalLoaded: 4 },
        { cylinderTypeId: cylinderTypeId2, totalLoaded: 6 },
      ],
      walkInOrders: [{ cylinderTypeId, quantity: 1, deliveredQuantity: 1 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
      orderBy: { fullsChange: 'asc' },
    });
    // If both cylinder types are distinct rows, expect 2. If only one
    // active type exists in this dev DB (single-type tenants), CT1==CT2
    // and the entries collapse to one row with totalLoaded summed.
    if (cylinderTypeId === cylinderTypeId2) {
      expect(returnEvents).toHaveLength(1);
      // Loaded 6 (last write wins on upsert), walk-in delivered 1 → unsold 5
      expect(returnEvents[0].fullsChange).toBe(5);
    } else {
      expect(returnEvents).toHaveLength(2);
      const byType = new Map(returnEvents.map((e) => [e.cylinderTypeId, e.fullsChange]));
      expect(byType.get(cylinderTypeId)).toBe(3);
      expect(byType.get(cylinderTypeId2)).toBe(6);
    }
  });

  it('cancellation_return event references manifest.id, not dvaId', async () => {
    const [manifest] = await Promise.all([
      createOrUpdateManifest(
        DIST,
        dvaId,
        [{ cylinderTypeId, totalLoaded: 3 }],
        adminUserId,
      ),
    ]);
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    await markVehicleReturned(vehicleId, driverId, DIST);
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });
    const event = await prisma.inventoryEvent.findFirstOrThrow({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(event.referenceId).toBe(manifest[0].id);
    expect(event.referenceId).not.toBe(dvaId);
  });

  it('Flag OFF: dispatch event not written → cancellation_return event also skipped', async () => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'false';
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 6 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    await markVehicleReturned(vehicleId, driverId, DIST);
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });
    const dispatchEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(dispatchEvents).toHaveLength(0);
    expect(returnEvents).toHaveLength(0);
  });
});
