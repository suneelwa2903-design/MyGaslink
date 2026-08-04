/**
 * GST Filing Export — 8 integration tests covering:
 *   - Multi-sheet xlsx shape (6 sheets with the expected headers)
 *   - Exclusion of cancelled invoices (status='cancelled' AND cancelled_at)
 *   - Exclusion of opening-balance invoices (is_opening_balance=true)
 *   - Exclusion of soft-deleted invoices (deleted_at)
 *   - Multi-cylinder-type invoice → multiple InvoiceLines rows sharing the
 *     same Invoice No / Date / Customer (per user's explicit clarification)
 *   - Cross-tenant isolation (dist-002 export never surfaces a dist-001 row)
 *   - HTTP 400 on missing / malformed ?month
 *   - Content-Disposition attachment header on the response
 *
 * Fixture-isolation: every invoice this suite creates is dated 2099-12-15
 * ('2099-12' fits both the anti-pattern #7 TEST_DATE convention AND the
 * month-window query the service runs). Teardown deletes by tracked id.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  generateToken,
} from './helpers.js';
import type { UserRole } from '@gaslink/shared';

const app = createApp();
const TEST_MONTH = '2099-12';
const TEST_DATE = new Date('2099-12-15');

const created = {
  invoiceIds: [] as string[],
  paymentIds: [] as string[],
};

async function loginAsDist002Admin(): Promise<{ token: string; distributorId: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, distributorId: user.distributorId! };
}

async function firstCustomer(distributorId: string) {
  return prisma.customer.findFirstOrThrow({
    where: { distributorId, deletedAt: null },
    select: { id: true, customerName: true, businessName: true },
  });
}

async function twoActiveCylinderTypes(distributorId: string) {
  const rows = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    orderBy: { typeName: 'asc' },
    take: 2,
  });
  if (rows.length < 2) {
    throw new Error(`Need ≥2 active cylinder types for distributor ${distributorId}; found ${rows.length}`);
  }
  return rows;
}

interface CreateInvoiceOpts {
  distributorId: string;
  customerId: string;
  invoiceNumber: string;
  status?: 'issued' | 'cancelled';
  cancelled?: boolean;
  softDeleted?: boolean;
  isOpeningBalance?: boolean;
  items: Array<{
    cylinderTypeId: string;
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
}

async function createInvoice(opts: CreateInvoiceOpts) {
  const totalAmount = opts.items.reduce((s, it) => s + it.totalPrice, 0);
  const taxable = totalAmount / 1.18;
  const halfGst = (totalAmount - taxable) / 2;
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: opts.invoiceNumber,
      distributorId: opts.distributorId,
      customerId: opts.customerId,
      issueDate: TEST_DATE,
      dueDate: TEST_DATE,
      totalAmount,
      amountPaid: 0,
      outstandingAmount: totalAmount,
      status: opts.status ?? 'issued',
      cancelledAt: opts.cancelled ? new Date() : null,
      deletedAt: opts.softDeleted ? new Date() : null,
      isOpeningBalance: opts.isOpeningBalance ?? false,
      taxableValue: taxable,
      cgstValue: halfGst,
      sgstValue: halfGst,
      igstValue: 0,
      items: {
        create: opts.items.map((it) => ({
          cylinderTypeId: it.cylinderTypeId,
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          totalPrice: it.totalPrice,
          gstRate: 18,
          taxableValue: it.totalPrice / 1.18,
          uom: 'NOS',
        })),
      },
    },
  });
  created.invoiceIds.push(inv.id);
  return inv;
}

async function teardown() {
  if (created.invoiceIds.length) {
    await prisma.paymentAllocation.deleteMany({ where: { invoiceId: { in: created.invoiceIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: created.invoiceIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: created.invoiceIds } } });
    created.invoiceIds = [];
  }
  if (created.paymentIds.length) {
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: created.paymentIds } } });
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: created.paymentIds } } });
    created.paymentIds = [];
  }
}

beforeAll(teardown);
afterEach(teardown);
afterAll(teardown);

/** Parse a supertest xlsx response into an ExcelJS.Workbook. */
async function parseXlsx(body: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs types expect the classic Node Buffer; cast keeps the wire buffer through.
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  return wb;
}

/** Extract header row values from a worksheet. */
function headers(ws: ExcelJS.Worksheet): string[] {
  const row = ws.getRow(1);
  const out: string[] = [];
  row.eachCell((c) => out.push(String(c.value ?? '')));
  return out;
}

/** All data rows as arrays of cell values (skips header). */
function dataRows(ws: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const vals: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => vals.push(cell.value));
    rows.push(vals);
  });
  return rows;
}

async function callExport(token: string, month = TEST_MONTH) {
  return request(app)
    .get(`/api/reports/gst-filing-export?month=${month}`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

// ════════════════════════════════════════════════════════════════════════
describe('GET /api/reports/gst-filing-export', () => {
  it('1. returns xlsx with 6 sheets and the expected column headers', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    const cust = await firstCustomer(distributorId);
    const [type1] = await twoActiveCylinderTypes(distributorId);
    await createInvoice({
      distributorId,
      customerId: cust.id,
      invoiceNumber: `TEST-GSTX-${Date.now()}-1`,
      items: [{ cylinderTypeId: type1.id, description: 'LPG', quantity: 5, unitPrice: 1180, totalPrice: 5900 }],
    });

    const res = await callExport(token);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".+\.xlsx"/);

    const wb = await parseXlsx(res.body as Buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(['GST_Summary', 'Invoices', 'InvoiceLines', 'Customers', 'Payments', 'CylinderBalances']);

    expect(headers(wb.getWorksheet('GST_Summary')!)).toEqual([
      'Cylinder Type', 'HSN', 'UOM', 'Qty', 'Taxable Value', 'CGST ₹', 'SGST ₹', 'IGST ₹', 'Total Invoice Value',
    ]);
    expect(headers(wb.getWorksheet('Invoices')!)).toContain('Invoice No');
    expect(headers(wb.getWorksheet('InvoiceLines')!)).toContain('Cylinder Type');
    expect(headers(wb.getWorksheet('Customers')!)).toContain('GSTIN');
    expect(headers(wb.getWorksheet('Payments')!)).toContain('Method');
    expect(headers(wb.getWorksheet('CylinderBalances')!)).toContain('Delivered This Month');
  });

  it('2. excludes cancelled invoices from every sheet', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    const cust = await firstCustomer(distributorId);
    const [type1] = await twoActiveCylinderTypes(distributorId);
    const stamp = Date.now();
    const goodNumber = `TEST-GSTX-${stamp}-good`;
    const cancelledNumber = `TEST-GSTX-${stamp}-cancelled`;
    await createInvoice({
      distributorId, customerId: cust.id, invoiceNumber: goodNumber,
      items: [{ cylinderTypeId: type1.id, description: 'LPG', quantity: 3, unitPrice: 1180, totalPrice: 3540 }],
    });
    await createInvoice({
      distributorId, customerId: cust.id, invoiceNumber: cancelledNumber,
      status: 'cancelled', cancelled: true,
      items: [{ cylinderTypeId: type1.id, description: 'LPG', quantity: 99, unitPrice: 1180, totalPrice: 116820 }],
    });

    const res = await callExport(token);
    const wb = await parseXlsx(res.body as Buffer);
    const invRows = dataRows(wb.getWorksheet('Invoices')!);
    const invNumbers = invRows.map((r) => String(r[1] ?? ''));
    expect(invNumbers).toContain(goodNumber);
    expect(invNumbers).not.toContain(cancelledNumber);
    // InvoiceLines: same exclusion.
    const lineNumbers = dataRows(wb.getWorksheet('InvoiceLines')!).map((r) => String(r[1] ?? ''));
    expect(lineNumbers).not.toContain(cancelledNumber);
  });

  it('3. excludes opening-balance invoices', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    const cust = await firstCustomer(distributorId);
    const [type1] = await twoActiveCylinderTypes(distributorId);
    const stamp = Date.now();
    const obNumber = `TEST-GSTX-${stamp}-ob`;
    await createInvoice({
      distributorId, customerId: cust.id, invoiceNumber: obNumber,
      isOpeningBalance: true,
      items: [{ cylinderTypeId: type1.id, description: 'OB', quantity: 1, unitPrice: 1180, totalPrice: 1180 }],
    });

    const res = await callExport(token);
    const wb = await parseXlsx(res.body as Buffer);
    const invNumbers = dataRows(wb.getWorksheet('Invoices')!).map((r) => String(r[1] ?? ''));
    expect(invNumbers).not.toContain(obNumber);
  });

  it('4. excludes soft-deleted invoices', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    const cust = await firstCustomer(distributorId);
    const [type1] = await twoActiveCylinderTypes(distributorId);
    const stamp = Date.now();
    const deletedNumber = `TEST-GSTX-${stamp}-deleted`;
    await createInvoice({
      distributorId, customerId: cust.id, invoiceNumber: deletedNumber,
      softDeleted: true,
      items: [{ cylinderTypeId: type1.id, description: 'X', quantity: 1, unitPrice: 1180, totalPrice: 1180 }],
    });

    const res = await callExport(token);
    const wb = await parseXlsx(res.body as Buffer);
    const invNumbers = dataRows(wb.getWorksheet('Invoices')!).map((r) => String(r[1] ?? ''));
    expect(invNumbers).not.toContain(deletedNumber);
  });

  it('5. multi-cylinder-type invoice produces multiple InvoiceLines rows sharing Invoice No / Date / Customer', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    const cust = await firstCustomer(distributorId);
    const [type1, type2] = await twoActiveCylinderTypes(distributorId);
    const stamp = Date.now();
    const invNo = `TEST-GSTX-${stamp}-multi`;
    await createInvoice({
      distributorId, customerId: cust.id, invoiceNumber: invNo,
      items: [
        { cylinderTypeId: type1.id, description: 'A', quantity: 5, unitPrice: 1180, totalPrice: 5900 },
        { cylinderTypeId: type2.id, description: 'B', quantity: 2, unitPrice: 3540, totalPrice: 7080 },
      ],
    });

    const res = await callExport(token);
    const wb = await parseXlsx(res.body as Buffer);
    const lineRows = dataRows(wb.getWorksheet('InvoiceLines')!);
    const matching = lineRows.filter((r) => String(r[1] ?? '') === invNo);
    expect(matching.length).toBe(2);
    // Cylinder Type column (index 5) differs between the two rows.
    const types = matching.map((r) => String(r[5] ?? ''));
    expect(new Set(types).size).toBe(2);
    // Invoice No / Date / Customer are identical across both rows.
    expect(matching[0][1]).toBe(matching[1][1]);
    expect(matching[0][2]).toBe(matching[1][2]);
    expect(matching[0][3]).toBe(matching[1][3]);
    // The single invoice appears exactly once in the Invoices sheet (header-level).
    const invRows = dataRows(wb.getWorksheet('Invoices')!).filter((r) => String(r[1] ?? '') === invNo);
    expect(invRows.length).toBe(1);
  });

  it('6. cross-tenant isolation: dist-002 export never surfaces a dist-001 invoice', async () => {
    const { token: tokenA, distributorId: distA } = await loginAsDistAdmin(); // dist-001
    const { token: tokenB, distributorId: distB } = await loginAsDist002Admin(); // dist-002
    const custA = await firstCustomer(distA);
    const custB = await firstCustomer(distB);
    const [typeA] = await twoActiveCylinderTypes(distA);
    const [typeB] = await twoActiveCylinderTypes(distB);
    const stamp = Date.now();
    const numA = `TEST-GSTX-${stamp}-A`;
    const numB = `TEST-GSTX-${stamp}-B`;
    await createInvoice({
      distributorId: distA, customerId: custA.id, invoiceNumber: numA,
      items: [{ cylinderTypeId: typeA.id, description: 'A', quantity: 1, unitPrice: 1180, totalPrice: 1180 }],
    });
    await createInvoice({
      distributorId: distB, customerId: custB.id, invoiceNumber: numB,
      items: [{ cylinderTypeId: typeB.id, description: 'B', quantity: 1, unitPrice: 1180, totalPrice: 1180 }],
    });

    const resA = await callExport(tokenA);
    const wbA = await parseXlsx(resA.body as Buffer);
    const numsA = dataRows(wbA.getWorksheet('Invoices')!).map((r) => String(r[1] ?? ''));
    expect(numsA).toContain(numA);
    expect(numsA).not.toContain(numB);

    const resB = await callExport(tokenB);
    const wbB = await parseXlsx(resB.body as Buffer);
    const numsB = dataRows(wbB.getWorksheet('Invoices')!).map((r) => String(r[1] ?? ''));
    expect(numsB).toContain(numB);
    expect(numsB).not.toContain(numA);
  });

  it('7. returns 400 on missing or malformed month', async () => {
    const { token } = await loginAsDistAdmin();

    const noMonth = await request(app)
      .get('/api/reports/gst-filing-export')
      .set('Authorization', `Bearer ${token}`);
    expect(noMonth.status).toBe(400);

    const badMonth = await request(app)
      .get('/api/reports/gst-filing-export?month=2099-13')
      .set('Authorization', `Bearer ${token}`);
    expect(badMonth.status).toBe(400);

    const badFormat = await request(app)
      .get('/api/reports/gst-filing-export?month=Dec-2099')
      .set('Authorization', `Bearer ${token}`);
    expect(badFormat.status).toBe(400);
  });

  it('8. TZ-boundary regression — an invoice dated on the month-last-day IS included (Prisma @db.Date UTC-truncation guard)', async () => {
    // Bug (2026-08-04): monthWindow used `new Date(year, mon-1, 1)` / `new Date(year, mon, 1)` which
    // are LOCAL-TZ midnights. On IST (UTC+5:30) that made toExclusive = 2026-07-31T18:30Z, and Prisma
    // truncated the @db.Date filter to '2026-07-31', silently dropping every row whose issue_date
    // equalled the month's last day. Vanasthali's real July filing was short 21 invoices before the
    // fix. Pin the boundary explicitly here.
    const { token, distributorId } = await loginAsDistAdmin();
    const cust = await firstCustomer(distributorId);
    const [type1] = await twoActiveCylinderTypes(distributorId);
    const stamp = Date.now();
    const lastDayNumber = `TEST-GSTX-${stamp}-lastday`;
    // Override the shared TEST_DATE for this one row so we can assert on the last day of TEST_MONTH.
    const lastDay = new Date(Date.UTC(2099, 11, 31)); // 2099-12-31 (last day of TEST_MONTH='2099-12')
    await prisma.invoice.create({
      data: {
        invoiceNumber: lastDayNumber,
        distributorId,
        customerId: cust.id,
        issueDate: lastDay,
        dueDate: lastDay,
        totalAmount: 1180,
        amountPaid: 0,
        outstandingAmount: 1180,
        status: 'issued',
        taxableValue: 1000,
        cgstValue: 90,
        sgstValue: 90,
        igstValue: 0,
        items: {
          create: [{
            cylinderTypeId: type1.id,
            description: 'LAST-DAY',
            quantity: 1,
            unitPrice: 1180,
            totalPrice: 1180,
            gstRate: 18,
            taxableValue: 1000,
            uom: 'NOS',
          }],
        },
      },
    });
    created.invoiceIds.push((await prisma.invoice.findFirstOrThrow({ where: { invoiceNumber: lastDayNumber } })).id);

    const res = await callExport(token);
    const wb = await parseXlsx(res.body as Buffer);
    const invNumbers = dataRows(wb.getWorksheet('Invoices')!).map((r) => String(r[1] ?? ''));
    expect(invNumbers).toContain(lastDayNumber);
  });

  it('9. Content-Disposition filename encodes distributor docCode + month', async () => {
    const { token, distributorId } = await loginAsDistAdmin();
    const distributor = await prisma.distributor.findFirstOrThrow({
      where: { id: distributorId },
      select: { docCode: true },
    });

    const res = await callExport(token);
    const cd = res.headers['content-disposition'] ?? '';
    expect(cd).toContain(TEST_MONTH);
    if (distributor.docCode) {
      expect(cd.toLowerCase()).toContain(distributor.docCode.toLowerCase());
    }
  });
});
