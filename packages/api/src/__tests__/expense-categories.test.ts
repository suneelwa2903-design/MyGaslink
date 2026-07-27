/**
 * Mini-op #5 v2 (2026-07-27 evening) — Expense-category guard tests.
 *
 * Covers the invariants the tenant-owned taxonomy relies on:
 *   T1 — every distributor has the 13 seeded system leaves after migration
 *   T2 — service refuses to create an expense against a header
 *   T3 — service refuses to create an expense against an inactive category
 *   T4 — cross-tenant categoryId is rejected
 *   T5 — system categories can't be hard-deleted
 *   T6 — user category with expenses can't be hard-deleted
 *   T7 — code is unique per (distributorId, code)
 */
import { describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import * as categoryService from '../services/expenseCategoryService.js';
import * as expenseService from '../services/expenseService.js';
import { SYSTEM_EXPENSE_CODES } from '@gaslink/shared';

const DIST_ID = 'dist-001';
const OTHER_DIST_ID = 'dist-002';
// Anti-pattern #7: fixed far-future date so real dev-DB data can't
// tangle with the test fixtures.
const TEST_DATE = '2099-12-31';

async function getTestUserId(distributorId: string): Promise<string> {
  const u = await prisma.user.findFirst({
    where: { distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!u) throw new Error(`no user seeded for ${distributorId}`);
  return u.id;
}

async function getFuelCategoryId(distributorId: string): Promise<string> {
  const row = await prisma.expenseCategory.findFirst({
    where: { distributorId, code: 'fuel' },
    select: { id: true },
  });
  if (!row) throw new Error(`fuel category not seeded for ${distributorId}`);
  return row.id;
}

describe('Expense categories (mini-op #5 v2)', () => {
  it('T1 — every distributor has all 13 seeded system leaves', async () => {
    for (const distributorId of [DIST_ID, OTHER_DIST_ID]) {
      const leaves = await prisma.expenseCategory.findMany({
        where: { distributorId, isSystem: true, isHeader: false, deletedAt: null },
        select: { code: true },
      });
      const codes = leaves.map((l) => l.code).sort();
      const expected = [...SYSTEM_EXPENSE_CODES].sort();
      expect(codes).toEqual(expected);
    }
  });

  it('T2 — createExpense refuses a header categoryId', async () => {
    const header = await prisma.expenseCategory.findFirst({
      where: { distributorId: DIST_ID, isHeader: true, deletedAt: null },
      select: { id: true },
    });
    if (!header) throw new Error('no header seeded');
    const userId = await getTestUserId(DIST_ID);
    await expect(expenseService.createExpense(DIST_ID, userId, {
      expenseDate: TEST_DATE,
      categoryId: header.id,
      amount: 100,
      description: 'guard test — header',
    })).rejects.toMatchObject({ code: 'CATEGORY_IS_HEADER' });
  });

  it('T3 — createExpense refuses an inactive category', async () => {
    const other = await categoryService.createCategory(DIST_ID, {
      parentId: null, isHeader: false, name: 'Temp Inactive Leaf',
    });
    await categoryService.updateCategory(DIST_ID, other.categoryId, { isActive: false });
    const userId = await getTestUserId(DIST_ID);
    await expect(expenseService.createExpense(DIST_ID, userId, {
      expenseDate: TEST_DATE,
      categoryId: other.categoryId,
      amount: 100,
      description: 'guard test — inactive',
    })).rejects.toMatchObject({ code: 'CATEGORY_INACTIVE' });
    // Cleanup: make it deletable (still no expenses attached).
    await prisma.expenseCategory.update({ where: { id: other.categoryId }, data: { deletedAt: new Date() } });
  });

  it('T4 — cross-tenant categoryId is rejected', async () => {
    const fuelInOtherTenant = await getFuelCategoryId(OTHER_DIST_ID);
    const userId = await getTestUserId(DIST_ID);
    await expect(expenseService.createExpense(DIST_ID, userId, {
      expenseDate: TEST_DATE,
      categoryId: fuelInOtherTenant,
      amount: 100,
      description: 'guard test — cross-tenant',
    })).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
  });

  it('T5 — system categories can be hidden but not hard-deleted', async () => {
    const fuelId = await getFuelCategoryId(DIST_ID);
    await expect(categoryService.deleteCategory(DIST_ID, fuelId))
      .rejects.toMatchObject({ code: 'SYSTEM_CATEGORY' });
    // But hiding works.
    const hidden = await categoryService.updateCategory(DIST_ID, fuelId, { isActive: false });
    expect(hidden.isActive).toBe(false);
    // Restore for other tests.
    await categoryService.updateCategory(DIST_ID, fuelId, { isActive: true });
  });

  it('T6 — user category with expenses can\'t be hard-deleted', async () => {
    const cat = await categoryService.createCategory(DIST_ID, {
      parentId: null, isHeader: false, name: 'In-Use Leaf',
    });
    const userId = await getTestUserId(DIST_ID);
    const expense = await expenseService.createExpense(DIST_ID, userId, {
      expenseDate: TEST_DATE,
      categoryId: cat.categoryId,
      amount: 100,
      description: 'guard test — in use',
    });
    await expect(categoryService.deleteCategory(DIST_ID, cat.categoryId))
      .rejects.toMatchObject({ code: 'IN_USE' });
    // Cleanup.
    await prisma.expense.update({ where: { id: expense.expenseId }, data: { deletedAt: new Date() } });
    await prisma.expenseCategory.update({ where: { id: cat.categoryId }, data: { deletedAt: new Date() } });
  });

  it('T7 — explicit `code` collision is 409', async () => {
    await expect(categoryService.createCategory(DIST_ID, {
      parentId: null, isHeader: false, name: 'Duplicate Fuel', code: 'fuel',
    })).rejects.toMatchObject({ code: 'CODE_TAKEN' });
  });
});
