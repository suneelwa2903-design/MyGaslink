/**
 * Date helpers for `@db.Date` (calendar-date) Prisma columns.
 *
 * Background — the timezone trap that motivated this file:
 *   `assignment_date`, `delivery_date`, `order_date`, etc. are Postgres
 *   `DATE` columns (`@db.Date`). Prisma reads them back as UTC-midnight
 *   `Date` objects (e.g. 2026-05-21 → 2026-05-21T00:00:00.000Z) and, when
 *   you query them, truncates any `Date` bound you pass to its UTC calendar
 *   date.
 *
 *   The old idiom `const d = new Date(); d.setHours(0,0,0,0)` produces
 *   LOCAL midnight. On a server in a positive-offset zone (this app runs in
 *   IST, UTC+5:30) local midnight is the PREVIOUS day at 18:30 UTC, so
 *   Prisma truncates it to YESTERDAY's calendar date — every "today" query
 *   on a `@db.Date` column silently returned the wrong day. The web frontend
 *   (and getRecommendedMappings) instead use `new Date('YYYY-MM-DD')` =
 *   UTC midnight, so the two disagreed and the Drivers tab showed a stale
 *   mapping while the Vehicle Mapping tab showed the correct one.
 *
 *   Fix: always derive `@db.Date` query bounds from the UTC calendar date,
 *   matching how the column is stored and how the rest of the app queries it.
 *   Use these helpers instead of `setHours` for any `@db.Date` comparison.
 */

/** UTC-midnight Date for the given instant's UTC calendar date (default: now). */
export function startOfUtcDay(at: Date = new Date()): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Half-open [gte, lt) range covering one UTC calendar day. Use for range
 * queries against `@db.Date` columns (e.g. assignmentDate, deliveryDate).
 */
export function utcDayRange(at: Date = new Date()): { gte: Date; lt: Date } {
  const gte = startOfUtcDay(at);
  const lt = new Date(gte);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte, lt };
}
