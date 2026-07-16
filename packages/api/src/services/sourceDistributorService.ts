/**
 * Mini-Operator (2026-07-16) — Source Distributor service.
 *
 * A source distributor is a free-text supplier the mini-operator buys stock
 * from. Not linked to any existing Distributor row (a mini-operator may
 * source from a kirana depot or an out-of-network agency). Just a name;
 * v1 has no address / GSTIN / phone.
 *
 * Tenant scoping: every query includes `distributorId` from the JWT (see
 * routes/sourceDistributors.ts). Cross-tenant reads/writes are structurally
 * impossible — anti-pattern #13 discipline.
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

const sourceDistributorSelect = {
  id: true,
  distributorId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SourceDistributorSelect;

export class SourceDistributorError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'SourceDistributorError';
  }
}

export async function listSourceDistributors(distributorId: string) {
  return prisma.sourceDistributor.findMany({
    where: { distributorId, deletedAt: null },
    select: sourceDistributorSelect,
    orderBy: { name: 'asc' },
  });
}

export async function createSourceDistributor(
  distributorId: string,
  data: { name: string },
) {
  const trimmed = data.name.trim();
  if (!trimmed) {
    throw new SourceDistributorError('Name is required', 400, 'INVALID_NAME');
  }

  // Case-insensitive duplicate guard (@@unique is case-sensitive at the
  // Postgres layer; we defend against "Sharma" vs "sharma" surfacing as a
  // spurious second entry). If a soft-deleted row exists with the same
  // name, revive it — same pattern as customer soft-delete recovery.
  const existing = await prisma.sourceDistributor.findFirst({
    where: {
      distributorId,
      name: { equals: trimmed, mode: 'insensitive' },
    },
    select: { id: true, deletedAt: true },
  });

  if (existing && !existing.deletedAt) {
    throw new SourceDistributorError(
      'A source distributor with this name already exists',
      409,
      'DUPLICATE_NAME',
    );
  }
  if (existing && existing.deletedAt) {
    return prisma.sourceDistributor.update({
      where: { id: existing.id },
      data: { name: trimmed, deletedAt: null },
      select: sourceDistributorSelect,
    });
  }

  return prisma.sourceDistributor.create({
    data: { distributorId, name: trimmed },
    select: sourceDistributorSelect,
  });
}

export async function deleteSourceDistributor(
  distributorId: string,
  sourceDistributorId: string,
) {
  const existing = await prisma.sourceDistributor.findFirst({
    where: { id: sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) {
    throw new SourceDistributorError('Source distributor not found', 404, 'NOT_FOUND');
  }

  await prisma.sourceDistributor.update({
    where: { id: sourceDistributorId },
    data: { deletedAt: new Date() },
  });
}
