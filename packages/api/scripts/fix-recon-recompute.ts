// One-off: recompute dist-002 inventory summaries after removing the 5 duplicate
// reconciliation events (2026-08-12). Safe/idempotent — rebuilds summaries from events.
import { prisma } from '../src/lib/prisma.js';
import { recalculateSummariesFromDate } from '../src/services/inventoryService.js';

const DIST = 'dist-002';
const FROM = new Date('2026-01-01T00:00:00.000Z');

async function main() {
  const types = await prisma.inventoryEvent.findMany({
    where: { distributorId: DIST },
    select: { cylinderTypeId: true },
    distinct: ['cylinderTypeId'],
  });
  console.log(`Recomputing ${types.length} cylinder types for ${DIST} from ${FROM.toISOString().slice(0, 10)}...`);
  for (const t of types) {
    await recalculateSummariesFromDate(DIST, t.cylinderTypeId, FROM);
    console.log(`  ✓ ${t.cylinderTypeId}`);
  }
  console.log('Done.');
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
