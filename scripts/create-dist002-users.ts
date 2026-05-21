/**
 * create-dist002-users.ts
 *
 * One-time script to add sub-role users for dist-002 (Sharma Gas Distributors).
 * Run: npx tsx scripts/create-dist002-users.ts
 *
 * Users created (idempotent — upserts on email):
 *   finance2@gasdist.com    Finance@123   finance   dist-002
 *   inventory2@gasdist.com  Inventory@123 inventory dist-002
 *   driver2@gasdist.com     Driver@123    driver    dist-002  → Kiran Reddy
 *   customer2@gasdist.com   Customer@123  customer  dist-002  → Bangalore Foods
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DIST_ID = 'dist-002';

// IDs resolved from live DB (seeded by seed.ts)
const KIRAN_REDDY_ID = '23f33fbf-645d-44a4-bf91-4258f80df668';
const BANGALORE_FOODS_ID = '7f3231f7-adf1-4dab-9cdf-6a7065bb62d1';

async function main() {
  console.log('Creating dist-002 sub-role users...\n');

  // Verify the distributor and linked records actually exist
  const dist = await prisma.distributor.findUnique({ where: { id: DIST_ID } });
  if (!dist) throw new Error(`Distributor ${DIST_ID} not found — run seed first`);

  const driver = await prisma.driver.findUnique({ where: { id: KIRAN_REDDY_ID } });
  if (!driver) throw new Error(`Driver ${KIRAN_REDDY_ID} (Kiran Reddy) not found — run seed first`);

  const customer = await prisma.customer.findUnique({ where: { id: BANGALORE_FOODS_ID } });
  if (!customer) throw new Error(`Customer ${BANGALORE_FOODS_ID} (Bangalore Foods) not found — run seed first`);

  console.log(`Distributor : ${dist.businessName}`);
  console.log(`Driver link : ${driver.driverName} (${KIRAN_REDDY_ID})`);
  console.log(`Customer link: ${customer.customerName} (${BANGALORE_FOODS_ID})\n`);

  // ── Finance ────────────────────────────────────────────────────────────────
  const financeHash = await bcrypt.hash('Finance@123', 12);
  const financeUser = await prisma.user.upsert({
    where: { email: 'finance2@gasdist.com' },
    update: {},
    create: {
      email: 'finance2@gasdist.com',
      passwordHash: financeHash,
      firstName: 'Divya',
      lastName: 'Sharma',
      phone: '9876500011',
      role: 'finance',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: DIST_ID,
      requiresPasswordReset: false,
    },
  });
  console.log(`✅ Finance   : ${financeUser.email} (${financeUser.id})`);

  // ── Inventory ──────────────────────────────────────────────────────────────
  const inventoryHash = await bcrypt.hash('Inventory@123', 12);
  const inventoryUser = await prisma.user.upsert({
    where: { email: 'inventory2@gasdist.com' },
    update: {},
    create: {
      email: 'inventory2@gasdist.com',
      passwordHash: inventoryHash,
      firstName: 'Suresh',
      lastName: 'Reddy',
      phone: '9876500012',
      role: 'inventory',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: DIST_ID,
      requiresPasswordReset: false,
    },
  });
  console.log(`✅ Inventory : ${inventoryUser.email} (${inventoryUser.id})`);

  // ── Driver ─────────────────────────────────────────────────────────────────
  const driverHash = await bcrypt.hash('Driver@123', 12);
  const driverUser = await prisma.user.upsert({
    where: { email: 'driver2@gasdist.com' },
    update: {},
    create: {
      email: 'driver2@gasdist.com',
      passwordHash: driverHash,
      firstName: 'Kiran',
      lastName: 'Reddy',
      phone: '9876500010',
      role: 'driver',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: DIST_ID,
      requiresPasswordReset: false,
    },
  });
  console.log(`✅ Driver    : ${driverUser.email} → Kiran Reddy driver record`);

  // ── Customer ───────────────────────────────────────────────────────────────
  const customerHash = await bcrypt.hash('Customer@123', 12);
  const customerUser = await prisma.user.upsert({
    where: { email: 'customer2@gasdist.com' },
    update: {},
    create: {
      email: 'customer2@gasdist.com',
      passwordHash: customerHash,
      firstName: 'Bangalore',
      lastName: 'Foods',
      phone: '9876500001',
      role: 'customer',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: DIST_ID,
      customerId: BANGALORE_FOODS_ID,
      requiresPasswordReset: false,
    },
  });
  console.log(`✅ Customer  : ${customerUser.email} → Bangalore Foods customer record\n`);

  console.log('All dist-002 sub-role users created (idempotent — existing rows unchanged).');
  console.log('\nCredentials:');
  console.log('  finance2@gasdist.com    / Finance@123    (finance)');
  console.log('  inventory2@gasdist.com  / Inventory@123  (inventory)');
  console.log('  driver2@gasdist.com     / Driver@123     (driver)');
  console.log('  customer2@gasdist.com   / Customer@123   (customer)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
