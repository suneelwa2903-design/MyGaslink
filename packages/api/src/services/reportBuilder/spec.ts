/**
 * Report Builder spec — zod validation (Phase 2 · 2026-08-05).
 *
 * Everything the client sends passes through this schema BEFORE the
 * allowlist gate. Zod enforces:
 *   - Shape correctness (required fields, correct types)
 *   - Field-name regex: `^[a-zA-Z][a-zA-Z0-9_.]*$` — rejects SQL chars
 *     immediately (defense in depth; Prisma ORM already prevents
 *     injection but a bad field name would break the query builder)
 *   - Operator enums (strict — no unknown ops)
 *   - Aggregation shape (field + op + optional alias)
 *
 * If a spec fails zod, the route returns 400 with the zod issue list.
 */

import { z } from 'zod';

// Field-name shape — dot-notation for nested relations. First char letter,
// rest letters/digits/underscore/dot. NO whitespace, quotes, semicolons.
const FIELD_NAME = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/, 'invalid field name');

const MODEL = z.enum([
  'Order', 'Invoice', 'PaymentTransaction',
  'CustomerLedgerEntry', 'Expense', 'PurchaseEntry',
]);

const DATE_PRESET = z.enum([
  'today', 'yesterday',
  'this_week', 'last_week',
  'this_month', 'last_month',
  'this_quarter',
  'this_fy', 'last_fy',
]);

const AGG_ENUM = z.enum([
  'sum', 'count', 'count_distinct',
  'avg', 'min', 'max',
  'running_total',
]);

// 2026-08-06: SCALAR rejects empty string on eq/neq/gt/gte/lt/lte/in/not_in/
// between/contains/starts_with. The web builder defaults a new filter to
// {op: 'eq', value: ''} on "Add filter" click; hitting "Run preview" before
// picking a value used to reach the executor and throw a Prisma runtime
// validation error (visible-in-console as 500). Explicit rejection here
// returns 400 with a clear message: "value is required".
const NONEMPTY_SCALAR = z.union([
  z.string().min(1, 'value is required'),
  z.number(),
]);
const NONEMPTY_STRING = z.string().min(1, 'value is required').max(500);

// Discriminated filter — each op has its own required shape.
const FILTER = z.discriminatedUnion('op', [
  z.object({ field: FIELD_NAME, op: z.literal('eq'), value: NONEMPTY_SCALAR }),
  z.object({ field: FIELD_NAME, op: z.literal('neq'), value: NONEMPTY_SCALAR }),
  z.object({ field: FIELD_NAME, op: z.literal('gt'), value: NONEMPTY_SCALAR }),
  z.object({ field: FIELD_NAME, op: z.literal('gte'), value: NONEMPTY_SCALAR }),
  z.object({ field: FIELD_NAME, op: z.literal('lt'), value: NONEMPTY_SCALAR }),
  z.object({ field: FIELD_NAME, op: z.literal('lte'), value: NONEMPTY_SCALAR }),
  z.object({ field: FIELD_NAME, op: z.literal('in'), values: z.array(NONEMPTY_SCALAR).min(1).max(100) }),
  z.object({ field: FIELD_NAME, op: z.literal('not_in'), values: z.array(NONEMPTY_SCALAR).min(1).max(100) }),
  z.object({ field: FIELD_NAME, op: z.literal('between'), from: NONEMPTY_SCALAR, to: NONEMPTY_SCALAR }),
  z.object({ field: FIELD_NAME, op: z.literal('is_null') }),
  z.object({ field: FIELD_NAME, op: z.literal('is_not_null') }),
  z.object({ field: FIELD_NAME, op: z.literal('contains'), value: NONEMPTY_STRING }),
  z.object({ field: FIELD_NAME, op: z.literal('starts_with'), value: NONEMPTY_STRING }),
  z.object({ field: FIELD_NAME, op: z.literal('preset'), preset: DATE_PRESET }),
]);

const AGGREGATE = z.object({
  // Special-case 'rows' allowed so `count of rows` works without a field.
  field: z.union([FIELD_NAME, z.literal('rows')]),
  op: AGG_ENUM,
  as: z.string().max(60).optional(),
});

export const REPORT_BUILDER_SPEC = z.object({
  model: MODEL,
  fields: z.array(FIELD_NAME).max(50),
  filters: z.array(FILTER).max(20).default([]),
  groupBy: z.array(FIELD_NAME).max(5).default([]),
  aggregates: z.array(AGGREGATE).max(10).default([]),
  orderBy: z.array(z.object({
    field: FIELD_NAME,
    dir: z.enum(['asc', 'desc']),
  })).max(5).default([]),
  limit: z.number().int().positive().max(50000).optional(),
});

export type ValidatedReportBuilderSpec = z.infer<typeof REPORT_BUILDER_SPEC>;

/** SavedReport CRUD payloads. */
export const CREATE_SAVED_REPORT = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  visibility: z.enum(['private', 'distributor']).default('private'),
  spec: REPORT_BUILDER_SPEC,
});

export const UPDATE_SAVED_REPORT = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  visibility: z.enum(['private', 'distributor']).optional(),
  spec: REPORT_BUILDER_SPEC.optional(),
});
