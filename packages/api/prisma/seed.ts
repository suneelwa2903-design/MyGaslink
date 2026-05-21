import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ─── 1. Create Super Admin ────────────────────────────────────────────────
  const superAdminPassword = await bcrypt.hash('Admin@123', 12);
  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@mygaslink.com' },
    update: {},
    create: {
      email: 'admin@mygaslink.com',
      passwordHash: superAdminPassword,
      firstName: 'Suneel',
      lastName: 'Kumar',
      phone: '9999999999',
      role: 'super_admin',
      status: 'active',
      provisioningStatus: 'active',
      requiresPasswordReset: false,
    },
  });
  console.log('Super admin created:', superAdmin.email);

  // ─── 2. Create Distributor ────────────────────────────────────────────────
  const distributor = await prisma.distributor.upsert({
    where: { id: 'dist-001' },
    update: {},
    create: {
      id: 'dist-001',
      businessName: 'Bhargava Gas Agency',
      legalName: 'Bhargava Gas Agency Pvt Ltd',
      gstin: '36AABCU9603R1ZM',
      address: '123 Main Road, Secunderabad',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500003',
      phone: '9876543210',
      email: 'bhargava@gasagency.com',
      status: 'active',
      gstMode: 'disabled',
      providerCodes: ['IOCL'],
      subscriptionPlan: 'business',
      billingTier: 'tier_2',
      gaslinkBillingEnabled: false,
    },
  });
  console.log('Distributor created:', distributor.businessName);

  // ─── 3. Create Distributor Admin ──────────────────────────────────────────
  const distAdminPassword = await bcrypt.hash('Distadmin@123', 12);
  const distAdmin = await prisma.user.upsert({
    where: { email: 'bhargava@gasagency.com' },
    update: {},
    create: {
      email: 'bhargava@gasagency.com',
      passwordHash: distAdminPassword,
      firstName: 'Bhargava',
      lastName: 'Mannava',
      phone: '9876543210',
      role: 'distributor_admin',
      status: 'active',
      provisioningStatus: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });
  console.log('Distributor admin created:', distAdmin.email);

  // ─── 4a. Seed Provider Catalog (IOCL standard cylinders) ──────────────────
  // Provider catalog is global (platform-level). Each distributor's
  // CylinderType rows now point back to a catalog entry so we can trace
  // tenant cylinder types back to the provider that supplies them.
  const catalogEntries = [
    { providerCode: 'IOCL', shortName: '5KG',    longName: 'IOCL 5 KG Domestic Cylinder',    weight: 5,     hsnCode: '27111900' },
    { providerCode: 'IOCL', shortName: '19KG',   longName: 'IOCL 19 KG Commercial Cylinder', weight: 19,    hsnCode: '27111900' },
    { providerCode: 'IOCL', shortName: '47.5KG', longName: 'IOCL 47.5 KG Commercial Cylinder', weight: 47.5, hsnCode: '27111900' },
    { providerCode: 'IOCL', shortName: '425KG',  longName: 'IOCL 425 KG Bulk Cylinder',       weight: 425,   hsnCode: '27111900' },
    { providerCode: 'HPCL', shortName: '5KG',    longName: 'HPCL 5 KG Domestic Cylinder',    weight: 5,     hsnCode: '27111900' },
    { providerCode: 'HPCL', shortName: '19KG',   longName: 'HPCL 19 KG Commercial Cylinder', weight: 19,    hsnCode: '27111900' },
    { providerCode: 'HPCL', shortName: '47.5KG', longName: 'HPCL 47.5 KG Commercial Cylinder', weight: 47.5, hsnCode: '27111900' },
    { providerCode: 'HPCL', shortName: '425KG',  longName: 'HPCL 425 KG Bulk Cylinder',       weight: 425,   hsnCode: '27111900' },
  ] as const;

  const catalog = await Promise.all(catalogEntries.map((c) =>
    prisma.providerCatalogCylinderType.upsert({
      where: { providerCode_shortName: { providerCode: c.providerCode, shortName: c.shortName } },
      update: { longName: c.longName, weight: c.weight, hsnCode: c.hsnCode, isActive: true },
      create: { providerCode: c.providerCode, shortName: c.shortName, longName: c.longName, weight: c.weight, hsnCode: c.hsnCode },
    }),
  ));
  console.log('Provider catalog seeded:', catalog.map(c => `${c.providerCode} ${c.shortName}`).join(', '));

  // Lookup helpers — catalog is keyed by (provider, weight) so we can pick the
  // right row for each distributor's cylinder types.
  const iocl = new Map(catalog.filter(c => c.providerCode === 'IOCL').map(c => [c.weight, c]));
  const hpcl = new Map(catalog.filter(c => c.providerCode === 'HPCL').map(c => [c.weight, c]));
  // Back-compat for any callers below that still expect catalogByWeight (IOCL).
  const catalogByWeight = iocl;

  // ─── 4b. Create Distributor Cylinder Types (linked to catalog) ────────────
  const cylinderTypeSpecs = [
    { typeName: '5 KG',    capacity: 5 },
    { typeName: '19 KG',   capacity: 19 },
    { typeName: '47.5 KG', capacity: 47.5 },
    { typeName: '425 KG',  capacity: 425 },
  ];

  const cylinderTypes = await Promise.all(cylinderTypeSpecs.map((spec) => {
    const catalogEntry = catalogByWeight.get(spec.capacity);
    return prisma.cylinderType.upsert({
      where: { distributorId_typeName: { distributorId: distributor.id, typeName: spec.typeName } },
      update: { providerCatalogId: catalogEntry?.id ?? null },
      create: {
        distributorId: distributor.id,
        typeName: spec.typeName,
        capacity: spec.capacity,
        unit: 'KG',
        hsnCode: '27111900',
        providerCatalogId: catalogEntry?.id ?? null,
      },
    });
  }));
  console.log('Cylinder types created:', cylinderTypes.map(ct => ct.typeName).join(', '));

  // ─── Idempotency gate for Bhargava transactional data ─────────────────────
  // The rest of the per-distributor block (prices, customers, drivers,
  // vehicles, orders, invoices, payments) uses .create() without unique
  // constraints we can upsert on, so we short-circuit if a previous seed run
  // already populated this distributor. (WI-032)
  const bhargavaExistingPrices = await prisma.cylinderPrice.count({ where: { distributorId: distributor.id } });
  const bhargavaSeeded = bhargavaExistingPrices > 0;
  if (bhargavaSeeded) {
    console.log('Bhargava transactional data already seeded — skipping prices/customers/drivers/vehicles/orders/invoices/payments');
  }

  // ─── 5. Create Cylinder Prices ────────────────────────────────────────────
  // Use a date well in the past so prices are effective for any order date
  const priceEffectiveDate = '2024-01-01';
  const prices = [
    { cylinderTypeId: cylinderTypes[0].id, price: 450 },    // 5 KG
    { cylinderTypeId: cylinderTypes[1].id, price: 1800 },   // 19 KG
    { cylinderTypeId: cylinderTypes[2].id, price: 4200 },   // 47.5 KG
    { cylinderTypeId: cylinderTypes[3].id, price: 38000 },  // 425 KG
  ];

  if (!bhargavaSeeded) {
    for (const p of prices) {
      await prisma.cylinderPrice.create({
        data: {
          distributorId: distributor.id,
          cylinderTypeId: p.cylinderTypeId,
          price: p.price,
          effectiveDate: new Date(priceEffectiveDate),
        },
      });
    }
    console.log('Cylinder prices set');
  }

  // ─── 6. Create Empty Cylinder Prices ──────────────────────────────────────
  const emptyPrices = [
    { cylinderTypeId: cylinderTypes[0].id, price: 1200 },
    { cylinderTypeId: cylinderTypes[1].id, price: 3500 },
    { cylinderTypeId: cylinderTypes[2].id, price: 8000 },
    { cylinderTypeId: cylinderTypes[3].id, price: 65000 },
  ];

  for (const ep of emptyPrices) {
    await prisma.emptyCylinderPrice.upsert({
      where: { distributorId_cylinderTypeId: { distributorId: distributor.id, cylinderTypeId: ep.cylinderTypeId } },
      update: {},
      create: { distributorId: distributor.id, cylinderTypeId: ep.cylinderTypeId, emptyCylinderPrice: ep.price },
    });
  }
  console.log('Empty cylinder prices set');

  // ─── 7. Create Thresholds ─────────────────────────────────────────────────
  for (const ct of cylinderTypes) {
    await prisma.cylinderThreshold.upsert({
      where: { distributorId_cylinderTypeId: { distributorId: distributor.id, cylinderTypeId: ct.id } },
      update: {},
      create: { distributorId: distributor.id, cylinderTypeId: ct.id, warningLevel: 20, criticalLevel: 5 },
    });
  }
  console.log('Inventory thresholds set');

  // ─── 8. Create Customers (5 customers) ────────────────────────────────────
  // Bhargava transactional block — guarded by bhargavaSeeded so re-runs skip.
  // customers/drivers/vehicles are hoisted so the transactional section
  // (orders/invoices/payments) further down can also reference them when
  // gated by the same flag.
  let customers: Awaited<ReturnType<typeof prisma.customer.create>>[] = [];
  let drivers: Awaited<ReturnType<typeof prisma.driver.create>>[] = [];
  let vehicles: Awaited<ReturnType<typeof prisma.vehicle.create>>[] = [];
  if (!bhargavaSeeded) {
  customers = await Promise.all([
    prisma.customer.create({
      data: {
        distributorId: distributor.id, customerName: 'Royal Kitchen Restaurant', businessName: 'Royal Kitchen Pvt Ltd',
        gstin: '36AADCR1234H1ZQ', customerType: 'B2B', phone: '9876000001', email: 'royal@kitchen.com',
        billingAddressLine1: '45 MG Road', billingCity: 'Hyderabad', billingState: 'Telangana', billingPincode: '500001',
        shippingAddressLine1: '45 MG Road', shippingCity: 'Hyderabad', shippingState: 'Telangana', shippingPincode: '500001',
        creditPeriodDays: 30, status: 'active',
      },
    }),
    prisma.customer.create({
      data: {
        distributorId: distributor.id, customerName: 'Spice Garden Hotel', businessName: 'Spice Garden Hotels Ltd',
        gstin: '36AADCS5678J1ZR', customerType: 'B2B', phone: '9876000002', email: 'spice@garden.com',
        billingAddressLine1: '78 Jubilee Hills', billingCity: 'Hyderabad', billingState: 'Telangana', billingPincode: '500033',
        creditPeriodDays: 15, status: 'active',
      },
    }),
    prisma.customer.create({
      data: {
        distributorId: distributor.id, customerName: 'Metropolis Industries', businessName: 'Metropolis Industries Pvt Ltd',
        gstin: '27AADCM9012K1ZS', customerType: 'B2B', phone: '9876000003', email: 'metro@industries.com',
        billingAddressLine1: '12 MIDC, Pune', billingCity: 'Pune', billingState: 'Maharashtra', billingPincode: '411001',
        creditPeriodDays: 45, status: 'active',
      },
    }),
    prisma.customer.create({
      data: {
        distributorId: distributor.id, customerName: 'Lakshmi Mess', customerType: 'B2C',
        phone: '9876000004', billingCity: 'Hyderabad', billingState: 'Telangana',
        creditPeriodDays: 7, status: 'active',
      },
    }),
    prisma.customer.create({
      data: {
        distributorId: distributor.id, customerName: 'Green Valley Caterers', businessName: 'Green Valley Services',
        gstin: '36AADCG3456L1ZT', customerType: 'B2B', phone: '9876000005', email: 'green@valley.com',
        billingAddressLine1: '99 Banjara Hills', billingCity: 'Hyderabad', billingState: 'Telangana', billingPincode: '500034',
        creditPeriodDays: 30, status: 'active',
      },
    }),
  ]);
  console.log('Customers created:', customers.length);

  // ─── 9. Customer Discounts ────────────────────────────────────────────────
  // Royal Kitchen gets ₹10 off on 19KG
  await prisma.customerCylinderDiscount.create({
    data: { customerId: customers[0].id, cylinderTypeId: cylinderTypes[1].id, discountPerUnit: 10 },
  });
  // Metropolis gets ₹50 off on 47.5KG (bulk buyer)
  await prisma.customerCylinderDiscount.create({
    data: { customerId: customers[2].id, cylinderTypeId: cylinderTypes[2].id, discountPerUnit: 50 },
  });
  console.log('Customer discounts set');

  // ─── 10. Create Drivers ───────────────────────────────────────────────────
  drivers = await Promise.all([
    prisma.driver.create({
      data: { distributorId: distributor.id, driverName: 'Raju Kumar', phone: '9800000001', licenseNumber: 'TS09-2020-001', employmentType: 'permanent', status: 'active', availableToday: true },
    }),
    prisma.driver.create({
      data: { distributorId: distributor.id, driverName: 'Suresh Babu', phone: '9800000002', licenseNumber: 'TS09-2020-002', employmentType: 'permanent', status: 'active', availableToday: true },
    }),
    prisma.driver.create({
      data: { distributorId: distributor.id, driverName: 'Venkat Rao', phone: '9800000003', licenseNumber: 'TS09-2020-003', employmentType: 'contract', status: 'active', availableToday: true },
    }),
  ]);
  console.log('Drivers created:', drivers.map(d => d.driverName).join(', '));

  // ─── 11. Create Vehicles ──────────────────────────────────────────────────
  vehicles = await Promise.all([
    prisma.vehicle.create({
      data: { distributorId: distributor.id, vehicleNumber: 'TS09-AB-1234', vehicleType: 'Truck', capacity: 100, status: 'idle' },
    }),
    prisma.vehicle.create({
      data: { distributorId: distributor.id, vehicleNumber: 'TS09-CD-5678', vehicleType: 'Tempo', capacity: 50, status: 'idle' },
    }),
  ]);
  console.log('Vehicles created:', vehicles.map(v => v.vehicleNumber).join(', '));

  // ─── 12. Create Finance & Inventory Users ─────────────────────────────────
  const financePassword = await bcrypt.hash('Finance@123', 12);
  await prisma.user.create({
    data: {
      email: 'finance@gasagency.com', passwordHash: financePassword,
      firstName: 'Priya', lastName: 'Sharma', phone: '9800000010',
      role: 'finance', status: 'active', provisioningStatus: 'active',
      distributorId: distributor.id, requiresPasswordReset: false,
    },
  });

  const inventoryPassword = await bcrypt.hash('Inventory@123', 12);
  await prisma.user.create({
    data: {
      email: 'inventory@gasagency.com', passwordHash: inventoryPassword,
      firstName: 'Ramesh', lastName: 'Patel', phone: '9800000011',
      role: 'inventory', status: 'active', provisioningStatus: 'active',
      distributorId: distributor.id, requiresPasswordReset: false,
    },
  });
  console.log('Finance and Inventory users created');

  // ─── 12b. Create Driver User ────────────────────────────────────────────
  const driverPassword = await bcrypt.hash('Driver@123', 12);
  await prisma.user.create({
    data: {
      email: 'raju@gasagency.com', passwordHash: driverPassword,
      firstName: 'Raju', lastName: 'Kumar', phone: '9800000001',
      role: 'driver', status: 'active', provisioningStatus: 'active',
      distributorId: distributor.id, requiresPasswordReset: false,
    },
  });
  console.log('Driver user created: raju@gasagency.com / Driver@123');

  // ─── 12c. Create Customer User ──────────────────────────────────────────
  const customerPassword = await bcrypt.hash('Customer@123', 12);
  await prisma.user.create({
    data: {
      email: 'royal@kitchen.com', passwordHash: customerPassword,
      firstName: 'Royal', lastName: 'Kitchen', phone: '9876000001',
      role: 'customer', status: 'active', provisioningStatus: 'active',
      distributorId: distributor.id, customerId: customers[0].id,
      requiresPasswordReset: false,
    },
  });
  console.log('Customer user created: royal@kitchen.com / Customer@123');
  } // end if (!bhargavaSeeded)

  // ─── 13. GST Reference Data ───────────────────────────────────────────────
  const states = [
    { stateCode: '36', stateName: 'Telangana' },
    { stateCode: '27', stateName: 'Maharashtra' },
    { stateCode: '29', stateName: 'Karnataka' },
    { stateCode: '33', stateName: 'Tamil Nadu' },
    { stateCode: '07', stateName: 'Delhi' },
    { stateCode: '09', stateName: 'Uttar Pradesh' },
  ];
  for (const s of states) {
    await prisma.gstState.upsert({ where: { stateCode: s.stateCode }, update: {}, create: s });
  }

  await prisma.hsnCode.upsert({
    where: { hsnCode: '27111900' }, update: {},
    create: { hsnCode: '27111900', description: 'Liquefied petroleum gases (LPG)' },
  });
  console.log('GST reference data seeded');

  // ─── 14. GST-Enabled Distributor (for GST workflow testing) ───────────────
  const gstDist = await prisma.distributor.upsert({
    where: { id: 'dist-002' },
    update: {},
    create: {
      id: 'dist-002',
      businessName: 'Sharma Gas Distributors',
      legalName: 'Sharma Gas Distributors Pvt Ltd',
      gstin: '29AAGCB1286Q000',
      address: '56 MG Road, Bangalore',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      phone: '9876500000',
      email: 'sharma@gasdist.com',
      status: 'active',
      gstMode: 'sandbox',
      providerCodes: ['HPCL'],
      subscriptionPlan: 'business',
      billingTier: 'tier_2',
      gaslinkBillingEnabled: false,
    },
  });
  console.log('GST-enabled distributor created:', gstDist.businessName);

  // GST distributor admin — upsert by email (User.email is @unique).
  const gstAdminPassword = await bcrypt.hash('Gstadmin@123', 12);
  await prisma.user.upsert({
    where: { email: 'sharma@gasdist.com' },
    update: {},
    create: {
      email: 'sharma@gasdist.com', passwordHash: gstAdminPassword,
      firstName: 'Amit', lastName: 'Sharma', phone: '9876500000',
      role: 'distributor_admin', status: 'active', provisioningStatus: 'active',
      distributorId: gstDist.id, requiresPasswordReset: false,
    },
  });

  // GST distributor cylinder types and prices — all 4 types linked to the
  // HPCL provider catalog (Sharma is an HPCL distributor).
  const gstCylinderTypeSpecs = [
    { typeName: '5 KG',    capacity: 5,    price: 600,   warning: 10, critical: 3 },
    { typeName: '19 KG',   capacity: 19,   price: 2000,  warning: 15, critical: 3 },
    { typeName: '47.5 KG', capacity: 47.5, price: 5000,  warning: 10, critical: 2 },
    { typeName: '425 KG',  capacity: 425,  price: 42000, warning: 5,  critical: 1 },
  ];

  const gstCylTypes = await Promise.all(gstCylinderTypeSpecs.map((spec) =>
    prisma.cylinderType.upsert({
      where: { distributorId_typeName: { distributorId: gstDist.id, typeName: spec.typeName } },
      update: { providerCatalogId: hpcl.get(spec.capacity)?.id ?? null },
      create: {
        distributorId: gstDist.id, typeName: spec.typeName, capacity: spec.capacity,
        unit: 'KG', hsnCode: '27111900',
        providerCatalogId: hpcl.get(spec.capacity)?.id ?? null,
      },
    }),
  ));

  // Idempotency gate for Sharma transactional data — same pattern as Bhargava.
  const sharmaExistingPrices = await prisma.cylinderPrice.count({ where: { distributorId: gstDist.id } });
  const sharmaSeeded = sharmaExistingPrices > 0;
  if (sharmaSeeded) {
    console.log('Sharma transactional data already seeded — skipping prices/customers/drivers/vehicles/orders/invoices');
  }

  if (!sharmaSeeded) {
    for (let i = 0; i < gstCylTypes.length; i++) {
      const ct = gstCylTypes[i];
      const spec = gstCylinderTypeSpecs[i];
      await prisma.cylinderPrice.create({
        data: { distributorId: gstDist.id, cylinderTypeId: ct.id, price: spec.price, effectiveDate: new Date('2024-01-01') },
      });
      await prisma.cylinderThreshold.upsert({
        where: { distributorId_cylinderTypeId: { distributorId: gstDist.id, cylinderTypeId: ct.id } },
        update: {},
        create: { distributorId: gstDist.id, cylinderTypeId: ct.id, warningLevel: spec.warning, criticalLevel: spec.critical },
      });
    }
  }

  if (!sharmaSeeded) {
  // GST distributor customers - one same-state (Karnataka), one inter-state (Telangana)
  const gstCustomers = await Promise.all([
    prisma.customer.create({
      data: {
        distributorId: gstDist.id, customerName: 'Bangalore Foods', businessName: 'Bangalore Foods Pvt Ltd',
        customerType: 'B2C', phone: '9876500001', // B2C (no GSTIN) - same state, no IRN needed
        billingAddressLine1: '10 Brigade Road', billingCity: 'Bangalore', billingState: 'Karnataka', billingPincode: '560001',
        creditPeriodDays: 30, status: 'active',
      },
    }),
    prisma.customer.create({
      data: {
        distributorId: gstDist.id, customerName: 'Hyderabad Caterers', businessName: 'Hyderabad Caterers Ltd',
        gstin: '36AAGCB1286Q004', customerType: 'B2B', phone: '9876500002', // Telangana sandbox GSTIN
        billingAddressLine1: '20 Ameerpet', billingCity: 'Hyderabad', billingState: 'Telangana', billingPincode: '500016',
        creditPeriodDays: 30, status: 'active',
      },
    }),
    prisma.customer.create({
      data: {
        distributorId: gstDist.id, customerName: 'Maruthi Agencies', businessName: 'Maruthi Agencies Pvt Ltd',
        gstin: '29AWGPV7107B1Z1', customerType: 'B2B', phone: '9876500003',
        billingAddressLine1: '45 Jayanagar', billingCity: 'Bangalore', billingState: 'Karnataka', billingPincode: '560041',
        shippingAddressLine1: '45 Jayanagar', shippingCity: 'Bangalore', shippingState: 'Karnataka', shippingPincode: '560041',
        creditPeriodDays: 30, status: 'active',
      },
    }),
  ]);

  // GST distributor drivers and vehicles
  const gstDriver = await prisma.driver.create({
    data: { distributorId: gstDist.id, driverName: 'Kiran Reddy', phone: '9876500010', licenseNumber: 'KA01-2023-001', employmentType: 'permanent', status: 'active', availableToday: true },
  });
  const gstVehicle = await prisma.vehicle.create({
    data: { distributorId: gstDist.id, vehicleNumber: 'KA01-MN-9999', vehicleType: 'Truck', capacity: 80, status: 'idle' },
  });

  // E-Invoice credentials (EINS prefix). Rotated 2026-05-15 from the
  // original coolsupersaiyan@gmail.com account to mvsuneelkumar2903@gmail.com
  // because the original WhiteBooks sandbox account was deregistered
  // (auth returns "This email is not registered with WhiteBooks").
  // Confirmed 2026-05-16 by switching back and getting the same rejection.
  await prisma.gstCredential.create({
    data: {
      distributor: { connect: { id: gstDist.id } },
      scope: 'einvoice',
      clientId: 'EINSc0e87f75-51b3-4284-a57f-639a7582514c',
      clientSecret: 'EINSda1f2b7a-feea-46b2-9054-0e4371da3fd4',
      username: 'BVMGSP',
      password: 'Wbooks@0142',
      gstin: '29AAGCB1286Q000',
      email: 'mvsuneelkumar2903@gmail.com',
      isValid: true,
    },
  });

  // E-Waybill credentials (EWBS prefix). Same rotation as above.
  await prisma.gstCredential.create({
    data: {
      distributor: { connect: { id: gstDist.id } },
      scope: 'ewaybill',
      clientId: 'EWBSa82587b9-88ca-43d0-a514-7457a38eb813',
      clientSecret: 'EWBS68034a54-66a6-41d5-b7df-4acd0b17b525',
      username: 'BVMGSP',
      password: 'Wbooks@0142',
      gstin: '29AAGCB1286Q000',
      email: 'mvsuneelkumar2903@gmail.com',
      isValid: true,
    },
  });
  console.log('WhiteBooks sandbox credentials seeded for GST distributor (einvoice + ewaybill)');
  } // end if (!sharmaSeeded) — Sharma customers + drivers + vehicles + credentials

  // ─── Sharma (dist-002) sub-role users ─────────────────────────────────────
  // Upserted outside the sharmaSeeded gate so they're created on any re-seed.
  // Driver is linked to Kiran Reddy; Customer is linked to Bangalore Foods.
  // Resolve linked IDs dynamically so this stays correct after a fresh seed.
  const kiranReddy = await prisma.driver.findFirst({
    where: { distributorId: gstDist.id, driverName: 'Kiran Reddy' },
  });
  const bangaloreFoods = await prisma.customer.findFirst({
    where: { distributorId: gstDist.id, customerName: 'Bangalore Foods' },
  });

  const finance2Hash = await bcrypt.hash('Finance@123', 12);
  await prisma.user.upsert({
    where: { email: 'finance2@gasdist.com' },
    update: {},
    create: {
      email: 'finance2@gasdist.com', passwordHash: finance2Hash,
      firstName: 'Divya', lastName: 'Sharma', phone: '9876500011',
      role: 'finance', status: 'active', provisioningStatus: 'active',
      distributorId: gstDist.id, requiresPasswordReset: false,
    },
  });

  const inventory2Hash = await bcrypt.hash('Inventory@123', 12);
  await prisma.user.upsert({
    where: { email: 'inventory2@gasdist.com' },
    update: {},
    create: {
      email: 'inventory2@gasdist.com', passwordHash: inventory2Hash,
      firstName: 'Suresh', lastName: 'Reddy', phone: '9876500012',
      role: 'inventory', status: 'active', provisioningStatus: 'active',
      distributorId: gstDist.id, requiresPasswordReset: false,
    },
  });

  const driver2Hash = await bcrypt.hash('Driver@123', 12);
  await prisma.user.upsert({
    where: { email: 'driver2@gasdist.com' },
    update: {},
    create: {
      email: 'driver2@gasdist.com', passwordHash: driver2Hash,
      firstName: 'Kiran', lastName: 'Reddy', phone: '9876500010',
      role: 'driver', status: 'active', provisioningStatus: 'active',
      distributorId: gstDist.id, requiresPasswordReset: false,
    },
  });

  const customer2Hash = await bcrypt.hash('Customer@123', 12);
  await prisma.user.upsert({
    where: { email: 'customer2@gasdist.com' },
    update: {},
    create: {
      email: 'customer2@gasdist.com', passwordHash: customer2Hash,
      firstName: 'Bangalore', lastName: 'Foods', phone: '9876500001',
      role: 'customer', status: 'active', provisioningStatus: 'active',
      distributorId: gstDist.id,
      customerId: bangaloreFoods?.id ?? null,
      requiresPasswordReset: false,
    },
  });
  console.log('Sharma (dist-002) sub-role users seeded: finance2, inventory2, driver2, customer2');

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSACTIONAL TEST DATA FOR BHARGAVA GAS AGENCY (dist-001)
  // ═══════════════════════════════════════════════════════════════════════════
  // Whole block gated on bhargavaSeeded — re-runs skip this entirely, since
  // none of the .create() calls below have a unique constraint we could
  // upsert on, and we'd otherwise duplicate orders/invoices/payments. (WI-032)
  if (!bhargavaSeeded) {

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  /** Helper: returns a Date object for N days ago (midnight) */
  function daysAgo(n: number): Date {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d;
  }

  // Shorthand references
  const ct5 = cylinderTypes[0];   // 5 KG
  const ct19 = cylinderTypes[1];  // 19 KG
  const ct47 = cylinderTypes[2];  // 47.5 KG
  const ct425 = cylinderTypes[3]; // 425 KG

  // ─── 15. Inventory Summaries (past 7 days, 4 cylinder types) ────────────

  // Base opening values per cylinder type
  const inventoryProfiles = [
    { ct: ct5,   openFulls: 100, openEmpties: 50,  dailyIn: 20, dailyOut: 15, dailyDeliver: 12, dailyCollect: 10 },
    { ct: ct19,  openFulls: 200, openEmpties: 80,  dailyIn: 40, dailyOut: 30, dailyDeliver: 25, dailyCollect: 20 },
    { ct: ct47,  openFulls: 50,  openEmpties: 20,  dailyIn: 10, dailyOut: 8,  dailyDeliver: 6,  dailyCollect: 5 },
    { ct: ct425, openFulls: 10,  openEmpties: 5,   dailyIn: 2,  dailyOut: 1,  dailyDeliver: 1,  dailyCollect: 1 },
  ];

  for (const profile of inventoryProfiles) {
    let currentFulls = profile.openFulls;
    let currentEmpties = profile.openEmpties;

    for (let day = 6; day >= 0; day--) {
      // Small random variation (+/- 2) for realism
      const variation = () => Math.floor(Math.random() * 5) - 2;
      const incomingFulls = Math.max(0, profile.dailyIn + variation());
      const outgoingEmpties = Math.max(0, profile.dailyOut + variation());
      const deliveredQty = Math.max(0, profile.dailyDeliver + variation());
      const collectedEmpties = Math.max(0, profile.dailyCollect + variation());

      const closingFulls = currentFulls + incomingFulls - deliveredQty;
      const closingEmpties = currentEmpties - outgoingEmpties + collectedEmpties;

      await prisma.inventorySummary.create({
        data: {
          distributorId: distributor.id,
          cylinderTypeId: profile.ct.id,
          summaryDate: daysAgo(day),
          openingFulls: currentFulls,
          openingEmpties: currentEmpties,
          incomingFulls,
          outgoingEmpties,
          deliveredQty,
          collectedEmpties,
          closingFulls,
          closingEmpties,
          isLocked: day > 0, // only today is unlocked
        },
      });

      // Next day's opening = this day's closing
      currentFulls = closingFulls;
      currentEmpties = closingEmpties;
    }
  }
  console.log('Inventory summaries created (7 days x 4 types)');

  // ─── 16. Inventory Events (15-20 events over past 7 days) ───────────────

  const inventoryEvents = [
    // Day 6 - incoming receipt from IOCL
    { ct: ct19, type: 'incoming_fulls' as const, fulls: 40, empties: 0, day: 6, notes: 'Receipt from IOCL depot - Truck #1', doc: 'REC-001' },
    { ct: ct5,  type: 'incoming_fulls' as const, fulls: 20, empties: 0, day: 6, notes: 'Receipt from IOCL depot - Truck #1', doc: 'REC-001' },
    { ct: ct19, type: 'outgoing_empties' as const, fulls: 0, empties: -30, day: 6, notes: 'Empties returned to IOCL depot', doc: 'RET-001' },

    // Day 5 - deliveries
    { ct: ct19, type: 'delivery' as const, fulls: -10, empties: 0, day: 5, notes: 'Delivery to Royal Kitchen', doc: null },
    { ct: ct47, type: 'delivery' as const, fulls: -4, empties: 0, day: 5, notes: 'Delivery to Metropolis Industries', doc: null },
    { ct: ct19, type: 'collection' as const, fulls: 0, empties: 8, day: 5, notes: 'Empties collected from Royal Kitchen', doc: null },

    // Day 4 - receipt + adjustment
    { ct: ct47, type: 'incoming_fulls' as const, fulls: 10, empties: 0, day: 4, notes: 'Receipt from IOCL - 47.5 KG batch', doc: 'REC-002' },
    { ct: ct5,  type: 'manual_adjustment' as const, fulls: -2, empties: 0, day: 4, notes: 'Physical count correction - 2 cylinders damaged', doc: 'ADJ-001' },
    { ct: ct425, type: 'incoming_fulls' as const, fulls: 2, empties: 0, day: 4, notes: 'Bulk receipt from IOCL', doc: 'REC-003' },

    // Day 3 - deliveries + returns
    { ct: ct19, type: 'delivery' as const, fulls: -15, empties: 0, day: 3, notes: 'Delivery to Spice Garden Hotel', doc: null },
    { ct: ct5,  type: 'delivery' as const, fulls: -8, empties: 0, day: 3, notes: 'Delivery to Lakshmi Mess', doc: null },
    { ct: ct47, type: 'collection' as const, fulls: 0, empties: 3, day: 3, notes: 'Empties collected from Metropolis', doc: null },

    // Day 2 - incoming
    { ct: ct19, type: 'incoming_fulls' as const, fulls: 35, empties: 0, day: 2, notes: 'Receipt from IOCL depot - Truck #2', doc: 'REC-004' },
    { ct: ct5,  type: 'incoming_fulls' as const, fulls: 25, empties: 0, day: 2, notes: 'Receipt from IOCL depot - Truck #2', doc: 'REC-004' },
    { ct: ct19, type: 'outgoing_empties' as const, fulls: 0, empties: -25, day: 2, notes: 'Empties returned to IOCL', doc: 'RET-002' },

    // Day 1 - deliveries
    { ct: ct19, type: 'delivery' as const, fulls: -8, empties: 0, day: 1, notes: 'Delivery to Green Valley Caterers', doc: null },
    { ct: ct425, type: 'delivery' as const, fulls: -1, empties: 0, day: 1, notes: 'Bulk delivery to Metropolis Industries', doc: null },
    { ct: ct47, type: 'delivery' as const, fulls: -6, empties: 0, day: 1, notes: 'Delivery to Green Valley Caterers', doc: null },

    // Today - receipt
    { ct: ct19, type: 'incoming_fulls' as const, fulls: 30, empties: 0, day: 0, notes: 'Morning receipt from IOCL depot', doc: 'REC-005' },
    { ct: ct5,  type: 'incoming_fulls' as const, fulls: 15, empties: 0, day: 0, notes: 'Morning receipt from IOCL depot', doc: 'REC-005' },
  ];

  for (const evt of inventoryEvents) {
    await prisma.inventoryEvent.create({
      data: {
        distributorId: distributor.id,
        cylinderTypeId: evt.ct.id,
        eventType: evt.type,
        fullsChange: evt.fulls,
        emptiesChange: evt.empties,
        eventDate: daysAgo(evt.day),
        documentNumber: evt.doc,
        notes: evt.notes,
        createdBy: distAdmin.id,
      },
    });
  }
  console.log('Inventory events created:', inventoryEvents.length);

  // ─── 17. Orders (11 orders in various statuses) ────────────────────────

  // Helper to create order with items
  async function createOrderWithItems(params: {
    orderNumber: string;
    customerId: string;
    driverId?: string;
    vehicleId?: string;
    orderDate: Date;
    deliveryDate: Date;
    status: 'pending_driver_assignment' | 'pending_dispatch' | 'pending_delivery' | 'delivered' | 'cancelled';
    deliveredAt?: Date;
    cancelledAt?: Date;
    cancellationReason?: string;
    items: Array<{ cylinderTypeId: string; quantity: number; unitPrice: number; discountPerUnit?: number; deliveredQuantity?: number; emptiesCollected?: number }>;
  }) {
    const totalAmount = params.items.reduce((sum, item) => sum + (item.unitPrice - (item.discountPerUnit || 0)) * item.quantity, 0);

    const order = await prisma.order.create({
      data: {
        orderNumber: params.orderNumber,
        distributorId: distributor.id,
        customerId: params.customerId,
        driverId: params.driverId || null,
        vehicleId: params.vehicleId || null,
        orderDate: params.orderDate,
        deliveryDate: params.deliveryDate,
        status: params.status,
        totalAmount,
        deliveredAt: params.deliveredAt || null,
        cancelledAt: params.cancelledAt || null,
        cancellationReason: params.cancellationReason || null,
        items: {
          create: params.items.map((item) => ({
            cylinderTypeId: item.cylinderTypeId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountPerUnit: item.discountPerUnit || 0,
            totalPrice: (item.unitPrice - (item.discountPerUnit || 0)) * item.quantity,
            deliveredQuantity: item.deliveredQuantity ?? null,
            emptiesCollected: item.emptiesCollected ?? null,
          })),
        },
      },
      include: { items: true },
    });
    return order;
  }

  // --- 3 Delivered Orders (days 5, 3, 1) ---
  const order1 = await createOrderWithItems({
    orderNumber: 'ORD-001',
    customerId: customers[0].id, // Royal Kitchen
    driverId: drivers[0].id,
    vehicleId: vehicles[0].id,
    orderDate: daysAgo(6),
    deliveryDate: daysAgo(5),
    status: 'delivered',
    deliveredAt: daysAgo(5),
    items: [
      { cylinderTypeId: ct19.id, quantity: 10, unitPrice: 1800, discountPerUnit: 10, deliveredQuantity: 10, emptiesCollected: 8 },
    ],
  });

  const order2 = await createOrderWithItems({
    orderNumber: 'ORD-002',
    customerId: customers[1].id, // Spice Garden
    driverId: drivers[0].id,
    vehicleId: vehicles[0].id,
    orderDate: daysAgo(4),
    deliveryDate: daysAgo(3),
    status: 'delivered',
    deliveredAt: daysAgo(3),
    items: [
      { cylinderTypeId: ct19.id, quantity: 15, unitPrice: 1800, deliveredQuantity: 15, emptiesCollected: 12 },
    ],
  });

  const order3 = await createOrderWithItems({
    orderNumber: 'ORD-003',
    customerId: customers[2].id, // Metropolis Industries
    driverId: drivers[1].id,
    vehicleId: vehicles[1].id,
    orderDate: daysAgo(2),
    deliveryDate: daysAgo(1),
    status: 'delivered',
    deliveredAt: daysAgo(1),
    items: [
      { cylinderTypeId: ct47.id, quantity: 6, unitPrice: 4200, discountPerUnit: 50, deliveredQuantity: 6, emptiesCollected: 5 },
      { cylinderTypeId: ct425.id, quantity: 1, unitPrice: 38000, deliveredQuantity: 1, emptiesCollected: 1 },
    ],
  });

  // --- 2 Dispatched Orders (today, in transit) ---
  const order4 = await createOrderWithItems({
    orderNumber: 'ORD-004',
    customerId: customers[4].id, // Green Valley
    driverId: drivers[0].id,
    vehicleId: vehicles[0].id,
    orderDate: daysAgo(1),
    deliveryDate: today,
    status: 'pending_delivery',
    items: [
      { cylinderTypeId: ct19.id, quantity: 8, unitPrice: 1800 },
      { cylinderTypeId: ct47.id, quantity: 2, unitPrice: 4200 },
    ],
  });

  const order5 = await createOrderWithItems({
    orderNumber: 'ORD-005',
    customerId: customers[3].id, // Lakshmi Mess
    driverId: drivers[1].id,
    vehicleId: vehicles[1].id,
    orderDate: daysAgo(1),
    deliveryDate: today,
    status: 'pending_delivery',
    items: [
      { cylinderTypeId: ct5.id, quantity: 6, unitPrice: 450 },
      { cylinderTypeId: ct19.id, quantity: 4, unitPrice: 1800 },
    ],
  });

  // --- 2 Assigned Orders (driver assigned, not dispatched yet) ---
  const order6 = await createOrderWithItems({
    orderNumber: 'ORD-006',
    customerId: customers[0].id, // Royal Kitchen
    driverId: drivers[0].id,
    vehicleId: vehicles[0].id,
    orderDate: today,
    deliveryDate: today,
    status: 'pending_dispatch',
    items: [
      { cylinderTypeId: ct19.id, quantity: 12, unitPrice: 1800, discountPerUnit: 10 },
    ],
  });

  const order7 = await createOrderWithItems({
    orderNumber: 'ORD-007',
    customerId: customers[2].id, // Metropolis
    driverId: drivers[1].id,
    vehicleId: vehicles[1].id,
    orderDate: today,
    deliveryDate: today,
    status: 'pending_dispatch',
    items: [
      { cylinderTypeId: ct47.id, quantity: 4, unitPrice: 4200, discountPerUnit: 50 },
    ],
  });

  // --- 3 Pending Orders (new, unassigned) ---
  await createOrderWithItems({
    orderNumber: 'ORD-008',
    customerId: customers[1].id, // Spice Garden
    orderDate: today,
    deliveryDate: today,
    status: 'pending_driver_assignment',
    items: [
      { cylinderTypeId: ct19.id, quantity: 20, unitPrice: 1800 },
    ],
  });

  await createOrderWithItems({
    orderNumber: 'ORD-009',
    customerId: customers[4].id, // Green Valley
    orderDate: today,
    deliveryDate: today,
    status: 'pending_driver_assignment',
    items: [
      { cylinderTypeId: ct19.id, quantity: 5, unitPrice: 1800 },
      { cylinderTypeId: ct5.id, quantity: 10, unitPrice: 450 },
    ],
  });

  await createOrderWithItems({
    orderNumber: 'ORD-010',
    customerId: customers[3].id, // Lakshmi Mess
    orderDate: today,
    deliveryDate: today,
    status: 'pending_driver_assignment',
    items: [
      { cylinderTypeId: ct5.id, quantity: 8, unitPrice: 450 },
    ],
  });

  // --- 1 Cancelled Order ---
  await createOrderWithItems({
    orderNumber: 'ORD-011',
    customerId: customers[1].id, // Spice Garden
    orderDate: daysAgo(2),
    deliveryDate: daysAgo(1),
    status: 'cancelled',
    cancelledAt: daysAgo(1),
    cancellationReason: 'Customer requested cancellation - kitchen renovation',
    items: [
      { cylinderTypeId: ct19.id, quantity: 10, unitPrice: 1800 },
    ],
  });

  console.log('Orders created: 11 (3 delivered, 2 dispatched, 2 assigned, 3 pending, 1 cancelled)');

  // ─── 18. Driver-Vehicle Assignments (today) ────────────────────────────

  await prisma.driverVehicleAssignment.create({
    data: {
      driverId: drivers[0].id,
      vehicleId: vehicles[0].id,
      distributorId: distributor.id,
      assignmentDate: today,
      tripNumber: 1,
      status: 'loaded_and_dispatched',
    },
  });

  await prisma.driverVehicleAssignment.create({
    data: {
      driverId: drivers[1].id,
      vehicleId: vehicles[1].id,
      distributorId: distributor.id,
      assignmentDate: today,
      tripNumber: 1,
      status: 'dispatch_ready',
    },
  });

  console.log('Driver-vehicle assignments created: 2');

  // ─── 19. Invoices (for delivered orders) ────────────────────────────────

  // Invoice 1 - Paid (Royal Kitchen, ORD-001)
  const invoice1 = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-001',
      distributorId: distributor.id,
      customerId: customers[0].id,
      orderId: order1.id,
      issueDate: daysAgo(5),
      dueDate: daysAgo(5 - 30), // 30 day credit
      totalAmount: order1.totalAmount,
      amountPaid: order1.totalAmount,
      outstandingAmount: 0,
      status: 'paid',
      items: {
        create: order1.items.map((item) => ({
          cylinderTypeId: item.cylinderTypeId,
          description: `${ct19.typeName} LPG Cylinder`,
          hsnCode: '27111900',
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPerUnit: item.discountPerUnit,
          gstRate: 0,
          totalPrice: item.totalPrice,
        })),
      },
    },
  });

  // Invoice 2 - Paid (Spice Garden, ORD-002)
  const invoice2 = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-002',
      distributorId: distributor.id,
      customerId: customers[1].id,
      orderId: order2.id,
      issueDate: daysAgo(3),
      dueDate: daysAgo(3 - 15), // 15 day credit
      totalAmount: order2.totalAmount,
      amountPaid: order2.totalAmount,
      outstandingAmount: 0,
      status: 'paid',
      items: {
        create: order2.items.map((item) => ({
          cylinderTypeId: item.cylinderTypeId,
          description: `${ct19.typeName} LPG Cylinder`,
          hsnCode: '27111900',
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPerUnit: item.discountPerUnit,
          gstRate: 0,
          totalPrice: item.totalPrice,
        })),
      },
    },
  });

  // Invoice 3 - Partially paid (Metropolis, ORD-003)
  const order3Total = order3.totalAmount;
  const partialPayment = 20000; // Partial payment of 20000 out of total
  const invoice3 = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-003',
      distributorId: distributor.id,
      customerId: customers[2].id,
      orderId: order3.id,
      issueDate: daysAgo(1),
      dueDate: daysAgo(1 - 45), // 45 day credit
      totalAmount: order3Total,
      amountPaid: partialPayment,
      outstandingAmount: order3Total - partialPayment,
      status: 'partially_paid',
      items: {
        create: order3.items.map((item) => ({
          cylinderTypeId: item.cylinderTypeId,
          description: item.cylinderTypeId === ct47.id ? `${ct47.typeName} LPG Cylinder` : `${ct425.typeName} LPG Bulk`,
          hsnCode: '27111900',
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPerUnit: item.discountPerUnit,
          gstRate: 0,
          totalPrice: item.totalPrice,
        })),
      },
    },
  });

  // Invoice 4 - Overdue (a past delivered order scenario - simulate as standalone)
  // We'll create this as an older invoice not linked to a new order (from a prior period)
  const overdueTotal = 9000; // 5 x 19KG = 5 * 1800
  const invoice4 = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-004',
      distributorId: distributor.id,
      customerId: customers[4].id, // Green Valley
      issueDate: daysAgo(25),
      dueDate: daysAgo(25 - 30), // Due was 5 days ago -> already past
      totalAmount: overdueTotal,
      amountPaid: 0,
      outstandingAmount: overdueTotal,
      status: 'overdue',
      items: {
        create: [{
          cylinderTypeId: ct19.id,
          description: `${ct19.typeName} LPG Cylinder`,
          hsnCode: '27111900',
          quantity: 5,
          unitPrice: 1800,
          discountPerUnit: 0,
          gstRate: 0,
          totalPrice: 9000,
        }],
      },
    },
  });

  console.log('Invoices created: 4 (2 paid, 1 partially paid, 1 overdue)');

  // ─── 20. Payment Transactions ───────────────────────────────────────────

  // Payment 1 - Fully allocated to INV-001 (Royal Kitchen)
  const payment1 = await prisma.paymentTransaction.create({
    data: {
      distributorId: distributor.id,
      customerId: customers[0].id,
      amount: order1.totalAmount,
      paymentMethod: 'upi',
      referenceNumber: 'UPI-RK-20260318',
      transactionDate: daysAgo(4),
      allocationStatus: 'fully_allocated',
      notes: 'Payment received via UPI',
    },
  });

  await prisma.paymentAllocation.create({
    data: {
      paymentId: payment1.id,
      invoiceId: invoice1.id,
      allocatedAmount: order1.totalAmount,
    },
  });

  // Payment 2 - Fully allocated to INV-002 (Spice Garden)
  const payment2 = await prisma.paymentTransaction.create({
    data: {
      distributorId: distributor.id,
      customerId: customers[1].id,
      amount: order2.totalAmount,
      paymentMethod: 'bank_transfer',
      referenceNumber: 'NEFT-SG-20260320',
      transactionDate: daysAgo(2),
      allocationStatus: 'fully_allocated',
      notes: 'Bank transfer received',
    },
  });

  await prisma.paymentAllocation.create({
    data: {
      paymentId: payment2.id,
      invoiceId: invoice2.id,
      allocatedAmount: order2.totalAmount,
    },
  });

  // Payment 3 - Partially allocated to INV-003 (Metropolis)
  const payment3 = await prisma.paymentTransaction.create({
    data: {
      distributorId: distributor.id,
      customerId: customers[2].id,
      amount: partialPayment,
      paymentMethod: 'cheque',
      referenceNumber: 'CHQ-MI-445566',
      transactionDate: daysAgo(1),
      allocationStatus: 'fully_allocated',
      notes: 'Cheque payment - partial against INV-003',
    },
  });

  await prisma.paymentAllocation.create({
    data: {
      paymentId: payment3.id,
      invoiceId: invoice3.id,
      allocatedAmount: partialPayment,
    },
  });

  // Payment 4 - Unallocated advance from Lakshmi Mess
  await prisma.paymentTransaction.create({
    data: {
      distributorId: distributor.id,
      customerId: customers[3].id,
      amount: 5000,
      paymentMethod: 'cash',
      transactionDate: today,
      allocationStatus: 'unallocated',
      notes: 'Advance cash payment',
    },
  });

  console.log('Payment transactions created: 4 (2 fully allocated, 1 partially allocated, 1 unallocated)');

  // ─── 21. Customer Inventory Balances ────────────────────────────────────

  const customerBalances = [
    // Royal Kitchen - has 19KG cylinders
    { customerId: customers[0].id, cylinderTypeId: ct19.id, withCustomerQty: 8, pendingReturns: 2 },
    // Spice Garden - has 19KG cylinders
    { customerId: customers[1].id, cylinderTypeId: ct19.id, withCustomerQty: 12, pendingReturns: 0 },
    // Metropolis - has 47.5KG and 425KG
    { customerId: customers[2].id, cylinderTypeId: ct47.id, withCustomerQty: 5, pendingReturns: 1 },
    { customerId: customers[2].id, cylinderTypeId: ct425.id, withCustomerQty: 1, pendingReturns: 0 },
    // Lakshmi Mess - has 5KG cylinders
    { customerId: customers[3].id, cylinderTypeId: ct5.id, withCustomerQty: 4, pendingReturns: 0 },
    { customerId: customers[3].id, cylinderTypeId: ct19.id, withCustomerQty: 2, pendingReturns: 0 },
    // Green Valley - has 19KG and 47.5KG
    { customerId: customers[4].id, cylinderTypeId: ct19.id, withCustomerQty: 6, pendingReturns: 1 },
    { customerId: customers[4].id, cylinderTypeId: ct47.id, withCustomerQty: 3, pendingReturns: 0 },
  ];

  for (const bal of customerBalances) {
    await prisma.customerInventoryBalance.create({
      data: bal,
    });
  }
  console.log('Customer inventory balances created:', customerBalances.length);

  // ─── Pending Actions ──────────────────────────────────────────────────────
  // The notification bell in the header polls /pending-actions?status=open.
  // Without seed rows the bell always reads empty and looks non-functional,
  // so seed a few realistic open actions across modules/severities.
  const pendingActionSeed = [
    {
      module: 'inventory' as const, entityType: 'cylinder_type', entityId: cylinderTypes[1].id,
      actionType: 'low_stock_alert', severity: 'high' as const,
      description: '19 KG cylinders below warning threshold — 8 full remaining',
    },
    {
      module: 'payment' as const, entityType: 'customer', entityId: customers[2].id,
      actionType: 'overdue_followup', severity: 'critical' as const,
      description: 'Metropolis Industries invoice overdue 12 days — follow up for payment',
    },
    {
      module: 'order' as const, entityType: 'customer', entityId: customers[3].id,
      actionType: 'delivery_discrepancy', severity: 'medium' as const,
      description: 'Lakshmi Mess delivery returned 2 fewer empties than expected',
    },
  ];
  for (const pa of pendingActionSeed) {
    await prisma.pendingAction.create({
      data: { distributorId: distributor.id, status: 'open', ...pa },
    });
  }
  console.log('Pending actions created:', pendingActionSeed.length);

  console.log('\n✅ Seed complete! Login credentials:');
  console.log('  Super Admin:    admin@mygaslink.com / Admin@123');
  console.log('  Dist Admin:     bhargava@gasagency.com / Distadmin@123 (GST OFF)');
  console.log('  GST Dist Admin: sharma@gasdist.com / Gstadmin@123 (GST SANDBOX)');
  console.log('  Finance:        finance@gasagency.com / Finance@123');
  console.log('  Inventory:      inventory@gasagency.com / Inventory@123');
  console.log('  Driver:         raju@gasagency.com / Driver@123');
  console.log('  Customer:       royal@kitchen.com / Customer@123');
  } // end if (!bhargavaSeeded) — TRANSACTIONAL TEST DATA FOR BHARGAVA

  // ─── 15. Pricing Tiers ──────────────────────────────────────────────────────
  const tierDefaults = {
    quarterlyDiscount: 5,
    halfYearlyDiscount: 10,
    yearlyDiscount: 15,
    extraSeatPriceAdmin: 299,
    extraSeatPriceDriver: 99,
    customerPortalPrice: 49,
    gstApiOveragePrice: 2,
  };

  await prisma.pricingTier.upsert({
    where: { plan: 'starter' },
    update: {},
    create: {
      plan: 'starter',
      volumeMin: 0,
      volumeMax: 10000,
      monthlyPrice: 4999,
      adminSeats: 1,
      financeSeats: 1,
      inventorySeats: 1,
      driverSeats: 5,
      gstApiCallsIncluded: 1500,
      ...tierDefaults,
    },
  });

  await prisma.pricingTier.upsert({
    where: { plan: 'growth' },
    update: {},
    create: {
      plan: 'growth',
      volumeMin: 10001,
      volumeMax: 30000,
      monthlyPrice: 8999,
      adminSeats: 2,
      financeSeats: 2,
      inventorySeats: 2,
      driverSeats: 12,
      gstApiCallsIncluded: 4000,
      ...tierDefaults,
    },
  });

  await prisma.pricingTier.upsert({
    where: { plan: 'business' },
    update: {},
    create: {
      plan: 'business',
      volumeMin: 30001,
      volumeMax: 70000,
      monthlyPrice: 14999,
      adminSeats: 3,
      financeSeats: 3,
      inventorySeats: 3,
      driverSeats: 25,
      gstApiCallsIncluded: 8000,
      ...tierDefaults,
    },
  });

  await prisma.pricingTier.upsert({
    where: { plan: 'enterprise' },
    update: {},
    create: {
      plan: 'enterprise',
      volumeMin: 70001,
      volumeMax: null,
      monthlyPrice: 19999,
      adminSeats: 5,
      financeSeats: 4,
      inventorySeats: 4,
      driverSeats: 40,
      gstApiCallsIncluded: 15000,
      ...tierDefaults,
    },
  });

  console.log('Pricing tiers seeded: starter, growth, business, enterprise');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
