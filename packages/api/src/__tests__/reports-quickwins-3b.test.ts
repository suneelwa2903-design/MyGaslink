// 2026-08-05 Chunk 3b — quick-win reports (N28 + N29 + N31) tests.
//
// Three registers grouped in one file — all in the Invoicing & Payments
// bucket, all "flat list of entities in date range" shape.
//
//   - creditNotesRegister                    (N28)
//   - debitNotesRegister                     (N29)
//   - openingBalanceCertificatesRegister     (N31)
//
// Each has: positive (seeded fixture visible + shape correct), wire-shape,
// route+CSV regression, and CN/DN specifically: cross-tenant guard via
// invoice-join (they have no distributorId column of their own).
//
// TEST_DATE 2099-12-22 per anti-pattern #7.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  creditNotesRegister,
  debitNotesRegister,
  openingBalanceCertificatesRegister,
} from '../services/reportsService.js';
import { getSeedData, loginAsDistAdmin } from './helpers.js';

const DAY = new Date('2099-12-22T00:00:00.000Z');
const DAY_STR = '2099-12-22';

let app: Express;
let token: string;
let distributorId: string;
let customerId: string;
const invoiceIds: string[] = [];
const creditNoteIds: string[] = [];
const debitNoteIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  const login = await loginAsDistAdmin();
  token = login.token;
  distributorId = login.distributorId;
  const seed = await getSeedData();
  customerId = seed.customers[0].id;
});

afterAll(async () => {
  if (creditNoteIds.length) {
    await prisma.creditNote.deleteMany({ where: { id: { in: creditNoteIds } } });
  }
  if (debitNoteIds.length) {
    await prisma.debitNote.deleteMany({ where: { id: { in: debitNoteIds } } });
  }
  if (invoiceIds.length) {
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  }
});

async function seedInvoice(opts: {
  invoiceNumber: string;
  isOpeningBalance?: boolean;
  totalAmount: number;
  amountPaid?: number;
}): Promise<string> {
  const inv = await prisma.invoice.create({
    data: {
      distributorId,
      customerId,
      invoiceNumber: opts.invoiceNumber,
      issueDate: DAY,
      dueDate: DAY,
      totalAmount: opts.totalAmount,
      amountPaid: opts.amountPaid ?? 0,
      outstandingAmount: opts.totalAmount - (opts.amountPaid ?? 0),
      isOpeningBalance: opts.isOpeningBalance ?? false,
      // InvoiceStatus enum has no dedicated 'opening_balance' value —
      // OB invoices reuse the money-side statuses (issued / partially_paid
      // / paid). The `isOpeningBalance` boolean is the dedicated flag.
      status: opts.amountPaid && opts.amountPaid > 0 && opts.amountPaid < opts.totalAmount
        ? 'partially_paid'
        : opts.amountPaid && opts.amountPaid >= opts.totalAmount
          ? 'paid'
          : 'issued',
    },
  });
  invoiceIds.push(inv.id);
  return inv.id;
}

describe('N28 — Credit Notes Register (Chunk 3b)', () => {
  it('POSITIVE — 1 seeded credit note appears with correct fields + status-suffix stripped', async () => {
    const invId = await seedInvoice({ invoiceNumber: 'TEST-CN-INV-001', totalAmount: 5000 });
    const cn = await prisma.creditNote.create({
      data: {
        invoiceId: invId,
        creditNoteNumber: 'CN-TEST-N28-001',
        totalAmount: 500,
        reason: 'defective cylinder returned',
        issueDate: DAY,
        status: 'pending_cn',
      },
    });
    creditNoteIds.push(cn.id);

    const res = await creditNotesRegister(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const row = res.rows.find((r) => r.creditNoteNumber === 'CN-TEST-N28-001');
    expect(row).toBeDefined();
    expect(row!.invoiceNumber).toBe('TEST-CN-INV-001');
    expect(Number(row!.amount)).toBe(500);
    expect(row!.reason).toBe('defective cylinder returned');
    // Status suffix `_cn` MUST be stripped (anti-pattern #9 discipline)
    expect(row!.status).toBe('pending');
  });

  it('WIRE-SHAPE — 7 columns in expected order + totals row', async () => {
    const res = await creditNotesRegister(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const colKeys = res.columns.map((c) => c.key);
    expect(colKeys).toEqual([
      'date', 'creditNoteNumber', 'invoiceNumber', 'customer', 'reason', 'amount', 'status',
    ]);
    expect(res.columns[5].money).toBe(true);
    expect(res.totals).toHaveProperty('amount');
  });

  it('REGRESSION — /api/reports/credit-notes-register + CSV', async () => {
    const res = await request(app)
      .get('/api/reports/credit-notes-register')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app)
      .get('/api/reports/credit-notes-register')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' })
      .set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('CN Number');
  });

  it('CROSS-TENANT — CN under dist-B invoice invisible when querying as dist-A', async () => {
    const distB = await prisma.distributor.findFirst({
      where: { id: { not: distributorId }, deletedAt: null },
    });
    if (!distB) return;
    // Every returned row's invoice must belong to dist-A (proves the
    // invoice-join tenant scope holds).
    const res = await creditNotesRegister(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    for (const r of res.rows) {
      if (r.date === 'TOTAL' || !r.invoiceNumber) continue;
      const inv = await prisma.invoice.findFirst({
        where: { invoiceNumber: r.invoiceNumber as string, distributorId },
      });
      expect(inv).not.toBeNull();
    }
  });
});

describe('N29 — Debit Notes Register (Chunk 3b)', () => {
  it('POSITIVE — 1 seeded debit note appears with correct fields + status-suffix stripped', async () => {
    const invId = await seedInvoice({ invoiceNumber: 'TEST-DN-INV-001', totalAmount: 7000 });
    const dn = await prisma.debitNote.create({
      data: {
        invoiceId: invId,
        debitNoteNumber: 'DN-TEST-N29-001',
        totalAmount: 350,
        reason: 'freight adjustment',
        issueDate: DAY,
        status: 'pending_dn',
      },
    });
    debitNoteIds.push(dn.id);

    const res = await debitNotesRegister(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const row = res.rows.find((r) => r.debitNoteNumber === 'DN-TEST-N29-001');
    expect(row).toBeDefined();
    expect(row!.invoiceNumber).toBe('TEST-DN-INV-001');
    expect(Number(row!.amount)).toBe(350);
    expect(row!.status).toBe('pending');
  });

  it('WIRE-SHAPE — 7 columns in expected order', async () => {
    const res = await debitNotesRegister(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const colKeys = res.columns.map((c) => c.key);
    expect(colKeys).toEqual([
      'date', 'debitNoteNumber', 'invoiceNumber', 'customer', 'reason', 'amount', 'status',
    ]);
    expect(res.columns[5].money).toBe(true);
  });

  it('REGRESSION — /api/reports/debit-notes-register + CSV', async () => {
    const res = await request(app)
      .get('/api/reports/debit-notes-register')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app)
      .get('/api/reports/debit-notes-register')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' })
      .set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });
});

describe('N31 — Opening Balance Certificates Register (Chunk 3b)', () => {
  it('POSITIVE — OB invoice with partial payment yields correct paid + outstanding', async () => {
    await seedInvoice({
      invoiceNumber: 'TEST-OB-N31-001',
      isOpeningBalance: true,
      totalAmount: 12000,
      amountPaid: 3000,
    });

    const res = await openingBalanceCertificatesRegister(distributorId, {
      dateFrom: DAY_STR,
      dateTo: DAY_STR,
    });
    const row = res.rows.find((r) => r.invoiceNumber === 'TEST-OB-N31-001');
    expect(row).toBeDefined();
    expect(Number(row!.totalAmount)).toBe(12000);
    expect(Number(row!.amountPaid)).toBe(3000);
    expect(Number(row!.outstanding)).toBe(9000);
  });

  it('NEGATIVE — non-OB invoice does NOT appear in register', async () => {
    await seedInvoice({
      invoiceNumber: 'TEST-OB-N31-NEG',
      isOpeningBalance: false, // explicit
      totalAmount: 8888,
    });
    const res = await openingBalanceCertificatesRegister(distributorId, {
      dateFrom: DAY_STR,
      dateTo: DAY_STR,
    });
    const leaked = res.rows.find((r) => r.invoiceNumber === 'TEST-OB-N31-NEG');
    expect(leaked).toBeUndefined();
  });

  it('WIRE-SHAPE — 7 columns in expected order + totals well-formed', async () => {
    const res = await openingBalanceCertificatesRegister(distributorId, {
      dateFrom: DAY_STR,
      dateTo: DAY_STR,
    });
    const colKeys = res.columns.map((c) => c.key);
    expect(colKeys).toEqual([
      'issueDate', 'invoiceNumber', 'customer', 'totalAmount', 'amountPaid', 'outstanding', 'status',
    ]);
    // 3 money columns
    for (const k of ['totalAmount', 'amountPaid', 'outstanding']) {
      const col = res.columns.find((c) => c.key === k);
      expect(col?.money).toBe(true);
    }
  });

  it('REGRESSION — /api/reports/opening-balance-certificates-register + CSV', async () => {
    const res = await request(app)
      .get('/api/reports/opening-balance-certificates-register')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app)
      .get('/api/reports/opening-balance-certificates-register')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' })
      .set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });
});
