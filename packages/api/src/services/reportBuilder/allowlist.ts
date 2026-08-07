/**
 * Report Builder allowlist (Phase 2 · 2026-08-05).
 *
 * The AUTHORITATIVE source of truth for what a user can see + query
 * via Report Builder. Everything not on this list is invisible.
 *
 * Structure: model → role → { fields: string[], filterableFields: Set<string>,
 * groupableFields: Set<string>, aggregatableFields: Set<string>, indexedFields: Set<string> }
 *
 * A user's spec is checked against this matrix at 4 gates:
 *   1. Every `spec.fields` entry must be in the role's `fields` array
 *   2. Every `spec.filters[].field` must be in `filterableFields`
 *   3. Every `spec.groupBy` field must be in `groupableFields`
 *   4. Every `spec.aggregates[].field` must be in `aggregatableFields`
 *      (or the field is literally 'rows' for `count`)
 *
 * `indexedFields` is used to warn ("this filter is not indexed") rather
 * than to reject.
 *
 * Field names use dot-notation for nested relations, e.g.
 * `customer.customerName`. The executor translates dot-paths into
 * Prisma `select` / `include` shapes.
 *
 * SAFETY INVARIANTS:
 *   - Field names in this file MUST match Prisma schema columns exactly
 *   - When adding a new field, decide explicitly: visible? filterable?
 *     groupable? aggregatable? indexed?
 *   - Nested fields require BOTH the parent relation being in `fields`
 *     AND the leaf being on the allowlist
 */

import type { ReportBuilderModel } from '@gaslink/shared';
import type { UserRole as UserRoleEnum } from '@gaslink/shared';

// Use string-union locally to match how UserRole values are compared elsewhere.
export type AllowRole = 'super_admin' | 'distributor_admin' | 'finance' | 'inventory' | 'mini_operator_admin';

export interface ModelRoleAllowlist {
  fields: string[];
  filterableFields: Set<string>;
  groupableFields: Set<string>;
  aggregatableFields: Set<string>;
  /** Fields that have a DB index. Used to warn user before slow queries. */
  indexedFields: Set<string>;
}

// ─── Order allowlist ──────────────────────────────────────────────────

const ORDER_STAFF_FIELDS = [
  'orderNumber', 'orderDate', 'deliveryDate', 'status', 'tripNumber',
  'isGodownPickup', 'isBackdated', 'deliveryNotes', 'poNumber',
  // FK fields — useful for grouping (users pick "Customer" in the UI
  // and we translate to `customerId` group). Also allow raw FK filtering.
  'customerId', 'driverId', 'vehicleId',
  'customer.customerName', 'driver.driverName', 'vehicle.vehicleNumber',
];
const ORDER_MONEY_FIELDS = ['totalAmount'];
const ORDER_INDEXED = new Set(['distributorId', 'deliveryDate', 'orderDate', 'status', 'driverId', 'vehicleId', 'customerId']);

// ─── Invoice allowlist ────────────────────────────────────────────────

const INVOICE_STAFF_FIELDS = [
  'invoiceNumber', 'issueDate', 'dueDate', 'status',
  'irnStatus', 'ewbStatus', 'poNumber',
  'isOpeningBalance', 'customer.customerName',
];
const INVOICE_MONEY_FIELDS = [
  'totalAmount', 'amountPaid', 'outstandingAmount',
  'cgstValue', 'sgstValue', 'igstValue', 'taxableValue',
];
const INVOICE_INDEXED = new Set(['distributorId', 'issueDate', 'status', 'customerId', 'orderId']);

// ─── PaymentTransaction allowlist ─────────────────────────────────────

const PAYMENT_STAFF_FIELDS = [
  'transactionDate', 'paymentMethod', 'referenceNumber', 'notes',
  'allocationStatus', 'customer.customerName',
];
const PAYMENT_MONEY_FIELDS = ['amount'];
const PAYMENT_INDEXED = new Set(['distributorId', 'transactionDate', 'customerId']);

// ─── CustomerLedgerEntry allowlist ────────────────────────────────────

const LEDGER_STAFF_FIELDS = [
  'entryType', 'entryDate', 'narration', 'voucherNumber',
  'customer.customerName', 'cylinderType.typeName', 'qtyDelta',
];
const LEDGER_MONEY_FIELDS = ['amountDelta'];
const LEDGER_INDEXED = new Set(['distributorId', 'customerId', 'entryDate', 'entryType']);

// ─── Expense allowlist ────────────────────────────────────────────────

const EXPENSE_STAFF_FIELDS = [
  'expenseDate', 'description', 'paymentMethod', 'vendorName', 'paidToName',
  'referenceNumber', 'category.name', 'vehicle.vehicleNumber', 'driver.driverName',
];
const EXPENSE_MONEY_FIELDS = ['amount'];
const EXPENSE_INDEXED = new Set(['distributorId', 'expenseDate', 'categoryId']);

// ─── PurchaseEntry allowlist (mini-op today; wider post-F8) ───────────

// 'purchaseNumber' (internal PSHD auto-number) is intentionally ABSENT.
// It is a DB handle, never user-facing — a builder field would let a user
// construct a report that surfaces it. Only the OMC's own reference is
// exposed. Keep it out of this list.
const PURCHASE_STAFF_FIELDS = [
  'supplierDocumentNumber', 'purchaseDate', 'notes',
  'sourceDistributor.name', 'isOpeningBalance',
];
const PURCHASE_MONEY_FIELDS = ['amountPaid'];
const PURCHASE_INDEXED = new Set(['distributorId', 'purchaseDate', 'sourceDistributorId']);

// ─── Master allowlist matrix ──────────────────────────────────────────

function build(
  common: string[],
  money: string[],
  indexed: Set<string>,
): Record<AllowRole, ModelRoleAllowlist> {
  const withMoney = [...common, ...money];
  const setFrom = (arr: string[]): Set<string> => new Set(arr);
  return {
    super_admin: {
      fields: withMoney,
      filterableFields: setFrom(withMoney),
      groupableFields: setFrom(common),
      aggregatableFields: setFrom(money),
      indexedFields: indexed,
    },
    distributor_admin: {
      fields: withMoney,
      filterableFields: setFrom(withMoney),
      groupableFields: setFrom(common),
      aggregatableFields: setFrom(money),
      indexedFields: indexed,
    },
    finance: {
      fields: withMoney,
      filterableFields: setFrom(withMoney),
      groupableFields: setFrom(common),
      aggregatableFields: setFrom(money),
      indexedFields: indexed,
    },
    inventory: {
      // Inventory role can see common fields but NOT money fields.
      fields: common,
      filterableFields: setFrom(common),
      groupableFields: setFrom(common),
      aggregatableFields: new Set(), // no money = no aggregation
      indexedFields: indexed,
    },
    mini_operator_admin: {
      fields: withMoney,
      filterableFields: setFrom(withMoney),
      groupableFields: setFrom(common),
      aggregatableFields: setFrom(money),
      indexedFields: indexed,
    },
  };
}

export const ALLOWLIST: Record<ReportBuilderModel, Record<AllowRole, ModelRoleAllowlist>> = {
  Order: build(ORDER_STAFF_FIELDS, ORDER_MONEY_FIELDS, ORDER_INDEXED),
  Invoice: build(INVOICE_STAFF_FIELDS, INVOICE_MONEY_FIELDS, INVOICE_INDEXED),
  PaymentTransaction: build(PAYMENT_STAFF_FIELDS, PAYMENT_MONEY_FIELDS, PAYMENT_INDEXED),
  CustomerLedgerEntry: build(LEDGER_STAFF_FIELDS, LEDGER_MONEY_FIELDS, LEDGER_INDEXED),
  Expense: build(EXPENSE_STAFF_FIELDS, EXPENSE_MONEY_FIELDS, EXPENSE_INDEXED),
  PurchaseEntry: build(PURCHASE_STAFF_FIELDS, PURCHASE_MONEY_FIELDS, PURCHASE_INDEXED),
};

/** Check if a role has any access to a model. Denies driver/customer/customer_hq
 *  entirely (they have their own portals — no Builder access). */
export function isRoleAllowedForBuilder(role: UserRoleEnum | string): role is AllowRole {
  return role === 'super_admin' || role === 'distributor_admin' || role === 'finance'
      || role === 'inventory' || role === 'mini_operator_admin';
}

/** Return the allowlist for (model, role) or null if role has no access. */
export function getAllowlist(model: ReportBuilderModel, role: string): ModelRoleAllowlist | null {
  if (!isRoleAllowedForBuilder(role)) return null;
  return ALLOWLIST[model][role];
}
