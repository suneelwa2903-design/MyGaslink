/**
 * Mini-Operator (2026-07-16) — one-shot dev seed for the CP3 browser
 * verification.
 *
 * Creates a persistent mini_operator distributor + one mini_operator_admin
 * login + one active cylinder type. Idempotent — re-running the script
 * upserts the same rows.
 *
 * Run with: pnpm --filter @gaslink/api exec tsx scripts/seed-mini-op-for-browser-check.ts
 *
 * Login credentials for the browser check:
 *   email:    miniop@quickgas.com
 *   password: MiniOp@1234
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';

const DIST_ID = 'dist-miniop-cp3';
const EMAIL = 'miniop@quickgas.com';
const PASSWORD = 'MiniOp@1234';

async function main() {
  const distributor = await prisma.distributor.upsert({
    where: { id: DIST_ID },
    create: {
      id: DIST_ID,
      businessName: 'Quick Gas Supply',
      legalName: 'Quick Gas Supply Pvt Ltd',
      docCode: 'QGS',
      accountType: 'mini_operator',
      gstMode: 'disabled',
      state: 'Telangana',
      phone: '+919000000000',
      email: 'contact@quickgas.com',
    },
    update: {
      accountType: 'mini_operator',
      gstMode: 'disabled',
      docCode: 'QGS',
      businessName: 'Quick Gas Supply',
      legalName: 'Quick Gas Supply Pvt Ltd',
    },
    select: { id: true, businessName: true, docCode: true, accountType: true },
  });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    create: {
      email: EMAIL,
      passwordHash,
      firstName: 'Mini',
      lastName: 'Operator',
      role: 'mini_operator_admin',
      status: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
    update: {
      passwordHash,
      role: 'mini_operator_admin',
      status: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
    select: { id: true, email: true, role: true, distributorId: true },
  });

  const cylinderType = await prisma.cylinderType.upsert({
    where: { distributorId_typeName: { distributorId: distributor.id, typeName: '19KG Commercial' } },
    create: {
      distributorId: distributor.id,
      typeName: '19KG Commercial',
      capacity: 19,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
    },
    update: { isActive: true },
    select: { id: true, typeName: true },
  });

  // Customer has no customerCode field — key idempotency on a fixed UUID.
  const CUSTOMER_ID = 'cust-miniop-cp3-001';
  const customer = await prisma.customer.upsert({
    where: { id: CUSTOMER_ID },
    create: {
      id: CUSTOMER_ID,
      distributorId: distributor.id,
      customerName: 'Hotel Raj Palace',
      customerType: 'B2C',
      phone: '+919000000001',
      status: 'active',
      creditPeriodDays: 30,
      billingState: 'Telangana',
    },
    update: { customerName: 'Hotel Raj Palace', status: 'active' },
    select: { id: true, customerName: true },
  });

  // eslint-disable-next-line no-console
  console.log('\n✅ Mini-Op CP3 seed complete\n');
  // eslint-disable-next-line no-console
  console.log('Distributor:', distributor);
  // eslint-disable-next-line no-console
  console.log('User:       ', user);
  // eslint-disable-next-line no-console
  console.log('CylinderType:', cylinderType);
  // eslint-disable-next-line no-console
  console.log('Customer:   ', customer);
  // eslint-disable-next-line no-console
  console.log(`\nLogin at http://localhost:5173/login with:\n  email:    ${EMAIL}\n  password: ${PASSWORD}\n`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
