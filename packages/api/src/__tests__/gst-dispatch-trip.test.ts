/**
 * gst-dispatch-trip.test.ts — WI-065
 *
 * Covers the dispatch state-machine overhaul:
 *   1. NO_ORDERS check fires BEFORE any DVA mutation (the premature
 *      reset bug from the prior investigation).
 *   2. preflightOne stamps order.tripNumber with DVA.tripNumber at the
 *      pending_delivery transition.
 *   3. preflightAddToTrip dispatches new orders on an already-running
 *      trip without bumping tripNumber, and stamps the same tripNumber
 *      on the new orders.
 *   4. preflightAddToTrip rejects when no active trip exists.
 *   5. trip-sheet PDF query uses tripNumber to partition trips (Trip 1
 *      sheet shows only Trip 1 orders, even after Trip 2 dispatched).
 *   6. trip-sheet PDF works AFTER delivery (status filter widened to
 *      include delivered/modified_delivered).
 *   7. /api/orders/in-transit returns per-driver summaries for
 *      loaded_and_dispatched DVAs and excludes fresh-dispatch drivers.
 *
 * All fixtures use TEST_DATE='2099-12-31' per anti-pattern #7 so the
 * service-layer queries (filter by driver+date) never sweep up live
 * dev-DB rows.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original = await orig<typeof import('../services/gst/whitebooksClient.js')>();
  return {
    ...original,
    apiCall: vi.fn(),
    pingEinvoiceSession: vi.fn(async () => undefined), // WI-091 health-probe seam (default alive)
    getCredentials: vi.fn(async () => ({
      clientId: 'EINS-test',
      clientSecret: 'EINS-test-secret',
      username: 'BVMGSP',
      password: 'Wbooks@0142',
      gstin: '29AAGCB1286Q000',
      email: 'test@test.com',
      baseUrl: 'https://apisandbox.whitebooks.in',
    })),
    getAuthToken: vi.fn(async () => 'mock-token'),
  };
});

import { prisma } from '../lib/prisma.js';
import * as whitebooksClient from '../services/gst/whitebooksClient.js';
import {
  preflightDispatch,
  preflightAddToTrip,
  PreflightError,
} from '../services/gst/gstPreflightService.js';
import { generateTripSheetPdf } from '../services/pdf/tripSheetPdfService.js';
import { createApp } from '../app.js';
import { loginAsDistAdmin, getOrCreateTestVehicle } from './helpers.js';
import type { UserRole } from '@gaslink/shared';

/** Row shape from GET /api/orders/in-transit (only fields the tests read). */
interface InTransitDriverRow {
  driverId: string;
  tripNumber: number;
  inTransitCount: number;
  deliveredCount: number;
}

const TEST_DATE = '2099-12-31';
// WI-090: dedicated test vehicle. preflightAddToTrip now sets
// vehicle.status='dispatched' (FIX 1), and preflightDispatch always did —
// so these tests must dispatch a DEDICATED vehicle and reset only it, never
// the SEEDED dist-002 fleet used by live/manual dispatch testing.
// 2026-05-30: see note in gst-preflight.test.ts — RTO regex now requires
// valid Indian plate format before reaching NIC.
const TEST_VEHICLE_D2 = 'KA01-DT-0002';
const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

function ewbGenOk(no = '181012000777') {
  return {
    status_cd: '1',
    data: {
      ewayBillNo: no,
      ewayBillDate: '15/05/2026 12:00:00 PM',
      validUpto: '16/05/2026 11:59:00 PM',
    },
  };
}

/**
 * Seed N pending_dispatch B2C orders for a given driver+date. B2C
 * keeps the GST payload simple (standalone EWB only). Returns the
 * created order IDs.
 */
async function seedB2cOrders(opts: {
  distributorId: string;
  driverId: string;
  vehicleId: string;
  date: string;
  count: number;
}): Promise<string[]> {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: opts.distributorId, customerType: 'B2C', deletedAt: null },
  });
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: opts.distributorId, typeName: '19 KG' },
  });
  const ids: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const order = await prisma.order.create({
      data: {
        distributorId: opts.distributorId,
        customerId: customer.id,
        driverId: opts.driverId,
        vehicleId: opts.vehicleId,
        orderNumber: `TRIP-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(opts.date),
        deliveryDate: new Date(opts.date),
        status: 'pending_dispatch',
        orderType: 'delivery',
        totalAmount: 2000,
        items: {
          create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }],
        },
      },
    });
    ids.push(order.id);
  }
  return ids;
}

async function ensureDva(opts: {
  distributorId: string;
  driverId: string;
  vehicleId: string;
  date: string;
  status?: 'dispatch_ready' | 'loaded_and_dispatched';
  tripNumber?: number;
}) {
  const existing = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId: opts.driverId,
      distributorId: opts.distributorId,
      assignmentDate: new Date(opts.date),
    },
    orderBy: { tripNumber: 'desc' },
  });
  if (existing) {
    return prisma.driverVehicleAssignment.update({
      where: { id: existing.id },
      data: {
        status: opts.status ?? 'dispatch_ready',
        vehicleId: opts.vehicleId,
        ...(opts.tripNumber !== undefined ? { tripNumber: opts.tripNumber } : {}),
        tripSheetNo: null,
        tripSheetNo2: null,
        tripSheetGeneratedAt: null,
        tripSheetNo2GeneratedAt: null,
      },
    });
  }
  return prisma.driverVehicleAssignment.create({
    data: {
      driverId: opts.driverId,
      vehicleId: opts.vehicleId,
      distributorId: opts.distributorId,
      assignmentDate: new Date(opts.date),
      tripNumber: opts.tripNumber ?? 1,
      status: opts.status ?? 'dispatch_ready',
    },
  });
}

async function teardown(orderIds: string[], dvaIds: string[] = []) {
  if (orderIds.length > 0) {
    const invoices = await prisma.invoice.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
    const invIds = invoices.map((i) => i.id);
    await prisma.invoiceRevision.deleteMany({ where: { invoiceId: { in: invIds } } });
    await prisma.gstDocument.deleteMany({ where: { invoiceId: { in: invIds } } });
    await prisma.gstDocument.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.pendingAction.deleteMany({ where: { entityId: { in: [...orderIds, ...invIds] } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: invIds } } });
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  if (dvaIds.length > 0) {
    await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: dvaIds } } });
  }
}

beforeEach(() => apiCallMock.mockReset());

describe('WI-065 — dispatch state machine + Add to Trip', () => {
  let distributorId: string;
  let driverId: string;
  let vehicleId: string;
  let secondDriverId: string;

  beforeAll(async () => {
    // Use dist-002 (Sharma, GST sandbox) so the GST path actually runs.
    distributorId = 'dist-002';
    const drivers = await prisma.driver.findMany({
      where: { distributorId, status: 'active', deletedAt: null },
      orderBy: { driverName: 'asc' },
      take: 2,
    });
    driverId = drivers[0].id;
    secondDriverId = drivers[1]?.id ?? drivers[0].id;
    const vehicle = await getOrCreateTestVehicle(distributorId, TEST_VEHICLE_D2);
    vehicleId = vehicle.id;
  });

  it('Test 1 — NO_ORDERS check fires BEFORE DVA mutation (no premature reset)', async () => {
    // Set up: DVA in loaded_and_dispatched but 0 pending_dispatch orders
    // (the bug scenario: admin clicks Dispatch with no new orders to
    // dispatch on a driver whose previous trip already delivered).
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 2,
    });
    // Pre-stamp a tripSheetNo to verify the reset path didn't clear it.
    await prisma.driverVehicleAssignment.update({
      where: { id: dva.id },
      data: { tripSheetNo: 'CEWB-FROZEN-DO-NOT-CLEAR', tripSheetGeneratedAt: new Date() },
    });

    try {
      await preflightDispatch({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });
      throw new Error('Should have thrown NO_ORDERS');
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      const pfErr = err as PreflightError;
      expect(pfErr.code).toBe('NO_ORDERS');
      expect(pfErr.statusCode).toBe(400);
    }

    // CRITICAL: DVA must be UNTOUCHED.
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: dva.id },
    });
    expect(after.tripNumber).toBe(2);
    expect(after.status).toBe('loaded_and_dispatched');
    expect(after.tripSheetNo).toBe('CEWB-FROZEN-DO-NOT-CLEAR');
    expect(after.tripSheetGeneratedAt).toBeTruthy();
    await teardown([], [dva.id]);
  });

  it('Test 2 — Dispatch stamps tripNumber on each order', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'dispatch_ready', tripNumber: 1,
    });
    const ids = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 2 });
    try {
      apiCallMock
        .mockResolvedValueOnce(ewbGenOk('181012-A-1'))
        .mockResolvedValueOnce(ewbGenOk('181012-A-2'))
        .mockResolvedValueOnce({ status_cd: '1', data: 'CEWB-TRIP-1' }); // gencewb
      const result = await preflightDispatch({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(2);
      const orders = await prisma.order.findMany({ where: { id: { in: ids } }, select: { id: true, tripNumber: true, status: true } });
      expect(orders.every((o) => o.tripNumber === 1)).toBe(true);
      expect(orders.every((o) => o.status === 'pending_delivery')).toBe(true);
    } finally {
      await teardown(ids, [dva.id]);
    }
  });

  it('Test 3 — Add to Trip stamps the SAME tripNumber on new orders, leaves originals untouched', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'dispatch_ready', tripNumber: 1,
    });
    // Trip 1: 2 orders dispatched
    const trip1Ids = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 2 });
    try {
      apiCallMock
        .mockResolvedValueOnce(ewbGenOk('181012-T1-1'))
        .mockResolvedValueOnce(ewbGenOk('181012-T1-2'))
        .mockResolvedValueOnce({ status_cd: '1', data: 'CEWB-TRIP-1' });
      await preflightDispatch({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });

      // Admin assigns 2 more orders → pending_dispatch, driver in flight.
      const trip1State = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(trip1State.status).toBe('loaded_and_dispatched');
      expect(trip1State.tripNumber).toBe(1);

      const addOnIds = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 2 });

      apiCallMock
        .mockResolvedValueOnce(ewbGenOk('181012-T1-3'))
        .mockResolvedValueOnce(ewbGenOk('181012-T1-4'))
        .mockResolvedValueOnce({ status_cd: '1', data: 'CEWB-TRIP-1-ADDITION' });
      const addResult = await preflightAddToTrip({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });
      expect(addResult.summary.succeeded).toBe(2);

      // Add-on orders carry tripNumber=1 (NOT 2)
      const addOnRows = await prisma.order.findMany({
        where: { id: { in: addOnIds } }, select: { tripNumber: true, status: true },
      });
      expect(addOnRows.every((o) => o.tripNumber === 1)).toBe(true);
      expect(addOnRows.every((o) => o.status === 'pending_delivery')).toBe(true);

      // DVA stays on tripNumber=1 — Add to Trip is NOT a new trip
      const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(after.tripNumber).toBe(1);
      expect(after.status).toBe('loaded_and_dispatched');
      expect(after.tripSheetNo).toBe('CEWB-TRIP-1'); // original tripSheetNo preserved
      expect(after.tripSheetNo2).toBe('CEWB-TRIP-1-ADDITION'); // new add-to-trip sheet stored separately

      // Trip 1 original orders untouched (still tripNumber=1, still pending_delivery)
      const trip1Rows = await prisma.order.findMany({
        where: { id: { in: trip1Ids } }, select: { tripNumber: true, status: true },
      });
      expect(trip1Rows.every((o) => o.tripNumber === 1)).toBe(true);
      await teardown([...trip1Ids, ...addOnIds], [dva.id]);
    } catch (err) {
      await teardown(trip1Ids, [dva.id]);
      throw err;
    }
  });

  it('Test 4 — Add to Trip rejects when no active trip (DVA=dispatch_ready)', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'dispatch_ready', tripNumber: 1,
    });
    const ids = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 1 });
    try {
      await preflightAddToTrip({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });
      throw new Error('Should have rejected with NO_ACTIVE_TRIP');
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      const pfErr = err as PreflightError;
      expect(pfErr.code).toBe('NO_ACTIVE_TRIP');
      expect(pfErr.message).toMatch(/No active trip/);
    } finally {
      await teardown(ids, [dva.id]);
    }
  });

  it('Test 5 — Trip sheet PDF filters by tripNumber (Trip 1 sheet excludes Trip 2 orders)', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'dispatch_ready', tripNumber: 1,
    });
    // Trip 1 orders: dispatched + stamped with tripNumber=1
    const trip1Ids = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 2 });
    try {
      apiCallMock
        .mockResolvedValueOnce(ewbGenOk('181012-T1-A'))
        .mockResolvedValueOnce(ewbGenOk('181012-T1-B'))
        .mockResolvedValueOnce({ status_cd: '1', data: 'CEWB-TRIP1' });
      await preflightDispatch({ distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user' });

      // Mark Trip 1 orders as delivered to free the DVA for a Trip 2
      await prisma.order.updateMany({
        where: { id: { in: trip1Ids } },
        data: { status: 'delivered' },
      });

      // Trip 2: new dispatch, DVA bumps to tripNumber=2
      const trip2Ids = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 1 });
      apiCallMock
        .mockResolvedValueOnce(ewbGenOk('181012-T2-A'));
      await preflightDispatch({ distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user' });

      const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(after.tripNumber).toBe(2);

      // The Trip 2 trip-sheet PDF should ONLY include Trip 2 orders.
      // We can't easily diff inside the PDF buffer here, but we can
      // assert that the query filter excludes Trip 1 by re-running it:
      const inTrip2 = await prisma.order.findMany({
        where: {
          distributorId, driverId, deliveryDate: new Date(TEST_DATE), deletedAt: null,
          tripNumber: 2,
          status: { in: ['pending_delivery', 'delivered', 'modified_delivered'] },
        },
        select: { id: true },
      });
      expect(inTrip2.map((o) => o.id).sort()).toEqual(trip2Ids.sort());
      // Trip 1 orders DO have tripNumber=1, not 2
      const trip1Now = await prisma.order.findMany({
        where: { id: { in: trip1Ids } }, select: { tripNumber: true },
      });
      expect(trip1Now.every((o) => o.tripNumber === 1)).toBe(true);

      // PDF generation should succeed for the current trip (tripNumber=2)
      const pdf = await generateTripSheetPdf(dva.id, distributorId);
      expect(pdf.slice(0, 4).toString()).toBe('%PDF');

      await teardown([...trip1Ids, ...trip2Ids], [dva.id]);
    } catch (err) {
      await teardown(trip1Ids, [dva.id]);
      throw err;
    }
  });

  it('Test 6 — Trip sheet PDF generates after all orders delivered (no 400)', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'dispatch_ready', tripNumber: 1,
    });
    const ids = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 1 });
    try {
      apiCallMock.mockResolvedValueOnce(ewbGenOk('181012-DONE-1'));
      await preflightDispatch({ distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user' });

      // Mark all delivered
      await prisma.order.updateMany({
        where: { id: { in: ids } },
        data: { status: 'modified_delivered' },
      });

      // Previously this would throw TripSheetError (400 "No EWB available")
      // because the status filter was pending_delivery-only AND tripSheetNo
      // was null for single-order trips. Now: tripNumber filter picks up
      // the modified_delivered order, the EWB is on its gst_documents,
      // and the PDF renders.
      const pdf = await generateTripSheetPdf(dva.id, distributorId);
      expect(pdf.slice(0, 4).toString()).toBe('%PDF');
    } finally {
      await teardown(ids, [dva.id]);
    }
  });

  it('Test 7 — GET /api/orders/in-transit returns dispatched drivers, skips fresh-dispatch drivers', async () => {
    // Driver A: dispatched (loaded_and_dispatched, in-flight orders)
    const dvaA = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'dispatch_ready', tripNumber: 1,
    });
    const aIds = await seedB2cOrders({ distributorId, driverId, vehicleId, date: TEST_DATE, count: 1 });
    apiCallMock.mockResolvedValueOnce(ewbGenOk('181012-INT-A'));
    await preflightDispatch({ distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user' });

    // Driver B: never dispatched (DVA stays dispatch_ready)
    let dvaB: { id: string } | null = null;
    let bIds: string[] = [];
    if (secondDriverId !== driverId) {
      dvaB = await ensureDva({
        distributorId, driverId: secondDriverId, vehicleId, date: TEST_DATE,
        status: 'dispatch_ready', tripNumber: 1,
      });
      bIds = await seedB2cOrders({ distributorId, driverId: secondDriverId, vehicleId, date: TEST_DATE, count: 1 });
    }

    try {
      const app = createApp();
      const { token } = await loginAsDistAdmin();
      // dist-002 admin login isn't in helpers, so we manually craft a token
      // for dist-002. Actually loginAsDistAdmin returns dist-001 — we need
      // dist-002. Use sharma directly.
      const sharma = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
      const { generateToken } = await import('./helpers.js');
      const sharmaToken = generateToken({
        userId: sharma.id, email: sharma.email,
        role: sharma.role as UserRole, distributorId: sharma.distributorId,
      });
      void token; // silence unused

      const res = await request(app)
        .get(`/api/orders/in-transit?date=${TEST_DATE}`)
        .set({ Authorization: `Bearer ${sharmaToken}` });

      expect(res.status).toBe(200);
      const drivers = res.body.data.drivers;
      expect(Array.isArray(drivers)).toBe(true);

      const driverA = drivers.find((d: InTransitDriverRow) => d.driverId === driverId);
      expect(driverA).toBeDefined();
      expect(driverA.tripNumber).toBe(1);
      expect(driverA.inTransitCount).toBeGreaterThanOrEqual(1);

      // Driver B (fresh dispatch_ready) NOT in the response
      if (dvaB) {
        const driverBRow = drivers.find((d: InTransitDriverRow) => d.driverId === secondDriverId);
        expect(driverBRow).toBeUndefined();
      }
    } finally {
      await teardown(aIds, [dvaA.id]);
      if (dvaB) await teardown(bIds, [dvaB.id]);
    }
  });
});

// ─── WI-067 + WI-068 ─────────────────────────────────────────────────────────

describe('WI-067 — pincode-derived transDistance', () => {
  // Importing here keeps the suite isolated from the WhiteBooks mock
  // (this util has no external dependencies).
  let pinUtil: typeof import('../utils/pincodeDistance.js');
  beforeAll(async () => {
    pinUtil = await import('../utils/pincodeDistance.js');
    pinUtil.__resetPincodeCache();
  });

  it('Bangalore → Hyderabad returns a road-distance estimate inside NIC tolerance', () => {
    // Bangalore (560001, 12.97N 77.59E) to Hyderabad (500016, 17.38N
    // 78.48E). Haversine straight-line ≈ 500km. WI-070 multiplies by
    // 1.15 (road circuity factor) → ≈ 575km. NIC's internal road
    // distance for this pincode pair is ~575km; ±10% window is
    // 517-632km. The post-WI-070 value falls squarely inside.
    //
    // The 2026-05-19 live failure (ORD-MPCCQW4XHLJ) sent 500km on
    // WI-067 code and got NIC 702 because 500 < 517 (below window).
    const km = pinUtil.getTransDistance('560001', '500016');
    const n = parseInt(km, 10);
    expect(n).toBeGreaterThanOrEqual(517);
    expect(n).toBeLessThanOrEqual(632);
  });

  it('Same pincode returns "1" (NIC minimum non-zero)', () => {
    expect(pinUtil.getTransDistance('560001', '560001')).toBe('1');
  });

  it('Unknown pincode pair returns "0" (NIC auto-calc fallback)', () => {
    // 000000 / 999999 are not real Indian PINs — table miss → "0"
    expect(pinUtil.getTransDistance('000000', '999999')).toBe('0');
  });

  it('Intra-city same-metro returns small distance (≤ 20 km)', () => {
    // Both 560001 and 560041 are Bangalore — same centroid in our
    // hand-curated table, so Haversine = 0, ceil = 0, floored at 1.
    // Real road distance is ~5km. Test asserts the upper bound to
    // catch regressions like sending an inter-state value here.
    const km = pinUtil.getTransDistance('560001', '560041');
    const n = parseInt(km, 10);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(20);
  });

  it('Empty / null pincodes return "0" (defensive)', () => {
    expect(pinUtil.getTransDistance('', '500016')).toBe('0');
    expect(pinUtil.getTransDistance(null, '500016')).toBe('0');
    expect(pinUtil.getTransDistance('560001', undefined)).toBe('0');
  });
});

describe('WI-068 — DVA auto-reset + Add-to-Trip in-flight gate', () => {
  let distributorId: string;
  let driverId: string;
  let vehicleId: string;
  let orderService: typeof import('../services/orderService.js');

  beforeAll(async () => {
    distributorId = 'dist-002';
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId, status: 'active', deletedAt: null },
      orderBy: { driverName: 'asc' },
    });
    driverId = driver.id;
    const vehicle = await getOrCreateTestVehicle(distributorId, TEST_VEHICLE_D2);
    vehicleId = vehicle.id;
    orderService = await import('../services/orderService.js');
  });

  /**
   * Build an order already in pending_delivery with a stamped tripNumber.
   * Skips the full dispatch flow because this suite only exercises
   * confirmDelivery — whatever pre-delivery state we put the rows in
   * is sufficient for the auto-reset path.
   */
  async function seedInFlightOrder(opts: { tripNumber: number; deliveredQty?: number }) {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId, customerType: 'B2C', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId, typeName: '19 KG' },
    });
    const order = await prisma.order.create({
      data: {
        distributorId,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderNumber: `WI68-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_delivery',
        orderType: 'delivery',
        tripNumber: opts.tripNumber,
        totalAmount: 2000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
      },
    });
    return { orderId: order.id, customerId: customer.id, cylinderTypeId: cyl.id };
  }

  it('WI-096b: DVA STAYS loaded_and_dispatched after the last delivery (roll deferred to dispatch)', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 5,
    });
    const o1 = await seedInFlightOrder({ tripNumber: 5 });
    const o2 = await seedInFlightOrder({ tripNumber: 5 });
    try {
      // Deliver order 1 (one still in-flight)
      await orderService.confirmDelivery(o1.orderId, distributorId, 'test-user', {
        items: [{ cylinderTypeId: o1.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 0 }],
      });
      const dvaMid = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(dvaMid.status).toBe('loaded_and_dispatched');

      // Deliver order 2 (the last one) → WI-096b: DVA stays loaded_and_dispatched
      // at the same tripNumber (the roll now happens at the NEXT dispatch, not
      // here — preserving the Mark-Returned flow + timeline).
      await orderService.confirmDelivery(o2.orderId, distributorId, 'test-user', {
        items: [{ cylinderTypeId: o2.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 0 }],
      });
      const dvaAfter = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(dvaAfter.status).toBe('loaded_and_dispatched');
      expect(dvaAfter.tripNumber).toBe(5);
    } finally {
      await teardown([o1.orderId, o2.orderId], [dva.id]);
    }
  });

  it('Auto-reset: DVA stays loaded_and_dispatched when other orders remain in flight', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 6,
    });
    const o1 = await seedInFlightOrder({ tripNumber: 6 });
    const o2 = await seedInFlightOrder({ tripNumber: 6 });
    const o3 = await seedInFlightOrder({ tripNumber: 6 });
    try {
      await orderService.confirmDelivery(o1.orderId, distributorId, 'test-user', {
        items: [{ cylinderTypeId: o1.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 0 }],
      });
      // 2 orders still pending_delivery → DVA stays loaded_and_dispatched
      const dvaAfter = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(dvaAfter.status).toBe('loaded_and_dispatched');
    } finally {
      await teardown([o1.orderId, o2.orderId, o3.orderId], [dva.id]);
    }
  });

  it('Add-to-Trip is blocked (409 NO_ACTIVE_TRIP) when no orders are in flight', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 7,
    });
    // No in-flight orders. Seed 1 pending_dispatch that the request
    // wants to add. The gate must fire BEFORE the NO_ORDERS check —
    // we have new orders, just no active trip to add them to.
    const newIds = await seedB2cOrders({
      distributorId, driverId, vehicleId, date: TEST_DATE, count: 1,
    });
    try {
      await preflightAddToTrip({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });
      throw new Error('Should have thrown NO_ACTIVE_TRIP');
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      const pfErr = err as PreflightError;
      expect(pfErr.code).toBe('NO_ACTIVE_TRIP');
      expect(pfErr.statusCode).toBe(409);
      expect(pfErr.message).toMatch(/in transit/i);
    } finally {
      await teardown(newIds, [dva.id]);
    }
  });
});

// ─── WI-069 ──────────────────────────────────────────────────────────────────

describe('WI-069 — /in-transit excludes stale DVAs (0 in-flight orders)', () => {
  let distributorId: string;
  let driverId: string;
  let vehicleId: string;
  let sharmaToken: string;

  beforeAll(async () => {
    distributorId = 'dist-002';
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId, status: 'active', deletedAt: null },
      orderBy: { driverName: 'asc' },
    });
    driverId = driver.id;
    const vehicle = await getOrCreateTestVehicle(distributorId, TEST_VEHICLE_D2);
    vehicleId = vehicle.id;
    const sharma = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
    const { generateToken } = await import('./helpers.js');
    sharmaToken = generateToken({
      userId: sharma.id, email: sharma.email,
      role: sharma.role as UserRole, distributorId: sharma.distributorId,
    });
  });

  /**
   * Build a delivered order (no in-flight effect) stamped with a tripNumber.
   * Models the post-WI-068-merge scenario: DVA stuck loaded_and_dispatched
   * from pre-WI-068 deliveries, all orders already at delivered/modified_delivered.
   */
  async function seedDeliveredOrder(tripNumber: number) {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId, customerType: 'B2C', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId, typeName: '19 KG' },
    });
    const order = await prisma.order.create({
      data: {
        distributorId,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderNumber: `WI69-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'delivered',
        orderType: 'delivery',
        tripNumber,
        deliveredAt: new Date(),
        totalAmount: 2000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
      },
    });
    return order.id;
  }

  async function seedPendingDeliveryOrder(tripNumber: number) {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId, customerType: 'B2C', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId, typeName: '19 KG' },
    });
    const order = await prisma.order.create({
      data: {
        distributorId,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderNumber: `WI69P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_delivery',
        orderType: 'delivery',
        tripNumber,
        totalAmount: 2000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
      },
    });
    return order.id;
  }

  it('Test 1 — /in-transit excludes stale DVA where all orders already delivered', async () => {
    // Simulates the live 2026-05-19 incident: DVA stuck loaded_and_dispatched
    // from deliveries that ran on code pre-dating WI-068's auto-reset block.
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 10,
    });
    const d1 = await seedDeliveredOrder(10);
    const d2 = await seedDeliveredOrder(10);
    try {
      const app = createApp();
      const res = await request(app)
        .get(`/api/orders/in-transit?date=${TEST_DATE}`)
        .set({ Authorization: `Bearer ${sharmaToken}` });

      expect(res.status).toBe(200);
      const drivers = res.body.data.drivers;
      const row = drivers.find((d: InTransitDriverRow) => d.driverId === driverId);
      expect(row).toBeUndefined();
    } finally {
      await teardown([d1, d2], [dva.id]);
    }
  });

  it('Test 2 — /in-transit includes active DVA with at least one order in flight', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 11,
    });
    const delivered = await seedDeliveredOrder(11);
    const inFlight = await seedPendingDeliveryOrder(11);
    try {
      const app = createApp();
      const res = await request(app)
        .get(`/api/orders/in-transit?date=${TEST_DATE}`)
        .set({ Authorization: `Bearer ${sharmaToken}` });

      expect(res.status).toBe(200);
      const drivers = res.body.data.drivers;
      const row = drivers.find((d: InTransitDriverRow) => d.driverId === driverId);
      expect(row).toBeDefined();
      expect(row.inTransitCount).toBe(1);
      expect(row.deliveredCount).toBeGreaterThanOrEqual(1);
      expect(row.tripNumber).toBe(11);
    } finally {
      await teardown([delivered, inFlight], [dva.id]);
    }
  });

  it('Test 3 — stale DVA + new pending_dispatch: Dispatch self-heals (bumps tripNumber, stamps new order)', async () => {
    // After WI-069's /in-transit filter hides this stuck driver, the
    // Ready-to-Dispatch UI surfaces them. Admin clicks Dispatch ▶ → the
    // existing self-heal at gstPreflightService.ts:171-188 bumps
    // tripNumber and dispatches the new order on the new trip.
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 12,
    });
    // Pre-stamp stale tripSheets to verify the self-heal clears them.
    await prisma.driverVehicleAssignment.update({
      where: { id: dva.id },
      data: {
        tripSheetNo: 'CEWB-STALE-TRIP-12',
        tripSheetGeneratedAt: new Date(),
      },
    });
    const oldDelivered = await seedDeliveredOrder(12);
    const newOrderIds = await seedB2cOrders({
      distributorId, driverId, vehicleId, date: TEST_DATE, count: 1,
    });
    try {
      apiCallMock.mockResolvedValueOnce(ewbGenOk('181012-HEAL-1'));
      const result = await preflightDispatch({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(1);
      expect(result.dispatched).toBe(true);

      // DVA: bumped tripNumber, stale trip sheet cleared, status back to
      // loaded_and_dispatched for the FRESH trip.
      const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(after.tripNumber).toBe(13);
      expect(after.status).toBe('loaded_and_dispatched');
      expect(after.tripSheetNo).toBeNull();

      // New order stamped with the BUMPED tripNumber, transitioned to
      // pending_delivery.
      const newOrder = await prisma.order.findUniqueOrThrow({ where: { id: newOrderIds[0] } });
      expect(newOrder.tripNumber).toBe(13);
      expect(newOrder.status).toBe('pending_delivery');

      // Old delivered order untouched at tripNumber=12
      const oldOrder = await prisma.order.findUniqueOrThrow({ where: { id: oldDelivered } });
      expect(oldOrder.tripNumber).toBe(12);
      expect(oldOrder.status).toBe('delivered');
    } finally {
      await teardown([oldDelivered, ...newOrderIds], [dva.id]);
    }
  });
});

// ─── WI-070 ──────────────────────────────────────────────────────────────────

describe('WI-070 — confirmDelivery bumps tripNumber + EWB road circuity', () => {
  let distributorId: string;
  let driverId: string;
  let vehicleId: string;
  let orderService: typeof import('../services/orderService.js');

  beforeAll(async () => {
    distributorId = 'dist-002';
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId, status: 'active', deletedAt: null },
      orderBy: { driverName: 'asc' },
    });
    driverId = driver.id;
    const vehicle = await getOrCreateTestVehicle(distributorId, TEST_VEHICLE_D2);
    vehicleId = vehicle.id;
    orderService = await import('../services/orderService.js');
  });

  async function seedInFlight(tripNumber: number) {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId, customerType: 'B2C', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId, typeName: '19 KG' },
    });
    const order = await prisma.order.create({
      data: {
        distributorId,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderNumber: `WI70-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_delivery',
        orderType: 'delivery',
        tripNumber,
        totalAmount: 2000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
      },
    });
    return { orderId: order.id, cylinderTypeId: cyl.id };
  }

  it('Test 1 — WI-096b: last delivery does NOT roll/clear (trip sheet preserved; roll deferred to dispatch)', async () => {
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 1,
    });
    // Pre-stamp the trip sheet — WI-096b must NOT clear it at delivery time.
    await prisma.driverVehicleAssignment.update({
      where: { id: dva.id },
      data: {
        tripSheetNo: 'CEWB-TRIP-1',
        tripSheetGeneratedAt: new Date(),
        tripSheetNo2: 'CEWB-TRIP-1-ADDITION',
        tripSheetNo2GeneratedAt: new Date(),
      },
    });
    const o1 = await seedInFlight(1);
    const o2 = await seedInFlight(1);
    try {
      // Deliver order 1 — DVA stays loaded_and_dispatched (still 1 in flight)
      await orderService.confirmDelivery(o1.orderId, distributorId, 'test-user', {
        items: [{ cylinderTypeId: o1.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 0 }],
      });
      const dvaMid = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(dvaMid.status).toBe('loaded_and_dispatched');
      expect(dvaMid.tripNumber).toBe(1);
      expect(dvaMid.tripSheetNo).toBe('CEWB-TRIP-1');

      // Deliver order 2 (the last) — WI-096b: no roll. DVA stays
      // loaded_and_dispatched at tripNumber 1; trip sheet preserved (the next
      // dispatch performs the roll + clear, not the delivery).
      await orderService.confirmDelivery(o2.orderId, distributorId, 'test-user', {
        items: [{ cylinderTypeId: o2.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 0 }],
      });
      const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(after.status).toBe('loaded_and_dispatched');
      expect(after.tripNumber).toBe(1);
      expect(after.tripSheetNo).toBe('CEWB-TRIP-1');
      expect(after.tripSheetNo2).toBe('CEWB-TRIP-1-ADDITION');
    } finally {
      await teardown([o1.orderId, o2.orderId], [dva.id]);
    }
  });

  it('Test 2 — next dispatch uses the bumped tripNumber (no double-increment)', async () => {
    // Setup: DVA already at tripNumber=5, dispatch_ready (as if WI-070
    // auto-reset just fired on the previous trip).
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'dispatch_ready', tripNumber: 5,
    });
    const newOrderIds = await seedB2cOrders({
      distributorId, driverId, vehicleId, date: TEST_DATE, count: 1,
    });
    try {
      apiCallMock.mockResolvedValueOnce(ewbGenOk('181012-T5-A'));
      await preflightDispatch({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });

      // The new order should be stamped with the CURRENT tripNumber (5),
      // not a bumped one (6). The bump already happened on the prior
      // trip's last delivery.
      const order = await prisma.order.findUniqueOrThrow({ where: { id: newOrderIds[0] } });
      expect(order.tripNumber).toBe(5);
      expect(order.status).toBe('pending_delivery');

      // DVA holds at 5 (loaded_and_dispatched for the live trip). No
      // second increment from preflightDispatch's legacy branch — that
      // branch is gated on `status === 'loaded_and_dispatched'` and
      // the row was `dispatch_ready` at call time.
      const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(after.tripNumber).toBe(5);
      expect(after.status).toBe('loaded_and_dispatched');
    } finally {
      await teardown(newOrderIds, [dva.id]);
    }
  });

  it('Test 3 — Bangalore → Hyderabad transDistance sits inside NIC tolerance window', async () => {
    // Pre-WI-067: '1' → NIC 702 (way below window)
    // WI-067:     '500' (raw Haversine) → NIC 702 (still below 517km window)
    // WI-070:     '575' (Haversine × 1.15) → INSIDE 517-632km window
    const pinUtil = await import('../utils/pincodeDistance.js');
    pinUtil.__resetPincodeCache();
    const km = pinUtil.getTransDistance('560001', '500016');
    const n = parseInt(km, 10);
    expect(n).toBeGreaterThanOrEqual(517);
    expect(n).toBeLessThanOrEqual(632);
  });

  it('Test 4 — transDistance road-circuity caps at 4000 km (NIC hard max)', async () => {
    const { _roadDistanceFromHaversine } = await import('../utils/pincodeDistance.js');
    // 1km Haversine → ceil(1.15) = 2 (cleared the floor-at-1)
    expect(_roadDistanceFromHaversine(1)).toBe(2);
    // 500km Haversine → 575 (Bangalore-Hyderabad shape)
    expect(_roadDistanceFromHaversine(500)).toBe(575);
    // 3000km Haversine → 3450 (real-world reachable in India: e.g. Trivandrum-Srinagar)
    expect(_roadDistanceFromHaversine(3000)).toBe(3450);
    // 4000km Haversine → 4600 raw, capped to 4000
    expect(_roadDistanceFromHaversine(4000)).toBe(4000);
    // 5000km Haversine (synthetic) → capped to 4000
    expect(_roadDistanceFromHaversine(5000)).toBe(4000);
    // Floor at 1 still applies
    expect(_roadDistanceFromHaversine(0)).toBe(1);
  });

  it('Test 5 — legacy recovery branch increments by exactly 1 (no double-bump)', async () => {
    // Simulate a stuck DVA: status=loaded_and_dispatched but 0 in-flight
    // orders. This branch should fire and bump tripNumber by 1 — NOT 2.
    // Critical regression guard: the WI-070 confirmDelivery auto-reset
    // does NOT fire on this path because we don't go through
    // confirmDelivery — we go straight to preflightDispatch on a stuck
    // row. Only the legacy branch in gstPreflightService should bump.
    const dva = await ensureDva({
      distributorId, driverId, vehicleId, date: TEST_DATE,
      status: 'loaded_and_dispatched', tripNumber: 9,
    });
    // No in-flight orders. New pending_dispatch order ready.
    const newOrderIds = await seedB2cOrders({
      distributorId, driverId, vehicleId, date: TEST_DATE, count: 1,
    });
    try {
      apiCallMock.mockResolvedValueOnce(ewbGenOk('181012-LEGACY-1'));
      await preflightDispatch({
        distributorId, driverId, assignmentDate: TEST_DATE, userId: 'test-user',
      });

      // The legacy branch fired exactly once: 9 → 10. Order stamped with 10.
      const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
      expect(after.tripNumber).toBe(10);
      expect(after.status).toBe('loaded_and_dispatched');

      const order = await prisma.order.findUniqueOrThrow({ where: { id: newOrderIds[0] } });
      expect(order.tripNumber).toBe(10);
    } finally {
      await teardown(newOrderIds, [dva.id]);
    }
  });
});

// WI-090: reset the dedicated test vehicle so its dispatched state (set by
// preflightDispatch / preflightAddToTrip during these tests) never leaks into
// the shared dev DB's Fleet view. Scoped strictly to the test vehicle by
// vehicleNumber — the seeded fleet is never touched.
afterAll(async () => {
  await prisma.vehicle.updateMany({
    where: { distributorId: 'dist-002', vehicleNumber: TEST_VEHICLE_D2 },
    data: { status: 'idle' },
  });
});
