/**
 * STEP-2A — Guard tests for @gaslink/shared status labels.
 *
 * Purpose: catch the case where someone adds a new value to OrderStatus /
 * InvoiceStatus / AssignmentStatus / CreditNoteStatus in
 * packages/shared/src/enums/index.ts without adding a matching entry to the
 * label and variant maps. TypeScript's `Record<Enum, …>` enforces this at
 * compile time, but the compile error surfaces only inside the labels file;
 * a developer who blindly silences it would ship a broken label. These
 * tests fail loudly in CI instead.
 *
 * Why in the API package: @gaslink/shared has no vitest of its own; the API
 * package is the canonical place to put cross-package contract checks.
 */
import { describe, it, expect } from 'vitest';
import {
  OrderStatus,
  InvoiceStatus,
  AssignmentStatus,
  CreditNoteStatus,
  DebitNoteStatus,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_VARIANTS,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_VARIANTS,
  ASSIGNMENT_STATUS_LABELS,
  ASSIGNMENT_STATUS_VARIANTS,
  NOTE_STATUS_LABELS,
  NOTE_STATUS_VARIANTS,
  orderStatusLabel,
  orderStatusVariant,
  invoiceStatusLabel,
  invoiceStatusVariant,
  assignmentStatusLabel,
  assignmentStatusVariant,
  noteStatusLabel,
  noteStatusVariant,
  type StatusVariant,
} from '@gaslink/shared';

const VALID_VARIANTS: StatusVariant[] = ['success', 'warning', 'danger', 'info', 'neutral'];

function sortedValues<E extends Record<string, string>>(e: E): string[] {
  return Object.values(e).sort();
}

describe('STEP-2A: shared status labels — exhaustiveness', () => {
  it('ORDER_STATUS_LABELS covers every OrderStatus value', () => {
    expect(sortedValues(ORDER_STATUS_LABELS as unknown as Record<string, string>).length).toBe(
      Object.values(OrderStatus).length,
    );
    for (const value of Object.values(OrderStatus)) {
      expect(ORDER_STATUS_LABELS[value]).toBeTruthy();
    }
  });

  it('ORDER_STATUS_VARIANTS covers every OrderStatus value and uses valid variants', () => {
    for (const value of Object.values(OrderStatus)) {
      const variant = ORDER_STATUS_VARIANTS[value];
      expect(variant).toBeTruthy();
      expect(VALID_VARIANTS).toContain(variant);
    }
  });

  it('INVOICE_STATUS_LABELS covers every InvoiceStatus value', () => {
    for (const value of Object.values(InvoiceStatus)) {
      expect(INVOICE_STATUS_LABELS[value]).toBeTruthy();
    }
  });

  it('INVOICE_STATUS_VARIANTS covers every InvoiceStatus value and uses valid variants', () => {
    for (const value of Object.values(InvoiceStatus)) {
      const variant = INVOICE_STATUS_VARIANTS[value];
      expect(variant).toBeTruthy();
      expect(VALID_VARIANTS).toContain(variant);
    }
  });

  it('ASSIGNMENT_STATUS_LABELS covers every AssignmentStatus value', () => {
    for (const value of Object.values(AssignmentStatus)) {
      expect(ASSIGNMENT_STATUS_LABELS[value]).toBeTruthy();
    }
  });

  it('ASSIGNMENT_STATUS_VARIANTS covers every AssignmentStatus value and uses valid variants', () => {
    for (const value of Object.values(AssignmentStatus)) {
      const variant = ASSIGNMENT_STATUS_VARIANTS[value];
      expect(variant).toBeTruthy();
      expect(VALID_VARIANTS).toContain(variant);
    }
  });

  it('NOTE_STATUS_LABELS covers every CreditNoteStatus value (DN shares the same set)', () => {
    for (const value of Object.values(CreditNoteStatus)) {
      expect(NOTE_STATUS_LABELS[value]).toBeTruthy();
    }
  });

  it('NOTE_STATUS_VARIANTS covers every CreditNoteStatus value and uses valid variants', () => {
    for (const value of Object.values(CreditNoteStatus)) {
      const variant = NOTE_STATUS_VARIANTS[value];
      expect(variant).toBeTruthy();
      expect(VALID_VARIANTS).toContain(variant);
    }
  });

  it('CreditNoteStatus and DebitNoteStatus have identical value sets (single label map is safe)', () => {
    expect(sortedValues(CreditNoteStatus)).toEqual(sortedValues(DebitNoteStatus));
  });
});

describe('STEP-2A: canonical strings (the agreed user-visible wording)', () => {
  it('OrderStatus labels match the canonical strings agreed in the RCA', () => {
    expect(ORDER_STATUS_LABELS[OrderStatus.PENDING_DRIVER_ASSIGNMENT]).toBe('Pending Assignment');
    expect(ORDER_STATUS_LABELS[OrderStatus.PENDING_DISPATCH]).toBe('Pending Dispatch');
    expect(ORDER_STATUS_LABELS[OrderStatus.PREFLIGHT_IN_PROGRESS]).toBe('Dispatching…');
    expect(ORDER_STATUS_LABELS[OrderStatus.PENDING_DELIVERY]).toBe('Out for Delivery');
    expect(ORDER_STATUS_LABELS[OrderStatus.DELIVERED]).toBe('Delivered');
    expect(ORDER_STATUS_LABELS[OrderStatus.MODIFIED_DELIVERED]).toBe('Modified Delivered');
    expect(ORDER_STATUS_LABELS[OrderStatus.CANCELLED]).toBe('Cancelled');
    expect(ORDER_STATUS_LABELS[OrderStatus.RETURNS_ONLY]).toBe('Returns Only');
  });

  it('InvoiceStatus labels are Title Case (matches mobile, fixes web lowercase)', () => {
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.DRAFT]).toBe('Draft');
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.ISSUED]).toBe('Issued');
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.PARTIALLY_PAID]).toBe('Partially Paid');
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.PAID]).toBe('Paid');
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.OVERDUE]).toBe('Overdue');
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.CANCELLED]).toBe('Cancelled');
  });

  it('AssignmentStatus labels use the driver-pipeline short form (Ready/Dispatched/Returned/Reconciled)', () => {
    expect(ASSIGNMENT_STATUS_LABELS[AssignmentStatus.DISPATCH_READY]).toBe('Ready');
    expect(ASSIGNMENT_STATUS_LABELS[AssignmentStatus.LOADED_AND_DISPATCHED]).toBe('Dispatched');
    expect(ASSIGNMENT_STATUS_LABELS[AssignmentStatus.RETURNED_INVENTORY]).toBe('Returned');
    expect(ASSIGNMENT_STATUS_LABELS[AssignmentStatus.RECONCILED]).toBe('Reconciled');
    expect(ASSIGNMENT_STATUS_LABELS[AssignmentStatus.CANCELLED]).toBe('Cancelled');
  });
});

describe('STEP-2A: helper fallbacks', () => {
  it('orderStatusLabel returns the canonical string for known values', () => {
    expect(orderStatusLabel(OrderStatus.PENDING_DELIVERY)).toBe('Out for Delivery');
  });

  it('orderStatusLabel returns the raw input as fallback for unknown values', () => {
    expect(orderStatusLabel('not_a_real_status')).toBe('not_a_real_status');
  });

  it('orderStatusVariant returns neutral for unknown values', () => {
    expect(orderStatusVariant('not_a_real_status')).toBe('neutral');
  });

  it('invoiceStatusLabel resolves known + falls back on unknown', () => {
    expect(invoiceStatusLabel(InvoiceStatus.PARTIALLY_PAID)).toBe('Partially Paid');
    expect(invoiceStatusLabel('weird')).toBe('weird');
  });

  it('invoiceStatusVariant resolves known + neutral on unknown', () => {
    expect(invoiceStatusVariant(InvoiceStatus.PAID)).toBe('success');
    expect(invoiceStatusVariant('weird')).toBe('neutral');
  });

  it('assignmentStatusLabel resolves known + falls back', () => {
    expect(assignmentStatusLabel(AssignmentStatus.DISPATCH_READY)).toBe('Ready');
    expect(assignmentStatusLabel('weird')).toBe('weird');
  });

  it('assignmentStatusVariant resolves known + neutral on unknown', () => {
    expect(assignmentStatusVariant(AssignmentStatus.RECONCILED)).toBe('success');
    expect(assignmentStatusVariant('weird')).toBe('neutral');
  });

  it('noteStatusLabel handles both CN and DN values (shared enum set)', () => {
    expect(noteStatusLabel(CreditNoteStatus.APPROVED)).toBe('Approved');
    expect(noteStatusLabel(DebitNoteStatus.PENDING)).toBe('Pending');
  });

  it('noteStatusVariant handles both CN and DN values', () => {
    expect(noteStatusVariant(CreditNoteStatus.REJECTED)).toBe('danger');
    expect(noteStatusVariant(DebitNoteStatus.ISSUED)).toBe('success');
  });
});
