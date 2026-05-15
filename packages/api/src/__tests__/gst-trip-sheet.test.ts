import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Mock the WhiteBooks client BEFORE imports below so preflight + the
// consolidated EWB call both go through the same mock.
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
import { generateToken } from './helpers.js';
import * as whitebooksClient from '../services/gst/whitebooksClient.js';
import type { Express } from 'express';

// CLAUDE.md anti-pattern #7: tests that seed time-sensitive data use
// a fixed future date so real dev-DB rows never get swept into service
// queries that filter by date (e.g. preflightDispatch).
const TEST_DATE = '2099-12-31';
const today = () => TEST_DATE;

const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

let app: Express;
let sharmaAdminToken: string;
let bhargavaAdminToken: string;

function auth(token: string, distributorId?: string) {
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distributorId) h['X-Distributor-Id'] = distributorId;
  return h;
}

function irnSuccessWithEwb(ewbNo: string) {
  return {
    status_cd: '1',
    data: {
      Irn: 'irn_' + Math.random().toString(36).slice(2, 10),
      AckNo: '11261000099',
      AckDt: '15/05/2026 12:00:00 PM',
      SignedQRCode: 'eyJhbGciOi',
      EwbNo: ewbNo,
      EwbDt: '15/05/2026 12:00:00 PM',
      EwbValidTill: '16/05/2026 11:59:00 PM',
    },
  };
}

function gencewbOk(tripSheetNo = 'CEWB-200300999') {
  return { status_cd: '1', data: tripSheetNo };
}

beforeAll(async () => {
  app = createApp();
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
});

beforeEach(() => {
  apiCallMock.mockReset();
});

async function getSharmaContext() {
  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: 'dist-002', status: 'active', deletedAt: null },
  });
  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId: 'dist-002', status: { not: 'inactive' }, deletedAt: null },
  });
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
  } else if (mapping.status !== 'dispatch_ready' || mapping.tripSheetNo) {
    mapping = await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: { vehicleId: vehicle.id, status: 'dispatch_ready', tripSheetNo: null, tripSheetGeneratedAt: null },
    });
  }
  const b2bCust = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', customerType: 'B2B', gstin: { not: null }, deletedAt: null },
  });
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: 'dist-002', typeName: '19 KG' },
  });
  return { driver, vehicle, mapping, b2bCust, cyl };
}

async function seedOrders(opts: {
  customerId: string;
  count: number;
  cylinderTypeId: string;
  driverId: string;
  vehicleId: string;
}) {
  const orders = [];
  for (let i = 0; i < opts.count; i++) {
    const o = await prisma.order.create({
      data: {
        distributorId: 'dist-002',
        customerId: opts.customerId,
        orderNumber: `TS-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
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
            quantity: 5,
            unitPrice: 2000,
            discountPerUnit: 0,
            totalPrice: 10000,
          }],
        },
      },
    });
    orders.push(o);
  }
  return orders;
}

async function cleanupOrders(ids: string[]) {
  const invoices = await prisma.invoice.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
  await prisma.gstApiLog.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.gstDocument.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.pendingAction.deleteMany({ where: { entityId: { in: [...ids, ...invoices.map((i) => i.id)] } } });
  await prisma.invoiceRevision.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.customerLedgerEntry.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.driverAssignment.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.order.deleteMany({ where: { id: { in: ids } } });
}

describe('gstPreflightService — consolidated EWB (gencewb) on success', () => {
  let preflightDispatch: typeof import('../services/gst/gstPreflightService.js').preflightDispatch;
  beforeAll(async () => {
    const mod = await import('../services/gst/gstPreflightService.js');
    preflightDispatch = mod.preflightDispatch;
  });

  it('2+ orders all-success → gencewb called, tripSheetNo persisted', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 3,
      cylinderTypeId: ctx.cyl.id,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnSuccessWithEwb('181000100001'))  // order 1
        .mockResolvedValueOnce(irnSuccessWithEwb('181000100002'))  // order 2
        .mockResolvedValueOnce(irnSuccessWithEwb('181000100003'))  // order 3
        .mockResolvedValueOnce(gencewbOk('CEWB-TRIP-777'));     // gencewb
      const result = await preflightDispatch({
        distributorId: 'dist-002', driverId: ctx.driver.id,
        assignmentDate: today(), userId: 'test-user',
      });
      expect(result.summary).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
      // Last call was the gencewb
      const lastCall = apiCallMock.mock.calls[apiCallMock.mock.calls.length - 1];
      expect(String(lastCall[2])).toContain('/ewaybillapi/v1.03/ewayapi/gencewb');
      const payload = lastCall[3] as any;
      expect(payload.tripSheetEwbBills).toHaveLength(3);
      expect(payload.tripSheetEwbBills[0].ewbNo).toBe(181000100001);
      // Assignment row picked up tripSheetNo
      const updated = await prisma.driverVehicleAssignment.findUniqueOrThrow({
        where: { id: ctx.mapping.id },
      });
      expect(updated.tripSheetNo).toBe('CEWB-TRIP-777');
      expect(updated.tripSheetGeneratedAt).toBeTruthy();
    } finally {
      await cleanupOrders(orders.map((o) => o.id));
    }
  });

  it('Single order all-success → gencewb NOT called, tripSheetNo stays null', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 1,
      cylinderTypeId: ctx.cyl.id,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock.mockResolvedValueOnce(irnSuccessWithEwb('181000200001'));
      const result = await preflightDispatch({
        distributorId: 'dist-002', driverId: ctx.driver.id,
        assignmentDate: today(), userId: 'test-user',
      });
      expect(result.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
      // exactly one call: the IRN. No gencewb.
      expect(apiCallMock).toHaveBeenCalledTimes(1);
      const updated = await prisma.driverVehicleAssignment.findUniqueOrThrow({
        where: { id: ctx.mapping.id },
      });
      expect(updated.tripSheetNo).toBeNull();
    } finally {
      await cleanupOrders(orders.map((o) => o.id));
    }
  });

  it('gencewb failure does NOT block dispatch — LOW pending action created', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 2,
      cylinderTypeId: ctx.cyl.id,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      apiCallMock
        .mockResolvedValueOnce(irnSuccessWithEwb('181000300001'))
        .mockResolvedValueOnce(irnSuccessWithEwb('181000300002'))
        .mockImplementationOnce(() => { const e: any = new Error('gencewb 4001'); e.code = '4001'; throw e; });
      const result = await preflightDispatch({
        distributorId: 'dist-002', driverId: ctx.driver.id,
        assignmentDate: today(), userId: 'test-user',
      });
      expect(result.summary.succeeded).toBe(2);
      expect(result.dispatched).toBe(true); // Dispatch still completes
      const pa = await prisma.pendingAction.findFirst({
        where: { entityId: ctx.mapping.id, actionType: 'CONSOLIDATED_EWB_FAILED' },
      });
      expect(pa).toBeTruthy();
      expect(pa?.severity).toBe('low');
      // Assignment moves forward to loaded_and_dispatched even when gencewb fails
      const updated = await prisma.driverVehicleAssignment.findUniqueOrThrow({
        where: { id: ctx.mapping.id },
      });
      expect(updated.status).toBe('loaded_and_dispatched');
      expect(updated.tripSheetNo).toBeNull();
    } finally {
      await cleanupOrders(orders.map((o) => o.id));
    }
  });
});

describe('GET /api/orders/trip-sheet/:assignmentId — integration', () => {
  it('Returns 200 + application/pdf when trip sheet exists', async () => {
    const ctx = await getSharmaContext();
    const orders = await seedOrders({
      customerId: ctx.b2bCust.id, count: 2,
      cylinderTypeId: ctx.cyl.id,
      driverId: ctx.driver.id, vehicleId: ctx.vehicle.id,
    });
    try {
      // Pre-populate a trip sheet on the assignment
      await prisma.driverVehicleAssignment.update({
        where: { id: ctx.mapping.id },
        data: { tripSheetNo: 'CEWB-INT-TEST', tripSheetGeneratedAt: new Date() },
      });
      // Move orders to pending_delivery so the PDF service finds them
      await prisma.order.updateMany({
        where: { id: { in: orders.map((o) => o.id) } },
        data: { status: 'pending_delivery' },
      });
      const res = await request(app)
        .get(`/api/orders/trip-sheet/${ctx.mapping.id}`)
        .set(auth(sharmaAdminToken));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.body).toBeInstanceOf(Buffer);
      // PDFs start with %PDF
      expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    } finally {
      await cleanupOrders(orders.map((o) => o.id));
    }
  });

  it('Returns 404 when assignment belongs to a different distributor', async () => {
    const ctx = await getSharmaContext();
    await prisma.driverVehicleAssignment.update({
      where: { id: ctx.mapping.id },
      data: { tripSheetNo: 'CEWB-CROSS-TEST', tripSheetGeneratedAt: new Date() },
    });
    const res = await request(app)
      .get(`/api/orders/trip-sheet/${ctx.mapping.id}`)
      .set(auth(bhargavaAdminToken)); // dist-001, not dist-002
    expect(res.status).toBe(404);
  });

  it('Returns 400 when trip sheet not yet generated', async () => {
    const ctx = await getSharmaContext();
    // mapping starts without tripSheetNo from getSharmaContext()
    const res = await request(app)
      .get(`/api/orders/trip-sheet/${ctx.mapping.id}`)
      .set(auth(sharmaAdminToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not been generated/i);
  });

  it('Returns 404 for non-existent assignment', async () => {
    const res = await request(app)
      .get('/api/orders/trip-sheet/00000000-0000-0000-0000-000000000000')
      .set(auth(sharmaAdminToken));
    expect(res.status).toBe(404);
  });
});
