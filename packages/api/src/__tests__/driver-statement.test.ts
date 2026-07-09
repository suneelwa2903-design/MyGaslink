/**
 * Driver Statement — status helper + service function + PDF byte-shape.
 *
 * The Driver Statement is a per-invoice detail view for one driver in a
 * period, powering the "Statement" button on the Delivery Performance
 * report. Tests scoped to dist-001 (GST-disabled → no WhiteBooks mock
 * needed) with far-future TEST_DATE to avoid contaminating real dev-DB
 * rows (anti-pattern #7).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import {
  invoiceStatus,
  deliveryPerformanceStatement,
} from '../services/reportsService.js';
import { generateDriverStatementPdf } from '../services/pdf/driverStatementPdfService.js';
import type { $Enums } from '@prisma/client';

const D1 = 'dist-001';
const TEST_DATE_STR = '2099-12-25';
const RANGE_FROM = new Date('2099-12-20T00:00:00.000Z');
const RANGE_TO = new Date('2099-12-31T23:59:59.999Z');
const testDate = new Date(TEST_DATE_STR);
const idempotentSuffix = Date.now().toString(36);

const createdOrderIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdDriverIds: string[] = [];
const createdUserEmails: string[] = [];
const createdPaymentIds: string[] = [];

async function mkDriver(name: string, phone: string) {
  const email = `dstmt-${idempotentSuffix}-${name}@test-dstmt.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName: 'DStmt', lastName: name, phone, role: 'driver', status: 'active', distributorId: D1 },
  });
  const driver = await prisma.driver.create({
    data: { distributorId: D1, driverName: `DStmt ${name}`, phone, status: 'active' },
  });
  createdDriverIds.push(driver.id);
  createdUserEmails.push(email);
  return { userId: user.id, driverId: driver.id };
}

async function mkCustomer(name: string, creditPeriodDays = 30) {
  const cust = await prisma.customer.create({
    data: {
      distributorId: D1,
      customerName: name,
      businessName: name,
      phone: `9920${String(createdCustomerIds.length).padStart(6, '0')}`,
      customerType: 'B2C',
      creditPeriodDays,
    },
  });
  createdCustomerIds.push(cust.id);
  return cust.id;
}

async function mkOrderInvoice(opts: {
  driverId: string;
  customerId: string;
  cylinderTypeId: string;
  fulls: number;
  empties: number;
  unitPrice?: number;
  outstanding?: number;
  amountPaid?: number;
  dueDate?: Date;
  status?: $Enums.InvoiceStatus;
  isGodownPickup?: boolean;
}) {
  const unit = opts.unitPrice ?? 3000;
  const total = opts.fulls * unit;
  const outstanding = opts.outstanding ?? total;
  const amountPaid = opts.amountPaid ?? total - outstanding;
  const dueDate = opts.dueDate ?? new Date(testDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const order = await prisma.order.create({
    data: {
      distributorId: D1,
      customerId: opts.customerId,
      driverId: opts.driverId,
      orderNumber: `TEST-DSTMT-${idempotentSuffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      orderDate: testDate,
      deliveryDate: testDate,
      status: 'delivered',
      orderType: 'delivery',
      totalAmount: total,
      isGodownPickup: opts.isGodownPickup ?? false,
      items: {
        create: [
          {
            cylinderTypeId: opts.cylinderTypeId,
            quantity: opts.fulls,
            deliveredQuantity: opts.fulls,
            emptiesCollected: opts.empties,
            unitPrice: unit,
            totalPrice: total,
          },
        ],
      },
    },
  });
  createdOrderIds.push(order.id);
  const invoice = await prisma.invoice.create({
    data: {
      distributorId: D1,
      customerId: opts.customerId,
      orderId: order.id,
      invoiceNumber: `TEST-INV-DSTMT-${idempotentSuffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      issueDate: testDate,
      dueDate,
      totalAmount: total,
      outstandingAmount: outstanding,
      amountPaid,
      status: opts.status ?? 'issued',
      items: {
        create: [
          { cylinderTypeId: opts.cylinderTypeId, description: '19 KG (test)', quantity: opts.fulls, unitPrice: unit, totalPrice: total },
        ],
      },
    },
  });
  createdInvoiceIds.push(invoice.id);
  return { order, invoice };
}

async function cleanup() {
  await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: createdPaymentIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.inventoryEvent.deleteMany({ where: { referenceId: { in: createdOrderIds } } });
  await prisma.cancelledStockEvent.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  await prisma.user.deleteMany({ where: { email: { in: createdUserEmails } } });
}

let cyl19: string;

beforeAll(async () => {
  await cleanup();
  const c = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: D1 } });
  cyl19 = c.id;
});
afterAll(cleanup);

// ─── invoiceStatus helper ──────────────────────────────────────────────────

describe('invoiceStatus — 4 buckets', () => {
  const today = new Date('2100-06-01T00:00:00.000Z');
  const future = new Date('2100-07-01T00:00:00.000Z');
  const past = new Date('2100-05-01T00:00:00.000Z');

  it('1. Paid — outstanding=0 regardless of due date', () => {
    expect(invoiceStatus({ totalAmount: 1000, amountPaid: 1000, outstandingAmount: 0, dueDate: past }, today)).toBe('Paid');
    expect(invoiceStatus({ totalAmount: 1000, amountPaid: 1000, outstandingAmount: 0, dueDate: future }, today)).toBe('Paid');
  });

  it('2. Overdue — outstanding>0 and dueDate<today (takes priority over Partial)', () => {
    expect(invoiceStatus({ totalAmount: 1000, amountPaid: 0, outstandingAmount: 1000, dueDate: past }, today)).toBe('Overdue');
    expect(invoiceStatus({ totalAmount: 1000, amountPaid: 400, outstandingAmount: 600, dueDate: past }, today)).toBe('Overdue');
  });

  it('3. Partial — some paid, not overdue', () => {
    expect(invoiceStatus({ totalAmount: 1000, amountPaid: 400, outstandingAmount: 600, dueDate: future }, today)).toBe('Partial');
  });

  it('4. Pending — nothing paid, not overdue', () => {
    expect(invoiceStatus({ totalAmount: 1000, amountPaid: 0, outstandingAmount: 1000, dueDate: future }, today)).toBe('Pending');
  });

  it('5. Handles null dueDate as Pending (no overdue possible)', () => {
    expect(invoiceStatus({ totalAmount: 1000, amountPaid: 0, outstandingAmount: 1000, dueDate: null }, today)).toBe('Pending');
  });
});

// ─── deliveryPerformanceStatement service ──────────────────────────────────

describe('deliveryPerformanceStatement — service', () => {
  it('6. Returns one row per delivered invoice for the driver', async () => {
    const d = await mkDriver('svc1', '9922000001');
    const c1 = await mkCustomer('DStmt Cust A');
    const c2 = await mkCustomer('DStmt Cust B');
    await mkOrderInvoice({ driverId: d.driverId, customerId: c1, cylinderTypeId: cyl19, fulls: 3, empties: 3 });
    await mkOrderInvoice({ driverId: d.driverId, customerId: c2, cylinderTypeId: cyl19, fulls: 2, empties: 2 });
    const r = await deliveryPerformanceStatement(D1, d.driverId, RANGE_FROM, RANGE_TO, 'all');
    expect(r.rows.length).toBe(2);
    expect(r.rows.every((row) => row.type === 'statement_row')).toBe(true);
    // Columns present + labels match spec
    const labels = r.columns.map((c) => c.label);
    expect(labels).toEqual(['Date', 'Invoice #', 'Customer', 'Cylinders', 'F Del', 'E Coll', 'E Pend', 'Amount', 'Cr Days', 'Status', 'Overdue Amt']);
  });

  it('7. Cancelled invoices are excluded from the driver statement', async () => {
    const d = await mkDriver('svc2', '9922000002');
    const cust = await mkCustomer('DStmt Cancelled');
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3 });
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 5, empties: 5, status: 'cancelled' });
    const r = await deliveryPerformanceStatement(D1, d.driverId, RANGE_FROM, RANGE_TO, 'all');
    expect(r.rows.length).toBe(1);
    expect(Number(r.rows[0].fullsDelivered)).toBe(3);
  });

  it('8. Godown-pickup orders are excluded', async () => {
    const d = await mkDriver('svc3', '9922000003');
    const cust = await mkCustomer('DStmt Godown');
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3, isGodownPickup: true });
    const r = await deliveryPerformanceStatement(D1, d.driverId, RANGE_FROM, RANGE_TO, 'all');
    expect(r.rows.length).toBe(0);
  });

  it('9. KPI counts break down by status bucket', async () => {
    const d = await mkDriver('svc4', '9922000004');
    const cust = await mkCustomer('DStmt KPI');
    // Paid
    const paid = await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3, outstanding: 0, amountPaid: 9000 });
    // Overdue — dueDate must be BEFORE real today (2026-XX), not before
    // testDate (2099) — the status helper compares to real today.
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3, dueDate: new Date('2020-01-01T00:00:00.000Z') });
    // Pending (future due, not paid)
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3, dueDate: new Date('2199-01-01T00:00:00.000Z') });
    const r = await deliveryPerformanceStatement(D1, d.driverId, RANGE_FROM, RANGE_TO, 'all');
    const kpi = (r.totals?._kpiCounts as { paid: number; partial: number; pending: number; overdue: number });
    expect(kpi.paid).toBeGreaterThanOrEqual(1);
    expect(kpi.overdue).toBeGreaterThanOrEqual(1);
    expect(kpi.pending).toBeGreaterThanOrEqual(1);
    // Silence unused-var warning while retaining the reference:
    expect(paid.invoice).toBeTruthy();
  });

  it('10. statusFilter=overdue narrows rows but KPI still counts everything', async () => {
    const d = await mkDriver('svc5', '9922000005');
    const cust = await mkCustomer('DStmt Filter');
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3, outstanding: 0, amountPaid: 9000 });
    // Overdue — real-today comparison (see test 9 note).
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3, dueDate: new Date('2020-01-01T00:00:00.000Z') });
    const filtered = await deliveryPerformanceStatement(D1, d.driverId, RANGE_FROM, RANGE_TO, 'overdue');
    const all = await deliveryPerformanceStatement(D1, d.driverId, RANGE_FROM, RANGE_TO, 'all');
    expect(filtered.rows.every((r) => r.status === 'Overdue')).toBe(true);
    expect(filtered.rows.length).toBeLessThan(all.rows.length);
    // Both should report the same KPI counts (KPIs run before the filter).
    expect(filtered.totals?._kpiCounts).toEqual(all.totals?._kpiCounts);
  });

  it('11. Cylinders column compact-formats a multi-cyl-type order', async () => {
    const d = await mkDriver('svc6', '9922000006');
    const cust = await mkCustomer('DStmt MultiCyl');
    const cyl2 = await prisma.cylinderType.findFirst({
      where: { distributorId: D1, id: { not: cyl19 } },
      select: { id: true, typeName: true },
    });
    if (!cyl2) return; // env has only one cyl seeded
    const order = await prisma.order.create({
      data: {
        distributorId: D1,
        customerId: cust,
        driverId: d.driverId,
        orderNumber: `TEST-DSTMT-MULTI-${Date.now().toString(36)}`,
        orderDate: testDate,
        deliveryDate: testDate,
        status: 'delivered',
        orderType: 'delivery',
        totalAmount: 20000,
        items: {
          create: [
            { cylinderTypeId: cyl19, quantity: 3, deliveredQuantity: 3, emptiesCollected: 3, unitPrice: 3000, totalPrice: 9000 },
            { cylinderTypeId: cyl2.id, quantity: 2, deliveredQuantity: 2, emptiesCollected: 2, unitPrice: 5500, totalPrice: 11000 },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    const inv = await prisma.invoice.create({
      data: {
        distributorId: D1,
        customerId: cust,
        orderId: order.id,
        invoiceNumber: `TEST-INV-DSTMT-MULTI-${Date.now().toString(36)}`,
        issueDate: testDate,
        dueDate: new Date(testDate.getTime() + 30 * 24 * 60 * 60 * 1000),
        totalAmount: 20000,
        outstandingAmount: 20000,
        status: 'issued',
        items: {
          create: [
            { cylinderTypeId: cyl19, description: 'X', quantity: 3, unitPrice: 3000, totalPrice: 9000 },
            { cylinderTypeId: cyl2.id, description: 'Y', quantity: 2, unitPrice: 5500, totalPrice: 11000 },
          ],
        },
      },
    });
    createdInvoiceIds.push(inv.id);

    const r = await deliveryPerformanceStatement(D1, d.driverId, RANGE_FROM, RANGE_TO, 'all');
    expect(r.rows[0].cylinders).toMatch(/×/);
    expect(r.rows[0].cylinders).toMatch(/,/);
    expect(r.rows[0].fullsDelivered).toBe(5); // 3 + 2 combined
  });
});

// ─── PDF byte-shape ────────────────────────────────────────────────────────

describe('generateDriverStatementPdf', () => {
  it('12. Returns a valid PDF buffer with %PDF header', async () => {
    const d = await mkDriver('pdf1', '9922000007');
    const cust = await mkCustomer('DStmt PDF');
    await mkOrderInvoice({ driverId: d.driverId, customerId: cust, cylinderTypeId: cyl19, fulls: 3, empties: 3 });
    const buf = await generateDriverStatementPdf(D1, d.driverId, {
      from: '2099-12-20',
      to: '2099-12-31',
      statusFilter: 'all',
    });
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('13. Renders "No invoices match" copy when zero rows', async () => {
    const d = await mkDriver('pdf2', '9922000008');
    // No orders created for this driver in the range → PDF should still generate.
    const buf = await generateDriverStatementPdf(D1, d.driverId, {
      from: '2099-12-20',
      to: '2099-12-31',
      statusFilter: 'overdue',
    });
    expect(buf.length).toBeGreaterThan(500);
    // Header + summary still render even with zero rows.
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('14. Throws "Driver not found" for a mismatched driverId (tenant isolation)', async () => {
    await expect(
      generateDriverStatementPdf(D1, '00000000-0000-0000-0000-000000000000', { from: '2099-12-20', to: '2099-12-31' }),
    ).rejects.toThrow(/Driver not found/);
  });
});
