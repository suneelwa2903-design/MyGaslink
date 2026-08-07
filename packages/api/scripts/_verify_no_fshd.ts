import { prisma } from '../src/lib/prisma.js';
import { getSupplierLedger } from '../src/services/purchasePaymentService.js';

async function main() {
  const hpcl = await prisma.sourceDistributor.findFirstOrThrow({
    where: { distributorId: 'dist-002', name: 'HPCL', deletedAt: null },
    select: { id: true },
  });
  const ledger = await getSupplierLedger('dist-002', hpcl.id, { from: '2026-08-01', to: '2026-12-31' });
  console.log('Doc No column values for Sharma → HPCL ledger:');
  for (const r of ledger.rows) {
    console.log(`  [${r.kind.padEnd(15)}] date=${r.entryDate}  docNo=${r.documentNumber ?? '(null → shows as —)'}  narration="${r.narration}"`);
  }
  const fshdLeaks = ledger.rows.filter((r) => r.documentNumber?.startsWith('FSHD'));
  console.log(`\nFSHD leaks: ${fshdLeaks.length} (target: 0)`);
}
main().finally(() => prisma.$disconnect());
