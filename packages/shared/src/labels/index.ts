/**
 * Canonical user-visible labels + colour-variant assignments for status enums.
 *
 * Why this exists: until 2026-05-30 every consumer (each web page, each mobile
 * role screen, customer-portal i18n JSON, driver screens, inventory analytics)
 * rolled its own label and variant. The audit found 4 different strings for
 * `pending_delivery` alone, and 3 different colours. Mobile (admin) and
 * inventory analytics additionally bypassed the Badge variant system with
 * inline hex.
 *
 * Single source of truth: every consumer imports from here. The Badge
 * primitive on each platform owns the actual hex per variant; we reconcile
 * those two palettes in a separate pass (web index.css ← mobile theme.ts).
 *
 * Adding a new enum value: TypeScript's `Record<Enum, …>` makes the maps
 * exhaustive — leaving a value out is a compile error. The guard test in
 * the API package also asserts the enum value set matches the label key set
 * at runtime so a value silently added to an enum without a label entry
 * surfaces as a test failure.
 */

import {
  OrderStatus,
  InvoiceStatus,
  AssignmentStatus,
  CreditNoteStatus,
} from '../enums/index.js';

/** The 5 Badge variants both platforms support. */
export type StatusVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

// ─── Order statuses ──────────────────────────────────────────────────────────

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_DRIVER_ASSIGNMENT]: 'Pending Assignment',
  [OrderStatus.PENDING_DISPATCH]: 'Pending Dispatch',
  [OrderStatus.PREFLIGHT_IN_PROGRESS]: 'Dispatching…',
  [OrderStatus.PENDING_DELIVERY]: 'Out for Delivery',
  [OrderStatus.DELIVERED]: 'Delivered',
  [OrderStatus.MODIFIED_DELIVERED]: 'Modified Delivered',
  [OrderStatus.CANCELLED]: 'Cancelled',
  [OrderStatus.RETURNS_ONLY]: 'Returns Only',
};

export const ORDER_STATUS_VARIANTS: Record<OrderStatus, StatusVariant> = {
  [OrderStatus.PENDING_DRIVER_ASSIGNMENT]: 'warning',
  [OrderStatus.PENDING_DISPATCH]: 'info',
  [OrderStatus.PREFLIGHT_IN_PROGRESS]: 'info',
  [OrderStatus.PENDING_DELIVERY]: 'warning',
  [OrderStatus.DELIVERED]: 'success',
  [OrderStatus.MODIFIED_DELIVERED]: 'success',
  [OrderStatus.CANCELLED]: 'danger',
  [OrderStatus.RETURNS_ONLY]: 'neutral',
};

// ─── Invoice statuses ────────────────────────────────────────────────────────

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  [InvoiceStatus.DRAFT]: 'Draft',
  [InvoiceStatus.ISSUED]: 'Issued',
  [InvoiceStatus.PARTIALLY_PAID]: 'Partially Paid',
  [InvoiceStatus.PAID]: 'Paid',
  [InvoiceStatus.OVERDUE]: 'Overdue',
  [InvoiceStatus.CANCELLED]: 'Cancelled',
};

export const INVOICE_STATUS_VARIANTS: Record<InvoiceStatus, StatusVariant> = {
  [InvoiceStatus.DRAFT]: 'neutral',
  [InvoiceStatus.ISSUED]: 'info',
  [InvoiceStatus.PARTIALLY_PAID]: 'warning',
  [InvoiceStatus.PAID]: 'success',
  [InvoiceStatus.OVERDUE]: 'danger',
  [InvoiceStatus.CANCELLED]: 'neutral',
};

// ─── Driver-Vehicle Assignment / Trip statuses ──────────────────────────────

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  [AssignmentStatus.DISPATCH_READY]: 'Ready',
  [AssignmentStatus.LOADED_AND_DISPATCHED]: 'Dispatched',
  [AssignmentStatus.RETURNED_INVENTORY]: 'Returned',
  [AssignmentStatus.RECONCILED]: 'Reconciled',
  [AssignmentStatus.CANCELLED]: 'Cancelled',
};

export const ASSIGNMENT_STATUS_VARIANTS: Record<AssignmentStatus, StatusVariant> = {
  [AssignmentStatus.DISPATCH_READY]: 'warning',
  [AssignmentStatus.LOADED_AND_DISPATCHED]: 'info',
  [AssignmentStatus.RETURNED_INVENTORY]: 'success',
  [AssignmentStatus.RECONCILED]: 'success',
  [AssignmentStatus.CANCELLED]: 'danger',
};

// ─── Credit / Debit Note statuses ────────────────────────────────────────────
// CN and DN share the exact same status enum values and visual treatment,
// so one set of label/variant maps covers both.

export const NOTE_STATUS_LABELS: Record<CreditNoteStatus, string> = {
  [CreditNoteStatus.PENDING]: 'Pending',
  [CreditNoteStatus.APPROVED]: 'Approved',
  [CreditNoteStatus.ISSUED]: 'Issued',
  [CreditNoteStatus.REJECTED]: 'Rejected',
  [CreditNoteStatus.CANCELLED]: 'Cancelled',
};

export const NOTE_STATUS_VARIANTS: Record<CreditNoteStatus, StatusVariant> = {
  [CreditNoteStatus.PENDING]: 'warning',
  [CreditNoteStatus.APPROVED]: 'success',
  [CreditNoteStatus.ISSUED]: 'success',
  [CreditNoteStatus.REJECTED]: 'danger',
  [CreditNoteStatus.CANCELLED]: 'neutral',
};

// ─── String-input helpers ────────────────────────────────────────────────────
// API responses arrive as plain strings, not enum members. These helpers
// accept `string` and fall back to the raw value on unknown input so a new
// enum value reaching the UI before the labels module is rebuilt still
// renders something readable rather than `undefined`.

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status as OrderStatus] ?? status;
}

export function orderStatusVariant(status: string): StatusVariant {
  return ORDER_STATUS_VARIANTS[status as OrderStatus] ?? 'neutral';
}

export function invoiceStatusLabel(status: string): string {
  return INVOICE_STATUS_LABELS[status as InvoiceStatus] ?? status;
}

export function invoiceStatusVariant(status: string): StatusVariant {
  return INVOICE_STATUS_VARIANTS[status as InvoiceStatus] ?? 'neutral';
}

export function assignmentStatusLabel(status: string): string {
  return ASSIGNMENT_STATUS_LABELS[status as AssignmentStatus] ?? status;
}

export function assignmentStatusVariant(status: string): StatusVariant {
  return ASSIGNMENT_STATUS_VARIANTS[status as AssignmentStatus] ?? 'neutral';
}

export function noteStatusLabel(status: string): string {
  return NOTE_STATUS_LABELS[status as CreditNoteStatus] ?? status;
}

export function noteStatusVariant(status: string): StatusVariant {
  return NOTE_STATUS_VARIANTS[status as CreditNoteStatus] ?? 'neutral';
}
