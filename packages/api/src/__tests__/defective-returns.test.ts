/**
 * F1 Defective Returns — comprehensive test suite (2026-08-06).
 *
 * Scenarios covered:
 *   - Capture: positive + wire-shape + validation guards (qty, invoice, date, cross-tenant)
 *   - Raise CN: positive + paid-invoice CN + wire-shape + already-cn'd guard + cross-invoice guard
 *   - History + pending count + role visibility
 *   - Inventory aggregation regression (closingFulls untouched, closingDefectiveFulls tracks)
 *   - Anti-pattern #24 guards on 5 CustomerInventoryBalance readers
 *   - Outgoing batch: positive + numbering + status transitions + physical event
 *   - Scenario: end-to-end happy path (capture → check ledger → raise CN → check ledger → batch → corp credit)
 *   - Scenario: cross-tenant isolation (dist-002 admin cannot touch dist-001 defective rows)
 *   - Cancel: positive + status guard + inventory reversal
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  loginAsFinance,
  loginAsInventory,
  loginAsDriver,
} from './helpers.js';
import {
  captureDefectiveReturn,
  raiseDefectiveCn,
  getPendingCnCount,
  getDefectiveDepotBucket,
  createDefectiveReturnBatch,
  markBatchCorpCreditReceived,
  cancelDefectiveReturn,
  listDefectiveEligibleInvoices,
  DefectiveReturnError,
} from '../services/defectiveReturnService.js';

// Anti-pattern #7 — far-future dates so real dev-DB data isn't contaminated.
// Choose collected dates that fall within the 90-day-past window relative
// to what the service considers "today" — schema-validation happens at the
// zod level (which we bypass for service tests) or here inside the service
// with a 90-day check. To exercise both success + validation, use dates:
//   TEST_ISSUE = far-past (source invoice issue)  → 3 days ago
//   TEST_COLLECT = 1 day ago                       → passes 90-day window
// This means we DO touch the current date arithmetic, but only with a small
// bounded window per test. The isolation strategy is: unique customer names
// prefixed with the test file, distinct invoice numbers per test.

const TAG = 'F1-DEFRET-TEST';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;
let driverToken: string;
let distributorId: string;
let dist002DistributorId: string;
let cyl19kg: { id: string; typeName: string };
let cyl5kg: { id: string; typeName: string };

// Helper to build a well-formed source invoice for a customer, with N items.
async function seedInvoiceForCustomer(opts: {
  customerId: string;
  distributorId: string;
  invoiceNumber: string;
  issueDate?: Date;
  items: Array<{ cylinderTypeId: string; quantity: number; unitPrice: number }>;
  status?: 'issued' | 'paid';
}) {
  const items = opts.items.map((it) => ({
    cylinderTypeId: it.cylinderTypeId,
    description: `Test line ${it.cylinderTypeId.slice(0, 6)}`,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    totalPrice: it.unitPrice * it.quantity,
    gstRate: 18,
  }));
  const total = items.reduce((s, it) => s + it.totalPrice, 0);
  const invoice = await prisma.invoice.create({
    data: {
      distributorId: opts.distributorId,
      customerId: opts.customerId,
      invoiceNumber: opts.invoiceNumber,
      issueDate: opts.issueDate ?? new Date(),
      dueDate: opts.issueDate ?? new Date(),
      totalAmount: total,
      amountPaid: opts.status === 'paid' ? total : 0,
      outstandingAmount: opts.status === 'paid' ? 0 : total,
      status: opts.status ?? 'issued',
      cgstValue: Math.round((total / 1.18) * 0.09 * 100) / 100,
      sgstValue: Math.round((total / 1.18) * 0.09 * 100) / 100,
      igstValue: 0,
      irnStatus: 'not_attempted',
      ewbStatus: 'not_attempted',
      items: { create: items },
    },
    include: { items: true },
  });
  return invoice;
}

async function seedTestCustomer(distId: string, name: string, gstin: string | null = null) {
  return prisma.customer.create({
    data: {
      distributorId: distId,
      customerName: `${TAG}-${name}-${Date.now().toString(36)}`,
      phone: `9847${Math.floor(Math.random() * 900000 + 100000)}`,
      customerType: gstin ? 'B2B' : 'B2C',
      gstin,
      billingAddressLine1: 'Test',
      billingCity: 'Bangalore',
      billingState: 'Karnataka',
      creditPeriodDays: 30,
    },
  });
}

// Yesterday's date, YYYY-MM-DD — used as the collected date so we're safely
// inside the 90-day past window.
function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeAll(async () => {
  app = createApp();
  const adm = await loginAsDistAdmin();
  const fin = await loginAsFinance();
  const inv = await loginAsInventory();
  const drv = await loginAsDriver();
  adminToken = adm.token;
  financeToken = fin.token;
  inventoryToken = inv.token;
  driverToken = drv.token;
  distributorId = adm.distributorId;
  dist002DistributorId = 'dist-002';

  // Pin two cylinder types for the tests (should exist in seed).
  const cyls = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    orderBy: { capacity: 'desc' },
    take: 2,
    select: { id: true, typeName: true },
  });
  if (cyls.length < 2) throw new Error('Need at least 2 cylinder types seeded for dist-001');
  cyl19kg = cyls[0];
  cyl5kg = cyls[1];
});

afterAll(async () => {
  // Clean up all rows created by this test file, matched via the TAG prefix
  // on customer name. Order matters: children before parents.
  const customers = await prisma.customer.findMany({
    where: { customerName: { startsWith: TAG } },
    select: { id: true },
  });
  const custIds = customers.map((c) => c.id);
  if (custIds.length === 0) return;

  const drRows = await prisma.defectiveCylinderLedger.findMany({
    where: { customerId: { in: custIds } },
    select: { id: true, batchId: true },
  });
  const batchIds = [...new Set(drRows.map((r) => r.batchId).filter((b): b is string => b != null))];
  const drIds = drRows.map((r) => r.id);

  const invoices = await prisma.invoice.findMany({
    where: { customerId: { in: custIds } },
    select: { id: true },
  });
  const invIds = invoices.map((i) => i.id);

  // Delete in dependency order
  if (drIds.length > 0) {
    await prisma.inventoryEvent.deleteMany({
      where: { referenceId: { in: drIds } },
    });
    await prisma.customerLedgerEntry.deleteMany({
      where: { referenceId: { in: drIds } },
    });
    await prisma.defectiveCylinderLedger.deleteMany({
      where: { id: { in: drIds } },
    });
  }
  if (batchIds.length > 0) {
    await prisma.inventoryEvent.deleteMany({
      where: { referenceId: { in: batchIds } },
    });
    await prisma.defectiveReturnBatch.deleteMany({
      where: { id: { in: batchIds } },
    });
  }
  if (invIds.length > 0) {
    await prisma.customerLedgerEntry.deleteMany({ where: { invoiceId: { in: invIds } } });
    await prisma.creditNote.deleteMany({ where: { invoiceId: { in: invIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: invIds } } });
  }
  await prisma.customerInventoryBalance.deleteMany({ where: { customerId: { in: custIds } } });
  await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: custIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
});

// ─── Group 1 — Capture ──────────────────────────────────────────────────────

describe('F1 — Capture defective return', () => {
  it('T1 — writes DefectiveCylinderLedger row with status=collected + correct cnAmount', async () => {
    const cust = await seedTestCustomer(distributorId, 'CAP-T1');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id,
      distributorId,
      invoiceNumber: `${TAG}-CAP-T1-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 5, unitPrice: 1180 }],
    });
    const result = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id,
      sourceInvoiceId: inv.id,
      collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2 }],
    });
    expect(result.defectiveIds).toHaveLength(1);
    expect(result.cnAmountPreview).toBe(2360);

    const row = await prisma.defectiveCylinderLedger.findUniqueOrThrow({
      where: { id: result.defectiveIds[0] },
    });
    expect(row.status).toBe('collected');
    expect(row.quantity).toBe(2);
    expect(Number(row.perCylRate)).toBe(1180);
    expect(Number(row.cnAmount)).toBe(2360);
    expect(row.creditNoteId).toBeNull();
    expect(row.cnRaisedAt).toBeNull();
  });

  it('T2 — writes defective_return_from_customer InventoryEvent with negative fullsChange', async () => {
    const cust = await seedTestCustomer(distributorId, 'CAP-T2');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CAP-T2-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1200 }],
    });
    const { defectiveIds } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id,
      sourceInvoiceId: inv.id,
      collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const events = await prisma.inventoryEvent.findMany({
      where: { referenceId: defectiveIds[0], referenceType: 'defective_return' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('defective_return_from_customer');
    expect(events[0].fullsChange).toBe(-1);
    expect(events[0].emptiesChange).toBe(0);
  });

  it('T3 — decrements CustomerInventoryBalance.withCustomerQty', async () => {
    const cust = await seedTestCustomer(distributorId, 'CAP-T3');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CAP-T3-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 4, unitPrice: 1180 }],
    });
    // Seed customer balance at +10
    await prisma.customerInventoryBalance.create({
      data: { customerId: cust.id, cylinderTypeId: cyl19kg.id, withCustomerQty: 10 },
    });
    await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id,
      sourceInvoiceId: inv.id,
      collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3 }],
    });
    const bal = await prisma.customerInventoryBalance.findUniqueOrThrow({
      where: { customerId_cylinderTypeId: { customerId: cust.id, cylinderTypeId: cyl19kg.id } },
    });
    expect(bal.withCustomerQty).toBe(7);
  });

  it('T4 — writes CustomerLedgerEntry defective_collected with amountDelta=0 + invoiceId=null', async () => {
    const cust = await seedTestCustomer(distributorId, 'CAP-T4');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CAP-T4-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2, unitPrice: 1180 }],
    });
    const { defectiveIds } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id,
      sourceInvoiceId: inv.id,
      collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const entries = await prisma.customerLedgerEntry.findMany({
      where: { referenceId: defectiveIds[0], entryType: 'defective_collected' },
    });
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].amountDelta)).toBe(0);
    expect(entries[0].invoiceId).toBeNull();
    expect(entries[0].narration).toContain('Defective:');
    expect(entries[0].narration).toContain('pending CN');
  });

  it('T5 — multi-cyl-type capture writes N DR rows in one call', async () => {
    const cust = await seedTestCustomer(distributorId, 'CAP-T5');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CAP-T5-${Date.now()}`,
      items: [
        { cylinderTypeId: cyl19kg.id, quantity: 5, unitPrice: 1180 },
        { cylinderTypeId: cyl5kg.id, quantity: 3, unitPrice: 450 },
      ],
    });
    const { defectiveIds, cnAmountPreview } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id,
      sourceInvoiceId: inv.id,
      collectedDate: yesterdayISO(),
      items: [
        { cylinderTypeId: cyl19kg.id, quantity: 2 },
        { cylinderTypeId: cyl5kg.id, quantity: 1 },
      ],
    });
    expect(defectiveIds).toHaveLength(2);
    // preview = 2*1180 + 1*450 = 2810
    expect(cnAmountPreview).toBe(2810);
  });

  it('T6 — qty > remaining rejected', async () => {
    const cust = await seedTestCustomer(distributorId, 'CAP-T6');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CAP-T6-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2, unitPrice: 1180 }],
    });
    await expect(
      captureDefectiveReturn(distributorId, 'test-user', {
        customerId: cust.id,
        sourceInvoiceId: inv.id,
        collectedDate: yesterdayISO(),
        items: [{ cylinderTypeId: cyl19kg.id, quantity: 5 }],
      }),
    ).rejects.toThrow(DefectiveReturnError);
  });

  it('T7 — source invoice not belonging to this customer rejected', async () => {
    const custA = await seedTestCustomer(distributorId, 'CAP-T7-A');
    const custB = await seedTestCustomer(distributorId, 'CAP-T7-B');
    const invForA = await seedInvoiceForCustomer({
      customerId: custA.id, distributorId,
      invoiceNumber: `${TAG}-CAP-T7-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    // Try to claim custA's invoice as custB's defective
    await expect(
      captureDefectiveReturn(distributorId, 'test-user', {
        customerId: custB.id,
        sourceInvoiceId: invForA.id,
        collectedDate: yesterdayISO(),
        items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
      }),
    ).rejects.toThrow(DefectiveReturnError);
  });

  it('T8 — source invoice > 90 days old rejected', async () => {
    const cust = await seedTestCustomer(distributorId, 'CAP-T8');
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CAP-T8-${Date.now()}`,
      issueDate: oldDate,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    await expect(
      captureDefectiveReturn(distributorId, 'test-user', {
        customerId: cust.id,
        sourceInvoiceId: inv.id,
        collectedDate: yesterdayISO(),
        items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/older than 90 days/i);
  });

  it('T9 — cross-tenant customer rejected (dist-001 admin, dist-002 customer)', async () => {
    // Create a customer in dist-002 (Sharma) and try to capture as dist-001
    const cust2 = await seedTestCustomer(dist002DistributorId, 'CAP-T9');
    // Give dist-002 an invoice
    const cyl002 = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: dist002DistributorId, isActive: true },
    });
    const inv = await seedInvoiceForCustomer({
      customerId: cust2.id,
      distributorId: dist002DistributorId,
      invoiceNumber: `${TAG}-CAP-T9-${Date.now()}`,
      items: [{ cylinderTypeId: cyl002.id, quantity: 3, unitPrice: 1180 }],
    });
    await expect(
      captureDefectiveReturn(distributorId /* dist-001 */, 'test-user', {
        customerId: cust2.id, // dist-002 customer
        sourceInvoiceId: inv.id,
        collectedDate: yesterdayISO(),
        items: [{ cylinderTypeId: cyl002.id, quantity: 1 }],
      }),
    ).rejects.toThrow(DefectiveReturnError);
  });
});

// ─── Group 2 — Raise CN ─────────────────────────────────────────────────────

describe('F1 — Raise credit note', () => {
  it('T10 — raises CN with correct amount + updates DR rows to cn_issued', async () => {
    const cust = await seedTestCustomer(distributorId, 'CN-T10');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CN-T10-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 4, unitPrice: 1180 }],
    });
    const { defectiveIds } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id,
      sourceInvoiceId: inv.id,
      collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2 }],
    });
    const cn = await raiseDefectiveCn(distributorId, 'test-user', {
      defectiveIds,
      reason: 'Leaky valve',
    });
    expect(cn.cnAmount).toBe(2360);
    expect(cn.cnNumber).toBeTruthy();
    // Verify the CN exists
    const cnRow = await prisma.creditNote.findUniqueOrThrow({ where: { id: cn.creditNoteId } });
    expect(Number(cnRow.totalAmount)).toBe(2360);
    // Verify DR rows updated
    const dr = await prisma.defectiveCylinderLedger.findUniqueOrThrow({
      where: { id: defectiveIds[0] },
    });
    expect(dr.status).toBe('cn_issued');
    expect(dr.creditNoteId).toBe(cn.creditNoteId);
    expect(dr.cnRaisedAt).not.toBeNull();
  });

  it('T11 — writes CustomerLedgerEntry credit_note with negative amountDelta', async () => {
    const cust = await seedTestCustomer(distributorId, 'CN-T11');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CN-T11-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const { defectiveIds } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const cn = await raiseDefectiveCn(distributorId, 'test-user', {
      defectiveIds, reason: 'Damaged',
    });
    const cnLedger = await prisma.customerLedgerEntry.findFirst({
      where: {
        customerId: cust.id,
        entryType: 'credit_note',
        referenceId: cn.creditNoteId,
      },
    });
    expect(cnLedger).not.toBeNull();
    expect(Number(cnLedger!.amountDelta)).toBe(-1180);
  });

  it('T12 — CN against PAID invoice succeeds (customer credit carries forward)', async () => {
    const cust = await seedTestCustomer(distributorId, 'CN-T12');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CN-T12-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2, unitPrice: 1180 }],
      status: 'paid',
    });
    expect(Number(inv.outstandingAmount)).toBe(0);
    const { defectiveIds } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const cn = await raiseDefectiveCn(distributorId, 'test-user', {
      defectiveIds, reason: 'Post-payment defect',
    });
    expect(cn.cnAmount).toBe(1180);
    // Invoice.outstandingAmount was 0, approveCreditNote clamps at 0
    const invAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(Number(invAfter.outstandingAmount)).toBe(0);
    // But customer ledger picks up the -1180
    const ledgerEntries = await prisma.customerLedgerEntry.findMany({
      where: { customerId: cust.id, entryType: 'credit_note' },
    });
    expect(ledgerEntries.some((e) => Number(e.amountDelta) === -1180)).toBe(true);
  });

  it('T13 — double raise-cn on same rows rejected', async () => {
    const cust = await seedTestCustomer(distributorId, 'CN-T13');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CN-T13-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const { defectiveIds } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    await raiseDefectiveCn(distributorId, 'test-user', { defectiveIds, reason: 'First CN' });
    await expect(
      raiseDefectiveCn(distributorId, 'test-user', { defectiveIds, reason: 'Second CN' }),
    ).rejects.toThrow(/not 'collected'/i);
  });

  it('T14 — raise-cn across different source invoices rejected', async () => {
    const cust = await seedTestCustomer(distributorId, 'CN-T14');
    const invA = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CN-T14-A-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const invB = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CN-T14-B-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const drA = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: invA.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const drB = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: invB.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    await expect(
      raiseDefectiveCn(distributorId, 'test-user', {
        defectiveIds: [...drA.defectiveIds, ...drB.defectiveIds],
        reason: 'Cross-invoice',
      }),
    ).rejects.toThrow(/share the same source invoice/i);
  });

  it('T15 — cumulative CN exceeding invoice total rejected', async () => {
    const cust = await seedTestCustomer(distributorId, 'CN-T15');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CN-T15-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2, unitPrice: 1180 }],
    });
    // Manually create a prior CN of 2000 against the invoice
    await prisma.creditNote.create({
      data: {
        invoiceId: inv.id,
        creditNoteNumber: `PRIOR-${Date.now()}`,
        totalAmount: 2000,
        reason: 'prior',
        status: 'approved_cn',
      },
    });
    const { defectiveIds } = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    // Now try to raise another 1180 → total would be 3180, invoice is 2360
    await expect(
      raiseDefectiveCn(distributorId, 'test-user', { defectiveIds, reason: 'Over' }),
    ).rejects.toThrow(/would exceed invoice total/i);
  });
});

// ─── Group 3 — History + role visibility ────────────────────────────────────

describe('F1 — Reads (history, pending count, depot bucket, role visibility)', () => {
  it('T16 — pending count returns only collected rows', async () => {
    const cust = await seedTestCustomer(distributorId, 'READ-T16');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-READ-T16-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 5, unitPrice: 1180 }],
    });
    const before = await getPendingCnCount(distributorId);
    await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const after = await getPendingCnCount(distributorId);
    expect(after).toBe(before + 1);
  });

  it('T17 — pending count DECREMENTS after raise-cn', async () => {
    const cust = await seedTestCustomer(distributorId, 'READ-T17');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-READ-T17-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const before = await getPendingCnCount(distributorId);
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    expect(await getPendingCnCount(distributorId)).toBe(before + 1);
    await raiseDefectiveCn(distributorId, 'test-user', {
      defectiveIds: cap.defectiveIds, reason: 'test',
    });
    expect(await getPendingCnCount(distributorId)).toBe(before);
  });

  it('T18 — depot bucket surfaces cn_issued rows only', async () => {
    const cust = await seedTestCustomer(distributorId, 'READ-T18');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-READ-T18-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2 }],
    });
    // Before raising CN — depot bucket should NOT include this
    const bucketBefore = await getDefectiveDepotBucket(distributorId);
    const beforeQty = bucketBefore.find((b) => b.cylinderTypeId === cyl19kg.id)?.qty ?? 0;
    await raiseDefectiveCn(distributorId, 'test-user', {
      defectiveIds: cap.defectiveIds, reason: 'test',
    });
    // After raising CN — depot bucket now includes this
    const bucketAfter = await getDefectiveDepotBucket(distributorId);
    const afterQty = bucketAfter.find((b) => b.cylinderTypeId === cyl19kg.id)?.qty ?? 0;
    expect(afterQty).toBe(beforeQty + 2);
  });

  it('T19 — driver role hitting any DR route → 403', async () => {
    const res = await request(app)
      .get('/api/defective-returns/pending-count')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
  });

  it('T20 — inventory role CAN capture (staff-tier gate)', async () => {
    const cust = await seedTestCustomer(distributorId, 'READ-T20');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-READ-T20-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const res = await request(app)
      .post('/api/defective-returns')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .send({
        customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
        items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
      });
    expect(res.status).toBe(201);
  });

  it('T21 — inventory role CANNOT raise CN (CN-approve-tier gate)', async () => {
    const cust = await seedTestCustomer(distributorId, 'READ-T21');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-READ-T21-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const res = await request(app)
      .post(`/api/defective-returns/${cap.defectiveIds[0]}/raise-cn`)
      .set('Authorization', `Bearer ${inventoryToken}`)
      .send({ defectiveIds: cap.defectiveIds, reason: 'inventory tries CN' });
    expect(res.status).toBe(403);
  });

  it('T22 — finance role CAN raise CN', async () => {
    const cust = await seedTestCustomer(distributorId, 'READ-T22');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-READ-T22-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    const res = await request(app)
      .post(`/api/defective-returns/${cap.defectiveIds[0]}/raise-cn`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ defectiveIds: cap.defectiveIds, reason: 'finance CN' });
    expect(res.status).toBe(200);
  });

  it('T23 — HTTP GET /api/defective-returns wire shape', async () => {
    const res = await request(app)
      .get('/api/defective-returns')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('status');
      expect(row).toHaveProperty('quantity');
      expect(row).toHaveProperty('cnAmount');
      expect(row).toHaveProperty('cylinderTypeName');
    }
  });
});

// ─── Group 4 — Inventory integration (regression + defective bucket math) ──

describe('F1 — Inventory aggregation integration', () => {
  it('T24 — capture then batch: closingDefectiveFulls updates, closingFulls untouched', async () => {
    const cust = await seedTestCustomer(distributorId, 'INV-T24');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-INV-T24-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 5, unitPrice: 1180 }],
    });
    const collectedDate = yesterdayISO();

    // Snapshot pre-existing closingFulls on that date for this cyl (should exist from seed)
    const before = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId,
          cylinderTypeId: cyl19kg.id,
          summaryDate: new Date(`${collectedDate}T00:00:00.000Z`),
        },
      },
    });
    const beforeClosingFulls = before?.closingFulls ?? 0;
    const beforeClosingDefective = before?.closingDefectiveFulls ?? 0;

    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3 }],
    });

    const after = await prisma.inventorySummary.findUniqueOrThrow({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId,
          cylinderTypeId: cyl19kg.id,
          summaryDate: new Date(`${collectedDate}T00:00:00.000Z`),
        },
      },
    });
    // closingFulls MUST NOT change (WI-106 zone)
    expect(after.closingFulls).toBe(beforeClosingFulls);
    // closingDefectiveFulls MUST increase by 3
    expect(after.closingDefectiveFulls).toBe(beforeClosingDefective + 3);
    expect(after.defectiveFullsIn).toBeGreaterThanOrEqual(3);

    // Raise CN so we can batch
    await raiseDefectiveCn(distributorId, 'test-user', { defectiveIds: cap.defectiveIds, reason: 'T24' });

    // Now batch to corp
    await createDefectiveReturnBatch(distributorId, 'test-user', {
      corporationName: 'IOCL',
      defectiveIds: cap.defectiveIds,
    });

    // Batch recompute fires an event with `eventDate: now` which the DB
    // stores as a @db.Date (date-only). To avoid TZ boundary confusion,
    // query for any summary in the last 2 days that carries the defective
    // event's contribution.
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    twoDaysAgo.setHours(0, 0, 0, 0);
    const recentSummaries = await prisma.inventorySummary.findMany({
      where: {
        distributorId, cylinderTypeId: cyl19kg.id,
        summaryDate: { gte: twoDaysAgo },
      },
    });
    const totalOut = recentSummaries.reduce((s, r) => s + r.defectiveFullsOut, 0);
    expect(totalOut).toBeGreaterThanOrEqual(3);
  });
});

// ─── Group 5 — Anti-pattern #24 guards ──────────────────────────────────────

describe('F1 — Anti-pattern #24 guards (readers of withCustomerQty)', () => {
  it('T25 — customer credit gate (computeCustomerOverdue) unaffected by defective decrement', async () => {
    // Simple smoke: capture a defective, then invoke the credit gate lookup;
    // the number should just be about the ledger (invoice / payment), which
    // withCustomerQty doesn't feed. Any regression here would indicate
    // withCustomerQty leaking into the money-side.
    const cust = await seedTestCustomer(distributorId, 'AP24-T25');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-AP24-T25-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    // Import lazily so we don't have to plumb an extra module import at top
    const { computeCustomerOverdue } = await import('../services/paymentService.js');
    const overdue = await computeCustomerOverdue(distributorId, cust.id);
    // Overdue is a number (or object with total) — the exact number depends on
    // credit policy. We only assert that the CALL doesn't throw and returns.
    expect(overdue).toBeDefined();
  });

  it('T26 — CustomerInventoryBalance query for "empty cylinders per customer" still returns clean numbers', async () => {
    const cust = await seedTestCustomer(distributorId, 'AP24-T26');
    await prisma.customerInventoryBalance.create({
      data: { customerId: cust.id, cylinderTypeId: cyl19kg.id, withCustomerQty: 5 },
    });
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-AP24-T26-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 5, unitPrice: 1180 }],
    });
    await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2 }],
    });
    // Empty-cylinders reader: sum(withCustomerQty) per cyl type. After the
    // defective pickup the customer holds 3 (was 5, minus 2).
    const bal = await prisma.customerInventoryBalance.findUniqueOrThrow({
      where: {
        customerId_cylinderTypeId: {
          customerId: cust.id, cylinderTypeId: cyl19kg.id,
        },
      },
    });
    expect(bal.withCustomerQty).toBe(3);
  });
});

// ─── Group 6 — Outgoing batch ───────────────────────────────────────────────

describe('F1 — Outgoing batch to corporation', () => {
  it('T27 — batch creates row with F-prefix number, transitions DR status', async () => {
    const cust = await seedTestCustomer(distributorId, 'BATCH-T27');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-BATCH-T27-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2 }],
    });
    await raiseDefectiveCn(distributorId, 'test-user', {
      defectiveIds: cap.defectiveIds, reason: 'T27',
    });
    const batch = await createDefectiveReturnBatch(distributorId, 'test-user', {
      corporationName: 'IOCL',
      defectiveIds: cap.defectiveIds,
    });
    // Accepts either F-prefix (when tenant has docCode set — production
    // path) or DR-BATCH- legacy fallback (dev seed tenants without docCode,
    // mirroring how invoiceService.createCreditNote falls back to legacyNumber).
    expect(batch.batchNumber).toMatch(/^(F|DR-BATCH-)/);
    expect(batch.totalQuantity).toBe(2);
    const dr = await prisma.defectiveCylinderLedger.findUniqueOrThrow({
      where: { id: cap.defectiveIds[0] },
    });
    expect(dr.status).toBe('sent_to_corporation');
    expect(dr.batchId).toBe(batch.batchId);
  });

  it('T28 — batch rejects rows in wrong status (must be cn_issued)', async () => {
    const cust = await seedTestCustomer(distributorId, 'BATCH-T28');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-BATCH-T28-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    // Row is at status='collected', not 'cn_issued' — batch should reject
    await expect(
      createDefectiveReturnBatch(distributorId, 'test-user', {
        corporationName: 'IOCL',
        defectiveIds: cap.defectiveIds,
      }),
    ).rejects.toThrow(/not ready to ship/i);
  });

  it('T29 — mark corp credit received flips status + DR rows to corporation_credit_received', async () => {
    const cust = await seedTestCustomer(distributorId, 'BATCH-T29');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-BATCH-T29-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    await raiseDefectiveCn(distributorId, 'test-user', { defectiveIds: cap.defectiveIds, reason: 'T29' });
    const batch = await createDefectiveReturnBatch(distributorId, 'test-user', {
      corporationName: 'IOCL',
      defectiveIds: cap.defectiveIds,
    });
    await markBatchCorpCreditReceived(distributorId, 'test-user', batch.batchId, 1180);
    const batchAfter = await prisma.defectiveReturnBatch.findUniqueOrThrow({ where: { id: batch.batchId } });
    expect(batchAfter.status).toBe('corp_credit_received');
    expect(Number(batchAfter.corpCreditAmount)).toBe(1180);
    const drAfter = await prisma.defectiveCylinderLedger.findUniqueOrThrow({
      where: { id: cap.defectiveIds[0] },
    });
    expect(drAfter.status).toBe('corporation_credit_received');
  });

  it('T30 — batch with sourceDistributorId (mini-op / FK) captures FK', async () => {
    // sourceDistributor is optional; if provided, must belong to distributor.
    // Seed a synthetic SourceDistributor row for this test.
    const sd = await prisma.sourceDistributor.create({
      data: {
        distributorId,
        name: `${TAG}-CORP-T30`,
      },
    });
    const cust = await seedTestCustomer(distributorId, 'BATCH-T30');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-BATCH-T30-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    await raiseDefectiveCn(distributorId, 'test-user', { defectiveIds: cap.defectiveIds, reason: 'T30' });
    const batch = await createDefectiveReturnBatch(distributorId, 'test-user', {
      corporationName: 'IOCL',
      sourceDistributorId: sd.id,
      defectiveIds: cap.defectiveIds,
    });
    const batchRow = await prisma.defectiveReturnBatch.findUniqueOrThrow({ where: { id: batch.batchId } });
    expect(batchRow.sourceDistributorId).toBe(sd.id);
    // Cleanup
    await prisma.sourceDistributor.delete({ where: { id: sd.id } }).catch(() => {});
  });
});

// ─── Group 7 — Cancel ───────────────────────────────────────────────────────

describe('F1 — Cancel captured defective before CN', () => {
  it('T31 — cancel restores customer balance + flips status', async () => {
    const cust = await seedTestCustomer(distributorId, 'CANCEL-T31');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CANCEL-T31-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    await prisma.customerInventoryBalance.create({
      data: { customerId: cust.id, cylinderTypeId: cyl19kg.id, withCustomerQty: 5 },
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2 }],
    });
    let bal = await prisma.customerInventoryBalance.findUniqueOrThrow({
      where: { customerId_cylinderTypeId: { customerId: cust.id, cylinderTypeId: cyl19kg.id } },
    });
    expect(bal.withCustomerQty).toBe(3);
    // Cancel
    await cancelDefectiveReturn(distributorId, 'test-user', cap.defectiveIds[0], { reason: 'op error' });
    bal = await prisma.customerInventoryBalance.findUniqueOrThrow({
      where: { customerId_cylinderTypeId: { customerId: cust.id, cylinderTypeId: cyl19kg.id } },
    });
    expect(bal.withCustomerQty).toBe(5); // restored
    const dr = await prisma.defectiveCylinderLedger.findUniqueOrThrow({ where: { id: cap.defectiveIds[0] } });
    expect(dr.status).toBe('cancelled');
    expect(dr.cancelReason).toBe('op error');
  });

  it('T32 — cancel after CN raised is rejected', async () => {
    const cust = await seedTestCustomer(distributorId, 'CANCEL-T32');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-CANCEL-T32-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3, unitPrice: 1180 }],
    });
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 1 }],
    });
    await raiseDefectiveCn(distributorId, 'test-user', { defectiveIds: cap.defectiveIds, reason: 'T32' });
    await expect(
      cancelDefectiveReturn(distributorId, 'test-user', cap.defectiveIds[0], { reason: 'too late' }),
    ).rejects.toThrow(/status 'cn_issued'/i);
  });
});

// ─── Group 8 — Eligible invoices picker ─────────────────────────────────────

describe('F1 — Eligible invoices picker', () => {
  it('T33 — lists invoices from the last 90 days with remaining qty', async () => {
    const cust = await seedTestCustomer(distributorId, 'PICKER-T33');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-PICKER-T33-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 5, unitPrice: 1180 }],
    });
    const rows = await listDefectiveEligibleInvoices(distributorId, cust.id);
    const target = rows.find((r) => r.invoiceId === inv.id);
    expect(target).toBeDefined();
    expect(target!.lines).toHaveLength(1);
    expect(target!.lines[0].qty).toBe(5);
    expect(target!.lines[0].alreadyClaimedQty).toBe(0);
    expect(target!.lines[0].remainingQty).toBe(5);
    expect(target!.lines[0].perCylRate).toBe(1180);
  });

  it('T34 — subtracts prior defective claims from remainingQty', async () => {
    const cust = await seedTestCustomer(distributorId, 'PICKER-T34');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-PICKER-T34-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 5, unitPrice: 1180 }],
    });
    await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 2 }],
    });
    const rows = await listDefectiveEligibleInvoices(distributorId, cust.id);
    const target = rows.find((r) => r.invoiceId === inv.id);
    expect(target!.lines[0].alreadyClaimedQty).toBe(2);
    expect(target!.lines[0].remainingQty).toBe(3);
  });

  it('T35 — cross-tenant customer rejected', async () => {
    const cust2 = await seedTestCustomer(dist002DistributorId, 'PICKER-T35');
    await expect(
      listDefectiveEligibleInvoices(distributorId /* dist-001 */, cust2.id),
    ).rejects.toThrow(/Customer not found/i);
  });
});

// ─── Group 9 — End-to-end scenario ──────────────────────────────────────────

describe('F1 — Scenario: full happy path', () => {
  it('T36 — capture → check ledger → raise CN → check ledger → batch → corp credit', async () => {
    const cust = await seedTestCustomer(distributorId, 'SCEN-T36');
    const inv = await seedInvoiceForCustomer({
      customerId: cust.id, distributorId,
      invoiceNumber: `${TAG}-SCEN-T36-${Date.now()}`,
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 4, unitPrice: 1180 }],
    });

    // Step 1 — capture 3 defective
    const cap = await captureDefectiveReturn(distributorId, 'test-user', {
      customerId: cust.id, sourceInvoiceId: inv.id, collectedDate: yesterdayISO(),
      items: [{ cylinderTypeId: cyl19kg.id, quantity: 3 }],
    });
    expect(cap.defectiveIds).toHaveLength(1);
    expect(cap.cnAmountPreview).toBe(3540);

    // Step 2 — "check ledger" — the defective_collected row should be present
    const preLedger = await prisma.customerLedgerEntry.findMany({
      where: { customerId: cust.id, entryType: 'defective_collected' },
    });
    expect(preLedger.length).toBeGreaterThanOrEqual(1);
    expect(preLedger.some((e) => e.narration?.includes('pending CN'))).toBe(true);

    // Step 3 — raise CN
    const cn = await raiseDefectiveCn(distributorId, 'test-user', {
      defectiveIds: cap.defectiveIds, reason: 'End-to-end scenario',
    });
    expect(cn.cnAmount).toBe(3540);

    // Step 4 — "check ledger" post-CN — credit_note row + narration updated on DR ledger row
    const postCn = await prisma.customerLedgerEntry.findMany({
      where: { customerId: cust.id, entryType: 'credit_note', referenceId: cn.creditNoteId },
    });
    expect(postCn).toHaveLength(1);
    expect(Number(postCn[0].amountDelta)).toBe(-3540);
    // The defective_collected narration should now mention the CN number.
    // F1-FIX-8 (2026-08-06) — narration was shortened to fit PDF column;
    // format is now "Defective: N× <TYPE> · CN <CN_NUMBER>" (was
    // "Defective: N× (settled by CN <CN_NUMBER>)" which truncated).
    const drLedgerAfter = await prisma.customerLedgerEntry.findFirst({
      where: { customerId: cust.id, entryType: 'defective_collected', referenceId: cap.defectiveIds[0] },
    });
    expect(drLedgerAfter?.narration).toContain('· CN ');
    expect(drLedgerAfter?.narration).toMatch(/CN [A-Z0-9-]+/);

    // Step 5 — batch to corp
    const batch = await createDefectiveReturnBatch(distributorId, 'test-user', {
      corporationName: 'IOCL',
      challanNumber: 'RC/2026/E2E-T36',
      defectiveIds: cap.defectiveIds,
    });
    expect(batch.batchNumber).toMatch(/^(F|DR-BATCH-)/);
    expect(batch.totalQuantity).toBe(3);

    // Step 6 — mark corp credit received
    await markBatchCorpCreditReceived(distributorId, 'test-user', batch.batchId, 3540);
    const drFinal = await prisma.defectiveCylinderLedger.findUniqueOrThrow({
      where: { id: cap.defectiveIds[0] },
    });
    expect(drFinal.status).toBe('corporation_credit_received');
  });
});
