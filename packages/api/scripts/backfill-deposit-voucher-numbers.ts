/**
 * Change L v2 (2026-07-31) — one-shot backfill of voucher_number on
 * pre-existing deposit_charged / deposit_refunded ledger rows.
 *
 * Walks per distributor (docCode required), grouped by financial year of
 * entryDate (matches numberingService.getFinancialYear), assigns
 * sequential V<CODE><FY><SEQ> in entryDate ASC order, and updates the
 * counter row so subsequent live events pick up from N+1.
 *
 * Idempotent: rows already carrying voucherNumber are skipped.
 * Safe to re-run.
 *
 * Usage: `pnpm --filter @gaslink/api exec tsx scripts/backfill-deposit-voucher-numbers.ts`
 */
import { prisma } from '../src/lib/prisma.js';
import { allocateNumber, getFinancialYear } from '../src/services/numberingService.js';

async function main() {
  const distributors = await prisma.distributor.findMany({
    where: { docCode: { not: null } },
    select: { id: true, docCode: true, businessName: true },
  });
  console.log(`Found ${distributors.length} distributor(s) with docCode set`);

  let totalAssigned = 0;
  for (const dist of distributors) {
    if (!dist.docCode) continue;
    const rows = await prisma.customerLedgerEntry.findMany({
      where: {
        distributorId: dist.id,
        entryType: { in: ['deposit_charged', 'deposit_refunded'] },
        voucherNumber: null,
      },
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, entryDate: true, entryType: true },
    });
    if (rows.length === 0) {
      console.log(`  [${dist.docCode}] ${dist.businessName}: nothing to backfill`);
      continue;
    }
    console.log(`  [${dist.docCode}] ${dist.businessName}: ${rows.length} row(s) to number`);

    for (const row of rows) {
      await prisma.$transaction(async (tx) => {
        const num = await allocateNumber(tx, dist.id, 'V', row.entryDate, dist.docCode!);
        await tx.customerLedgerEntry.update({
          where: { id: row.id },
          data: { voucherNumber: num },
        });
        console.log(`    ${row.entryType.padEnd(18)} ${row.entryDate.toISOString().slice(0, 10)} FY${getFinancialYear(row.entryDate)} -> ${num}`);
      });
      totalAssigned += 1;
    }
  }
  console.log(`Done. Assigned ${totalAssigned} voucher number(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
