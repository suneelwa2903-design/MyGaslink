/**
 * INVESTIGATION-JUL09 — Duplicate notifications after IRN/EWB
 *
 * Root cause: orderService.confirmDelivery re-ran processInvoiceGst even
 * when preflight had already produced irnStatus='success' + ewbStatus='active'.
 * The 2nd NIC call returned 2150 (duplicate IRN) and the recovery branch
 * raised a spurious IRN_GENERATION PendingAction — the bell showed both
 * the stale preflight-era PA and the new retry PA.
 *
 * Fix:
 *   A) orderService.confirmDelivery — fast-path skip when fully compliant,
 *      and auto-resolve any stale open IRN_GENERATION/EWB_GENERATION PAs
 *      for the invoice.
 *   B) gstService.createPendingAction — swallow P2002 (race with a
 *      concurrent caller) and update the winner's row instead of
 *      surfacing an error. Migration 20260709000000 adds a partial
 *      unique index enforcing 1 open row per (dist, entity, actionType).
 *
 * Uses dist-001 (GST-disabled) so the fast-path check depends purely on
 * the invoice status columns — no WhiteBooks mock needed. Far-future
 * TEST_DATE (anti-pattern #7) keeps date-scoped queries off real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { confirmDelivery } from '../services/orderService.js';
import { createPendingAction } from '../services/gst/gstService.js';
import type { $Enums } from '@prisma/client';

const D1 = 'dist-001';
const TEST_DATE = '2099-12-31';
const date = new Date(TEST_DATE);
const PHONES = ['9915000001', '9915000002', '9915000003', '9915000004', '9915000005'];

const createdOrderIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdDvaIds: string[] = [];
const createdVehicleIds: string[] = [];
const createdDriverIds: string[] = [];
const createdUserEmails: string[] = [];
const createdPaIds: string[] = [];
const createdPaEntityIds: string[] = [];

async function mkDriver(distributorId: string, phone: string, name: string) {
  const email = `dupnotif-${name}@test-dupnotif.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName: 'DupNotif', lastName: name, phone, role: 'driver', status: 'active', distributorId },
  });
  const driver = await prisma.driver.create({ data: { distributorId, driverName: `DupNotif ${name}`, phone, status: 'active' } });
  const vehicle = await prisma.vehicle.create({ data: { distributorId, vehicleNumber: `TEST-DUPNOTIF-${name}`, vehicleType: 'Truck', status: 'dispatched' } });
  createdDriverIds.push(driver.id);
  createdUserEmails.push(email);
  createdVehicleIds.push(vehicle.id);
  return { userId: user.id, driverId: driver.id, vehicleId: vehicle.id };
}

async function mkDva(distributorId: string, driverId: string, vehicleId: string, tripNumber = 1) {
  const dva = await prisma.driverVehicleAssignment.create({
    data: { distributorId, driverId, vehicleId, assignmentDate: date, status: 'loaded_and_dispatched' as $Enums.AssignmentStatus, tripNumber },
  });
  createdDvaIds.push(dva.id);
  return dva;
}

async function mkOrderWithInvoice(
  distributorId: string,
  driverId: string,
  vehicleId: string,
  opts: { irnStatus: $Enums.IrnStatus; ewbStatus: $Enums.EwbStatus },
) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
  const order = await prisma.order.create({
    data: {
      distributorId,
      customerId: customer.id,
      driverId,
      vehicleId,
      orderNumber: `TEST-DUPNOTIF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      orderDate: date,
      deliveryDate: date,
      status: 'pending_delivery',
      orderType: 'delivery',
      totalAmount: 2000,
      tripNumber: 1,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
    },
    include: { items: true },
  });
  createdOrderIds.push(order.id);
  const invoice = await prisma.invoice.create({
    data: {
      distributorId,
      customerId: customer.id,
      orderId: order.id,
      invoiceNumber: `TEST-INV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      issueDate: date,
      dueDate: date,
      totalAmount: 2000,
      outstandingAmount: 2000,
      status: 'issued',
      irnStatus: opts.irnStatus,
      ewbStatus: opts.ewbStatus,
      items: { create: [{ cylinderTypeId: cyl.id, description: '19 KG (test)', quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
    },
  });
  createdInvoiceIds.push(invoice.id);
  return { order, invoice };
}

async function seedStalePa(distributorId: string, invoiceId: string, actionType: 'IRN_GENERATION' | 'EWB_GENERATION') {
  const pa = await prisma.pendingAction.create({
    data: {
      distributorId,
      module: 'gst_compliance',
      entityId: invoiceId,
      entityType: 'invoice',
      actionType,
      description: 'preflight-era failure (stale)',
      severity: 'high',
      status: 'open',
    },
  });
  createdPaIds.push(pa.id);
  createdPaEntityIds.push(invoiceId);
  return pa;
}

async function cleanup() {
  await prisma.pendingAction.deleteMany({
    where: { OR: [{ id: { in: createdPaIds } }, { entityId: { in: createdPaEntityIds } }] },
  });
  await prisma.gstDocument.deleteMany({ where: { OR: [{ orderId: { in: createdOrderIds } }, { invoiceId: { in: createdInvoiceIds } }] } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.cancelledStockEvent.deleteMany({ where: { OR: [{ orderId: { in: createdOrderIds } }, { vehicleId: { in: createdVehicleIds } }] } });
  await prisma.inventoryEvent.deleteMany({ where: { referenceId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: createdDvaIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: createdVehicleIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  await prisma.user.deleteMany({ where: { email: { in: createdUserEmails } } });
}

beforeAll(cleanup);
afterAll(cleanup);

describe('INVESTIGATION-JUL09 — Duplicate notification fast-path', () => {
  it('1. Fully-compliant invoice: fast-path auto-resolves stale open IRN_GENERATION PA', async () => {
    const d = await mkDriver(D1, PHONES[0], 'compliant');
    await mkDva(D1, d.driverId, d.vehicleId);
    const { order, invoice } = await mkOrderWithInvoice(D1, d.driverId, d.vehicleId, {
      irnStatus: 'success',
      ewbStatus: 'active',
    });
    const stalePa = await seedStalePa(D1, invoice.id, 'IRN_GENERATION');

    await confirmDelivery(order.id, D1, 'test-user', {
      items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    // Give the non-blocking updateMany a beat to land.
    await new Promise((r) => setTimeout(r, 200));
    const after = await prisma.pendingAction.findUniqueOrThrow({ where: { id: stalePa.id } });
    expect(after.status).toBe('resolved');
    expect(after.resolvedBy).toBe('system');
    expect(after.resolutionNotes).toMatch(/Auto-resolved.*IRN\+EWB/i);
    expect(after.resolvedAt).toBeTruthy();
  });

  it('2. Fully-compliant invoice: fast-path also resolves stale EWB_GENERATION PA', async () => {
    const d = await mkDriver(D1, PHONES[1], 'compliantewb');
    await mkDva(D1, d.driverId, d.vehicleId);
    const { order, invoice } = await mkOrderWithInvoice(D1, d.driverId, d.vehicleId, {
      irnStatus: 'success',
      ewbStatus: 'active',
    });
    const stalePa = await seedStalePa(D1, invoice.id, 'EWB_GENERATION');

    await confirmDelivery(order.id, D1, 'test-user', {
      items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    await new Promise((r) => setTimeout(r, 200));
    const after = await prisma.pendingAction.findUniqueOrThrow({ where: { id: stalePa.id } });
    expect(after.status).toBe('resolved');
    expect(after.resolvedBy).toBe('system');
  });

  it('3. Non-compliant invoice (irnStatus=not_attempted): stale PA stays open, fast-path NOT triggered', async () => {
    const d = await mkDriver(D1, PHONES[2], 'noncompliant');
    await mkDva(D1, d.driverId, d.vehicleId);
    const { order, invoice } = await mkOrderWithInvoice(D1, d.driverId, d.vehicleId, {
      irnStatus: 'not_attempted',
      ewbStatus: 'not_attempted',
    });
    const stalePa = await seedStalePa(D1, invoice.id, 'IRN_GENERATION');

    await confirmDelivery(order.id, D1, 'test-user', {
      items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    await new Promise((r) => setTimeout(r, 200));
    const after = await prisma.pendingAction.findUniqueOrThrow({ where: { id: stalePa.id } });
    // Fast-path guard did NOT fire — PA remains open (processInvoiceGst runs but
    // for GST-disabled dist-001 it's a no-op; the important assertion is the PA
    // was NOT auto-resolved by the fast-path).
    expect(after.status).toBe('open');
  });

  it('4. Non-compliant invoice (irnStatus=success but ewbStatus=failed): stale PA stays open', async () => {
    // Partial success — IRN went through, EWB failed. Fast-path must NOT fire
    // because the EWB is still in retry territory.
    const d = await mkDriver(D1, PHONES[3], 'partial');
    await mkDva(D1, d.driverId, d.vehicleId);
    const { order, invoice } = await mkOrderWithInvoice(D1, d.driverId, d.vehicleId, {
      irnStatus: 'success',
      ewbStatus: 'failed',
    });
    const stalePa = await seedStalePa(D1, invoice.id, 'EWB_GENERATION');

    await confirmDelivery(order.id, D1, 'test-user', {
      items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    await new Promise((r) => setTimeout(r, 200));
    const after = await prisma.pendingAction.findUniqueOrThrow({ where: { id: stalePa.id } });
    expect(after.status).toBe('open');
  });

  it('5. Modified delivery with live GST doc: fast-path does NOT fire (reissue path claims it)', async () => {
    // isModified=true + hasLiveGstDoc=true → reissueForDeliveryMismatch, NOT
    // fast-path (fully-compliant guard has explicit `!isModified` check).
    const d = await mkDriver(D1, PHONES[4], 'modified');
    await mkDva(D1, d.driverId, d.vehicleId);
    const { order, invoice } = await mkOrderWithInvoice(D1, d.driverId, d.vehicleId, {
      irnStatus: 'success',
      ewbStatus: 'active',
    });
    const stalePa = await seedStalePa(D1, invoice.id, 'IRN_GENERATION');

    // Deliver 0 empties (item.quantity is 1) → isModified=true.
    await confirmDelivery(order.id, D1, 'test-user', {
      items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 0, emptiesCollected: 0 })),
    });

    await new Promise((r) => setTimeout(r, 200));
    const after = await prisma.pendingAction.findUniqueOrThrow({ where: { id: stalePa.id } });
    // Fast-path skipped (isModified=true). Reissue fires instead; it may or may
    // not touch this PA, but the fast-path resolution-notes marker must NOT be set.
    if (after.status === 'resolved') {
      expect(after.resolutionNotes).not.toMatch(/Auto-resolved.*IRN\+EWB already active/i);
    }
  });
});

describe('INVESTIGATION-JUL09 — createPendingAction race safety (P2002 fallback)', () => {
  it('6. Two concurrent createPendingAction calls for the same (dist, entity, actionType) yield exactly 1 open row', async () => {
    const ENTITY = `dupnotif-race-${Date.now()}`;
    createdPaEntityIds.push(ENTITY);

    const [a, b] = await Promise.all([
      createPendingAction(D1, ENTITY, 'IRN_GENERATION', 'race caller A'),
      createPendingAction(D1, ENTITY, 'IRN_GENERATION', 'race caller B'),
    ]);
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBeTruthy();
    // Both callers observe the same winning row (either via findFirst-first or
    // via the P2002 fallback that re-lookups after the losing create throws).
    expect(a?.id).toBe(b?.id);

    const openRows = await prisma.pendingAction.findMany({
      where: { distributorId: D1, entityId: ENTITY, actionType: 'IRN_GENERATION', status: 'open' },
    });
    expect(openRows.length).toBe(1);
  });
});
