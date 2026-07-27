/**
 * Mini-op #5 v2 (2026-07-27 evening) — Expense category service.
 *
 * Tenant-owned taxonomy CRUD. Every distributor gets 5 system headers +
 * 13 system leaves seeded at migration time. Admins can add / rename /
 * hide their own; system rows are renameable + hideable but not
 * deletable (statutory continuity — historical reports keep resolving).
 *
 * Route layer gates on role:
 *  - Read: any authenticated user in the tenant.
 *  - Mutate: distributor_admin / mini_operator_admin / super_admin only.
 *
 * Every query includes distributorId — no cross-tenant leaks
 * (anti-pattern #13 discipline).
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import type {
  CreateExpenseCategoryInput,
  UpdateExpenseCategoryInput,
} from '@gaslink/shared';

export class CategoryError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'CategoryError';
  }
}

const categorySelect = {
  id: true,
  distributorId: true,
  parentId: true,
  code: true,
  name: true,
  isHeader: true,
  isSystem: true,
  isActive: true,
  sortOrder: true,
  showVehicle: true,
  vehicleRequired: true,
  showDriver: true,
  driverRequired: true,
  vendorLabel: true,
  vendorPlaceholder: true,
  referenceLabel: true,
  referencePlaceholder: true,
  hint: true,
  taxDeductibleHint: true,
  reservedForImport: true,
} satisfies Prisma.ExpenseCategorySelect;

type CategoryRow = Prisma.ExpenseCategoryGetPayload<{ select: typeof categorySelect }>;

/**
 * Deterministic slug generator. kebab-case, alphanumerics + `-` + `_`.
 * On collision, appends `-2`, `-3`, ... until a free slot in the tenant.
 */
async function generateCode(distributorId: string, name: string): Promise<string> {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 58) || 'category';
  let candidate = base;
  let suffix = 1;
  // Loop bound is generous — realistically collisions are rare.
  while (suffix < 500) {
    const existing = await prisma.expenseCategory.findFirst({
      where: { distributorId, code: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base.slice(0, 58 - String(suffix).length - 1)}_${suffix}`;
  }
  throw new CategoryError('Could not generate a unique code', 500, 'CODE_COLLISION');
}

/** Resolve display path "Parent / Leaf" from parent lookup. */
function resolvePath(row: CategoryRow, byId: Map<string, CategoryRow>): string {
  if (!row.parentId) return row.name;
  const parent = byId.get(row.parentId);
  return parent ? `${parent.name} / ${row.name}` : row.name;
}

function mapCategory(
  row: CategoryRow,
  byId: Map<string, CategoryRow>,
  expenseCount: number,
) {
  return {
    categoryId: row.id,
    distributorId: row.distributorId,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    isHeader: row.isHeader,
    isSystem: row.isSystem,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    showVehicle: row.showVehicle,
    vehicleRequired: row.vehicleRequired,
    showDriver: row.showDriver,
    driverRequired: row.driverRequired,
    vendorLabel: row.vendorLabel,
    vendorPlaceholder: row.vendorPlaceholder,
    referenceLabel: row.referenceLabel,
    referencePlaceholder: row.referencePlaceholder,
    hint: row.hint,
    taxDeductibleHint: row.taxDeductibleHint,
    reservedForImport: row.reservedForImport,
    path: resolvePath(row, byId),
    expenseCount,
  };
}

/**
 * List every category for the tenant, active + inactive.
 * Callers can filter client-side by `isActive` for the picker.
 */
export async function listCategories(distributorId: string) {
  const rows = await prisma.expenseCategory.findMany({
    where: { distributorId, deletedAt: null },
    select: categorySelect,
    orderBy: [
      // System headers first (sortOrder 10..50), then user headers, then
      // leaves within each header by sortOrder.
      { parentId: 'asc' },
      { sortOrder: 'asc' },
      { name: 'asc' },
    ],
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // One aggregate query to count active expenses per category.
  const counts = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: { distributorId, deletedAt: null },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.categoryId, c._count._all]));

  return rows.map((r) => mapCategory(r, byId, countMap.get(r.id) ?? 0));
}

/**
 * Create a new category. If `code` omitted, one is derived from `name`.
 * Enforces:
 *  - `parentId` if set must reference an active header in the SAME tenant
 *  - a leaf (`isHeader=false`) with parentId must land under a header
 *  - a header (`isHeader=true`) must NOT have parentId
 */
export async function createCategory(
  distributorId: string,
  data: CreateExpenseCategoryInput,
) {
  const isHeader = data.isHeader ?? false;

  if (isHeader && data.parentId) {
    throw new CategoryError('Headers cannot have a parent', 400, 'HEADER_WITH_PARENT');
  }
  if (data.parentId) {
    const parent = await prisma.expenseCategory.findFirst({
      where: { id: data.parentId, distributorId, deletedAt: null },
      select: { id: true, isHeader: true, isActive: true },
    });
    if (!parent) throw new CategoryError('Parent not found', 400, 'PARENT_NOT_FOUND');
    if (!parent.isHeader) throw new CategoryError('Parent must be a header', 400, 'PARENT_NOT_HEADER');
    if (!parent.isActive) throw new CategoryError('Parent is inactive', 400, 'PARENT_INACTIVE');
  }

  const code = data.code ?? await generateCode(distributorId, data.name);
  // Manual collision check for explicit code (auto-code is already unique).
  if (data.code) {
    const clash = await prisma.expenseCategory.findFirst({
      where: { distributorId, code },
      select: { id: true },
    });
    if (clash) throw new CategoryError('Code already in use in this tenant', 409, 'CODE_TAKEN');
  }

  const created = await prisma.expenseCategory.create({
    data: {
      distributorId,
      parentId: data.parentId ?? null,
      code,
      name: data.name,
      isHeader,
      isSystem: false, // only migrations set this true
      sortOrder: data.sortOrder ?? 100,
      showVehicle: data.showVehicle ?? false,
      vehicleRequired: data.vehicleRequired ?? false,
      showDriver: data.showDriver ?? false,
      driverRequired: data.driverRequired ?? false,
      vendorLabel: data.vendorLabel,
      vendorPlaceholder: data.vendorPlaceholder,
      referenceLabel: data.referenceLabel,
      referencePlaceholder: data.referencePlaceholder,
      hint: data.hint,
      taxDeductibleHint: data.taxDeductibleHint ?? null,
    },
    select: categorySelect,
  });
  const rows = await prisma.expenseCategory.findMany({
    where: { distributorId, deletedAt: null }, select: categorySelect,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return mapCategory(created, byId, 0);
}

/**
 * Update a category. Enforces:
 *  - `code` cannot be changed (validator on the router doesn't expose it)
 *  - system rows: `isHeader` cannot flip; `isSystem` cannot flip
 *  - can't demote a header to a leaf if it has active children
 *  - can't promote a leaf to a header if it has active expenses
 *  - moving `parentId` requires new parent to be an active header in tenant
 *  - `isActive: false` on a system row = hide; user row = hide (soft-delete
 *    uses the DELETE endpoint, not update)
 */
export async function updateCategory(
  distributorId: string,
  id: string,
  data: UpdateExpenseCategoryInput,
) {
  const existing = await prisma.expenseCategory.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: {
      id: true, isHeader: true, isSystem: true, parentId: true,
      _count: { select: { children: { where: { deletedAt: null, isActive: true } }, expenses: { where: { deletedAt: null } } } },
    },
  });
  if (!existing) throw new CategoryError('Category not found', 404, 'NOT_FOUND');

  if (data.isHeader !== undefined && data.isHeader !== existing.isHeader) {
    if (existing.isSystem) {
      throw new CategoryError('Cannot change header/leaf status of a system category', 400, 'SYSTEM_HEADER_FIXED');
    }
    if (existing.isHeader && data.isHeader === false && existing._count.children > 0) {
      throw new CategoryError('Cannot demote a header with active children', 400, 'HEADER_HAS_CHILDREN');
    }
    if (!existing.isHeader && data.isHeader === true && existing._count.expenses > 0) {
      throw new CategoryError('Cannot promote a leaf that has expenses', 400, 'LEAF_HAS_EXPENSES');
    }
  }

  if (data.parentId !== undefined) {
    if (data.parentId === null) {
      // Moving to top level — allowed for both headers and user leaves.
    } else {
      const parent = await prisma.expenseCategory.findFirst({
        where: { id: data.parentId, distributorId, deletedAt: null },
        select: { id: true, isHeader: true, isActive: true },
      });
      if (!parent) throw new CategoryError('Parent not found', 400, 'PARENT_NOT_FOUND');
      if (!parent.isHeader) throw new CategoryError('Parent must be a header', 400, 'PARENT_NOT_HEADER');
      if (!parent.isActive) throw new CategoryError('Parent is inactive', 400, 'PARENT_INACTIVE');
      if (parent.id === id) throw new CategoryError('Cannot parent to self', 400, 'PARENT_CYCLE');
    }
  }

  const updated = await prisma.expenseCategory.update({
    where: { id },
    data: {
      parentId: data.parentId,
      name: data.name,
      isHeader: data.isHeader,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
      showVehicle: data.showVehicle,
      vehicleRequired: data.vehicleRequired,
      showDriver: data.showDriver,
      driverRequired: data.driverRequired,
      vendorLabel: data.vendorLabel,
      vendorPlaceholder: data.vendorPlaceholder,
      referenceLabel: data.referenceLabel,
      referencePlaceholder: data.referencePlaceholder,
      hint: data.hint,
      taxDeductibleHint: data.taxDeductibleHint,
    },
    select: categorySelect,
  });
  const rows = await prisma.expenseCategory.findMany({
    where: { distributorId, deletedAt: null }, select: categorySelect,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const expenseCount = await prisma.expense.count({
    where: { distributorId, categoryId: id, deletedAt: null },
  });
  return mapCategory(updated, byId, expenseCount);
}

/**
 * Delete a category. Rules:
 *  - System categories: NEVER hard-delete. Use isActive:false to hide.
 *  - User categories: hard-delete only if zero expenses reference them.
 *    Otherwise the client should call update with isActive:false.
 *  - Headers: only deletable if they have no children (soft-deleted counts).
 */
export async function deleteCategory(distributorId: string, id: string) {
  const existing = await prisma.expenseCategory.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: {
      id: true, isSystem: true, isHeader: true,
      _count: { select: { children: { where: { deletedAt: null } }, expenses: { where: { deletedAt: null } } } },
    },
  });
  if (!existing) throw new CategoryError('Category not found', 404, 'NOT_FOUND');
  if (existing.isSystem) {
    throw new CategoryError('System categories cannot be deleted — hide them via isActive:false instead', 400, 'SYSTEM_CATEGORY');
  }
  if (existing.isHeader && existing._count.children > 0) {
    throw new CategoryError('Cannot delete a header with children', 400, 'HEADER_HAS_CHILDREN');
  }
  if (existing._count.expenses > 0) {
    throw new CategoryError('Category has expenses — hide via isActive:false instead of deleting', 400, 'IN_USE');
  }
  await prisma.expenseCategory.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

/**
 * Restore all system-seeded categories to isActive:true. Handy when an
 * admin experimentally hid a couple of defaults and wants them back
 * without hunting the toggle.
 */
export async function restoreSystemDefaults(distributorId: string) {
  await prisma.expenseCategory.updateMany({
    where: { distributorId, isSystem: true, deletedAt: null },
    data: { isActive: true },
  });
  return listCategories(distributorId);
}
