/**
 * 2026-07-23 — Supplier opening balance MVP tests.
 *
 * T1 seed happy path
 * T2 second seed → 400 ALREADY_SEEDED
 * T3 seed negative amount → 400
 * T4 seed bad date → 400
 * T5 edit updates in place
 * T6 edit never-seeded → 400
 * T7 edit below amountPaid → 400
 * T8 cross-tenant seed → 404
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import * as sourceDistributorService from '../services/sourceDistributorService.js';

const RUN = String(Date.now()).slice(-6);
function docLetters(): string {
  const n = Number(RUN.slice(-4)) || 0;
  const a = String.fromCharCode(65 + (n % 26));
  const b = String.fromCharCode(65 + (Math.floor(n / 26) % 26));
  return `${a}${b}`;
}

interface Fixture { distributorId: string; userId: string; }

async function seedTenant(letter: string): Promise<Fixture> {
  const dist = await prisma.distributor.create({
    data: {
      businessName: `SupOB ${letter} ${RUN}`,
      legalName: `SupOB ${letter} ${RUN}`,
      accountType: 'mini_operator', gstMode: 'disabled',
      docCode: `${letter}${docLetters()}`, state: 'Telangana',
    }, select: { id: true },
  });
  const passwordHash = await bcrypt.hash('x', 4);
  const user = await prisma.user.create({
    data: {
      email: `supob-${letter.toLowerCase()}-${RUN}@example.com`,
      passwordHash, firstName: 'SOB', lastName: letter,
      role: 'mini_operator_admin', status: 'active',
      distributorId: dist.id, requiresPasswordReset: false,
    }, select: { id: true },
  });
  return { distributorId: dist.id, userId: user.id };
}

async function cleanup(distributorId: string) {
  try {
    await prisma.purchasePaymentAllocation.deleteMany({ where: { purchaseEntry: { distributorId } } });
    await prisma.purchasePayment.deleteMany({ where: { distributorId } });
    await prisma.purchaseEntryItem.deleteMany({ where: { purchaseEntry: { distributorId } } });
    await prisma.purchaseEntry.deleteMany({ where: { distributorId } });
    await prisma.sourceDistributor.deleteMany({ where: { distributorId } });
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[supplier-ob cleanup]', (e as Error).message);
  }
}

describe('Supplier opening balance', () => {
  let tenantA: Fixture;
  let tenantB: Fixture;
  let supplierAId: string;
  let supplierBId: string;

  beforeAll(async () => {
    tenantA = await seedTenant('A');
    tenantB = await seedTenant('B');
    const sA = await sourceDistributorService.createSourceDistributor(tenantA.distributorId, { name: `HPCL A ${RUN}` });
    const sB = await sourceDistributorService.createSourceDistributor(tenantB.distributorId, { name: `HPCL B ${RUN}` });
    supplierAId = sA.id;
    supplierBId = sB.id;
  }, 30_000);

  afterAll(async () => {
    await cleanup(tenantA.distributorId);
    await cleanup(tenantB.distributorId);
  });

  it('T1 — seed happy path', async () => {
    const result = await sourceDistributorService.seedOpeningStateOnSupplier(
      tenantA.distributorId, tenantA.userId, supplierAId, 5000, '2099-12-30',
    );
    expect(result.openingBalanceAmount).toBe(5000);
    const sup = await prisma.sourceDistributor.findUnique({ where: { id: supplierAId } });
    expect(Number(sup?.openingBalanceAmount)).toBe(5000);
    expect(sup?.openingStateSeededAt).not.toBeNull();
    const ob = await prisma.purchaseEntry.findFirst({ where: { sourceDistributorId: supplierAId, isOpeningBalance: true } });
    expect(ob?.isOpeningBalance).toBe(true);
    expect(ob?.purchaseDate).toBe('2099-12-30');
  });

  it('T2 — second seed rejected', async () => {
    await expect(
      sourceDistributorService.seedOpeningStateOnSupplier(tenantA.distributorId, tenantA.userId, supplierAId, 1000, '2099-12-30'),
    ).rejects.toThrow(/already/i);
  });

  it('T3 — negative amount rejected', async () => {
    const s = await sourceDistributorService.createSourceDistributor(tenantA.distributorId, { name: `Neg ${RUN}` });
    await expect(
      sourceDistributorService.seedOpeningStateOnSupplier(tenantA.distributorId, tenantA.userId, s.id, -100, '2099-12-30'),
    ).rejects.toThrow(/non-negative/i);
  });

  it('T4 — bad date rejected', async () => {
    const s = await sourceDistributorService.createSourceDistributor(tenantA.distributorId, { name: `BadDt ${RUN}` });
    await expect(
      sourceDistributorService.seedOpeningStateOnSupplier(tenantA.distributorId, tenantA.userId, s.id, 500, '99-12-30'),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('T5 — edit updates in place', async () => {
    const result = await sourceDistributorService.updateOpeningStateOnSupplier(tenantA.distributorId, supplierAId, 7500, '2099-12-30');
    expect(result.openingBalanceAmount).toBe(7500);
    const sup = await prisma.sourceDistributor.findUnique({ where: { id: supplierAId } });
    expect(Number(sup?.openingBalanceAmount)).toBe(7500);
  });

  it('T6 — edit never-seeded rejected', async () => {
    const s = await sourceDistributorService.createSourceDistributor(tenantA.distributorId, { name: `Never ${RUN}` });
    await expect(
      sourceDistributorService.updateOpeningStateOnSupplier(tenantA.distributorId, s.id, 500, '2099-12-30'),
    ).rejects.toThrow(/never been seeded/i);
  });

  it('T7 — edit below amountPaid rejected', async () => {
    const s = await sourceDistributorService.createSourceDistributor(tenantA.distributorId, { name: `WithPmt ${RUN}` });
    const seed = await sourceDistributorService.seedOpeningStateOnSupplier(tenantA.distributorId, tenantA.userId, s.id, 5000, '2099-12-30');
    await prisma.purchaseEntry.update({ where: { id: seed.purchaseEntryId }, data: { amountPaid: 3000 } });
    await expect(
      sourceDistributorService.updateOpeningStateOnSupplier(tenantA.distributorId, s.id, 2000, '2099-12-30'),
    ).rejects.toThrow(/reduce.*below/i);
  });

  it('T8 — cross-tenant seed rejected', async () => {
    await expect(
      sourceDistributorService.seedOpeningStateOnSupplier(tenantA.distributorId, tenantA.userId, supplierBId, 1000, '2099-12-30'),
    ).rejects.toThrow(/not found/i);
  });
});
