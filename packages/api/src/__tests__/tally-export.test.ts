/**
 * Tally Setup + Export — 20 integration tests covering:
 *   - GET / PUT /api/tally-settings (8 tests)
 *   - tallyExportService XML output (8 tests)
 *   - cross-tenant isolation on settings + cylinder types + XML (3 tests)
 *   - Content-Disposition header on /api/reports/tally-export (1 test)
 *
 * Fixture-isolation: every invoice / payment / credit-note row this test
 * creates is dated TEST_DATE='2099-12-31'. Production data never reaches
 * that date so the export's date-window query (which is broader than
 * fixture IDs — anti-pattern #7/#8) cannot accidentally sweep real rows.
 * Teardown deletes by (distributorId, deleted-in-this-suite) rather than
 * a global wipe.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  loginAsFinance,
  generateToken,
} from './helpers.js';
import {
  buildTallyExport,
  escapeXml,
} from '../services/tallyExportService.js';
import type { UserRole } from '@gaslink/shared';

const app = createApp();
const TEST_DATE = '2099-12-31';
const TEST_DATE_DATE = new Date(TEST_DATE);

/** Track every row we create so teardown can drop only ours. */
const created = {
  invoiceIds: [] as string[],
  paymentIds: [] as string[],
  creditNoteIds: [] as string[],
  debitNoteIds: [] as string[],
};

async function loginAsDist002Admin(): Promise<{ token: string; distributorId: string }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'sharma@gasdist.com' },
  });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, distributorId: user.distributorId! };
}

/** Get a tenant's first active customer for fixtures. */
async function firstCustomer(distributorId: string) {
  return prisma.customer.findFirstOrThrow({
    where: { distributorId, deletedAt: null },
    select: { id: true, customerName: true, businessName: true },
  });
}

/** Get a tenant's first active cylinder type for fixtures. */
async function firstCylinderType(distributorId: string) {
  return prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, isActive: true },
    orderBy: { typeName: 'asc' },
  });
}

interface CreateInvoiceOpts {
  distributorId: string;
  customerId: string;
  invoiceNumber: string;
  totalAmount: number;
  taxableValue: number;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  items: Array<{
    cylinderTypeId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
}

async function createInvoice(opts: CreateInvoiceOpts) {
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: opts.invoiceNumber,
      distributorId: opts.distributorId,
      customerId: opts.customerId,
      issueDate: TEST_DATE_DATE,
      dueDate: TEST_DATE_DATE,
      totalAmount: opts.totalAmount,
      amountPaid: 0,
      outstandingAmount: opts.totalAmount,
      status: 'issued',
      taxableValue: opts.taxableValue,
      cgstValue: opts.cgstValue,
      sgstValue: opts.sgstValue,
      igstValue: opts.igstValue,
      items: {
        create: opts.items.map((it) => ({
          cylinderTypeId: it.cylinderTypeId,
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          totalPrice: it.totalPrice,
          gstRate: 18,
        })),
      },
    },
  });
  created.invoiceIds.push(inv.id);
  return inv;
}

async function teardown() {
  // Drop in FK-safe order — items + allocations first, parents last.
  if (created.invoiceIds.length) {
    await prisma.creditNote.deleteMany({
      where: { invoiceId: { in: created.invoiceIds } },
    });
    await prisma.debitNote.deleteMany({
      where: { invoiceId: { in: created.invoiceIds } },
    });
    await prisma.paymentAllocation.deleteMany({
      where: { invoiceId: { in: created.invoiceIds } },
    });
    await prisma.invoiceItem.deleteMany({
      where: { invoiceId: { in: created.invoiceIds } },
    });
    await prisma.invoice.deleteMany({
      where: { id: { in: created.invoiceIds } },
    });
  }
  if (created.paymentIds.length) {
    await prisma.paymentAllocation.deleteMany({
      where: { paymentId: { in: created.paymentIds } },
    });
    await prisma.paymentTransaction.deleteMany({
      where: { id: { in: created.paymentIds } },
    });
  }
  // Reset tally_settings only for distributors we wrote against. Don't
  // touch unrelated tenants.
  await prisma.tallySettings.deleteMany({
    where: { distributorId: { in: ['dist-001', 'dist-002'] } },
  });
}

beforeAll(async () => {
  // Ensure a clean slate — leftover rows from a previous failed run would
  // shift assertion counts. Delete before, delete after.
  await teardown();
});

// Per-test cleanup. The export's date-window query pulls EVERY invoice /
// payment / note in [dateFrom, dateTo] regardless of which test seeded
// it (anti-pattern #7/#8 — service queries are broader than fixture IDs).
// Without this hook, test N's settings get applied to test N-1's invoices
// because both share TEST_DATE, producing false positives in the
// "ledger appears" / "balanced sum" assertions.
afterEach(async () => {
  await teardown();
});

afterAll(async () => {
  await teardown();
});

// ════════════════════════════════════════════════════════════════════════
// SETTINGS API — 8 tests
// ════════════════════════════════════════════════════════════════════════

describe('GET /api/tally-settings', () => {
  it('1. with no record returns defaults, isConfigured=false, cylinderTypes mapped to typeName', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    // Ensure no row exists for this tenant.
    await prisma.tallySettings.deleteMany({ where: { distributorId } });

    const res = await request(app)
      .get('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isConfigured).toBe(false);
    expect(res.body.data.updatedAt).toBeNull();
    expect(res.body.data.settings).toMatchObject({
      tallyVersion: 'prime',
      tallyCompanyName: null,
      ledgerSales: 'Sales',
      ledgerCgst: 'Output CGST',
      ledgerSgst: 'Output SGST',
      ledgerIgst: 'Output IGST',
      ledgerCash: 'Cash',
      ledgerBank: 'Bank Account',
      ledgerSundryDebtors: 'Sundry Debtors',
      ledgerRoundOff: 'Round Off',
      voucherTypeSales: 'Sales',
      voucherTypeReceipt: 'Receipt',
      voucherTypeCreditNote: 'Credit Note',
      voucherTypeDebitNote: 'Debit Note',
      stockUnit: 'NOS',
      cylinderStockItems: {},
    });
    expect(Array.isArray(res.body.data.cylinderTypes)).toBe(true);
    // Every returned cylinder type has the fallback mapping = typeName.
    for (const ct of res.body.data.cylinderTypes) {
      expect(ct.mappedTallyName).toBe(ct.typeName);
      // typeName, not name (anti-pattern #17 — match existing convention).
      expect(typeof ct.typeName).toBe('string');
    }
  });

  it('2. with existing record returns saved values and isConfigured=true', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: {
        distributorId,
        tallyCompanyName: 'Bhargava Saved Co',
        ledgerSales: 'Saved Sales',
      },
      update: {
        tallyCompanyName: 'Bhargava Saved Co',
        ledgerSales: 'Saved Sales',
      },
    });

    const res = await request(app)
      .get('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isConfigured).toBe(true);
    expect(res.body.data.updatedAt).not.toBeNull();
    expect(res.body.data.settings.tallyCompanyName).toBe('Bhargava Saved Co');
    expect(res.body.data.settings.ledgerSales).toBe('Saved Sales');
  });

  it('3. cylinderTypes in response only contains this tenant\'s cylinders', async () => {
    const { token, distributorId } = await loginAsDistAdmin();

    const res = await request(app)
      .get('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const returnedIds = res.body.data.cylinderTypes.map((c: { id: string }) => c.id);
    expect(returnedIds.length).toBeGreaterThan(0);

    // Every returned id must belong to this distributor.
    const owned = await prisma.cylinderType.findMany({
      where: { id: { in: returnedIds }, distributorId },
      select: { id: true },
    });
    expect(owned.length).toBe(returnedIds.length);

    // And NONE belong to dist-002.
    const leaked = await prisma.cylinderType.findMany({
      where: { id: { in: returnedIds }, distributorId: 'dist-002' },
      select: { id: true },
    });
    expect(leaked.length).toBe(0);
  });

  it('finance role can also GET /api/tally-settings', async () => {
    // Spec: GET auth includes finance. Sanity check.
    const { token } = await loginAsFinance();
    const res = await request(app)
      .get('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/tally-settings', () => {
  function fullBody(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      tallyVersion: 'prime',
      tallyCompanyName: null,
      ledgerSales: 'Sales',
      ledgerCgst: 'Output CGST',
      ledgerSgst: 'Output SGST',
      ledgerIgst: 'Output IGST',
      ledgerCash: 'Cash',
      ledgerBank: 'Bank Account',
      ledgerSundryDebtors: 'Sundry Debtors',
      ledgerRoundOff: 'Round Off',
      voucherTypeSales: 'Sales',
      voucherTypeReceipt: 'Receipt',
      voucherTypeCreditNote: 'Credit Note',
      voucherTypeDebitNote: 'Debit Note',
      stockUnit: 'NOS',
      cylinderStockItems: {},
      ...overrides,
    };
  }

  it('4. PUT saves all fields; GET after PUT returns the saved values', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    const ct = await firstCylinderType(distributorId);
    const body = fullBody({
      tallyCompanyName: 'Test Co',
      ledgerSales: 'My Sales Ledger',
      ledgerCgst: 'My CGST',
      cylinderStockItems: { [ct.id]: 'My Tally Stock 14.2KG' },
    });

    const put = await request(app)
      .put('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(put.status).toBe(200);
    expect(put.body.data.isConfigured).toBe(true);
    expect(put.body.data.settings.ledgerSales).toBe('My Sales Ledger');

    const get = await request(app)
      .get('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`);
    expect(get.body.data.settings.tallyCompanyName).toBe('Test Co');
    expect(get.body.data.settings.ledgerSales).toBe('My Sales Ledger');
    expect(get.body.data.settings.ledgerCgst).toBe('My CGST');
    expect(get.body.data.settings.cylinderStockItems[ct.id]).toBe('My Tally Stock 14.2KG');

    // And the mapped cylinder type row reflects it.
    const mapped = get.body.data.cylinderTypes.find(
      (c: { id: string }) => c.id === ct.id,
    );
    expect(mapped.mappedTallyName).toBe('My Tally Stock 14.2KG');
  });

  it('5. PUT with blank ledgerCgst returns 400 naming that field', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .put('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`)
      .send(fullBody({ ledgerCgst: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const fieldErrors = res.body.details as Record<string, string[] | undefined>;
    expect(fieldErrors.ledgerCgst).toBeTruthy();
    expect(fieldErrors.ledgerCgst!.length).toBeGreaterThan(0);
  });

  it('6. PUT with invalid tallyVersion returns 400', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .put('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`)
      .send(fullBody({ tallyVersion: 'erp10' }));
    expect(res.status).toBe(400);
    const fieldErrors = res.body.details as Record<string, string[] | undefined>;
    expect(fieldErrors.tallyVersion).toBeTruthy();
  });

  it('7. PUT with cylinderStockItems key belonging to another tenant returns 400', async () => {
    const { token: tokenA } = await loginAsDistAdmin(); // dist-001
    // Pick a cylinder type from dist-002.
    const otherCt = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: 'dist-002', isActive: true },
    });

    const res = await request(app)
      .put('/api/tally-settings')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(
        fullBody({
          cylinderStockItems: { [otherCt.id]: 'Leaked Stock Name' },
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_CYLINDER_TYPE');
    expect(res.body.error).toContain(otherCt.id);
  });

  it('8. PUT with null tallyCompanyName succeeds', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .put('/api/tally-settings')
      .set('Authorization', `Bearer ${token}`)
      .send(fullBody({ tallyCompanyName: null }));
    expect(res.status).toBe(200);
    expect(res.body.data.settings.tallyCompanyName).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// EXPORT SERVICE — 8 tests
// ════════════════════════════════════════════════════════════════════════

describe('tallyExportService.buildTallyExport', () => {
  it('9. Sales voucher uses voucherTypeSales from settings in VCHTYPE', async () => {
    const { distributorId } = await loginAsDistAdmin();
    const customer = await firstCustomer(distributorId);

    // Custom voucher type name.
    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId, voucherTypeSales: 'CustomSalesVoucher' },
      update: { voucherTypeSales: 'CustomSalesVoucher' },
    });

    await createInvoice({
      distributorId,
      customerId: customer.id,
      invoiceNumber: `T9-${Date.now()}`,
      totalAmount: 1180,
      taxableValue: 1000,
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      items: [
        { cylinderTypeId: null, description: 'Test', quantity: 1, unitPrice: 1180, totalPrice: 1180 },
      ],
    });

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml).toContain('VCHTYPE="CustomSalesVoucher"');
    expect(xml).toContain('<VOUCHERTYPENAME>CustomSalesVoucher</VOUCHERTYPENAME>');
  });

  it('10. Intrastate: CGST + SGST ledger entries present, IGST absent', async () => {
    const { distributorId } = await loginAsDistAdmin();
    const customer = await firstCustomer(distributorId);

    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId, ledgerCgst: 'TestCGST', ledgerSgst: 'TestSGST', ledgerIgst: 'TestIGST' },
      update: { ledgerCgst: 'TestCGST', ledgerSgst: 'TestSGST', ledgerIgst: 'TestIGST' },
    });

    await createInvoice({
      distributorId,
      customerId: customer.id,
      invoiceNumber: `T10-${Date.now()}`,
      totalAmount: 1180,
      taxableValue: 1000,
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      items: [
        { cylinderTypeId: null, description: 'Test', quantity: 1, unitPrice: 1180, totalPrice: 1180 },
      ],
    });

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml).toContain('<LEDGERNAME>TestCGST</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>TestSGST</LEDGERNAME>');
    expect(xml).not.toContain('<LEDGERNAME>TestIGST</LEDGERNAME>');
  });

  it('11. Interstate: IGST ledger entry present, CGST + SGST absent', async () => {
    const { distributorId } = await loginAsDistAdmin();
    const customer = await firstCustomer(distributorId);

    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId, ledgerCgst: 'InterCGST', ledgerSgst: 'InterSGST', ledgerIgst: 'InterIGST' },
      update: { ledgerCgst: 'InterCGST', ledgerSgst: 'InterSGST', ledgerIgst: 'InterIGST' },
    });

    await createInvoice({
      distributorId,
      customerId: customer.id,
      invoiceNumber: `T11-${Date.now()}`,
      totalAmount: 1180,
      taxableValue: 1000,
      cgstValue: 0,
      sgstValue: 0,
      igstValue: 180,
      items: [
        { cylinderTypeId: null, description: 'Test', quantity: 1, unitPrice: 1180, totalPrice: 1180 },
      ],
    });

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml).toContain('<LEDGERNAME>InterIGST</LEDGERNAME>');
    expect(xml).not.toContain('<LEDGERNAME>InterCGST</LEDGERNAME>');
    expect(xml).not.toContain('<LEDGERNAME>InterSGST</LEDGERNAME>');
  });

  it('12. Round-off entry added when amounts do not sum to zero', async () => {
    const { distributorId } = await loginAsDistAdmin();
    const customer = await firstCustomer(distributorId);

    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId, ledgerRoundOff: 'TestRoundOff' },
      update: { ledgerRoundOff: 'TestRoundOff' },
    });

    // totalAmount > taxable + cgst + sgst → +0.50 sub-rupee gap → round-off needed.
    await createInvoice({
      distributorId,
      customerId: customer.id,
      invoiceNumber: `T12-${Date.now()}`,
      totalAmount: 1180.5,
      taxableValue: 1000,
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      items: [
        { cylinderTypeId: null, description: 'Test', quantity: 1, unitPrice: 1180.5, totalPrice: 1180.5 },
      ],
    });

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml).toContain('<LEDGERNAME>TestRoundOff</LEDGERNAME>');
  });

  it('13. All voucher amounts sum to zero after round-off (balanced voucher)', async () => {
    const { distributorId } = await loginAsDistAdmin();
    const customer = await firstCustomer(distributorId);

    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId },
      update: {},
    });

    await createInvoice({
      distributorId,
      customerId: customer.id,
      invoiceNumber: `T13-${Date.now()}`,
      totalAmount: 1180.5,
      taxableValue: 1000,
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      items: [
        { cylinderTypeId: null, description: 'Test', quantity: 1, unitPrice: 1180.5, totalPrice: 1180.5 },
      ],
    });

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    // Sum all <AMOUNT>nnn</AMOUNT> values inside ledger entries (not inventory).
    // Match ledger AMOUNT lines only — they appear inside <LEDGERENTRIES.LIST>
    // blocks. Take all AMOUNT lines that follow ISDEEMEDPOSITIVE (which is
    // unique to LEDGERENTRIES — inventory entries use ISDEEMEDPOSITIVE too,
    // but the test invoice has no inventory ledger contention because
    // ALLINVENTORYENTRIES.LIST uses ACTUALQTY, not AMOUNT-only summing).
    // Simpler: parse the ONLY voucher's LEDGERENTRIES.LIST blocks.
    const ledgerAmounts = [...xml.matchAll(
      /<LEDGERENTRIES\.LIST>[\s\S]*?<AMOUNT>(-?\d+(?:\.\d+)?)<\/AMOUNT>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g,
    )].map((m) => Number(m[1]));
    expect(ledgerAmounts.length).toBeGreaterThanOrEqual(4); // party + sales + cgst + sgst + round-off
    const sum = ledgerAmounts.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum)).toBeLessThan(0.01);
  });

  it('14. ALLINVENTORYENTRIES uses cylinderStockItems mapping; falls back to description', async () => {
    const { distributorId } = await loginAsDistAdmin();
    const customer = await firstCustomer(distributorId);
    const ct = await firstCylinderType(distributorId);

    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId, cylinderStockItems: { [ct.id]: 'MappedTallyCylinder' } },
      update: { cylinderStockItems: { [ct.id]: 'MappedTallyCylinder' } },
    });

    await createInvoice({
      distributorId,
      customerId: customer.id,
      invoiceNumber: `T14-${Date.now()}`,
      totalAmount: 2360,
      taxableValue: 2000,
      cgstValue: 180,
      sgstValue: 180,
      igstValue: 0,
      items: [
        // Line 1: mapped — uses MappedTallyCylinder
        { cylinderTypeId: ct.id, description: 'Should not appear', quantity: 1, unitPrice: 1180, totalPrice: 1180 },
        // Line 2: no cylinder type (transport charge) — falls back to description
        { cylinderTypeId: null, description: 'FallbackDescription', quantity: 1, unitPrice: 1180, totalPrice: 1180 },
      ],
    });

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml).toContain('<STOCKITEMNAME>MappedTallyCylinder</STOCKITEMNAME>');
    expect(xml).toContain('<STOCKITEMNAME>FallbackDescription</STOCKITEMNAME>');
    // The cylinder line's description must NOT leak out — it should have
    // been replaced by the mapping.
    expect(xml).not.toContain('<STOCKITEMNAME>Should not appear</STOCKITEMNAME>');
  });

  it('15. Receipt: CASH → ledgerCash, non-cash → ledgerBank', async () => {
    const { distributorId } = await loginAsDistAdmin();
    const customer = await firstCustomer(distributorId);

    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId, ledgerCash: 'TestCashLedger', ledgerBank: 'TestBankLedger' },
      update: { ledgerCash: 'TestCashLedger', ledgerBank: 'TestBankLedger' },
    });

    const cashPmt = await prisma.paymentTransaction.create({
      data: {
        distributorId,
        customerId: customer.id,
        amount: 500,
        paymentMethod: 'cash',
        transactionDate: TEST_DATE_DATE,
      },
    });
    created.paymentIds.push(cashPmt.id);

    const upiPmt = await prisma.paymentTransaction.create({
      data: {
        distributorId,
        customerId: customer.id,
        amount: 700,
        paymentMethod: 'upi',
        transactionDate: TEST_DATE_DATE,
        referenceNumber: 'UPI-REF-001',
      },
    });
    created.paymentIds.push(upiPmt.id);

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml).toContain('<LEDGERNAME>TestCashLedger</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>TestBankLedger</LEDGERNAME>');
  });

  it('16. tallyCompanyName overrides legalName in SVCURRENTCOMPANY when set', async () => {
    const { distributorId } = await loginAsDistAdmin();
    await prisma.tallySettings.upsert({
      where: { distributorId },
      create: { distributorId, tallyCompanyName: 'Override Co Pvt Ltd' },
      update: { tallyCompanyName: 'Override Co Pvt Ltd' },
    });

    const { xml } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml).toContain('<SVCURRENTCOMPANY>Override Co Pvt Ltd</SVCURRENTCOMPANY>');

    // And when cleared (null), falls back to Distributor.legalName.
    await prisma.tallySettings.update({
      where: { distributorId },
      data: { tallyCompanyName: null },
    });
    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: distributorId },
      select: { legalName: true },
    });
    const { xml: xml2 } = await buildTallyExport(distributorId, {
      dateFrom: TEST_DATE,
      dateTo: TEST_DATE,
    });
    expect(xml2).toContain(`<SVCURRENTCOMPANY>${escapeXml(dist.legalName)}</SVCURRENTCOMPANY>`);
  });
});

// ════════════════════════════════════════════════════════════════════════
// CROSS-TENANT — 3 tests
// ════════════════════════════════════════════════════════════════════════

describe('cross-tenant isolation', () => {
  it('17. GET /api/reports/tally-export — tenant A cannot see tenant B invoices in XML', async () => {
    const { distributorId: distA } = await loginAsDistAdmin();
    const { token: tokenA } = await loginAsDistAdmin();
    const { distributorId: distB } = await loginAsDist002Admin();

    const custA = await firstCustomer(distA);
    const custB = await firstCustomer(distB);

    // Seed one invoice per tenant with a unique invoiceNumber.
    const numA = `XTEN-A-${Date.now()}`;
    const numB = `XTEN-B-${Date.now()}`;
    await createInvoice({
      distributorId: distA,
      customerId: custA.id,
      invoiceNumber: numA,
      totalAmount: 1180,
      taxableValue: 1000,
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      items: [
        { cylinderTypeId: null, description: 'A line', quantity: 1, unitPrice: 1180, totalPrice: 1180 },
      ],
    });
    await createInvoice({
      distributorId: distB,
      customerId: custB.id,
      invoiceNumber: numB,
      totalAmount: 1180,
      taxableValue: 1000,
      cgstValue: 0,
      sgstValue: 0,
      igstValue: 180,
      items: [
        { cylinderTypeId: null, description: 'B line', quantity: 1, unitPrice: 1180, totalPrice: 1180 },
      ],
    });

    const res = await request(app)
      .get('/api/reports/tally-export')
      .query({ dateFrom: TEST_DATE, dateTo: TEST_DATE })
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(numA);
    expect(res.text).not.toContain(numB);
  });

  it('18. PUT /api/tally-settings — tenant A cannot overwrite tenant B settings', async () => {
    const { token: tokenA } = await loginAsDistAdmin(); // dist-001
    // Seed a marker row for dist-002 so we can detect overwrite.
    await prisma.tallySettings.upsert({
      where: { distributorId: 'dist-002' },
      create: { distributorId: 'dist-002', ledgerSales: 'B-untouched' },
      update: { ledgerSales: 'B-untouched' },
    });

    // PUT from tenant A — the route reads req.user.distributorId (dist-001),
    // so dist-002 must be unaffected even if the body could specify a
    // different id (it can't — body has no distributorId field).
    const res = await request(app)
      .put('/api/tally-settings')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        tallyVersion: 'prime',
        tallyCompanyName: null,
        ledgerSales: 'A-overwritten',
        ledgerCgst: 'Output CGST',
        ledgerSgst: 'Output SGST',
        ledgerIgst: 'Output IGST',
        ledgerCash: 'Cash',
        ledgerBank: 'Bank Account',
        ledgerSundryDebtors: 'Sundry Debtors',
        ledgerRoundOff: 'Round Off',
        voucherTypeSales: 'Sales',
        voucherTypeReceipt: 'Receipt',
        voucherTypeCreditNote: 'Credit Note',
        voucherTypeDebitNote: 'Debit Note',
        stockUnit: 'NOS',
        cylinderStockItems: {},
      });
    expect(res.status).toBe(200);

    const dist002Row = await prisma.tallySettings.findUniqueOrThrow({
      where: { distributorId: 'dist-002' },
    });
    expect(dist002Row.ledgerSales).toBe('B-untouched');

    const dist001Row = await prisma.tallySettings.findUniqueOrThrow({
      where: { distributorId: 'dist-001' },
    });
    expect(dist001Row.ledgerSales).toBe('A-overwritten');
  });

  it('19. GET /api/tally-settings cylinderTypes — only this tenant\'s cylinders returned', async () => {
    const { token: tokenA, distributorId: distA } = await loginAsDistAdmin();
    const res = await request(app)
      .get('/api/tally-settings')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.cylinderTypes.map((c: { id: string }) => c.id);
    const rows = await prisma.cylinderType.findMany({
      where: { id: { in: ids } },
      select: { distributorId: true },
    });
    for (const r of rows) expect(r.distributorId).toBe(distA);
  });
});

// ════════════════════════════════════════════════════════════════════════
// HEADERS — 1 test
// ════════════════════════════════════════════════════════════════════════

describe('headers', () => {
  it('20. GET /api/reports/tally-export returns Content-Disposition attachment header', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .get('/api/reports/tally-export')
      .query({ dateFrom: TEST_DATE, dateTo: TEST_DATE })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toContain(`tally-export-${TEST_DATE}_${TEST_DATE}.xml`);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
  });
});
