import { prisma } from '../src/lib/prisma.js';

async function main() {
  const rows = await prisma.distributor.findMany({
    where: { deletedAt: null },
    select: { id: true, businessName: true, accountType: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log('All distributors:');
  for (const r of rows) {
    console.log(`  ${r.accountType.padEnd(15)} ${r.businessName.padEnd(50)} ${r.id}`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
