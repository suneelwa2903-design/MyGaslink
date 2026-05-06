import { Prisma } from '@prisma/client';

/**
 * Convert a Prisma Decimal (or number / string) to a plain JS number for
 * use in arithmetic and JSON serialization at the API boundary.
 *
 * Storage is `NUMERIC(18, 4)` for all 35 monetary fields (migration
 * 20260506010000_monetary_fields_float_to_decimal). At-rest precision and
 * SQL aggregates are exact. Service-layer arithmetic still uses `number`
 * for simplicity — values are rounded to 4 decimals when written back.
 */
export function toNum(d: unknown): number {
  if (d == null) return 0;
  if (typeof d === 'number') return d;
  if (typeof d === 'string') return Number(d);
  if (typeof d === 'object' && d !== null) {
    // Prisma.Decimal instance OR a plain DecimalJsLike object {d, e, s}
    const dec = d as { toNumber?: () => number; toString: () => string };
    if (typeof dec.toNumber === 'function') return dec.toNumber();
    return Number(dec.toString());
  }
  return Number(d);
}

/**
 * Recursively convert every Prisma Decimal in an object/array tree to a
 * plain number. Useful for mappers that need to JSON-serialize a Prisma
 * row that contains Decimal columns.
 *
 * Pass-through for Date and other non-plain objects — only walks into
 * arrays and objects whose constructor is Object (or null prototypes).
 */
export function decimalsToNumbers<T>(value: T): T {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map(decimalsToNumbers) as unknown as T;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toNumber() as unknown as T;
  }
  if (typeof value !== 'object') return value;
  // Skip Date and any other class instance — only walk plain {…} objects.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = decimalsToNumbers(v);
  }
  return out as T;
}
