/**
 * Phase 8 — opening-balance "b/f" row in the mobile customer ledger.
 *
 * The /api/payments/ledger/:customerId route already enriches each entry
 * with `isOpeningBalance: boolean` (added Group 1, 2026-06-11). The mobile
 * (admin)/customer-detail.tsx ledger tab previously ignored that field —
 * every entry rendered with the generic `invoice_entry` styling. Phase 8
 * pins the OB row to the top of the FlatList and gives it the muted /
 * italic "Opening Balance b/f" treatment that matches the PDF statement.
 *
 * Server contract under test: the wire-shape field IS present (so the
 * UI has something real to switch on). The mobile-side rendering logic
 * itself is pinned via source-file guards.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import { loginAsDistAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let custWithOB: string;
let cleanupInvoiceId: string;
let cleanupLedgerId: string;

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;

  // Find any dist-001 customer to attach a fake OB to; create the OB
  // invoice + ledger entry inline so we don't rely on seed data drift.
  const cust = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-001', deletedAt: null },
  });
  custWithOB = cust.id;

  const FAR_PAST = new Date('1999-01-01');
  const obInvoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `PHASE8-OB-${Date.now()}`,
      distributorId: 'dist-001',
      customerId: cust.id,
      issueDate: FAR_PAST,
      dueDate: FAR_PAST,
      totalAmount: 2500,
      outstandingAmount: 2500,
      status: 'issued',
      isOpeningBalance: true,
      cgstValue: 0,
      sgstValue: 0,
      igstValue: 0,
    },
  });
  cleanupInvoiceId = obInvoice.id;

  const ledger = await prisma.customerLedgerEntry.create({
    data: {
      distributorId: 'dist-001',
      customerId: cust.id,
      entryType: 'invoice_entry',
      referenceId: obInvoice.id,
      invoiceId: obInvoice.id,
      amountDelta: 2500,
      narration: 'Opening Balance b/f — Phase 8 test',
      entryDate: FAR_PAST,
    },
  });
  cleanupLedgerId = ledger.id;
});

// Don't tear down the seed customer — only the OB fixture rows.
import { afterAll } from 'vitest';
afterAll(async () => {
  await prisma.customerLedgerEntry.delete({ where: { id: cleanupLedgerId } }).catch(() => {});
  await prisma.invoice.delete({ where: { id: cleanupInvoiceId } }).catch(() => {});
});

describe('Phase 8 — /api/payments/ledger/:customerId carries isOpeningBalance', () => {
  it('returns the OB entry with isOpeningBalance=true', async () => {
    const res = await request(app)
      .get(`/api/payments/ledger/${custWithOB}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    // Response is a raw array (no envelope) per the route comment.
    const obRow = data.find((row: { isOpeningBalance?: boolean; invoiceId: string }) =>
      row.invoiceId === cleanupInvoiceId,
    );
    expect(obRow).toBeDefined();
    expect(obRow.isOpeningBalance).toBe(true);
  });

  it('non-OB entries return isOpeningBalance=false (not undefined) so the UI gate is reliable', async () => {
    const res = await request(app)
      .get(`/api/payments/ledger/${custWithOB}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const nonOb = res.body.data.filter((row: { isOpeningBalance: boolean }) => !row.isOpeningBalance);
    for (const row of nonOb) {
      expect(typeof row.isOpeningBalance).toBe('boolean');
      expect(row.isOpeningBalance).toBe(false);
    }
  });
});

describe('Phase 8 — mobile customer-detail ledger source guards', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../mobile/app/(admin)/customer-detail.tsx'),
    'utf-8',
  );

  it('partitions opening-balance entries to the top of the list', () => {
    // The fix sorts opening entries before the rest. Pin the predicate
    // so a future refactor that drops the partition is caught.
    expect(source).toMatch(/filter\(\s*\([a-zA-Z]+\)\s*=>\s*[a-zA-Z]+\.isOpeningBalance\)/);
    expect(source).toMatch(/filter\(\s*\([a-zA-Z]+\)\s*=>\s*!\s*[a-zA-Z]+\.isOpeningBalance\)/);
  });

  it('renders the "Opening Balance b/f" label for OB rows', () => {
    expect(source).toContain('Opening Balance b/f');
  });

  it('applies italic styling to the OB row so it visually diverges from in-period entries', () => {
    expect(source).toMatch(/fontStyle:\s*'italic'/);
  });
});
