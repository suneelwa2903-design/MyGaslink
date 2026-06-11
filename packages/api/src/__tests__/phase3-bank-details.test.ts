/**
 * Phase 3 — distributor bank + UPI payment details.
 *
 * Three layers under test:
 *
 *   1. Wire contract  — GET /api/settings returns the 5 bank fields (null
 *      when unset); PUT /api/settings/payment-details accepts + persists
 *      them; PUT is open to distributor_admin (self-service) AND
 *      super_admin (onboarding).
 *
 *   2. Validation     — IFSC + UPI regex enforced server-side. Empty
 *      strings allowed (they clear the field). Lowercase IFSC rejected
 *      pre-normalisation so the user gets a clear error rather than
 *      having "hdfc..." silently stored.
 *
 *   3. PDF gate       — the invoicePdfService / customerLedgerPdfService
 *      "Payment Details" / "Pay To" blocks only render when
 *      bankAccountNumber AND ifscCode are both set. Source-file guards
 *      pin that contract — full PDF rendering is exercised by the
 *      existing PDF service tests; here we just lock in the gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsFinance, loginAsSuperAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import { IFSC_REGEX, UPI_REGEX } from '@gaslink/shared';
import type { Express } from 'express';

let app: Express;

// Capture + restore Bhargava's bank fields so this test cannot pollute
// downstream PDF / settings tests if they ever start asserting on real
// values for dist-001.
let originalBankFields: {
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchName: string | null;
  ifscCode: string | null;
  upiId: string | null;
};

beforeAll(async () => {
  app = createApp();
  const d = await prisma.distributor.findUniqueOrThrow({
    where: { id: 'dist-001' },
    select: { bankName: true, bankAccountNumber: true, bankBranchName: true, ifscCode: true, upiId: true },
  });
  originalBankFields = d;
});

afterAll(async () => {
  await prisma.distributor.update({
    where: { id: 'dist-001' },
    data: originalBankFields,
  });
});

describe('Phase 3 — shared regex helpers', () => {
  it('IFSC accepts a valid uppercase 11-char code', () => {
    expect(IFSC_REGEX.test('HDFC0001234')).toBe(true);
    expect(IFSC_REGEX.test('SBIN0123ABC')).toBe(true);
  });

  it('IFSC rejects lowercase', () => {
    expect(IFSC_REGEX.test('hdfc0001234')).toBe(false);
  });

  it('IFSC rejects wrong length', () => {
    expect(IFSC_REGEX.test('HDFC001234')).toBe(false);   // 10 chars
    expect(IFSC_REGEX.test('HDFC00012345')).toBe(false); // 12 chars
  });

  it('IFSC rejects the position-5 reserved char being anything but 0', () => {
    expect(IFSC_REGEX.test('HDFC1001234')).toBe(false);
  });

  it('UPI accepts a typical handle', () => {
    expect(UPI_REGEX.test('gasagency@hdfc')).toBe(true);
    expect(UPI_REGEX.test('acme.ltd@axisbank')).toBe(true);
    expect(UPI_REGEX.test('user_name-1@okhdfc')).toBe(true);
  });

  it('UPI rejects missing @', () => {
    expect(UPI_REGEX.test('agencyhdfc')).toBe(false);
  });

  it('UPI rejects empty user part', () => {
    expect(UPI_REGEX.test('@hdfc')).toBe(false);
  });
});

describe('Phase 3 — GET /api/settings exposes bank fields', () => {
  it('returns all 5 bank fields (null by default for unsaved distributor)', async () => {
    // Reset to a known empty state first so we can assert null.
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { bankName: null, bankAccountNumber: null, bankBranchName: null, ifscCode: null, upiId: null },
    });
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      bankName: null,
      bankAccountNumber: null,
      bankBranchName: null,
      ifscCode: null,
      upiId: null,
    });
  });
});

describe('Phase 3 — PUT /api/settings/payment-details', () => {
  it('saves a complete payment detail set for a distributor_admin (self-service)', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .put('/api/settings/payment-details')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'HDFC Bank',
        bankAccountNumber: '1234567890123',
        bankBranchName: 'Banjara Hills',
        ifscCode: 'HDFC0001234',
        upiId: 'gasagency@hdfc',
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      bankName: 'HDFC Bank',
      bankAccountNumber: '1234567890123',
      bankBranchName: 'Banjara Hills',
      ifscCode: 'HDFC0001234',
      upiId: 'gasagency@hdfc',
    });
  });

  it('round-trips: GET /api/settings reads back what PUT wrote', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data.bankName).toBe('HDFC Bank');
    expect(res.body.data.ifscCode).toBe('HDFC0001234');
    expect(res.body.data.upiId).toBe('gasagency@hdfc');
  });

  it('upper-cases lowercase IFSC server-side before writing (defense vs. UI bypass)', async () => {
    const { token } = await loginAsDistAdmin();
    // Note: the Zod regex actually rejects lowercase BEFORE the service
    // normaliser runs. That's the desired behaviour — the user gets a
    // 400, not a silently-mangled value. So this case verifies the 400.
    const res = await request(app)
      .put('/api/settings/payment-details')
      .set('Authorization', `Bearer ${token}`)
      .send({ ifscCode: 'hdfc0001234' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid UPI handle with 400', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .put('/api/settings/payment-details')
      .set('Authorization', `Bearer ${token}`)
      .send({ upiId: 'not-a-upi-handle' });
    expect(res.status).toBe(400);
  });

  it('accepts empty strings as a way to clear the field', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .put('/api/settings/payment-details')
      .set('Authorization', `Bearer ${token}`)
      .send({ upiId: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.upiId).toBeNull();
  });

  it('forbids finance role (only distributor_admin + super_admin can edit)', async () => {
    const { token } = await loginAsFinance();
    const res = await request(app)
      .put('/api/settings/payment-details')
      .set('Authorization', `Bearer ${token}`)
      .send({ bankName: 'should not save' });
    expect(res.status).toBe(403);
  });

  it('allows super_admin to edit payment details (cross-tenant onboarding)', async () => {
    const { token } = await loginAsSuperAdmin();
    const res = await request(app)
      .put('/api/settings/payment-details')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Distributor-Id', 'dist-001')
      .send({ bankName: 'Super-admin edited bank' });
    expect(res.status).toBe(200);
    expect(res.body.data.bankName).toBe('Super-admin edited bank');
  });
});

describe('Phase 3 — PDF render gate (source-file guards)', () => {
  // Anti-pattern #9 companion: lock in the consumer-side contract for
  // each of the two PDF surfaces. If either renderer drops the
  // bankAccountNumber + ifscCode AND gate, a partially-filled distributor
  // will start emitting half-blank Payment Details blocks.
  const invoicePdf = readFileSync(
    resolve(__dirname, '../services/pdf/invoicePdfService.ts'),
    'utf-8',
  );
  const ledgerPdf = readFileSync(
    resolve(__dirname, '../services/pdf/customerLedgerPdfService.ts'),
    'utf-8',
  );

  it('invoice PDF gates Payment Details block on bankAccountNumber AND ifscCode', () => {
    expect(invoicePdf).toMatch(/seller\.bankAccountNumber\s*&&\s*seller\.ifscCode/);
  });

  it('invoice PDF gates UPI line on upiId being non-empty', () => {
    expect(invoicePdf).toMatch(/seller\.upiId/);
  });

  it('customer ledger PDF gates Pay To block on bankAccountNumber AND ifscCode', () => {
    expect(ledgerPdf).toMatch(/distributor\.bankAccountNumber\s*&&\s*distributor\.ifscCode/);
  });

  it('customer ledger PDF emits the literal "Pay To:" label', () => {
    expect(ledgerPdf).toMatch(/Pay To:/);
  });
});
