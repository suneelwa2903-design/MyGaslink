/**
 * Demo distributor seed — dist-demo (Demo Gas Agency).
 *
 * The Google Play review needs a clean, self-contained tenant the reviewer
 * can log into without bumping into live data. dist-demo is that tenant.
 *
 * Design rule: mirror dist-002 (Sharma Gas Distributors) exactly on every
 * compliance/GST field — same sandbox GSTIN, same WhiteBooks env vars,
 * same HSN code, same cylinder catalog, same per-customer GSTINs. Only
 * the demo identifiers (id, businessName, docCode, user emails, customer/
 * driver/vehicle display names) differ.
 *
 * INVENTORY_DISPATCH_DEBIT is process-level, not per-distributor, so the
 * demo inherits whatever the EC2 has set (currently 'true').
 *
 * Idempotency: every upsert keys on a unique constraint (id, email,
 * (distributorId, scope), (distributorId, vehicleNumber), orderNumber,
 * invoiceNumber, …). A bulk `if (anyDemoOrderExists) skip transactional
 * block` gate prevents the 11-order + payment block from duplicating
 * on re-run, matching the dist-001 / dist-002 patterns in seed.ts.
 *
 * Run:
 *   pnpm --filter @gaslink/api seed:demo
 *
 * Cleanup (if ever needed — destructive, do NOT run in prod):
 *   await prisma.distributor.delete({ where: { id: 'dist-demo' } });
 *   (Cascade is not configured at the schema level for most relations —
 *   you'd need to drop in the inverse dependency order. Out of scope for
 *   this script.)
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Env helpers — same pattern as seed.ts ────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function daysAgoUtc(n: number): Date {
  const d = startOfTodayUtc();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// ─── Stable IDs — keep upserts deterministic across runs ──────────────────────
const DEMO = {
  distributorId: 'dist-demo',
  customerB2cId: 'demo-customer-foods',
  customerB2bInterId: 'demo-customer-caterers',
  customerB2bIntraId: 'demo-customer-agencies',
  driverId: 'demo-driver-1',
  vehicleId: 'demo-vehicle-1',
  adminUserEmail: 'demo@gasdist.com',
  financeUserEmail: 'demo.finance@gasdist.com',
  inventoryUserEmail: 'demo.inventory@gasdist.com',
  driverUserEmail: 'demo.driver@gasdist.com',
  customerUserEmail: 'demo.customer@gasdist.com',
} as const;

async function main(): Promise<void> {
  console.log('━━━ Demo Distributor Seed (dist-demo) ━━━');

  // ── STEP 1 — Distributor ───────────────────────────────────────────────────
  // Mirror dist-002 on GST/compliance fields. Distinct id, businessName,
  // docCode (DMO — globally @unique). The "DEMO - DO NOT DELETE" marker
  // goes in address since the Distributor model has no notes field.
  const distributor = await prisma.distributor.upsert({
    where: { id: DEMO.distributorId },
    update: { docCode: 'DMO' },
    create: {
      id: DEMO.distributorId,
      businessName: 'Demo Gas Agency',
      legalName: 'Demo Gas Agency Pvt Ltd',
      gstin: '29AAGCB1286Q000', // SAME as dist-002 — sandbox-only, won't collide with NIC live
      address: '1 Demo Street, Bangalore (DEMO - DO NOT DELETE)',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      phone: '9999000000',
      email: DEMO.adminUserEmail,
      status: 'active',
      gstMode: 'sandbox', // SAME as dist-002 — routes to WhiteBooks sandbox
      docCode: 'DMO',
      providerCodes: ['HPCL'],
      subscriptionPlan: 'business',
      billingTier: 'tier_2',
      gaslinkBillingEnabled: false,
    },
  });
  console.log(`✓ Distributor: ${distributor.businessName} (${distributor.id})`);

  // ── STEP 2 — Cylinder types + prices + thresholds ──────────────────────────
  // Identical to dist-002. HPCL provider catalog linkage is best-effort —
  // if the platform-level catalog rows don't exist yet (fresh DB), we leave
  // providerCatalogId null and the demo still works.
  const hpclCatalog = await prisma.providerCatalogCylinderType.findMany({
    where: { providerCode: 'HPCL' },
  });
  const hpclByCapacity = new Map(hpclCatalog.map((c) => [c.capacity, c]));

  const cylinderSpecs = [
    { typeName: '5 KG', capacity: 5, price: 600, warning: 10, critical: 3 },
    { typeName: '19 KG', capacity: 19, price: 2000, warning: 15, critical: 3 },
    { typeName: '47.5 KG', capacity: 47.5, price: 5000, warning: 10, critical: 2 },
    { typeName: '425 KG', capacity: 425, price: 42000, warning: 5, critical: 1 },
  ];

  const cylinderTypes = await Promise.all(
    cylinderSpecs.map((spec) =>
      prisma.cylinderType.upsert({
        where: {
          distributorId_typeName: {
            distributorId: distributor.id,
            typeName: spec.typeName,
          },
        },
        update: {
          providerCatalogId: hpclByCapacity.get(spec.capacity)?.id ?? null,
        },
        create: {
          distributorId: distributor.id,
          typeName: spec.typeName,
          capacity: spec.capacity,
          unit: 'KG',
          hsnCode: '27111900', // SAME as dist-002
          providerCatalogId: hpclByCapacity.get(spec.capacity)?.id ?? null,
        },
      }),
    ),
  );
  console.log(`✓ Cylinder types: ${cylinderTypes.length}`);

  for (let i = 0; i < cylinderTypes.length; i++) {
    const ct = cylinderTypes[i];
    const spec = cylinderSpecs[i];

    // Prices — no unique constraint, so guard with findFirst+create rather
    // than blindly inserting on every re-run.
    const existingPrice = await prisma.cylinderPrice.findFirst({
      where: { distributorId: distributor.id, cylinderTypeId: ct.id },
    });
    if (!existingPrice) {
      await prisma.cylinderPrice.create({
        data: {
          distributorId: distributor.id,
          cylinderTypeId: ct.id,
          price: spec.price,
          effectiveDate: new Date('2024-01-01'),
        },
      });
    }

    await prisma.cylinderThreshold.upsert({
      where: {
        distributorId_cylinderTypeId: {
          distributorId: distributor.id,
          cylinderTypeId: ct.id,
        },
      },
      update: {},
      create: {
        distributorId: distributor.id,
        cylinderTypeId: ct.id,
        warningLevel: spec.warning,
        criticalLevel: spec.critical,
      },
    });
  }
  console.log(`✓ Cylinder prices + thresholds`);

  // ── STEP 3 — Customers ─────────────────────────────────────────────────────
  // 3-customer mix mirroring dist-002: 1 B2C (no GSTIN), 1 B2B inter-state
  // (Telangana), 1 B2B intra-state (Karnataka). GSTINs IDENTICAL to dist-002
  // per the no-new-credentials rule — the demo tests the same compliance
  // path the production tenant does. "DEMO - DO NOT DELETE" appended to
  // businessName since Customer has no notes field.
  const demoFoods = await prisma.customer.upsert({
    where: { id: DEMO.customerB2cId },
    update: {},
    create: {
      id: DEMO.customerB2cId,
      distributorId: distributor.id,
      customerName: 'Demo Foods',
      businessName: 'Demo Foods Pvt Ltd (DEMO - DO NOT DELETE)',
      customerType: 'B2C',
      phone: '9999000101',
      billingAddressLine1: '1 Demo Street',
      billingCity: 'Bangalore',
      billingState: 'Karnataka',
      billingPincode: '560001',
      creditPeriodDays: 30,
      status: 'active',
    },
  });

  const demoCaterers = await prisma.customer.upsert({
    where: { id: DEMO.customerB2bInterId },
    update: {},
    create: {
      id: DEMO.customerB2bInterId,
      distributorId: distributor.id,
      customerName: 'Demo Caterers',
      businessName: 'Demo Caterers Ltd (DEMO - DO NOT DELETE)',
      gstin: '36AAGCB1286Q004', // SAME as dist-002 Hyderabad Caterers — sandbox Telangana
      customerType: 'B2B',
      phone: '9999000102',
      billingAddressLine1: '20 Demo Plaza',
      billingCity: 'Hyderabad',
      billingState: 'Telangana',
      billingPincode: '500016',
      creditPeriodDays: 30,
      status: 'active',
    },
  });

  const demoAgencies = await prisma.customer.upsert({
    where: { id: DEMO.customerB2bIntraId },
    update: {},
    create: {
      id: DEMO.customerB2bIntraId,
      distributorId: distributor.id,
      customerName: 'Demo Agencies',
      businessName: 'Demo Agencies Pvt Ltd (DEMO - DO NOT DELETE)',
      gstin: '29AWGPV7107B1Z1', // SAME as dist-002 Maruthi Agencies — sandbox Karnataka
      customerType: 'B2B',
      phone: '9999000103',
      billingAddressLine1: '45 Demo Layout',
      billingCity: 'Bangalore',
      billingState: 'Karnataka',
      billingPincode: '560041',
      shippingAddressLine1: '45 Demo Layout',
      shippingCity: 'Bangalore',
      shippingState: 'Karnataka',
      shippingPincode: '560041',
      creditPeriodDays: 30,
      status: 'active',
    },
  });
  console.log(`✓ Customers: 3 (1 B2C, 2 B2B — 1 inter-state, 1 intra-state)`);

  // ── STEP 4 — Driver + Vehicle ──────────────────────────────────────────────
  const demoDriver = await prisma.driver.upsert({
    where: { id: DEMO.driverId },
    update: {},
    create: {
      id: DEMO.driverId,
      distributorId: distributor.id,
      driverName: 'Demo Driver',
      phone: '9999000010',
      licenseNumber: 'DEMO-2024-001',
      employmentType: 'permanent',
      status: 'active',
      availableToday: true,
    },
  });

  const demoVehicle = await prisma.vehicle.upsert({
    where: {
      distributorId_vehicleNumber: {
        distributorId: distributor.id,
        vehicleNumber: 'DEMO-MN-0001',
      },
    },
    update: {},
    create: {
      id: DEMO.vehicleId,
      distributorId: distributor.id,
      vehicleNumber: 'DEMO-MN-0001',
      vehicleType: 'Truck',
      capacity: 80,
      status: 'idle',
    },
  });
  console.log(`✓ Driver: ${demoDriver.driverName} / Vehicle: ${demoVehicle.vehicleNumber}`);

  // ── STEP 5 — Users ─────────────────────────────────────────────────────────
  // SPEC CONFLICT: the task spec lists `sharma@gasdist.com` as the demo
  // admin, but that email is already the dist-002 admin in seed.ts and
  // User.email is @unique. The CRITICAL RULES at the top of the same spec
  // say "All user emails use demo@... pattern". We follow the rule and
  // use demo@gasdist.com so the script remains runnable alongside seed.ts.
  // Update PLAY_STORE_CREDENTIALS.md if the spec intent was different.
  const adminPw = await bcrypt.hash('Demo@Admin123', 12);
  await prisma.user.upsert({
    where: { email: DEMO.adminUserEmail },
    update: { distributorId: distributor.id },
    create: {
      email: DEMO.adminUserEmail,
      passwordHash: adminPw,
      firstName: 'Demo',
      lastName: 'Admin',
      phone: '9999000000',
      role: 'distributor_admin',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });

  const financePw = await bcrypt.hash('Demo@Finance123', 12);
  await prisma.user.upsert({
    where: { email: DEMO.financeUserEmail },
    update: { distributorId: distributor.id },
    create: {
      email: DEMO.financeUserEmail,
      passwordHash: financePw,
      firstName: 'Demo',
      lastName: 'Finance',
      phone: '9999000011',
      role: 'finance',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });

  const inventoryPw = await bcrypt.hash('Demo@Inventory123', 12);
  await prisma.user.upsert({
    where: { email: DEMO.inventoryUserEmail },
    update: { distributorId: distributor.id },
    create: {
      email: DEMO.inventoryUserEmail,
      passwordHash: inventoryPw,
      firstName: 'Demo',
      lastName: 'Inventory',
      phone: '9999000012',
      role: 'inventory',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });

  const driverPw = await bcrypt.hash('Demo@Driver123', 12);
  await prisma.user.upsert({
    where: { email: DEMO.driverUserEmail },
    update: { distributorId: distributor.id },
    create: {
      email: DEMO.driverUserEmail,
      passwordHash: driverPw,
      firstName: 'Demo',
      lastName: 'Driver',
      phone: '9999000010', // matches Driver.phone — that's the (phone,distributorId) link used by /me/* routes
      role: 'driver',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });

  const customerPw = await bcrypt.hash('Demo@Customer123', 12);
  await prisma.user.upsert({
    where: { email: DEMO.customerUserEmail },
    update: { distributorId: distributor.id, customerId: demoFoods.id },
    create: {
      email: DEMO.customerUserEmail,
      passwordHash: customerPw,
      firstName: 'Demo',
      lastName: 'Customer',
      phone: '9999000101',
      role: 'customer',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: distributor.id,
      customerId: demoFoods.id,
      requiresPasswordReset: false,
    },
  });
  console.log(`✓ Users: 5 roles seeded`);

  // ── STEP 6 — GST Credentials ───────────────────────────────────────────────
  // IDENTICAL to dist-002 — same env vars, same gstin, same WhiteBooks-
  // registered email. Sandbox-only, no live exposure.
  await prisma.gstCredential.upsert({
    where: {
      distributorId_scope: {
        distributorId: distributor.id,
        scope: 'einvoice',
      },
    },
    update: { isValid: true },
    create: {
      distributor: { connect: { id: distributor.id } },
      scope: 'einvoice',
      clientId: requireEnv('WHITEBOOKS_EINVOICE_CLIENT_ID'),
      clientSecret: requireEnv('WHITEBOOKS_EINVOICE_CLIENT_SECRET'),
      username: requireEnv('WHITEBOOKS_EINVOICE_USERNAME'),
      password: requireEnv('WHITEBOOKS_EINVOICE_PASSWORD'),
      gstin: '29AAGCB1286Q000',
      email: 'mvsuneelkumar2903@gmail.com',
      isValid: true,
    },
  });
  await prisma.gstCredential.upsert({
    where: {
      distributorId_scope: {
        distributorId: distributor.id,
        scope: 'ewaybill',
      },
    },
    update: { isValid: true },
    create: {
      distributor: { connect: { id: distributor.id } },
      scope: 'ewaybill',
      clientId: requireEnv('WHITEBOOKS_EWAYBILL_CLIENT_ID'),
      clientSecret: requireEnv('WHITEBOOKS_EWAYBILL_CLIENT_SECRET'),
      username: requireEnv('WHITEBOOKS_EWAYBILL_USERNAME'),
      password: requireEnv('WHITEBOOKS_EWAYBILL_PASSWORD'),
      gstin: '29AAGCB1286Q000',
      email: 'mvsuneelkumar2903@gmail.com',
      isValid: true,
    },
  });
  console.log(`✓ GST credentials: einvoice + ewaybill`);

  // ── STEP 7 — Opening Inventory (today only) ────────────────────────────────
  // Per the spec: simple single-day summary for the four cylinder types.
  const today = startOfTodayUtc();
  const openingByCapacity = new Map<number, { full: number; empty: number }>([
    [5, { full: 30, empty: 10 }],
    [19, { full: 50, empty: 20 }],
    [47.5, { full: 20, empty: 8 }],
    [425, { full: 5, empty: 2 }],
  ]);

  for (const ct of cylinderTypes) {
    const opening = openingByCapacity.get(ct.capacity);
    if (!opening) continue;
    await prisma.inventorySummary.upsert({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: distributor.id,
          cylinderTypeId: ct.id,
          summaryDate: today,
        },
      },
      update: {
        openingFulls: opening.full,
        openingEmpties: opening.empty,
        closingFulls: opening.full,
        closingEmpties: opening.empty,
      },
      create: {
        distributorId: distributor.id,
        cylinderTypeId: ct.id,
        summaryDate: today,
        openingFulls: opening.full,
        openingEmpties: opening.empty,
        closingFulls: opening.full,
        closingEmpties: opening.empty,
      },
    });
  }
  console.log(`✓ Opening inventory: today @ 4 cylinder types`);

  // ── STEP 8 — Transactional data ────────────────────────────────────────────
  // Gate the whole block on existence of a demo order so re-runs skip the
  // heavy work and don't create duplicates. Same pattern as the
  // `sharmaSeeded` gate in seed.ts.
  const anyDemoOrder = await prisma.order.findFirst({
    where: { distributorId: distributor.id },
    select: { id: true },
  });
  if (anyDemoOrder) {
    console.log('✓ Transactional data already seeded — skipping orders/invoices/payments');
    console.log('━━━ Demo seed complete (idempotent re-run) ━━━');
    await printSummary();
    return;
  }

  // Shorthand cylinder references — ordered by spec index above
  const ct5 = cylinderTypes[0];
  const ct19 = cylinderTypes[1];
  const ct47 = cylinderTypes[2];
  const ct425 = cylinderTypes[3];

  const adminUser = await prisma.user.findUniqueOrThrow({
    where: { email: DEMO.adminUserEmail },
  });

  // DVA for today so the demo driver shows up in the "with vehicle" list.
  await prisma.driverVehicleAssignment.upsert({
    where: {
      driverId_assignmentDate_tripNumber: {
        driverId: demoDriver.id,
        assignmentDate: today,
        tripNumber: 1,
      },
    },
    update: {},
    create: {
      distributorId: distributor.id,
      driverId: demoDriver.id,
      vehicleId: demoVehicle.id,
      assignmentDate: today,
      tripNumber: 1,
      status: 'dispatch_ready',
    },
  });

  type ItemSpec = {
    ct: { id: string };
    qty: number;
    unitPrice: number;
    discount?: number;
    delivered?: number;
    collected?: number;
  };
  type OrderSpec = {
    orderNumber: string;
    customerId: string;
    daysAgo: number;
    status: 'delivered' | 'pending_delivery' | 'pending_driver_assignment';
    assignDriver: boolean;
    items: ItemSpec[];
    invoice?: { invoiceNumber: string; status: 'paid' | 'partially_paid' | 'issued' };
    paymentMethod?: 'cash' | 'upi' | 'bank_transfer';
    paymentRef?: string;
    partialAmount?: number; // for partially_paid
  };

  // ── 8 delivered orders (last 2-30 days) ──────────────────────────────────
  const delivered: OrderSpec[] = [
    {
      orderNumber: 'DEMO-ORD-D01',
      customerId: demoCaterers.id,
      daysAgo: 30,
      status: 'delivered',
      assignDriver: true,
      items: [{ ct: ct19, qty: 10, unitPrice: 2000, delivered: 10, collected: 8 }],
      invoice: { invoiceNumber: 'DEMO-INV-D01', status: 'paid' },
      paymentMethod: 'upi',
      paymentRef: 'DEMO-UPI-D01',
    },
    {
      orderNumber: 'DEMO-ORD-D02',
      customerId: demoFoods.id,
      daysAgo: 24,
      status: 'delivered',
      assignDriver: true,
      items: [{ ct: ct19, qty: 5, unitPrice: 2000, delivered: 5, collected: 4 }],
      invoice: { invoiceNumber: 'DEMO-INV-D02', status: 'paid' },
      paymentMethod: 'cash',
      paymentRef: 'DEMO-CASH-D02',
    },
    {
      orderNumber: 'DEMO-ORD-D03',
      customerId: demoAgencies.id,
      daysAgo: 21,
      status: 'delivered',
      assignDriver: true,
      items: [
        { ct: ct47, qty: 4, unitPrice: 5000, delivered: 4, collected: 4 },
        { ct: ct19, qty: 6, unitPrice: 2000, delivered: 6, collected: 5 },
      ],
      invoice: { invoiceNumber: 'DEMO-INV-D03', status: 'paid' },
      paymentMethod: 'bank_transfer',
      paymentRef: 'DEMO-NEFT-D03',
    },
    {
      orderNumber: 'DEMO-ORD-D04',
      customerId: demoCaterers.id,
      daysAgo: 16,
      status: 'delivered',
      assignDriver: true,
      items: [{ ct: ct19, qty: 12, unitPrice: 2000, delivered: 12, collected: 10 }],
      invoice: { invoiceNumber: 'DEMO-INV-D04', status: 'partially_paid' },
      paymentMethod: 'upi',
      paymentRef: 'DEMO-UPI-D04',
      partialAmount: 10000,
    },
    {
      orderNumber: 'DEMO-ORD-D05',
      customerId: demoFoods.id,
      daysAgo: 12,
      status: 'delivered',
      assignDriver: true,
      items: [{ ct: ct5, qty: 8, unitPrice: 600, delivered: 8, collected: 6 }],
      invoice: { invoiceNumber: 'DEMO-INV-D05', status: 'paid' },
      paymentMethod: 'cash',
      paymentRef: 'DEMO-CASH-D05',
    },
    {
      orderNumber: 'DEMO-ORD-D06',
      customerId: demoAgencies.id,
      daysAgo: 8,
      status: 'delivered',
      assignDriver: true,
      items: [{ ct: ct425, qty: 1, unitPrice: 42000, delivered: 1, collected: 1 }],
      invoice: { invoiceNumber: 'DEMO-INV-D06', status: 'paid' },
      paymentMethod: 'bank_transfer',
      paymentRef: 'DEMO-NEFT-D06',
    },
    {
      orderNumber: 'DEMO-ORD-D07',
      customerId: demoCaterers.id,
      daysAgo: 5,
      status: 'delivered',
      assignDriver: true,
      items: [{ ct: ct19, qty: 8, unitPrice: 2000, delivered: 8, collected: 7 }],
      invoice: { invoiceNumber: 'DEMO-INV-D07', status: 'paid' },
      paymentMethod: 'upi',
      paymentRef: 'DEMO-UPI-D07',
    },
    {
      orderNumber: 'DEMO-ORD-D08',
      customerId: demoFoods.id,
      daysAgo: 2,
      status: 'delivered',
      assignDriver: true,
      items: [{ ct: ct19, qty: 4, unitPrice: 2000, delivered: 4, collected: 3 }],
      invoice: { invoiceNumber: 'DEMO-INV-D08', status: 'paid' },
      paymentMethod: 'cash',
      paymentRef: 'DEMO-CASH-D08',
    },
  ];

  // ── 1 in-transit + 2 pending (today) ─────────────────────────────────────
  const live: OrderSpec[] = [
    {
      orderNumber: 'DEMO-ORD-T01',
      customerId: demoAgencies.id,
      daysAgo: 0,
      status: 'pending_delivery',
      assignDriver: true,
      items: [{ ct: ct47, qty: 1, unitPrice: 5000 }],
    },
    {
      orderNumber: 'DEMO-ORD-P01',
      customerId: demoCaterers.id,
      daysAgo: 0,
      status: 'pending_driver_assignment',
      assignDriver: false,
      items: [{ ct: ct19, qty: 2, unitPrice: 2000 }],
    },
    {
      orderNumber: 'DEMO-ORD-P02',
      customerId: demoFoods.id,
      daysAgo: 0,
      status: 'pending_driver_assignment',
      assignDriver: false,
      items: [{ ct: ct19, qty: 3, unitPrice: 2000 }],
    },
  ];

  for (const spec of [...delivered, ...live]) {
    const orderDate = daysAgoUtc(spec.daysAgo);
    const deliveryDate = orderDate;
    const total = spec.items.reduce(
      (sum, it) => sum + (it.unitPrice - (it.discount ?? 0)) * it.qty,
      0,
    );
    const order = await prisma.order.upsert({
      where: { orderNumber: spec.orderNumber },
      update: {},
      create: {
        orderNumber: spec.orderNumber,
        distributorId: distributor.id,
        customerId: spec.customerId,
        driverId: spec.assignDriver ? demoDriver.id : null,
        vehicleId: spec.assignDriver ? demoVehicle.id : null,
        orderDate,
        deliveryDate,
        status: spec.status,
        totalAmount: total,
        deliveredAt: spec.status === 'delivered' ? deliveryDate : null,
        items: {
          create: spec.items.map((it) => ({
            cylinderTypeId: it.ct.id,
            quantity: it.qty,
            unitPrice: it.unitPrice,
            discountPerUnit: it.discount ?? 0,
            totalPrice: (it.unitPrice - (it.discount ?? 0)) * it.qty,
            deliveredQuantity: it.delivered ?? null,
            emptiesCollected: it.collected ?? null,
          })),
        },
      },
    });

    if (spec.invoice && spec.status === 'delivered') {
      const invTotal = total;
      const paid =
        spec.invoice.status === 'paid'
          ? invTotal
          : spec.invoice.status === 'partially_paid'
            ? (spec.partialAmount ?? 0)
            : 0;
      const invoice = await prisma.invoice.upsert({
        where: { invoiceNumber: spec.invoice.invoiceNumber },
        update: {},
        create: {
          invoiceNumber: spec.invoice.invoiceNumber,
          distributorId: distributor.id,
          customerId: spec.customerId,
          orderId: order.id,
          issueDate: deliveryDate,
          dueDate: daysAgoUtc(spec.daysAgo - 30),
          totalAmount: invTotal,
          amountPaid: paid,
          outstandingAmount: invTotal - paid,
          status: spec.invoice.status,
          // Dummy IRN — plausibly shaped (64 hex chars), labelled DEMO so
          // it's impossible to mistake for a real NIC issuance. The demo
          // does NOT call WhiteBooks for these.
          irn: `DEMO${spec.invoice.invoiceNumber.replace(/[^A-Z0-9]/g, '')}${'0'.repeat(60)}`.slice(0, 64),
          irnStatus: 'success',
          ackNo: `DEMO-ACK-${spec.invoice.invoiceNumber}`,
          ackDate: deliveryDate,
          items: {
            create: spec.items.map((it) => ({
              cylinderTypeId: it.ct.id,
              description: `${cylinderTypes.find((x) => x.id === it.ct.id)!.typeName} LPG Cylinder`,
              hsnCode: '27111900',
              quantity: it.qty,
              unitPrice: it.unitPrice,
              discountPerUnit: it.discount ?? 0,
              gstRate: 0, // 5% IGST on inter-state, 0 intra (LPG schedule)
              totalPrice: (it.unitPrice - (it.discount ?? 0)) * it.qty,
            })),
          },
        },
      });

      if (paid > 0 && spec.paymentMethod && spec.paymentRef) {
        // Payment ref serves as our idempotency key — no @unique on the
        // schema but the find-then-create avoids duplicating on re-run.
        const existingPayment = await prisma.paymentTransaction.findFirst({
          where: { referenceNumber: spec.paymentRef, distributorId: distributor.id },
        });
        const payment =
          existingPayment ??
          (await prisma.paymentTransaction.create({
            data: {
              distributorId: distributor.id,
              customerId: spec.customerId,
              amount: paid,
              paymentMethod: spec.paymentMethod,
              referenceNumber: spec.paymentRef,
              transactionDate: deliveryDate,
              allocationStatus:
                spec.invoice.status === 'paid' ? 'fully_allocated' : 'partially_allocated',
              notes: 'DEMO - DO NOT DELETE',
            },
          }));
        const existingAllocation = await prisma.paymentAllocation.findFirst({
          where: { paymentId: payment.id, invoiceId: invoice.id },
        });
        if (!existingAllocation) {
          await prisma.paymentAllocation.create({
            data: {
              paymentId: payment.id,
              invoiceId: invoice.id,
              allocatedAmount: paid,
            },
          });
        }
      }
    }

    await prisma.orderStatusLog.create({
      data: {
        orderId: order.id,
        oldStatus: 'pending_driver_assignment',
        newStatus: spec.status,
        changedBy: adminUser.id,
        notes: 'DEMO - DO NOT DELETE — seeded via seed-demo.ts',
      },
    });
  }

  console.log(`✓ Orders: 11 (8 delivered, 1 in-transit, 2 pending)`);
  console.log(`✓ Invoices: 8 (7 paid, 1 partially paid)`);
  console.log(`✓ Payments: 8 with allocations`);
  console.log('━━━ Demo seed complete ━━━');
  await printSummary();
}

async function printSummary(): Promise<void> {
  console.log('\nLogin credentials:');
  console.log(`  Distributor Admin: ${DEMO.adminUserEmail} / Demo@Admin123`);
  console.log(`  Finance:           ${DEMO.financeUserEmail} / Demo@Finance123`);
  console.log(`  Inventory:         ${DEMO.inventoryUserEmail} / Demo@Inventory123`);
  console.log(`  Driver:            ${DEMO.driverUserEmail} / Demo@Driver123`);
  console.log(`  Customer:          ${DEMO.customerUserEmail} / Demo@Customer123`);
}

main()
  .catch((err) => {
    console.error('Demo seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
