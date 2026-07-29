import { prisma } from '../src/lib/prisma.js';

async function main() {
  const users = await prisma.user.findMany({
    where: { distributorId: 'dist-miniop-cp3' },
    select: { email: true, role: true, status: true }
  });
  console.log('Users for dist-miniop-cp3:', JSON.stringify(users, null, 2));
  const dists = await prisma.distributor.findMany({
    where: { accountType: 'mini_operator' },
    select: { id: true, businessName: true }
  });
  console.log('Mini-op tenants:', JSON.stringify(dists, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
