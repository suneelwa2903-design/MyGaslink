import { prisma } from '../src/lib/prisma.js';
async function main() {
  const rows = await prisma.distributor.findMany({
    where: { id: { in: ['dist-001','dist-002'] } },
    select: {
      id: true, businessName: true, providerCodes: true,
      sourceDistributors: { where: { deletedAt: null }, select: { name: true } }
    }
  });
  console.log(JSON.stringify(rows, null, 2));

  // Also check any existing incoming_fulls events that are pre-F8 (no PurchaseEntry)
  const preF8Events = await prisma.inventoryEvent.count({
    where: { distributorId: 'dist-001', eventType: 'incoming_fulls' }
  });
  const purchaseEntries = await prisma.purchaseEntry.count({ where: { distributorId: 'dist-001' } });
  console.log(`\ndist-001: ${preF8Events} incoming_fulls InventoryEvents, ${purchaseEntries} PurchaseEntry rows`);
}
main().finally(() => prisma.$disconnect());
