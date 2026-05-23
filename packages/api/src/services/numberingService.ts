/**
 * WI-108 — Structured invoice/order numbering.
 *
 * Format: <TYPE 1><CODE 3><FY 4><SEQ 6> = 14 chars, e.g. ISHD2526000123.
 *   TYPE: I=invoice R=revision C=credit-note D=debit-note O=order
 *   CODE: the distributor's 3-letter docCode (uppercase)
 *   FY  : Indian financial year, 4 digits (Apr–Mar), e.g. 2025-26 → "2526"
 *   SEQ : per-(distributor, type, FY) sequence, zero-padded to 6
 *
 * Activation is implicit: callers only invoke allocateNumber when the
 * distributor has a docCode set. With no docCode the legacy random format is
 * kept (the docCode presence IS the toggle — no feature flag).
 *
 * The sequence is allocated with an atomic upsert-increment on a single
 * counter row, and MUST be called inside the same transaction as the
 * invoice/order create so a rollback frees the number (gapless).
 */
import type { Prisma } from '@prisma/client';

export type DocNumberType = 'I' | 'R' | 'C' | 'D' | 'O';
const VALID_TYPES: ReadonlySet<string> = new Set(['I', 'R', 'C', 'D', 'O']);

/**
 * Indian financial year (April start) as a 4-char string.
 *   2026-05-23 → "2526"   (FY 2025-26)
 *   2026-03-31 → "2526"   (still FY 2025-26)
 *   2026-04-01 → "2627"   (FY 2026-27)
 *   2027-01-15 → "2627"
 */
export function getFinancialYear(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1–12
  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}${String(endYear).slice(-2)}`;
}

/**
 * Allocate the next structured document number for a distributor.
 *
 * MUST run inside the same Prisma transaction as the row it numbers, so the
 * counter increment rolls back with the create on failure.
 */
export async function allocateNumber(
  tx: Prisma.TransactionClient,
  distributorId: string,
  type: DocNumberType,
  date: Date,
  docCode: string,
): Promise<string> {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid document type '${type}' — expected one of I/R/C/D/O`);
  }
  const code = (docCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`Invalid docCode '${docCode}': must be exactly 3 uppercase letters (A–Z)`);
  }

  const financialYear = getFinancialYear(date);

  // Atomic: { increment: 1 } compiles to UPDATE ... SET last_sequence =
  // last_sequence + 1 RETURNING, serialising concurrent allocations on the
  // unique (distributorId, type, financialYear) row.
  const counter = await tx.invoiceCounter.upsert({
    where: { distributorId_type_financialYear: { distributorId, type, financialYear } },
    create: { distributorId, type, financialYear, lastSequence: 1 },
    update: { lastSequence: { increment: 1 } },
    select: { lastSequence: true },
  });

  const sequence = String(counter.lastSequence).padStart(6, '0');
  const number = `${type}${code}${financialYear}${sequence}`;

  // Loud failure (NIC DocDtls.No is capped at 16 chars and must not start
  // with 0/-/'/'). The 14-char format never trips this, but a future change
  // to widths must fail here rather than silently corrupt a doc number.
  if (number.length > 16) {
    throw new Error(`Generated number '${number}' exceeds the NIC 16-char limit — configuration error`);
  }
  if (!/^[A-Z]/.test(number)) {
    throw new Error(`Generated number '${number}' must start with a letter — configuration error`);
  }
  return number;
}
