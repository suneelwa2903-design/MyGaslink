import { prisma } from '../src/lib/prisma.js';
async function main() {
  const rows = await prisma.defectiveCylinderLedger.findMany({
    where: { distributorId: 'dist-002' },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { collectedDate: 'desc' },
    take: 20,
  });
  console.log('Sharma defective ledger:');
  for (const r of rows) {
    console.log(`  ${r.collectedDate}  ${r.cylinderType?.typeName ?? '?'}  qty=${r.quantity}  status=${r.status}`);
  }
  const batches = await prisma.defectiveReturnBatch.findMany({
    where: { distributorId: 'dist-002' },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\nSharma defective batches: ${batches.length}`);
  for (const b of batches) {
    console.log(`  ${b.batchNumber} on ${b.createdAt.toISOString().slice(0,10)} status=${b.status} qty=${b.totalQuantity}`);
  }
}
main().finally(() => prisma.$disconnect());
