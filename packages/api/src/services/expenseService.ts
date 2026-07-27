/**
 * Mini-op #5 v2 (2026-07-27 evening) — Expense service.
 *
 * Every operational expense outside of cylinder purchases (which flow
 * through PurchaseEntry / PurchasePayment). Category is a FK into
 * expense_categories (tenant-owned taxonomy, see expenseCategoryService).
 *
 * Every query includes distributorId from the JWT (route layer). The
 * category-lookup path also filters by the same distributorId — never
 * trust a categoryId from the body without verifying tenant scope.
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma, PaymentMethod } from '@prisma/client';
import { toNum } from '../utils/decimal.js';
import type {
  CreateExpenseInput,
  UpdateExpenseInput,
  ListExpensesQuery,
} from '@gaslink/shared';

export class ExpenseError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'ExpenseError';
  }
}

const expenseInclude = {
  vehicle: { select: { id: true, vehicleNumber: true } },
  driver: { select: { id: true, driverName: true } },
  category: {
    select: {
      id: true, code: true, name: true, isHeader: true, parentId: true,
      parent: { select: { id: true, name: true, code: true } },
    },
  },
} satisfies Prisma.ExpenseInclude;

type ExpenseWithJoins = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

function categoryPath(cat: ExpenseWithJoins['category']): string {
  if (cat.parent) return `${cat.parent.name} / ${cat.name}`;
  return cat.name;
}

function mapExpense(e: ExpenseWithJoins) {
  return {
    expenseId: e.id,
    distributorId: e.distributorId,
    expenseDate: e.expenseDate,
    categoryId: e.categoryId,
    categoryCode: e.category.code,
    categoryName: e.category.name,
    categoryPath: categoryPath(e.category),
    amount: toNum(e.amount),
    description: e.description,
    paymentMethod: e.paymentMethod,
    vendorName: e.vendorName,
    vehicleId: e.vehicleId,
    vehicleNumber: e.vehicle?.vehicleNumber ?? null,
    driverId: e.driverId,
    driverName: e.driver?.driverName ?? null,
    referenceNumber: e.referenceNumber,
    notes: e.notes,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/**
 * Verify a categoryId belongs to the tenant, is a leaf (not a header),
 * and is currently active. Returns the row for downstream reuse.
 */
async function assertLeafCategory(distributorId: string, categoryId: string) {
  const cat = await prisma.expenseCategory.findFirst({
    where: { id: categoryId, distributorId, deletedAt: null },
    select: { id: true, isHeader: true, isActive: true },
  });
  if (!cat) throw new ExpenseError('Category not found in this tenant', 400, 'CATEGORY_NOT_FOUND');
  if (cat.isHeader) throw new ExpenseError('Category is a header — pick a leaf', 400, 'CATEGORY_IS_HEADER');
  if (!cat.isActive) throw new ExpenseError('Category is inactive — reactivate before recording', 400, 'CATEGORY_INACTIVE');
  return cat;
}

export async function createExpense(
  distributorId: string,
  userId: string,
  data: CreateExpenseInput,
) {
  await assertLeafCategory(distributorId, data.categoryId);

  if (data.vehicleId) {
    const v = await prisma.vehicle.findFirst({
      where: { id: data.vehicleId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!v) throw new ExpenseError('Vehicle not found in this tenant', 400, 'VEHICLE_NOT_FOUND');
  }
  if (data.driverId) {
    const d = await prisma.driver.findFirst({
      where: { id: data.driverId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!d) throw new ExpenseError('Driver not found in this tenant', 400, 'DRIVER_NOT_FOUND');
  }

  const row = await prisma.expense.create({
    data: {
      distributorId,
      expenseDate: data.expenseDate,
      categoryId: data.categoryId,
      amount: data.amount,
      description: data.description,
      paymentMethod: (data.paymentMethod ?? 'cash') as PaymentMethod,
      vendorName: data.vendorName,
      vehicleId: data.vehicleId,
      driverId: data.driverId,
      referenceNumber: data.referenceNumber,
      notes: data.notes,
      createdBy: userId,
    },
    include: expenseInclude,
  });
  return mapExpense(row);
}

export async function listExpenses(distributorId: string, query: ListExpensesQuery) {
  const where: Prisma.ExpenseWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (query.from || query.to) {
    where.expenseDate = {};
    if (query.from) (where.expenseDate as { gte?: string }).gte = query.from;
    if (query.to) (where.expenseDate as { lte?: string }).lte = query.to;
  }
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.vehicleId) where.vehicleId = query.vehicleId;
  if (query.driverId) where.driverId = query.driverId;

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const [rows, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: expenseInclude,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.expense.count({ where }),
  ]);
  return {
    expenses: rows.map(mapExpense),
    meta: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

export async function updateExpense(
  distributorId: string,
  id: string,
  data: UpdateExpenseInput,
) {
  const existing = await prisma.expense.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new ExpenseError('Expense not found', 404, 'NOT_FOUND');

  if (data.categoryId !== undefined) {
    await assertLeafCategory(distributorId, data.categoryId);
  }
  if (data.vehicleId !== undefined && data.vehicleId !== null) {
    const v = await prisma.vehicle.findFirst({
      where: { id: data.vehicleId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!v) throw new ExpenseError('Vehicle not found in this tenant', 400, 'VEHICLE_NOT_FOUND');
  }
  if (data.driverId !== undefined && data.driverId !== null) {
    const d = await prisma.driver.findFirst({
      where: { id: data.driverId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!d) throw new ExpenseError('Driver not found in this tenant', 400, 'DRIVER_NOT_FOUND');
  }

  const row = await prisma.expense.update({
    where: { id },
    data: {
      expenseDate: data.expenseDate,
      categoryId: data.categoryId,
      amount: data.amount,
      description: data.description,
      paymentMethod: data.paymentMethod as PaymentMethod | undefined,
      vendorName: data.vendorName,
      vehicleId: data.vehicleId,
      driverId: data.driverId,
      referenceNumber: data.referenceNumber,
      notes: data.notes,
    },
    include: expenseInclude,
  });
  return mapExpense(row);
}

export async function deleteExpense(distributorId: string, id: string) {
  const existing = await prisma.expense.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new ExpenseError('Expense not found', 404, 'NOT_FOUND');
  await prisma.expense.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

/**
 * Summary rollup — GET /api/expenses/summary. Now returns categoryId +
 * categoryName + parent (for grouping) instead of the old enum code.
 * Consumers can group client-side by parentId to render headers.
 */
export async function summarizeExpenses(
  distributorId: string,
  query: { from?: string; to?: string },
) {
  const where: Prisma.ExpenseWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (query.from || query.to) {
    where.expenseDate = {};
    if (query.from) (where.expenseDate as { gte?: string }).gte = query.from;
    if (query.to) (where.expenseDate as { lte?: string }).lte = query.to;
  }

  const [total, byCategoryRows] = await Promise.all([
    prisma.expense.aggregate({
      where,
      _sum: { amount: true },
      _count: true,
    }),
    prisma.expense.groupBy({
      by: ['categoryId'],
      where,
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  // Enrich with category name + parent for the client-side grouping.
  const categoryIds = byCategoryRows.map((r) => r.categoryId);
  const categoryRows = categoryIds.length
    ? await prisma.expenseCategory.findMany({
        where: { id: { in: categoryIds }, distributorId },
        select: {
          id: true, code: true, name: true, parentId: true,
          parent: { select: { name: true } },
        },
      })
    : [];
  const byIdCat = new Map(categoryRows.map((c) => [c.id, c]));

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    totalAmount: toNum(total._sum.amount),
    count: total._count,
    byCategory: byCategoryRows
      .map((r) => {
        const c = byIdCat.get(r.categoryId);
        return {
          categoryId: r.categoryId,
          categoryCode: c?.code ?? 'unknown',
          categoryName: c?.name ?? 'Unknown',
          parentId: c?.parentId ?? null,
          parentName: c?.parent?.name ?? null,
          amount: toNum(r._sum.amount),
          count: r._count,
        };
      })
      .sort((a, b) => b.amount - a.amount),
  };
}
