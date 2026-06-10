// Task 3 — Option A cleanup.
// Soft-delete the 229 garbage Driver rows on dist-001 (name='X', phone='9999999999')
// surfaced by inspect-driver-user-population.ts. They are clearly fixtures from a
// runaway prior script — all share the same phone+name. Soft-delete is reversible
// (set deleted_at IS NULL again) and respects any downstream FK references.
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  const matches = await prisma.driver.count({
    where: {
      distributorId: 'dist-001',
      phone: '9999999999',
      driverName: 'X',
      deletedAt: null,
    },
  });
  console.log(`Found ${matches} garbage Driver rows to soft-delete.`);
  if (matches === 0) {
    console.log('Nothing to do.');
    await prisma.$disconnect();
    return;
  }
  const result = await prisma.driver.updateMany({
    where: {
      distributorId: 'dist-001',
      phone: '9999999999',
      driverName: 'X',
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });
  console.log(`Soft-deleted ${result.count} rows.`);
  await prisma.$disconnect();
})();
