/**
 * Mini-op #5 (2026-07-27) — Expense service.
 *
 * Every operational expense outside of cylinder purchases (which go
 * through PurchaseEntry / PurchasePayment). Fixed 13-category taxonomy.
 * Optional attribution to vehicle and/or driver.
 *
 * Tenant scoping: every query includes `distributorId` from the JWT
 * (route layer). Cross-tenant reads/writes are structurally impossible
 * — anti-pattern #13 discipline.
 *
 * Available to BOTH distributor + mini_operator tenants. The route layer
 * gates on role (distributor_admin / finance / mini_operator_admin /
 * super_admin).
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma, ExpenseCategory, PaymentMethod } from '@prisma/client';
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
} satisfies Prisma.ExpenseInclude;

type ExpenseWithJoins = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

/** Map a Prisma row → the wire shape declared in shared/types. */
function mapExpense(e: ExpenseWithJoins) {
  return {
    expenseId: e.id,
    distributorId: e.distributorId,
    expenseDate: e.expenseDate,
    category: e.category,
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

export async function createExpense(
  distributorId: string,
  userId: string,
  data: CreateExpenseInput,
) {
  // Cross-tenant guards on optional attribution refs. Silent no-op is
  // wrong here — a wrong-tenant vehicle_id would silently persist and
  // then confuse the operator when the row shows up with a mystery
  // "vehicle number: —" cell. Explicit 400 keeps the wire honest.
  if (data.vehicleId) {
    const v = await prisma.vehicle.findFirst({
      where: { id: data.vehicleId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!v) {
      throw new ExpenseError('Vehicle not found in this tenant', 400, 'VEHICLE_NOT_FOUND');
    }
  }
  if (data.driverId) {
    const d = await prisma.driver.findFirst({
      where: { id: data.driverId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!d) {
      throw new ExpenseError('Driver not found in this tenant', 400, 'DRIVER_NOT_FOUND');
    }
  }

  const row = await prisma.expense.create({
    data: {
      distributorId,
      expenseDate: data.expenseDate,
      category: data.category as ExpenseCategory,
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
  if (query.category) where.category = query.category as ExpenseCategory;
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

  // Re-validate attribution refs when they change.
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
      category: data.category as ExpenseCategory | undefined,
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
  // Soft-delete pattern (same as customers, orders, etc).
  await prisma.expense.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

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

  const [total, byCategory] = await Promise.all([
    prisma.expense.aggregate({
      where,
      _sum: { amount: true },
      _count: true,
    }),
    prisma.expense.groupBy({
      by: ['category'],
      where,
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    totalAmount: toNum(total._sum.amount),
    count: total._count,
    byCategory: byCategory
      .map((r) => ({
        category: r.category,
        amount: toNum(r._sum.amount),
        count: r._count,
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}
