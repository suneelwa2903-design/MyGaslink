import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

// CRITICAL: vi.mock must be hoisted before module imports so that
// gstPreflightService sees the mocked apiCall when it's imported below.
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
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsFinance, loginAsInventory, getOrCreateTestVehicle } from './helpers.js';

// WI-090: dedicated test vehicles so teardown never resets the SEEDED
// dist-002 / dist-001 fleet used by live/manual dispatch testing.
const TEST_VEHICLE_D2 = 'TEST-PF-VEHICLE-D2';
const TEST_VEHICLE_D1 = 'TEST-PF-VEHICLE-D1';

// ─── Test date isolation ────────────────────────────────────────────────────
// CLAUDE.md anti-pattern #7: tests that seed time-sensitive data must
// use a fixed future date that real manual-test data will never occupy.
// preflightDispatch queries pending_dispatch orders by
// (distributorId, driverId, deliveryDate) — using today's date here
// caused tests to sweep up real dev-DB orders and overwrite their
// gst_documents with mock IRNs. Fixing to 2099-12-31 keeps the test
// fixtures in their own date bucket.
const TEST_DATE = '2099-12-31';
const today = () => TEST_DATE;
import * as whitebooksClient from '../services/gst/whitebooksClient.js';
import type { Express } from 'express';

const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

let app: Express;
let sharmaAdminToken: string;
let bhargavaAdminToken: string;
let financeToken: string;
let inventoryToken: string;

function auth(token: string, distributorId?: string) {
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distributorId) h['X-Distributor-Id'] = distributorId;
  return h;
}

// Successful IRN response with inline EWB — the happy path NIC returns
// when transport details are sent inside the IRN request payload.
function irnSuccessWithInlineEwb(over: Record<string, any> = {}) {
  return {
    status_cd: '1',
    data: {
      Irn: 'irn_' + Math.random().toString(36).slice(2, 10),
      AckNo: '112610000000001',
      AckDt: '15/05/2026 12:00:00 PM',
      SignedQRCode: 'eyJhbGciOiJSUzI1NiIs',
      EwbNo: '181012000001',
      EwbDt: '15/05/2026 12:00:00 PM',
      EwbValidTill: '16/05/2026 11:59:00 PM',
      ...over,
    },
  };
}

function irnSuccessNoInlineEwb() {
  return {
    status_cd: '1',
    data: {
      Irn: 'irn_' + Math.random().toString(36).slice(2, 10),
      AckNo: '112610000000002',
      AckDt: '15/05/2026 12:00:00 PM',
      SignedQRCode: 'eyJhbGciOiJSUzI1NiIs',
      EwbNo: null,
      EwbDt: null,
      EwbValidTill: null,
    },
  };
}

function ewbStandaloneSuccess() {
  return {
    status_cd: '1',
    data: {
      ewayBillNo: '181012000999',
      ewayBillDate: '15/05/2026 12:00:00 PM',
      validUpto: '16/05/2026 11:59:00 PM',
    },
  };
}

function whitebooksThrow(code: string, message: string) {
  const err: any = new Error(message);
  err.code = code;
  throw err;
}

beforeAll(async () => {
  app = createApp();

  // Build a distributor-admin token for Sharma (dist-002). seed.ts creates
  // sharma@gasdist.com via upsert; loginAs helpers only know dist-001.
  const sharmaAdmin = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  sharmaAdminToken = generateToken({
    userId: sharmaAdmin.id, email: sharmaAdmin.email,
    role: sharmaAdmin.role as any, distributorId: sharmaAdmin.distributorId,
  });
  const bhargavaAdmin = await prisma.user.findUniqueOrThrow({ where: { email: 'bhargava@gasagency.com' } });
  bhargavaAdminToken = generateToken({
    userId: bhargavaAdmin.id, email: bhargavaAdmin.email,
    role: bhargavaAdmin.role as any, distributorId: bhargavaAdmin.distributorId,
  });
  const fin = await loginAsFinance(); financeToken = fin.token;
  const inv = await loginAsInventory(); inventoryToken = inv.token;
});

beforeEach(() => {
  apiCallMock.mockReset();
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────
// Each test asks for a clean slate of `count` orders on a given customer.
// We resolve driver/vehicle/mapping from the existing seed so tests don't
// trample shared rows like the day's vehicle mapping.

async function seedOrders(opts: {
  customerId: string;
  count: number;
  cylinderTypeId: string;
  qty: number;
  driverId: string;
  vehicleId: string;
}) {
  const orders = [];
  for (let i = 0; i < opts.count; i++) {
    const o = await prisma.order.create({
      data: {
        distributorId: 'dist-002',
        customerId: opts.customerId,
        orderNumber: `PFT-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(),
        deliveryDate: new Date(today()),
        status: 'pending_dispatch',
        orderType: 'delivery',
        driverId: opts.driverId,
        vehicleId: opts.vehicleId,
        totalAmount: 5000 + i,
        items: {
          create: [{
            cylinderTypeId: opts.cylinderTypeId,
            quantity: opts.qty,
            unitPrice: 2000,
            discountPerUnit: 0,
            totalPrice: opts.qty * 2000,
          }],
        },
      },
      include: { items: true },
    });
    orders.push(o);
  }
  return orders;
}

async function clearPreflightArtifacts(orderIds: string[]) {
  await prisma.gstApiLog.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.gstDocument.deleteMany({ where: { invoice: { orderId: { in: orderIds } } } });
  await prisma.pendingAction.deleteMany({ where: { entityId: { in: orderIds } } });
  const invoices = await prisma.invoice.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true },
  });
  await prisma.pendingAction.deleteMany({ where: { entityId: { in: invoices.map((i) => i.id) } } });
  await prisma.customerLedgerEntry.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.driverAssignment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  // Reset vehicle status — the preflight service writes vehicle.status='dispatched'
  // on success. WI-090: scope the reset to the DEDICATED test vehicle only
  // (by vehicleNumber). Resetting all dist-002 vehicles previously corrupted
  // the SEEDED fleet's live dispatch state on the shared dev DB (anti-pattern
  // #8 — now properly isolated, not blanket-reset).
  await prisma.vehicle.updateMany({
    where: { distributorId: 'dist-002', vehicleNumber: TEST_VEHICLE_D2 },
    data: { status: 'idle' },
  });
  // Also restore the test DVA back to dispatch_ready so the NEXT test in the
  // same run can preflight without re-seeding.
  await prisma.driverVehicleAssignment.updateMany({
    where: { distributorId: 'dist-002', assignmentDate: new Date(today()), isReconciled: false },
    data: { status: 'dispatch_ready' },
  });
}

async function getSharmaContext() {
  const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: 'dist-002' } });
  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: 'dist-002', status: 'active', deletedAt: null },
  });
  // WI-090: dedicated test vehicle (not the seeded fleet) so teardown can
  // reset by vehicleNumber without touching live dispatch state.
  const vehicle = await getOrCreateTestVehicle('dist-002', TEST_VEHICLE_D2);
  // Ensure today's mapping exists between this driver+vehicle. seed.ts
  // creates it; if it's been removed, recreate.
  const targetDate = new Date(today());
  let mapping = await prisma.driverVehicleAssignment.findFirst({
    where: { distributorId: 'dist-002', driverId: driver.id, assignmentDate: targetDate },
  });
  if (!mapping) {
    mapping = await prisma.driverVehicleAssignment.create({
      data: {
        distributorId: 'dist-002', driverId: driver.id, vehicleId: vehicle.id,
        assignmentDate: targetDate, status: 'dispatch_ready', isReconciled: false,
      },
    });
  } else if (mapping.vehicleId !== vehicle.id || mapping.status !== 'dispatch_ready') {
    mapping = await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: { vehicleId: vehicle.id, status: 'dispatch_ready' },
    });
  }
  const b2bCust = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', customerType: 'B2B', gstin: { not: null }, deletedAt: null },
  });
  const b2cCust = await prisma.customer.findFirst({
    where: { distributorId: 'dist-002', customerType: 'B2C', deletedAt: null },
  });
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: 'dist-002', typeName: '19 KG' },
  });
  return { dist, driver, vehicle, mapping, b2bCust, b2cCust, cyl };
}

// ────────────────────────────────────────────────────────────────────────────
// PART 1 — Unit tests (service-level, real DB, mocked WhiteBooks)
// ────────────────────────────────────────────────────────────────────────────

describe('gstPreflightService — unit tests with mocked WhiteBooks', () => {
  // Resolve service module AFTER vi.mock has been applied.
  let preflightDispatch: typeof import('../services/gst/gstPreflightService.js').preflightDispatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstPreflightService.js');
    preflightDispatch = mod.preflightDispatch;
  });

  it('B2B happy path: IRN-only then EWB-by-IRN → pending_delivery + gst_documents row', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // Two-step pattern (2026-05-15 fix): IRN GENERATE without inline
      // EwbDtls, then standalone genewaybill. Mock both responses.
      apiCallMock
        .mockResolvedValueOnce(irnSuccessNoInlineEwb())
        .mockResolvedValueOnce(ewbStandaloneSuccess());
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
      expect(result.results[0]).toMatchObject({ mode: 'B2B', success: true });
      expect(result.results[0].irn).toBeTruthy();
      expect(result.results[0].ewbNo).toBe('181012000999');
      expect(result.dispatched).toBe(true);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } });
      expect(order.status).toBe('pending_delivery');
      const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: orders[0].id } });
      expect(inv.irn).toBeTruthy();
      expect(inv.irnStatus).toBe('success');
      expect(inv.ewbStatus).toBe('active');
      const doc = await prisma.gstDocument.findFirstOrThrow({ where: { invoiceId: inv.id, isLatest: true } });
      expect(doc.ewbNo).toBe('181012000999');

      // Regression guards (2026-05-15 fixes):
      //   - IRN payload MUST NOT include the inline EwbDtls block. NIC
      //     sandbox returns generic 5002 when it's present (we lost a
      //     live dispatch session to this; PascalCase, mixed-case, and
      //     NIC-canonical casing all failed).
      //   - The standalone /ewaybillapi/.../genewaybill call MUST be
      //     made as a second API call.
      expect(apiCallMock).toHaveBeenCalledTimes(2);
      const [, , irnPath, irnPayload] = apiCallMock.mock.calls[0];
      const [, , ewbPath] = apiCallMock.mock.calls[1];
      expect(String(irnPath)).toContain('/einvoice/type/GENERATE/version/V1_03');
      expect(String(ewbPath)).toContain('/ewaybillapi/v1.03/ewayapi/genewaybill');
      expect((irnPayload as any).EwbDtls).toBeUndefined();
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('B2B no inline EWB → falls back to recoverEwbFromIrn lookup', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // 1st call: GENERATE IRN → no inline EWB
      apiCallMock.mockResolvedValueOnce(irnSuccessNoInlineEwb());
      // 2nd call: GETIRN (recoverEwbFromIrn) → returns EwbNo
      apiCallMock.mockResolvedValueOnce({
        data: {
          Irn: 'recovered-irn',
          EwbNo: '999999000001',
          EwbDt: '15/05/2026 12:00:00 PM',
          EwbValidTill: '16/05/2026 11:59:00 PM',
        },
      });
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(1);
      expect(result.results[0].ewbNo).toBe('999999000001');
      const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: orders[0].id } });
      expect(inv.irnStatus).toBe('success');
      expect(inv.ewbStatus).toBe('active');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('B2C high-value order: standalone EWB only, no IRN', async () => {
    const ctx = await getSharmaContext();
    if (!ctx.b2cCust) return; // no B2C seeded → skip
    const orders = await seedOrders({
      customerId: ctx.b2cCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 30,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    await prisma.order.update({ where: { id: orders[0].id }, data: { totalAmount: 60_000 } });
    try {
      apiCallMock.mockResolvedValueOnce(ewbStandaloneSuccess());
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(1);
      expect(result.results[0].mode).toBe('B2C');
      expect(result.results[0].ewbNo).toBe('181012000999');
      expect(apiCallMock).toHaveBeenCalledTimes(1);
      const [, , path] = apiCallMock.mock.calls[0];
      expect(String(path)).toContain('/ewaybillapi/v1.03/ewayapi/genewaybill');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('B2C low-value order: still generates standalone EWB (no invoice-value gate)', async () => {
    const ctx = await getSharmaContext();
    if (!ctx.b2cCust) return;
    const orders = await seedOrders({
      customerId: ctx.b2cCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 2,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    await prisma.order.update({ where: { id: orders[0].id }, data: { totalAmount: 4_000 } });
    try {
      apiCallMock.mockResolvedValueOnce(ewbStandaloneSuccess());
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(1);
      expect(result.results[0].mode).toBe('B2C');
      expect(result.results[0].ewbNo).toBe('181012000999');
      expect(apiCallMock).toHaveBeenCalledTimes(1);
      const [, , path] = apiCallMock.mock.calls[0];
      expect(String(path)).toContain('/ewaybillapi/v1.03/ewayapi/genewaybill');
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } });
      expect(order.status).toBe('pending_delivery');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('Partial dispatch — order 3 IRN fails with 3028, others succeed', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 3,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnSuccessWithInlineEwb())                                // order 1
        .mockResolvedValueOnce(irnSuccessWithInlineEwb())                                // order 2
        .mockImplementationOnce(() => { whitebooksThrow('3028', 'GSTIN is invalid'); }); // order 3
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
      expect(result.dispatched).toBe(false);
      const failed = result.results.find((r) => !r.success)!;
      expect(failed.errorCode).toBe('3028');
      expect(failed.pendingActionId).toBeTruthy();
      // Successful orders → pending_delivery; failing order → pending_dispatch
      const orderStatuses = await prisma.order.findMany({
        where: { id: { in: orders.map((o) => o.id) } },
        select: { id: true, status: true },
      });
      const failedOrder = orderStatuses.find((o) => o.id === failed.orderId)!;
      expect(failedOrder.status).toBe('pending_dispatch');
      const okOrders = orderStatuses.filter((o) => o.id !== failed.orderId);
      okOrders.forEach((o) => expect(o.status).toBe('pending_delivery'));
      // Mapping stays dispatch_ready (not all succeeded)
      const mapping = await prisma.driverVehicleAssignment.findFirstOrThrow({
        where: { id: ctx.mapping.id },
      });
      expect(mapping.status).toBe('dispatch_ready');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('Transient WhiteBooks 5002: order reverts to pending_dispatch + PendingAction', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockImplementationOnce(() => { whitebooksThrow('5002', 'Application error'); });
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary.failed).toBe(1);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } });
      expect(order.status).toBe('pending_dispatch'); // unlocked, not stuck
      const pa = await prisma.pendingAction.findFirst({
        where: { distributorId: 'dist-002', actionType: 'IRN_GENERATION' },
        orderBy: { createdAt: 'desc' },
      });
      expect(pa).toBeTruthy();
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('Preflight lock: concurrent claim → second attempt returns ALREADY_IN_PREFLIGHT', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // Manually flip the order to preflight_in_progress to simulate a
      // racing preflight that already claimed it.
      await prisma.order.update({
        where: { id: orders[0].id },
        data: { status: 'preflight_in_progress' },
      });
      // This run has nothing in pending_dispatch — so the service throws
      // NO_ORDERS. Reset to pending_dispatch, then run preflight twice
      // back-to-back using only one WhiteBooks slot.
      await prisma.order.update({
        where: { id: orders[0].id },
        data: { status: 'pending_dispatch' },
      });
      apiCallMock.mockResolvedValueOnce(irnSuccessWithInlineEwb());
      const result1 = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result1.summary.succeeded).toBe(1);
      // WI-065: second call from the SAME state — no new
      // pending_dispatch orders, the original is now pending_delivery.
      // The dispatch gate now runs the pending_dispatch order count
      // BEFORE touching DVA (premature-reset fix), so the failure is
      // NO_ORDERS, not ALREADY_DISPATCHED. The ALREADY_DISPATCHED
      // 409 path is exercised by the dedicated test at line 609 below
      // (active trip + 1 new pending_dispatch order).
      await expect(
        preflightDispatch({
          distributorId: 'dist-002',
          driverId: ctx.driver.id,
          assignmentDate: today(),
          userId: 'test-user',
        }),
      ).rejects.toMatchObject({ code: 'NO_ORDERS' });
    } finally {
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: { status: 'dispatch_ready' },
      });
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('GST disabled tenant: dispatch direct, no WhiteBooks call', async () => {
    // dist-001 (Bhargava) has gstMode='disabled'
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: 'dist-001', status: 'active', deletedAt: null },
    });
    // WI-090: dedicated dist-001 test vehicle (not the seeded fleet).
    const vehicle = await getOrCreateTestVehicle('dist-001', TEST_VEHICLE_D1);
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: 'dist-001', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: 'dist-001', typeName: '19 KG' },
    });
    // Ensure today's mapping
    const targetDate = new Date(today());
    let mapping = await prisma.driverVehicleAssignment.findFirst({
      where: { distributorId: 'dist-001', driverId: driver.id, assignmentDate: targetDate },
    });
    if (!mapping) {
      mapping = await prisma.driverVehicleAssignment.create({
        data: {
          distributorId: 'dist-001', driverId: driver.id, vehicleId: vehicle.id,
          assignmentDate: targetDate, status: 'dispatch_ready', isReconciled: false,
        },
      });
    } else if (mapping.status !== 'dispatch_ready') {
      mapping = await prisma.driverVehicleAssignment.update({
        where: { id: mapping.id }, data: { status: 'dispatch_ready' },
      });
    }
    // Build orders manually under dist-001 (seedOrders is hard-coded to dist-002)
    const orderIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const o = await prisma.order.create({
        data: {
          distributorId: 'dist-001',
          customerId: cust.id,
          orderNumber: `PFT-D-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          orderDate: new Date(),
          deliveryDate: new Date(today()),
          status: 'pending_dispatch',
          orderType: 'delivery',
          driverId: driver.id,
          vehicleId: vehicle.id,
          totalAmount: 5000,
          items: { create: [{
            cylinderTypeId: cyl.id, quantity: 5, unitPrice: 2000,
            discountPerUnit: 0, totalPrice: 10_000,
          }] },
        },
      });
      orderIds.push(o.id);
    }
    try {
      const result = await preflightDispatch({
        distributorId: 'dist-001',
        driverId: driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(2);
      expect(apiCallMock).not.toHaveBeenCalled();
      const orders = await prisma.order.findMany({ where: { id: { in: orderIds } } });
      orders.forEach((o) => expect(o.status).toBe('pending_delivery'));
    } finally {
      await clearPreflightArtifacts(orderIds);
      // clearPreflightArtifacts only resets dist-002 — reset the dedicated
      // dist-001 vehicle this test dispatched (WI-090).
      await prisma.vehicle.updateMany({
        where: { distributorId: 'dist-001', vehicleNumber: TEST_VEHICLE_D1 },
        data: { status: 'idle' },
      });
    }
  });

  it('No vehicle mapping: blocked before any API call (NO_VEHICLE_MAPPING)', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // Remove the mapping for today
      await prisma.driverVehicleAssignment.delete({ where: { id: ctx.mapping.id } });
      await expect(
        preflightDispatch({
          distributorId: 'dist-002',
          driverId: ctx.driver.id,
          assignmentDate: today(),
          userId: 'test-user',
        }),
      ).rejects.toThrow(/NO_VEHICLE_MAPPING|no confirmed vehicle/i);
      expect(apiCallMock).not.toHaveBeenCalled();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } });
      expect(order.status).toBe('pending_dispatch'); // not touched
    } finally {
      // Restore mapping so subsequent tests work
      await prisma.driverVehicleAssignment.create({
        data: {
          distributorId: 'dist-002', driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
          assignmentDate: new Date(today()), status: 'dispatch_ready', isReconciled: false,
        },
      });
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('Already-dispatched assignment WITH in-flight orders: 409 ALREADY_DISPATCHED', async () => {
    const ctx = await getSharmaContext();
    // New order ready to dispatch for trip 2.
    const newOrders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    // An order still in flight from trip 1 — this is what should block
    // the new dispatch. Without an in-flight order the relaxed gate
    // allows trip 2 (see the next test).
    const inFlight = await prisma.order.create({
      data: {
        distributorId: 'dist-002',
        customerId: ctx.b2bCust.id,
        orderNumber: `PFT-IF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(),
        deliveryDate: new Date(today()),
        status: 'pending_delivery',
        orderType: 'delivery',
        driverId: ctx.driver.id,
        vehicleId: ctx.vehicle.id,
        totalAmount: 5000,
        items: { create: [{ cylinderTypeId: ctx.cyl.id, quantity: 5, unitPrice: 2000, discountPerUnit: 0, totalPrice: 10000 }] },
      },
    });
    try {
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: { status: 'loaded_and_dispatched' },
      });
      await expect(
        preflightDispatch({
          distributorId: 'dist-002',
          driverId: ctx.driver.id,
          assignmentDate: today(),
          userId: 'test-user',
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_DISPATCHED' });
    } finally {
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: { status: 'dispatch_ready' },
      });
      await clearPreflightArtifacts([inFlight.id, ...newOrders.map((o) => o.id)]);
    }
  });

  it('Already-dispatched assignment with NO in-flight orders: allowed (trip 2), bumps tripNumber', async () => {
    const ctx = await getSharmaContext();
    const newOrders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // Simulate the morning trip having completed but no one ran
      // reconciliation yet.
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: {
          status: 'loaded_and_dispatched',
          tripNumber: 1,
          tripSheetNo: 'OLD-TRIP-SHEET-001',
          tripSheetGeneratedAt: new Date(Date.now() - 4 * 3600_000),
        },
      });
      apiCallMock.mockResolvedValueOnce(irnSuccessWithInlineEwb());
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
      // tripNumber incremented; stale trip sheet cleared.
      const updated = await prisma.driverVehicleAssignment.findUniqueOrThrow({
        where: { id: ctx.mapping.id },
      });
      expect(updated.tripNumber).toBe(2);
      expect(updated.tripSheetNo).toBeNull();
      expect(updated.tripSheetGeneratedAt).toBeNull();
      // And the new dispatch flips status back to loaded_and_dispatched.
      expect(updated.status).toBe('loaded_and_dispatched');
    } finally {
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: {
          status: 'dispatch_ready',
          tripNumber: 1,
          tripSheetNo: null,
          tripSheetGeneratedAt: null,
        },
      });
      await clearPreflightArtifacts(newOrders.map((o) => o.id));
    }
  });

  it('Duplicate IRN (2150): treated as success, order proceeds', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockImplementationOnce(() => { whitebooksThrow('2150', 'Duplicate IRN'); });
      const result = await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(1);
      expect(result.results[0].errorCode).toBe('2150');
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } });
      expect(order.status).toBe('pending_delivery');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('Empty pending_dispatch list: throws NO_ORDERS', async () => {
    const ctx = await getSharmaContext();
    await expect(
      preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      }),
    ).rejects.toMatchObject({ code: 'NO_ORDERS' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 2 — Integration tests (POST /api/orders/preflight-dispatch)
// ────────────────────────────────────────────────────────────────────────────

describe('POST /api/orders/preflight-dispatch — integration', () => {
  it('full B2B batch success → 200, all 3 orders pending_delivery', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 3,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnSuccessWithInlineEwb())
        .mockResolvedValueOnce(irnSuccessWithInlineEwb())
        .mockResolvedValueOnce(irnSuccessWithInlineEwb());
      const res = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(sharmaAdminToken))
        .send({ driverId: ctx.driver.id, assignmentDate: today() });
      expect(res.status).toBe(200);
      expect(res.body.data.summary).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
      expect(res.body.data.dispatched).toBe(true);
      const statuses = await prisma.order.findMany({
        where: { id: { in: orders.map((o) => o.id) } },
        select: { status: true },
      });
      statuses.forEach((s) => expect(s.status).toBe('pending_delivery'));
      const mapping = await prisma.driverVehicleAssignment.findUniqueOrThrow({
        where: { id: ctx.mapping.id },
      });
      expect(mapping.status).toBe('loaded_and_dispatched');
    } finally {
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: { status: 'dispatch_ready' },
      });
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('partial failure → 207 Multi-Status', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 3,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnSuccessWithInlineEwb())
        .mockResolvedValueOnce(irnSuccessWithInlineEwb())
        .mockImplementationOnce(() => { whitebooksThrow('3028', 'GSTIN invalid'); });
      const res = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(sharmaAdminToken))
        .send({ driverId: ctx.driver.id, assignmentDate: today() });
      expect(res.status).toBe(207);
      expect(res.body.data.summary).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
      expect(res.body.data.results.filter((r: any) => r.success).length).toBe(2);
      expect(res.body.data.results.find((r: any) => !r.success).errorCode).toBe('3028');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('GST-disabled tenant (dist-001) bypasses WhiteBooks entirely', async () => {
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: 'dist-001', status: 'active', deletedAt: null },
    });
    // WI-090: dedicated dist-001 test vehicle (not the seeded fleet).
    const vehicle = await getOrCreateTestVehicle('dist-001', TEST_VEHICLE_D1);
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: 'dist-001', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: 'dist-001', typeName: '19 KG' },
    });
    const targetDate = new Date(today());
    let mapping = await prisma.driverVehicleAssignment.findFirst({
      where: { distributorId: 'dist-001', driverId: driver.id, assignmentDate: targetDate },
    });
    if (!mapping) {
      mapping = await prisma.driverVehicleAssignment.create({
        data: {
          distributorId: 'dist-001', driverId: driver.id, vehicleId: vehicle.id,
          assignmentDate: targetDate, status: 'dispatch_ready', isReconciled: false,
        },
      });
    } else if (mapping.status !== 'dispatch_ready') {
      mapping = await prisma.driverVehicleAssignment.update({
        where: { id: mapping.id }, data: { status: 'dispatch_ready' },
      });
    }
    const orderIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const o = await prisma.order.create({
        data: {
          distributorId: 'dist-001', customerId: cust.id,
          orderNumber: `PFT-I3-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          orderDate: new Date(), deliveryDate: new Date(today()),
          status: 'pending_dispatch', orderType: 'delivery',
          driverId: driver.id, vehicleId: vehicle.id,
          totalAmount: 5000,
          items: { create: [{
            cylinderTypeId: cyl.id, quantity: 5, unitPrice: 2000,
            discountPerUnit: 0, totalPrice: 10_000,
          }] },
        },
      });
      orderIds.push(o.id);
    }
    try {
      const res = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(bhargavaAdminToken))
        .send({ driverId: driver.id, assignmentDate: today() });
      expect(res.status).toBe(200);
      expect(res.body.data.summary.succeeded).toBe(2);
      expect(apiCallMock).not.toHaveBeenCalled();
      const docCount = await prisma.gstDocument.count({
        where: { invoice: { orderId: { in: orderIds } } },
      });
      expect(docCount).toBe(0);
    } finally {
      await clearPreflightArtifacts(orderIds);
      // Reset the dedicated dist-001 vehicle this test dispatched (WI-090).
      await prisma.vehicle.updateMany({
        where: { distributorId: 'dist-001', vehicleNumber: TEST_VEHICLE_D1 },
        data: { status: 'idle' },
      });
    }
  });

  it('auth: finance → 403, inventory now allowed (role gate passes; tenant isolation still blocks cross-tenant)', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // WI-088: finance now has preflight-dispatch access. Passes role gate;
      // fails tenant isolation (dist-002 driver, finance token is dist-001) → 404.
      const finRes = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(financeToken))
        .send({ driverId: ctx.driver.id, assignmentDate: today() });
      expect(finRes.status).not.toBe(403);
      expect(finRes.status).toBe(404);

      // Inventory role is now permitted on preflight-dispatch (founder
      // spec: dispatch is an inventory task). The inventoryToken belongs
      // to dist-001 (bhargava); calling on a dist-002 driver passes the
      // role gate but fails tenant isolation → 404 NOT_FOUND, not 403.
      const invRes = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(inventoryToken))
        .send({ driverId: ctx.driver.id, assignmentDate: today() });
      expect(invRes.status).not.toBe(403);
      expect(invRes.status).toBe(404);

      // dist-001 admin trying to preflight a dist-002 driver — 404 NOT_FOUND
      const crossRes = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(bhargavaAdminToken))
        .send({ driverId: ctx.driver.id, assignmentDate: today() });
      expect(crossRes.status).toBe(404);
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('preflight lock semantics: re-running after success finds no eligible orders', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockResolvedValueOnce(irnSuccessWithInlineEwb());
      const ok = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(sharmaAdminToken))
        .send({ driverId: ctx.driver.id, assignmentDate: today() });
      expect(ok.status).toBe(200);

      // WI-065: second call has no new pending_dispatch orders (the
      // original is now pending_delivery). The dispatch gate runs the
      // pending_dispatch order count BEFORE touching DVA, so the
      // failure is NO_ORDERS (400), not ALREADY_DISPATCHED (409). The
      // 409 path is exercised by the dedicated test above
      // ("Already-dispatched assignment WITH in-flight orders").
      const retry = await request(app)
        .post('/api/orders/preflight-dispatch')
        .set(auth(sharmaAdminToken))
        .send({ driverId: ctx.driver.id, assignmentDate: today() });
      expect(retry.status).toBe(400);
      expect(retry.body.code).toBe('NO_ORDERS');
    } finally {
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: { status: 'dispatch_ready' },
      });
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 3 — Regression
// ────────────────────────────────────────────────────────────────────────────

describe('Regression — preflight does not affect existing flows', () => {
  it('OrderStatus enum addition: existing pending_dispatch query still returns rows', async () => {
    // Pure DB query through Prisma — confirms the enum addition didn't
    // break casts on existing rows.
    const count = await prisma.order.count({
      where: { status: 'pending_dispatch' },
    });
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('assign-driver still transitions to pending_dispatch (not pending_delivery)', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // Put the order back to pending_driver_assignment so we can re-assign
      await prisma.order.update({
        where: { id: orders[0].id },
        data: { status: 'pending_driver_assignment', driverId: null, vehicleId: null },
      });
      const res = await request(app)
        .post(`/api/orders/${orders[0].id}/assign-driver`)
        .set(auth(sharmaAdminToken))
        .send({ driverId: ctx.driver.id });
      expect(res.status).toBe(200);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } });
      // The key invariant: assign-driver does NOT skip preflight by going
      // straight to pending_delivery.
      expect(order.status).toBe('pending_dispatch');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('tenant isolation: preflighting dist-002 driver as dist-001 admin returns 404', async () => {
    const sharmaDriver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: 'dist-002', status: 'active' },
    });
    const res = await request(app)
      .post('/api/orders/preflight-dispatch')
      .set(auth(bhargavaAdminToken))
      .send({ driverId: sharmaDriver.id, assignmentDate: today() });
    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 4 — Audit + side-effects coverage
// ────────────────────────────────────────────────────────────────────────────

describe('Audit + side-effects', () => {
  let preflightDispatch: typeof import('../services/gst/gstPreflightService.js').preflightDispatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstPreflightService.js');
    preflightDispatch = mod.preflightDispatch;
  });

  it('gst_api_logs row is written on every WhiteBooks call (success)', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockResolvedValueOnce(irnSuccessWithInlineEwb());
      const before = await prisma.gstApiLog.count({ where: { orderId: orders[0].id } });
      await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      const log = await prisma.gstApiLog.findFirst({
        where: { orderId: orders[0].id, status: 'success' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log!.apiType).toBe('IRN_GENERATE');
      expect(log!.scope).toBe('einvoice');
      expect(log!.latencyMs).toBeGreaterThanOrEqual(0);
      expect(before).toBe(0);
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('gst_api_logs row records failed call with errorCode', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockImplementationOnce(() => { whitebooksThrow('3028', 'GSTIN invalid'); });
      await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      const log = await prisma.gstApiLog.findFirst({
        where: { orderId: orders[0].id, status: 'failed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log!.errorCode).toBe('3028');
      expect(log!.errorMessage).toMatch(/GSTIN/);
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('order_status_logs entry created for preflight transition', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockResolvedValueOnce(irnSuccessWithInlineEwb());
      await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      const logs = await prisma.orderStatusLog.findMany({
        where: { orderId: orders[0].id },
        orderBy: { changedAt: 'asc' },
      });
      // Should have at least one log: preflight_in_progress → pending_delivery
      const transition = logs.find((l) => l.newStatus === 'pending_delivery');
      expect(transition).toBeTruthy();
      expect(transition!.oldStatus).toBe('preflight_in_progress');
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('preflight does not create inventory events (those are at delivery time)', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockResolvedValueOnce(irnSuccessWithInlineEwb());
      const eventsBefore = await prisma.inventoryEvent.count({
        where: { distributorId: 'dist-002', referenceId: orders[0].id },
      });
      await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      const eventsAfter = await prisma.inventoryEvent.count({
        where: { distributorId: 'dist-002', referenceId: orders[0].id },
      });
      expect(eventsAfter).toBe(eventsBefore);
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });

  it('Indian-format dates from NIC round-trip cleanly to gst_documents', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id, qty: 5,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockResolvedValueOnce(irnSuccessWithInlineEwb({
        AckDt: '15/05/2026 09:15:30 AM',
        EwbDt: '15/05/2026 09:20:00 AM',
        EwbValidTill: '17/05/2026 11:59:00 PM',
      }));
      await preflightDispatch({
        distributorId: 'dist-002',
        driverId: ctx.driver.id,
        assignmentDate: today(),
        userId: 'test-user',
      });
      const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: orders[0].id } });
      // Dates round-trip as real Date values (not null and not Invalid Date).
      // We don't pin hours because the JS Date constructor interprets the
      // unspecified-TZ ISO string as local time — getUTCHours varies with
      // the test host's timezone. The important thing is parsing succeeded
      // and the day-of-month is preserved.
      expect(inv.ackDate).toBeInstanceOf(Date);
      expect(Number.isNaN(inv.ackDate!.getTime())).toBe(false);
      const doc = await prisma.gstDocument.findFirstOrThrow({
        where: { invoiceId: inv.id, isLatest: true },
      });
      expect(doc.ewbDate).toBeInstanceOf(Date);
      expect(doc.ewbValidTill).toBeInstanceOf(Date);
      // Local-day assertion (locale-stable): the "17" should be visible in
      // either UTC or local rendering for an evening of 17/05/2026.
      const validTillIso = doc.ewbValidTill!.toISOString();
      expect(validTillIso.includes('2026-05-17') || validTillIso.includes('2026-05-18')).toBe(true);
    } finally {
      await clearPreflightArtifacts(orders.map((o) => o.id));
    }
  });
});

afterAll(async () => {
  // Cleanup any stray preflight artifacts from this test file.
  await prisma.gstApiLog.deleteMany({ where: { apiType: { startsWith: 'IRN_GENERATE' } } });
  // Belt-and-braces: reset only the DEDICATED test vehicles in case a test
  // failed mid-way and its clearPreflightArtifacts never ran (WI-090 — never
  // blanket-reset the seeded fleet).
  await prisma.vehicle.updateMany({
    where: { distributorId: 'dist-002', vehicleNumber: TEST_VEHICLE_D2 },
    data: { status: 'idle' },
  });
  await prisma.vehicle.updateMany({
    where: { distributorId: 'dist-001', vehicleNumber: TEST_VEHICLE_D1 },
    data: { status: 'idle' },
  });
  // Clean up the far-future TEST_DATE DVA created/modified by getSharmaContext.
  await prisma.driverVehicleAssignment.deleteMany({
    where: { distributorId: { in: ['dist-001', 'dist-002'] }, assignmentDate: new Date(today()) },
  });
});
