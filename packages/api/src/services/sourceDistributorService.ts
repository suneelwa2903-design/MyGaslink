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
  // 2026-07-23 — surface opening state on every list read so the
  // Purchases page can render existing balances + wire the Edit-OB
  // modal without a second round-trip.
  openingBalanceAmount: true,
  openingStateSeededAt: true,
  emptyOpenings: {
    select: {
      cylinderTypeId: true,
      openingSeedQty: true,
      cylinderType: { select: { typeName: true } },
    },
  },
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

/**
 * 2026-07-23 — Seed the ₹ opening balance owed to a supplier at the
 * time this row was first added to the app. Idempotent-blocking on
 * openingStateSeededAt (one-shot, similar to
 * customerService.seedOpeningStateOnCustomer).
 *
 * Writes an atomic transaction:
 *   1. Update source_distributors: openingBalanceAmount + openingStateSeededAt
 *   2. Create a synthetic purchase_entry with is_opening_balance=TRUE.
 *      This surfaces the opening balance on the supplier ledger PDF as
 *      an "Opening Balance b/f" row above delivery entries.
 *
 * Only mini_operator tenants can seed — route enforces via requireRole.
 */
export async function seedOpeningStateOnSupplier(
  distributorId: string,
  userId: string,
  sourceDistributorId: string,
  amount: number,
  asOfDate: string,
  // 2026-07-23 — per-cylinder-type empties owed to supplier at seed time.
  // Optional. Zero-qty rows are skipped so callers can pass a full picker
  // list without filtering. Rows validated for tenant ownership of the
  // cylinder type inside the transaction.
  empties?: Array<{ cylinderTypeId: string; qty: number }>,
): Promise<{
  sourceDistributorId: string;
  seededAt: string;
  openingBalanceAmount: number;
  purchaseEntryId: string;
  empties: Array<{ cylinderTypeId: string; qty: number }>;
}> {
  const supplier = await prisma.sourceDistributor.findFirst({
    where: { id: sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true, name: true, openingStateSeededAt: true },
  });
  if (!supplier) throw new SourceDistributorError('Supplier not found', 404, 'NOT_FOUND');
  if (supplier.openingStateSeededAt) {
    throw new SourceDistributorError(
      'This supplier already has an opening balance seeded. Use the edit path.',
      400,
      'ALREADY_SEEDED',
    );
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new SourceDistributorError('amount must be a non-negative number', 400, 'INVALID_AMOUNT');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new SourceDistributorError('asOfDate must be YYYY-MM-DD', 400, 'INVALID_DATE');
  }

  // Filter out zero-qty rows up front; validate remaining ones.
  const nonZeroEmpties = (empties ?? []).filter((e) => Number.isFinite(e.qty) && e.qty > 0);
  for (const row of nonZeroEmpties) {
    if (!Number.isInteger(row.qty) || row.qty < 0) {
      throw new SourceDistributorError(
        `Empties qty must be a non-negative integer (got ${row.qty} for ${row.cylinderTypeId})`,
        400,
        'INVALID_EMPTIES_QTY',
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const seededAt = new Date();
    await tx.sourceDistributor.update({
      where: { id: sourceDistributorId },
      data: {
        openingBalanceAmount: amount,
        openingStateSeededAt: seededAt,
      },
    });

    // Cross-tenant guard: cylinder types must belong to the same tenant.
    if (nonZeroEmpties.length > 0) {
      const typeIds = nonZeroEmpties.map((e) => e.cylinderTypeId);
      const owned = await tx.cylinderType.findMany({
        where: { id: { in: typeIds }, distributorId },
        select: { id: true },
      });
      if (owned.length !== typeIds.length) {
        throw new SourceDistributorError(
          'One or more cylinder types are not accessible to this tenant',
          400,
          'CROSS_TENANT_CYLINDER_TYPE',
        );
      }
      await tx.sourceDistributorEmptyOpening.createMany({
        data: nonZeroEmpties.map((e) => ({
          sourceDistributorId,
          cylinderTypeId: e.cylinderTypeId,
          openingSeedQty: e.qty,
        })),
      });
    }

    // Synthetic OB purchase-entry so the supplier ledger renders the
    // "Opening Balance b/f" row above real deliveries.
    const purchase = await tx.purchaseEntry.create({
      data: {
        purchaseNumber: `OB-SUP-${sourceDistributorId.slice(0, 8)}-${Date.now().toString().slice(-6)}`,
        distributorId,
        sourceDistributorId,
        sourceDistributorName: supplier.name,
        purchaseDate: asOfDate,
        isOpeningBalance: true,
        notes: `Opening balance b/f — ${supplier.name}`,
        createdBy: userId,
      },
      select: { id: true },
    });

    return {
      sourceDistributorId: supplier.id,
      seededAt: seededAt.toISOString(),
      openingBalanceAmount: amount,
      purchaseEntryId: purchase.id,
      empties: nonZeroEmpties,
    };
  });
}

/**
 * 2026-07-23 — Edit an already-seeded supplier opening balance.
 * Refuses reduction below the amountPaid recorded against the OB entry
 * (would leave a negative outstanding). Refuses delete-to-zero if any
 * payment has been applied.
 */
export async function updateOpeningStateOnSupplier(
  distributorId: string,
  sourceDistributorId: string,
  amount: number,
  asOfDate: string,
  // 2026-07-23 — same empties axis as seed. Full replace semantics:
  // whatever's sent becomes the persisted set (zero-qty rows are
  // deleted). Absent argument = leave existing empties untouched.
  empties?: Array<{ cylinderTypeId: string; qty: number }>,
): Promise<{
  sourceDistributorId: string;
  openingBalanceAmount: number;
  empties: Array<{ cylinderTypeId: string; qty: number }>;
}> {
  const supplier = await prisma.sourceDistributor.findFirst({
    where: { id: sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true, openingStateSeededAt: true },
  });
  if (!supplier) throw new SourceDistributorError('Supplier not found', 404, 'NOT_FOUND');
  if (!supplier.openingStateSeededAt) {
    throw new SourceDistributorError(
      'This supplier has never been seeded. Use POST /source-distributors/:id/seed-opening-state first.',
      400,
      'NEVER_SEEDED',
    );
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new SourceDistributorError('amount must be a non-negative number', 400, 'INVALID_AMOUNT');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new SourceDistributorError('asOfDate must be YYYY-MM-DD', 400, 'INVALID_DATE');
  }

  const obPurchase = await prisma.purchaseEntry.findFirst({
    where: { distributorId, sourceDistributorId, isOpeningBalance: true, deletedAt: null },
    select: { id: true, amountPaid: true },
  });
  const paid = obPurchase ? Number(obPurchase.amountPaid) : 0;
  if (amount < paid) {
    throw new SourceDistributorError(
      `Cannot reduce opening balance below payments already applied (₹${paid.toFixed(2)}).`,
      400,
      'PAYMENTS_APPLIED',
    );
  }

  const nonZeroEmpties = (empties ?? []).filter((e) => Number.isFinite(e.qty) && e.qty > 0);

  return prisma.$transaction(async (tx) => {
    await tx.sourceDistributor.update({
      where: { id: sourceDistributorId },
      data: {
        openingBalanceAmount: amount,
        openingStateSeededAt: new Date(),
      },
    });
    if (obPurchase) {
      await tx.purchaseEntry.update({
        where: { id: obPurchase.id },
        data: { purchaseDate: asOfDate },
      });
    }
    // If the caller passed `empties`, treat it as a full replace of
    // the existing set — cheapest correct semantic (delete + createMany).
    // If they omitted `empties` entirely (undefined), don't touch the
    // existing rows.
    if (empties !== undefined) {
      // Cross-tenant guard on the incoming rows.
      if (nonZeroEmpties.length > 0) {
        const typeIds = nonZeroEmpties.map((e) => e.cylinderTypeId);
        const owned = await tx.cylinderType.findMany({
          where: { id: { in: typeIds }, distributorId },
          select: { id: true },
        });
        if (owned.length !== typeIds.length) {
          throw new SourceDistributorError(
            'One or more cylinder types are not accessible to this tenant',
            400,
            'CROSS_TENANT_CYLINDER_TYPE',
          );
        }
      }
      await tx.sourceDistributorEmptyOpening.deleteMany({
        where: { sourceDistributorId },
      });
      if (nonZeroEmpties.length > 0) {
        await tx.sourceDistributorEmptyOpening.createMany({
          data: nonZeroEmpties.map((e) => ({
            sourceDistributorId,
            cylinderTypeId: e.cylinderTypeId,
            openingSeedQty: e.qty,
          })),
        });
      }
    }
    return {
      sourceDistributorId: supplier.id,
      openingBalanceAmount: amount,
      empties: nonZeroEmpties,
    };
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
