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
  showPaidTo: true,
  paidToRequired: true,
  paidToLabel: true,
  paidToPlaceholder: true,
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
    showPaidTo: row.showPaidTo,
    paidToRequired: row.paidToRequired,
    paidToLabel: row.paidToLabel,
    paidToPlaceholder: row.paidToPlaceholder,
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
      showPaidTo: data.showPaidTo ?? false,
      paidToRequired: data.paidToRequired ?? false,
      paidToLabel: data.paidToLabel,
      paidToPlaceholder: data.paidToPlaceholder,
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
      showPaidTo: data.showPaidTo,
      paidToRequired: data.paidToRequired,
      paidToLabel: data.paidToLabel,
      paidToPlaceholder: data.paidToPlaceholder,
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

// 2026-07-29 — Static definition of the system taxonomy. The v2 + v3
// migrations seed this via PL/pgSQL DO-loops that iterate over existing
// `distributors` rows. That works for prod (dist-001/002/003 already
// existed when the migrations shipped) but leaves two gaps closed here:
//   1. New distributors created via `createDistributor()` after these
//      migrations ran wouldn't get any categories — the DO-loop is a
//      one-time replay, not a continuously-fired trigger.
//   2. CI tests (fresh Postgres → migrate → then create dist-001/002 via
//      the seed script) hit the same trap: migrations ran when the
//      distributors table was still empty, so 0 rows were inserted.
// The helper below is called at both sites (see createDistributor +
// prisma/seed.ts). Idempotent — an existing `(distributor_id, code)`
// row is left alone.

type SystemHeader = {
  code: string;
  name: string;
  sortOrder: number;
};

type SystemLeaf = {
  headerCode: string;
  code: string;
  name: string;
  sortOrder: number;
  showVehicle?: boolean;
  vehicleRequired?: boolean;
  showDriver?: boolean;
  driverRequired?: boolean;
  showPaidTo?: boolean;
  paidToRequired?: boolean;
  paidToLabel?: string | null;
  paidToPlaceholder?: string | null;
  vendorLabel?: string | null;
  vendorPlaceholder?: string | null;
  referenceLabel?: string | null;
  referencePlaceholder?: string | null;
  hint?: string | null;
};

const SYSTEM_HEADERS: SystemHeader[] = [
  { code: '__hdr_vehicle',    name: 'Vehicle Costs',        sortOrder: 10 },
  { code: '__hdr_staff',      name: 'Staff Costs',          sortOrder: 20 },
  { code: '__hdr_facility',   name: 'Facility Costs',       sortOrder: 30 },
  { code: '__hdr_compliance', name: 'Compliance & Finance', sortOrder: 40 },
  { code: '__hdr_misc',       name: 'Miscellaneous',        sortOrder: 50 },
];

// 20 system leaves = 13 from v2 taxonomy + 7 added in v3. Field-reveal
// tweaks from the v3 UPDATE statements (salaries_wages / loading_unloading
// / rent / insurance) are baked in directly here — the post-migration
// state is the source of truth for anyone landing on the current schema.
const SYSTEM_LEAVES: SystemLeaf[] = [
  // Vehicle Costs
  { headerCode: '__hdr_vehicle', code: 'fuel', name: 'Fuel', sortOrder: 10, showVehicle: true, vehicleRequired: true, showDriver: true, vendorLabel: 'Petrol pump', vendorPlaceholder: 'e.g. HP Petrol Pump', referenceLabel: 'Bill #', referencePlaceholder: 'From the fuel bill' },
  { headerCode: '__hdr_vehicle', code: 'vehicle_maintenance', name: 'Vehicle maintenance', sortOrder: 20, showVehicle: true, vehicleRequired: true, vendorLabel: 'Service center', vendorPlaceholder: 'e.g. Bosch Service', referenceLabel: 'Invoice #', referencePlaceholder: 'From the service invoice' },
  { headerCode: '__hdr_vehicle', code: 'vehicle_insurance', name: 'Vehicle Insurance', sortOrder: 25, showVehicle: true, vehicleRequired: true, vendorLabel: 'Insurer', vendorPlaceholder: 'e.g. Bajaj Allianz', referenceLabel: 'Policy #', referencePlaceholder: 'Insurance policy number' },
  { headerCode: '__hdr_vehicle', code: 'vehicle_road_tax', name: 'Vehicle Road Tax / RTO', sortOrder: 30, showVehicle: true, vehicleRequired: true, vendorLabel: 'Department', vendorPlaceholder: 'e.g. RTO Telangana', referenceLabel: 'Challan #', referencePlaceholder: 'Payment challan / receipt' },
  // Staff Costs
  { headerCode: '__hdr_staff', code: 'driver_salary', name: 'Driver Salary', sortOrder: 5, showDriver: true, driverRequired: true, vendorLabel: 'Month / period', vendorPlaceholder: 'e.g. July 2026', referenceLabel: 'Reference #', referencePlaceholder: 'Payslip # / bank ref', hint: 'Pulls the driver from your fleet list. Use "Salaries & wages" or "Helper / Loader Wages" for others.' },
  { headerCode: '__hdr_staff', code: 'salaries_wages', name: 'Salaries & wages', sortOrder: 10, showPaidTo: true, paidToRequired: true, paidToLabel: 'Paid to (staff name)', paidToPlaceholder: 'e.g. Raju (driver) OR Ravi (helper)', referenceLabel: 'Reference #', referencePlaceholder: 'Any receipt / note ID', hint: 'For driver salary specifically, use the "Driver Salary" category instead — it pulls the driver from the fleet list.' },
  { headerCode: '__hdr_staff', code: 'helper_wages', name: 'Helper / Loader Wages', sortOrder: 15, showPaidTo: true, paidToRequired: true, paidToLabel: 'Helper / loader name', paidToPlaceholder: 'e.g. Ramu (loader)', referenceLabel: 'Reference #', referencePlaceholder: 'Any receipt / note ID' },
  { headerCode: '__hdr_staff', code: 'loading_unloading', name: 'Loading / unloading', sortOrder: 20, showPaidTo: true, paidToLabel: 'Labor / loader name', paidToPlaceholder: 'e.g. Depot loader team', referenceLabel: 'Reference #', referencePlaceholder: 'Any receipt / note ID' },
  { headerCode: '__hdr_staff', code: 'office_staff_salary', name: 'Office Staff Salary', sortOrder: 25, showPaidTo: true, paidToRequired: true, paidToLabel: 'Staff name', paidToPlaceholder: 'e.g. Priya (accountant)', referenceLabel: 'Reference #', referencePlaceholder: 'Payslip # / bank ref' },
  { headerCode: '__hdr_staff', code: 'staff_health_insurance', name: 'Staff Health Insurance', sortOrder: 30, showPaidTo: true, paidToRequired: true, paidToLabel: 'Beneficiary (staff name)', paidToPlaceholder: 'e.g. Raju (driver) family', vendorLabel: 'Insurer', vendorPlaceholder: 'e.g. HDFC Ergo', referenceLabel: 'Policy #', referencePlaceholder: 'Insurance policy number' },
  // Facility Costs
  { headerCode: '__hdr_facility', code: 'rent', name: 'Rent', sortOrder: 10, showPaidTo: true, paidToRequired: true, paidToLabel: 'Landlord name', paidToPlaceholder: 'e.g. Sri Ramesh (owner)', vendorLabel: 'Property / building name (optional)', vendorPlaceholder: 'e.g. Godown #4, Kondapur', referenceLabel: 'Receipt #', referencePlaceholder: 'Rent receipt number' },
  { headerCode: '__hdr_facility', code: 'godown_insurance', name: 'Godown Insurance', sortOrder: 15, vendorLabel: 'Insurer', vendorPlaceholder: 'e.g. Bajaj Allianz', referenceLabel: 'Policy #', referencePlaceholder: 'Insurance policy number' },
  { headerCode: '__hdr_facility', code: 'utilities', name: 'Utilities', sortOrder: 20, vendorLabel: 'Provider', vendorPlaceholder: 'e.g. TSSPDCL, Metro Water', referenceLabel: 'Bill / account #', referencePlaceholder: 'Utility bill number' },
  { headerCode: '__hdr_facility', code: 'office_supplies', name: 'Office supplies', sortOrder: 30, vendorLabel: 'Store', vendorPlaceholder: 'e.g. Reliance Trends', referenceLabel: 'Bill #', referencePlaceholder: 'From the bill' },
  { headerCode: '__hdr_facility', code: 'communication', name: 'Communication', sortOrder: 40, vendorLabel: 'Provider', vendorPlaceholder: 'e.g. Airtel, Jio', referenceLabel: 'Bill / account #', referencePlaceholder: 'Utility bill number' },
  // Compliance & Finance
  { headerCode: '__hdr_compliance', code: 'insurance', name: 'Insurance', sortOrder: 10, vendorLabel: 'Insurer', vendorPlaceholder: 'e.g. Bajaj Allianz', referenceLabel: 'Policy #', referencePlaceholder: 'Insurance policy number', hint: 'Prefer the specific leaves below — Vehicle Insurance, Godown Insurance, or Staff Health Insurance — for cleaner reports.' },
  { headerCode: '__hdr_compliance', code: 'taxes_licenses', name: 'Taxes & licenses', sortOrder: 20, vendorLabel: 'Department', vendorPlaceholder: 'e.g. GST, RTO', referenceLabel: 'Challan #', referencePlaceholder: 'Payment challan / receipt' },
  { headerCode: '__hdr_compliance', code: 'bank_charges', name: 'Bank charges', sortOrder: 30, vendorLabel: 'Bank', vendorPlaceholder: 'e.g. HDFC, SBI', referenceLabel: 'Transaction #', referencePlaceholder: 'Statement reference' },
  { headerCode: '__hdr_compliance', code: 'cylinder_deposits', name: 'Cylinder deposits', sortOrder: 40, vendorLabel: 'Supplier', vendorPlaceholder: 'e.g. HPCL depot', referenceLabel: 'Deposit receipt #', referencePlaceholder: 'From deposit slip' },
  // Miscellaneous
  { headerCode: '__hdr_misc', code: 'other', name: 'Other', sortOrder: 10, showVehicle: true, showDriver: true, vendorLabel: 'Vendor (optional)', vendorPlaceholder: 'Vendor name', referenceLabel: 'Reference # (optional)', referencePlaceholder: 'Any reference' },
];

/**
 * Idempotently seed the 5 system headers + 20 system leaves for one
 * distributor. Existing `(distributor_id, code)` rows are left alone —
 * safe to call multiple times, safe to call after the initial DO-loop
 * migrations ran.
 *
 * Callers:
 *   - `distributorService.createDistributor` (production runtime — every
 *     new tenant is seeded on creation).
 *   - `prisma/seed.ts` (test / dev DB reseed).
 */
export async function seedSystemExpenseCategoriesForDistributor(
  distributorId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  const headerIds = new Map<string, string>();

  for (const h of SYSTEM_HEADERS) {
    const existing = await client.expenseCategory.findFirst({
      where: { distributorId, code: h.code },
      select: { id: true },
    });
    if (existing) {
      headerIds.set(h.code, existing.id);
      continue;
    }
    const created = await client.expenseCategory.create({
      data: {
        distributorId,
        code: h.code,
        name: h.name,
        isHeader: true,
        isSystem: true,
        sortOrder: h.sortOrder,
      },
      select: { id: true },
    });
    headerIds.set(h.code, created.id);
  }

  for (const l of SYSTEM_LEAVES) {
    const existing = await client.expenseCategory.findFirst({
      where: { distributorId, code: l.code },
      select: { id: true },
    });
    if (existing) continue;
    const parentId = headerIds.get(l.headerCode);
    if (!parentId) throw new Error(`Header ${l.headerCode} missing while seeding leaf ${l.code}`);
    await client.expenseCategory.create({
      data: {
        distributorId,
        parentId,
        code: l.code,
        name: l.name,
        isHeader: false,
        isSystem: true,
        sortOrder: l.sortOrder,
        showVehicle: l.showVehicle ?? false,
        vehicleRequired: l.vehicleRequired ?? false,
        showDriver: l.showDriver ?? false,
        driverRequired: l.driverRequired ?? false,
        showPaidTo: l.showPaidTo ?? false,
        paidToRequired: l.paidToRequired ?? false,
        paidToLabel: l.paidToLabel ?? null,
        paidToPlaceholder: l.paidToPlaceholder ?? null,
        vendorLabel: l.vendorLabel ?? null,
        vendorPlaceholder: l.vendorPlaceholder ?? null,
        referenceLabel: l.referenceLabel ?? null,
        referencePlaceholder: l.referencePlaceholder ?? null,
        hint: l.hint ?? null,
      },
    });
  }
}
