/**
 * Report Builder executor (Phase 2 · 2026-08-05).
 *
 * Takes a VALIDATED spec + user context, runs it against Prisma,
 * returns rows + metadata. Never composes SQL as a string. Never
 * touches $queryRaw. Every field name comes from the allowlist.
 *
 * Safety guarantees enforced here:
 *   1. Tenant scope always injected: where.distributorId = user.distributorId
 *   2. Row cap 50,000 (hard clamp on `limit`)
 *   3. Statement timeout 10s (Promise.race for JS responsiveness; hard
 *      Postgres timeout via $transaction wrapper is a follow-up)
 *   4. Every field is allowlist-verified for user's role
 *   5. Unindexed-filter warning attached to response meta
 *   6. Row-level scope for future non-staff roles (driver/customer) —
 *      today only staff roles reach here per allowlist.isRoleAllowedForBuilder
 *
 * The executor supports TWO execution modes:
 *   - RAW mode:      no groupBy / no aggregates → returns row-level results
 *                    (Prisma findMany with select)
 *   - GROUPED mode:  groupBy + aggregates → returns aggregated results
 *                    (Prisma groupBy)
 */

import { prisma } from '../../lib/prisma.js';
import { Prisma } from '@prisma/client';
import type { ReportBuilderModel, SavedReportRunResult } from '@gaslink/shared';
import { localTodayISO, localDateISO } from '@gaslink/shared';
import { getAllowlist, type ModelRoleAllowlist } from './allowlist.js';
import type { ValidatedReportBuilderSpec } from './spec.js';

const MAX_ROWS = 50_000;
const STATEMENT_TIMEOUT_MS = 10_000;

// ─── Prisma model dispatch ────────────────────────────────────────────

interface ModelRunner {
  findMany: (args: unknown) => Promise<unknown[]>;
  groupBy: (args: unknown) => Promise<unknown[]>;
  count: (args: unknown) => Promise<number>;
}

function runnerFor(model: ReportBuilderModel): ModelRunner {
  switch (model) {
    case 'Order':               return prisma.order as unknown as ModelRunner;
    case 'Invoice':             return prisma.invoice as unknown as ModelRunner;
    case 'PaymentTransaction':  return prisma.paymentTransaction as unknown as ModelRunner;
    case 'CustomerLedgerEntry': return prisma.customerLedgerEntry as unknown as ModelRunner;
    case 'Expense':             return prisma.expense as unknown as ModelRunner;
    case 'PurchaseEntry':       return prisma.purchaseEntry as unknown as ModelRunner;
  }
}

// ─── Date preset resolver ─────────────────────────────────────────────

function resolvePreset(preset: string): { from: string; to: string } {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  const iso = (dt: Date): string => localDateISO(dt);
  const first = (dt: Date): Date => new Date(dt.getFullYear(), dt.getMonth(), 1);
  const last = (dt: Date): Date => new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
  switch (preset) {
    case 'today':      return { from: localTodayISO(), to: localTodayISO() };
    case 'yesterday': {
      const dt = new Date(y, m, d - 1);
      return { from: iso(dt), to: iso(dt) };
    }
    case 'this_week': {
      const day = today.getDay();
      const monOffset = day === 0 ? -6 : 1 - day;
      const start = new Date(y, m, d + monOffset);
      return { from: iso(start), to: localTodayISO() };
    }
    case 'last_week': {
      const day = today.getDay();
      const monOffset = day === 0 ? -6 : 1 - day;
      const thisMon = new Date(y, m, d + monOffset);
      const lastMon = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - 7);
      const lastSun = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - 1);
      return { from: iso(lastMon), to: iso(lastSun) };
    }
    case 'this_month': return { from: iso(first(today)), to: localTodayISO() };
    case 'last_month': {
      const lm = new Date(y, m - 1, 1);
      return { from: iso(first(lm)), to: iso(last(lm)) };
    }
    case 'this_quarter': {
      const qStart = new Date(y, Math.floor(m / 3) * 3, 1);
      return { from: iso(qStart), to: localTodayISO() };
    }
    case 'this_fy': {
      const fyStart = m >= 3 ? new Date(y, 3, 1) : new Date(y - 1, 3, 1);
      return { from: iso(fyStart), to: localTodayISO() };
    }
    case 'last_fy': {
      const fyStart = m >= 3 ? new Date(y - 1, 3, 1) : new Date(y - 2, 3, 1);
      const fyEnd = m >= 3 ? new Date(y, 2, 31) : new Date(y - 1, 2, 31);
      return { from: iso(fyStart), to: iso(fyEnd) };
    }
    default:
      return { from: localTodayISO(), to: localTodayISO() };
  }
}

// ─── Prisma where builder ─────────────────────────────────────────────

function pathToNestedObject(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const result: Record<string, unknown> = {};
  let cursor = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[parts[i]] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
  return result;
}

function filterToWhere(filter: ValidatedReportBuilderSpec['filters'][number]): Record<string, unknown> {
  switch (filter.op) {
    case 'eq':    return pathToNestedObject(filter.field, filter.value);
    case 'neq':   return pathToNestedObject(filter.field, { not: filter.value });
    case 'gt':    return pathToNestedObject(filter.field, { gt: filter.value });
    case 'gte':   return pathToNestedObject(filter.field, { gte: filter.value });
    case 'lt':    return pathToNestedObject(filter.field, { lt: filter.value });
    case 'lte':   return pathToNestedObject(filter.field, { lte: filter.value });
    case 'in':    return pathToNestedObject(filter.field, { in: filter.values });
    case 'not_in': return pathToNestedObject(filter.field, { notIn: filter.values });
    case 'between': return pathToNestedObject(filter.field, { gte: filter.from, lte: filter.to });
    case 'is_null': return pathToNestedObject(filter.field, null);
    case 'is_not_null': return pathToNestedObject(filter.field, { not: null });
    case 'contains': return pathToNestedObject(filter.field, { contains: filter.value, mode: 'insensitive' });
    case 'starts_with': return pathToNestedObject(filter.field, { startsWith: filter.value, mode: 'insensitive' });
    case 'preset': {
      const { from, to } = resolvePreset(filter.preset);
      return pathToNestedObject(filter.field, { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) });
    }
  }
}

// ─── Prisma select builder ────────────────────────────────────────────

function fieldsToSelect(fields: string[]): Record<string, unknown> {
  const select: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split('.');
    if (parts.length === 1) {
      select[parts[0]] = true;
    } else {
      let cursor = select;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!cursor[key] || typeof cursor[key] !== 'object') {
          cursor[key] = { select: {} };
        }
        cursor = (cursor[key] as { select: Record<string, unknown> }).select;
      }
      cursor[parts[parts.length - 1]] = true;
    }
  }
  return select;
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function toCellValue(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const num = Number(v);
  if (Number.isFinite(num)) return num;
  return String(v);
}

// ─── Result cache (per-user, per-spec, 60s TTL) ───────────────────────

interface CacheEntry {
  expiresAt: number;
  result: SavedReportRunResult;
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheKey(distributorId: string, userId: string, spec: ValidatedReportBuilderSpec): string {
  return `${distributorId}:${userId}:${JSON.stringify(spec)}`;
}

// ─── Main executor ────────────────────────────────────────────────────

export interface ExecutorContext {
  distributorId: string;
  userId: string;
  role: string;
}

export type ExecutorResult = SavedReportRunResult;

export async function executeReportBuilderSpec(
  spec: ValidatedReportBuilderSpec,
  ctx: ExecutorContext,
): Promise<ExecutorResult> {
  const ck = cacheKey(ctx.distributorId, ctx.userId, spec);
  const cached = CACHE.get(ck);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const allow = getAllowlist(spec.model, ctx.role);
  if (!allow) {
    const err = new Error('Report Builder is not available for your role');
    (err as Error & { statusCode: number }).statusCode = 403;
    throw err;
  }
  validateFieldsAgainstAllowlist(spec, allow);

  const start = Date.now();
  const limit = Math.min(spec.limit ?? MAX_ROWS, MAX_ROWS);
  const runner = runnerFor(spec.model);

  // Base where — ALWAYS starts with tenant scope. Never trust spec.
  let baseWhere: Record<string, unknown> = { distributorId: ctx.distributorId };
  for (const filter of spec.filters) {
    baseWhere = deepMerge(baseWhere, filterToWhere(filter));
  }
  if (['Order', 'Invoice', 'Expense', 'PurchaseEntry'].includes(spec.model)) {
    baseWhere.deletedAt = null;
  }

  const unindexedFilterFields = spec.filters
    .map((f) => f.field)
    .filter((f) => !allow.indexedFields.has(f) && !allow.indexedFields.has(f.split('.')[0]));

  let rows: Record<string, string | number | null>[];
  let columns: Array<{ key: string; label: string; money?: boolean }>;
  let capped = false;

  const isGrouped = spec.groupBy.length > 0 && spec.aggregates.length > 0;

  if (isGrouped) {
    const nonNestedGroupBy = spec.groupBy.filter((g) => !g.includes('.'));
    if (nonNestedGroupBy.length !== spec.groupBy.length) {
      const err = new Error('Cannot group by nested fields — use the FK (e.g. customerId) instead');
      (err as Error & { statusCode: number }).statusCode = 400;
      throw err;
    }
    const args: Record<string, unknown> = {
      by: nonNestedGroupBy,
      where: baseWhere,
      take: limit,
      // Prisma requires orderBy on groupBy — the orderBy fields must
      // ALL be in `by[]`. If we don't supply one, Prisma injects an
      // implicit orderBy on `id` which then fails because id isn't
      // in by[]. Explicit orderBy on the first groupBy field is safe.
      orderBy: nonNestedGroupBy.map((f) => ({ [f]: 'asc' })),
    };
    for (const agg of spec.aggregates) {
      if (agg.op === 'sum' || agg.op === 'avg' || agg.op === 'min' || agg.op === 'max') {
        const key = `_${agg.op}` as const;
        args[key] = (args[key] as Record<string, boolean>) ?? {};
        if (agg.field !== 'rows') {
          (args[key] as Record<string, boolean>)[agg.field.split('.').pop()!] = true;
        }
      } else if (agg.op === 'count' || agg.op === 'count_distinct') {
        args._count = true;
      }
    }
    const grouped = await withTimeout(runner.groupBy(args));
    if (grouped.length >= limit) capped = true;
    rows = grouped.map((g) => {
      const out: Record<string, string | number | null> = {};
      for (const key of nonNestedGroupBy) {
        out[key] = toCellValue((g as Record<string, unknown>)[key]);
      }
      for (const agg of spec.aggregates) {
        const alias = agg.as ?? `${agg.op}_${agg.field}`;
        if (agg.op === 'sum' || agg.op === 'avg' || agg.op === 'min' || agg.op === 'max') {
          const bucket = (g as Record<string, Record<string, unknown>>)[`_${agg.op}`];
          out[alias] = agg.field === 'rows' ? 0 : toCellValue(bucket?.[agg.field.split('.').pop()!]);
        } else if (agg.op === 'count' || agg.op === 'count_distinct') {
          const count = (g as Record<string, unknown>)._count;
          out[alias] = typeof count === 'number' ? count : 0;
        } else if (agg.op === 'running_total') {
          out[alias] = 0;
        }
      }
      return out;
    });
    // Post-loop running_total (scans the sorted result).
    for (const agg of spec.aggregates.filter((a) => a.op === 'running_total')) {
      const alias = agg.as ?? `running_${agg.field}`;
      const sourceKey = agg.field.split('.').pop()!;
      let cum = 0;
      for (const r of rows) {
        const v = Number(r[sourceKey] ?? 0);
        cum += Number.isFinite(v) ? v : 0;
        r[alias] = cum;
      }
    }
    columns = [
      ...nonNestedGroupBy.map((k) => ({ key: k, label: k })),
      ...spec.aggregates.map((a) => ({
        key: a.as ?? `${a.op}_${a.field}`,
        label: a.as ?? `${a.op}(${a.field})`,
        money: ['sum', 'avg'].includes(a.op),
      })),
    ];
  } else {
    // RAW path
    const select = fieldsToSelect(spec.fields);
    const orderBy = spec.orderBy
      .filter((o) => !o.field.includes('.'))
      .map((o) => ({ [o.field]: o.dir }));
    const raw = await withTimeout(runner.findMany({
      where: baseWhere,
      select,
      orderBy: orderBy.length > 0 ? orderBy : undefined,
      take: limit,
    }));
    if (raw.length >= limit) capped = true;
    rows = raw.map((r) => {
      const out: Record<string, string | number | null> = {};
      for (const field of spec.fields) {
        out[field] = toCellValue(getPath(r, field));
      }
      return out;
    });
    columns = spec.fields.map((f) => ({
      key: f,
      label: f.split('.').pop() ?? f,
      money: /amount|total|value|price|cost|revenue/i.test(f.split('.').pop() ?? ''),
    }));
  }

  const durationMs = Date.now() - start;
  const result: ExecutorResult = {
    columns,
    rows,
    meta: {
      rowCount: rows.length,
      durationMs,
      capped,
      ...(unindexedFilterFields.length > 0 && {
        unindexedWarning: `Filter${unindexedFilterFields.length > 1 ? 's' : ''} not indexed: ${unindexedFilterFields.join(', ')}. Add a date filter to speed things up.`,
      }),
    },
  };

  CACHE.set(ck, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const k of Object.keys(b)) {
    const av = out[k];
    const bv = b[k];
    if (av && bv && typeof av === 'object' && typeof bv === 'object'
        && !Array.isArray(av) && !Array.isArray(bv) && !(av instanceof Date) && !(bv instanceof Date)) {
      out[k] = deepMerge(av as Record<string, unknown>, bv as Record<string, unknown>);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => {
        const e = new Error(`Report Builder query timed out after ${STATEMENT_TIMEOUT_MS}ms — narrow your filters and try again`);
        (e as Error & { statusCode: number }).statusCode = 408;
        reject(e);
      }, STATEMENT_TIMEOUT_MS)),
    ]);
  } catch (err) {
    // 2026-08-06: translate Prisma runtime errors (bad enum value, malformed
    // Decimal, wrong scalar type for a nullable column, etc.) into 400s so
    // the client gets a helpful message instead of a bare 500. The zod layer
    // now rejects the most common trigger (empty-string on eq/neq/in/etc.)
    // — this is defense in depth for any surviving edge case.
    if (err instanceof Prisma.PrismaClientValidationError) {
      const trimmed = err.message.split('\n').filter((l) => l.trim().startsWith('Argument')).slice(0, 3).join(' · ')
        || 'One of the filter values does not match the column type';
      const e = new Error(`Invalid filter value: ${trimmed}`);
      (e as Error & { statusCode: number }).statusCode = 400;
      throw e;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const e = new Error(`Query rejected by database: ${err.code} ${err.message.split('\n')[0]}`);
      (e as Error & { statusCode: number }).statusCode = 400;
      throw e;
    }
    throw err;
  }
}

function validateFieldsAgainstAllowlist(
  spec: ValidatedReportBuilderSpec,
  allow: ModelRoleAllowlist,
): void {
  const err = (msg: string): never => {
    const e = new Error(msg);
    (e as Error & { statusCode: number }).statusCode = 400;
    throw e;
  };
  for (const f of spec.fields) {
    if (!allow.fields.includes(f)) err(`Field not allowed for your role: ${f}`);
  }
  for (const filter of spec.filters) {
    if (!allow.filterableFields.has(filter.field)) {
      err(`Filter field not allowed for your role: ${filter.field}`);
    }
  }
  for (const g of spec.groupBy) {
    if (!allow.groupableFields.has(g)) {
      err(`GroupBy field not allowed for your role: ${g}`);
    }
  }
  for (const agg of spec.aggregates) {
    if (agg.field === 'rows' && agg.op === 'count') continue;
    if (!allow.aggregatableFields.has(agg.field)) {
      err(`Aggregate field not allowed for your role: ${agg.field}`);
    }
  }
}

export const __testable = {
  resolvePreset,
  fieldsToSelect,
  filterToWhere,
  pathToNestedObject,
  deepMerge,
  getPath,
  toCellValue,
  MAX_ROWS,
  CACHE,
};
