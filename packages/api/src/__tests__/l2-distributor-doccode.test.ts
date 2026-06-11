/**
 * Group L2 (2026-06-11) — docCode on distributor create/edit.
 *
 *   - Zod regex: 2–6 uppercase letters/digits; lowercase rejected.
 *   - createDistributor saves the docCode (uppercased).
 *   - Uniqueness: a second create with the same docCode → 409.
 *   - Uniqueness is case-insensitive even if a lowercase value somehow
 *     bypasses the regex (defensive — same row, different case = clash).
 *   - updateDistributor on the SAME row keeping the same docCode does
 *     NOT self-match. updating to ANOTHER tenant's docCode does → 409.
 *   - Optional at create: distributor saves cleanly without docCode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  createDistributor,
  updateDistributor,
  DistributorError,
} from '../services/distributorService.js';
import { createDistributorSchema } from '@gaslink/shared';

const TRACK = 'L2-Doc-';
const baseFor = (suffix: string) => ({
  businessName: `${TRACK}${suffix}`,
  legalName: `${TRACK}${suffix} Pvt Ltd`,
});

async function cleanup() {
  await prisma.distributor.deleteMany({
    where: { businessName: { startsWith: TRACK } },
  });
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe('L2 — Zod docCode regex', () => {
  const base = { businessName: 'X', legalName: 'X' };

  it('accepts 3 uppercase letters', () => {
    const r = createDistributorSchema.safeParse({ ...base, docCode: 'VAN' });
    expect(r.success).toBe(true);
  });
  it('accepts 5 uppercase letters/digits mix', () => {
    const r = createDistributorSchema.safeParse({ ...base, docCode: 'AB12X' });
    expect(r.success).toBe(true);
  });
  it('rejects 1 char (too short)', () => {
    const r = createDistributorSchema.safeParse({ ...base, docCode: 'A' });
    expect(r.success).toBe(false);
  });
  it('rejects 7 chars (too long)', () => {
    const r = createDistributorSchema.safeParse({ ...base, docCode: 'ABCDEFG' });
    expect(r.success).toBe(false);
  });
  it('rejects lowercase', () => {
    const r = createDistributorSchema.safeParse({ ...base, docCode: 'van' });
    expect(r.success).toBe(false);
  });
  it('rejects punctuation', () => {
    const r = createDistributorSchema.safeParse({ ...base, docCode: 'VAN!' });
    expect(r.success).toBe(false);
  });
  it('accepts empty string (optional)', () => {
    const r = createDistributorSchema.safeParse({ ...base, docCode: '' });
    expect(r.success).toBe(true);
  });
  it('accepts missing docCode (optional)', () => {
    const r = createDistributorSchema.safeParse({ ...base });
    expect(r.success).toBe(true);
  });
});

describe('L2 — service uniqueness + persistence', () => {
  it('saves an uppercase docCode on create', async () => {
    const d = await createDistributor({ ...baseFor('A1'), docCode: 'L2A' });
    expect(d.docCode).toBe('L2A');
  });

  it('normalises input by trim + uppercase before persisting', async () => {
    const d = await createDistributor({ ...baseFor('A2'), docCode: '  l2b  ' });
    expect(d.docCode).toBe('L2B');
  });

  it('throws DistributorError 409 when docCode is already taken', async () => {
    await createDistributor({ ...baseFor('B1'), docCode: 'L2C' });
    let err: unknown;
    try {
      await createDistributor({ ...baseFor('B2'), docCode: 'L2C' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DistributorError);
    expect((err as DistributorError).statusCode).toBe(409);
    expect((err as DistributorError).code).toBe('DOC_CODE_CONFLICT');
  });

  it('uniqueness is case-insensitive against a stored uppercase docCode', async () => {
    await createDistributor({ ...baseFor('B3'), docCode: 'L2D' });
    let err: unknown;
    try {
      // Service normalises to 'L2D' so this is structurally the same.
      // Even an attacker bypassing the Zod regex hits the lowercase-vs-
      // stored-uppercase check via insensitive find.
      await createDistributor({ ...baseFor('B4'), docCode: 'l2d' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DistributorError);
  });

  it('updateDistributor on the SAME row keeping the same docCode does not throw', async () => {
    const d = await createDistributor({ ...baseFor('C1'), docCode: 'L2E' });
    const updated = await updateDistributor(d.id, { docCode: 'L2E', businessName: `${TRACK}C1-Renamed` });
    expect(updated.docCode).toBe('L2E');
  });

  it('updateDistributor to another tenant\'s docCode throws 409', async () => {
    const a = await createDistributor({ ...baseFor('D1'), docCode: 'L2F' });
    const b = await createDistributor({ ...baseFor('D2'), docCode: 'L2G' });
    let err: unknown;
    try {
      await updateDistributor(b.id, { docCode: 'L2F' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DistributorError);
    expect((err as DistributorError).statusCode).toBe(409);
    void a;
  });

  it('createDistributor without docCode saves cleanly (optional)', async () => {
    const d = await createDistributor({ ...baseFor('E1') });
    expect(d.docCode).toBeNull();
  });

  it('updateDistributor clearing docCode (empty string → null) succeeds', async () => {
    const d = await createDistributor({ ...baseFor('F1'), docCode: 'L2H' });
    const updated = await updateDistributor(d.id, { docCode: '' });
    expect(updated.docCode).toBeNull();
  });
});
