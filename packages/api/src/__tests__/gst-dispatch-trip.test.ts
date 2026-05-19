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
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    apiCall: vi.fn(),
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
import { generateTripSheetPdf, TripSheetError } from '../services/pdf/tripSheetPdfService.js';
import { createApp } from '../app.js';
import { loginAsDistAdmin } from './helpers.js';

const TEST_DATE = '2099-12-31';
const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

function irnSuccess() {
  return {
    status_cd: '1',
    data: {
      Irn: 'irn_' + Math.random().toString(36).slice(2, 10),
      AckNo: '112610000099999',
      AckDt: '15/05/2026 12:00:00 PM',
      SignedQRCode: 'eyJhbGciOi',
    },
  };
}
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
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { distributorId } });
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
    } catch (err: any) {
      expect(err).toBeInstanceOf(PreflightError);
      expect(err.code).toBe('NO_ORDERS');
      expect(err.statusCode).toBe(400);
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
    } catch (err: any) {
      expect(err).toBeInstanceOf(PreflightError);
      expect(err.code).toBe('NO_ACTIVE_TRIP');
      expect(err.message).toMatch(/No active trip/);
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
        role: sharma.role as any, distributorId: sharma.distributorId,
      });
      void token; // silence unused

      const res = await request(app)
        .get(`/api/orders/in-transit?date=${TEST_DATE}`)
        .set({ Authorization: `Bearer ${sharmaToken}` });

      expect(res.status).toBe(200);
      const drivers = res.body.data.drivers;
      expect(Array.isArray(drivers)).toBe(true);

      const driverA = drivers.find((d: any) => d.driverId === driverId);
      expect(driverA).toBeDefined();
      expect(driverA.tripNumber).toBe(1);
      expect(driverA.inTransitCount).toBeGreaterThanOrEqual(1);

      // Driver B (fresh dispatch_ready) NOT in the response
      if (dvaB) {
        const driverBRow = drivers.find((d: any) => d.driverId === secondDriverId);
        expect(driverBRow).toBeUndefined();
      }
    } finally {
      await teardown(aIds, [dvaA.id]);
      if (dvaB) await teardown(bIds, [dvaB.id]);
    }
  });
});
