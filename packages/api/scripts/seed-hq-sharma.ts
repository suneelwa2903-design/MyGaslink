/**
 * Seeds a Sharma HQ CustomerGroup with 3 members + provisions an
 * HQ portal login (hq-sharma@mygaslink.com / HqTest@123).
 *
 * Idempotent: reuses existing group / login if present.
 * Run: cd packages/api && npx tsx <path-to-this-file>
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const dist = await prisma.distributor.findFirst({
    where: { legalName: { contains: 'Sharma', mode: 'insensitive' } },
    select: { id: true, businessName: true },
  });
  if (!dist) throw new Error('Sharma distributor not found');
  console.log('Distributor:', dist.businessName, dist.id);

  const customers = await prisma.customer.findMany({
    where: { distributorId: dist.id, deletedAt: null, customerType: 'B2B' },
    select: { id: true, customerName: true, businessName: true },
    take: 3,
    orderBy: { createdAt: 'asc' },
  });
  if (customers.length < 2) {
    console.log('Available B2B customers:', customers.length);
    throw new Error('Need at least 2 B2B customers on Sharma');
  }
  console.log('Members:', customers.map(c => c.customerName).join(', '));

  const groupName = 'Sharma HQ Test Group';
  let group = await prisma.customerGroup.findFirst({
    where: { distributorId: dist.id, name: groupName, deletedAt: null },
  });
  if (!group) {
    group = await prisma.customerGroup.create({
      data: { distributorId: dist.id, name: groupName },
    });
    console.log('Created group:', group.id);
  } else {
    console.log('Reusing group:', group.id);
  }

  for (const c of customers) {
    await prisma.customerGroupMember.upsert({
      where: { groupId_customerId: { groupId: group.id, customerId: c.id } },
      create: { groupId: group.id, customerId: c.id },
      update: {},
    });
  }
  console.log(`Members synced: ${customers.length}`);

  const email = 'hq-sharma@mygaslink.com';
  const passwordHash = await bcrypt.hash('HqTest@123', 10);
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      firstName: 'Sharma',
      lastName: 'HQ',
      role: 'customer_hq',
      status: 'active',
      distributorId: dist.id,
      groupId: group.id,
      requiresPasswordReset: false,
    },
    update: {
      passwordHash,
      role: 'customer_hq',
      status: 'active',
      distributorId: dist.id,
      groupId: group.id,
      requiresPasswordReset: false,
      deletedAt: null,
    },
  });
  console.log(`\nHQ login ready:`);
  console.log(`  email:    ${email}`);
  console.log(`  password: HqTest@123`);
  console.log(`  userId:   ${user.id}`);
  console.log(`  groupId:  ${group.id}`);
}

main().finally(() => prisma.$disconnect());
