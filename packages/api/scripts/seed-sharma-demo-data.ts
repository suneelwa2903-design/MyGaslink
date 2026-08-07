/**
 * Seed demo data for Sharma Gas Distributors (dist-002).
 *
 * Adds 12 months of realistic activity — orders, invoices, payments,
 * expenses, deposits, inventory events — so every catalog report has
 * enough data to render meaningfully (charts, trends, rankings).
 *
 * Idempotent: checks for existing marker in Order.specialInstructions.
 * Safe to re-run; skips if already applied.
 *
 * Cleanup: everything is tagged with SEED_MARKER — delete via a
 * companion script (or by hand).
 *
 * Run:
 *   cd packages/api
 *   pnpm exec tsx scripts/seed-sharma-demo-data.ts
 */

import { prisma } from '../src/lib/prisma.js';
import type { PaymentMethod } from '@prisma/client';
import { randomUUID } from 'crypto';

const DISTRIBUTOR_ID = 'dist-002';
const SEED_MARKER = 'SEED_DEMO_2026-08-05_SHARMA';
const START_DATE = new Date('2025-08-01T00:00:00.000Z');
const END_DATE = new Date('2026-08-05T00:00:00.000Z');

// ─── Fixtures — Hyderabad-area realistic names ────────────────────────

const NEW_CUSTOMERS = [
  { name: 'Paradise Biryani House', phone: '9848011001', type: 'B2B' as const },
  { name: 'Chutneys Restaurant', phone: '9848011002', type: 'B2B' as const },
  { name: 'Mehfil Family Restaurant', phone: '9848011003', type: 'B2B' as const },
  { name: 'Bawarchi Restaurant', phone: '9848011004', type: 'B2B' as const },
  { name: 'Shah Ghouse Cafe', phone: '9848011005', type: 'B2B' as const },
  { name: 'Kritunga Restaurant', phone: '9848011006', type: 'B2B' as const },
  { name: 'Nagarjuna Restaurant', phone: '9848011007', type: 'B2B' as const },
  { name: 'Barkas Cafe Kitchen', phone: '9848011008', type: 'B2B' as const },
  { name: 'Sarvi Restaurant', phone: '9848011009', type: 'B2B' as const },
  { name: 'Ohri Group Kitchen', phone: '9848011010', type: 'B2B' as const },
  { name: 'Alpha Hotels Central Kitchen', phone: '9848011011', type: 'B2B' as const },
  { name: 'Ista Hotel Banquets', phone: '9848011012', type: 'B2B' as const },
  { name: 'Green Park Hotel', phone: '9848011013', type: 'B2B' as const },
  { name: 'Taj Krishna Kitchen', phone: '9848011014', type: 'B2B' as const },
  { name: 'ITC Kakatiya Kitchen', phone: '9848011015', type: 'B2B' as const },
  { name: 'Novotel HICC Kitchen', phone: '9848011016', type: 'B2B' as const },
  { name: 'Radisson Blu Kitchen', phone: '9848011017', type: 'B2B' as const },
  { name: 'Marriott Hyderabad Kitchen', phone: '9848011018', type: 'B2B' as const },
  { name: 'Sarojini Devi Hostel', phone: '9848011019', type: 'B2B' as const },
  { name: 'St. Mary\'s College Canteen', phone: '9848011020', type: 'B2B' as const },
  { name: 'BITS Pilani Hyderabad Mess', phone: '9848011021', type: 'B2B' as const },
  { name: 'IIT Hyderabad Central Mess', phone: '9848011022', type: 'B2B' as const },
  { name: 'Osmania University Boys Hostel', phone: '9848011023', type: 'B2B' as const },
  { name: 'Muffakham Jah College Mess', phone: '9848011024', type: 'B2B' as const },
  { name: 'Kailash Iyengar Bakery', phone: '9848011025', type: 'B2B' as const },
  { name: 'Karachi Bakery Central', phone: '9848011026', type: 'B2B' as const },
  { name: 'Almond House Bakery', phone: '9848011027', type: 'B2B' as const },
  { name: 'Concu Patisserie', phone: '9848011028', type: 'B2B' as const },
  { name: 'Sri Krishna Sweets', phone: '9848011029', type: 'B2B' as const },
  { name: 'Ganesh Bhandar Sweets', phone: '9848011030', type: 'B2B' as const },
  { name: 'Rangoli Sweets & Snacks', phone: '9848011031', type: 'B2B' as const },
  { name: 'Ratnadeep Super Market Kitchen', phone: '9848011032', type: 'B2B' as const },
  { name: 'More Megastore Kitchen', phone: '9848011033', type: 'B2B' as const },
  { name: 'Reliance Fresh Kitchen', phone: '9848011034', type: 'B2B' as const },
  { name: 'BigBasket Dark Kitchen', phone: '9848011035', type: 'B2B' as const },
  { name: 'Swiggy Cloud Kitchen — Kondapur', phone: '9848011036', type: 'B2B' as const },
  { name: 'Zomato Kitchen — Gachibowli', phone: '9848011037', type: 'B2B' as const },
  { name: 'Rebel Foods Behrouz — Madhapur', phone: '9848011038', type: 'B2B' as const },
  { name: 'Faasos Kitchen — Kukatpally', phone: '9848011039', type: 'B2B' as const },
  { name: 'Freshmenu Kitchen — Jubilee Hills', phone: '9848011040', type: 'B2B' as const },
];

const NEW_DRIVERS = [
  { driverName: 'Ramesh Reddy', phone: '9701020001', licenseNumber: 'TS0120220001' },
  { driverName: 'Krishna Rao', phone: '9701020002', licenseNumber: 'TS0120220002' },
  { driverName: 'Venkatesh Naidu', phone: '9701020003', licenseNumber: 'TS0120220003' },
  { driverName: 'Suresh Yadav', phone: '9701020004', licenseNumber: 'TS0120220004' },
  { driverName: 'Mahesh Goud', phone: '9701020005', licenseNumber: 'TS0120220005' },
  { driverName: 'Rajesh Kumar', phone: '9701020006', licenseNumber: 'TS0120220006' },
  { driverName: 'Ganesh Prasad', phone: '9701020007', licenseNumber: 'TS0120220007' },
  { driverName: 'Srinivas Reddy', phone: '9701020008', licenseNumber: 'TS0120220008' },
  { driverName: 'Ashok Rao', phone: '9701020009', licenseNumber: 'TS0120220009' },
  { driverName: 'Vinod Kumar', phone: '9701020010', licenseNumber: 'TS0120220010' },
  { driverName: 'Prakash Yadav', phone: '9701020011', licenseNumber: 'TS0120220011' },
  { driverName: 'Mohan Reddy', phone: '9701020012', licenseNumber: 'TS0120220012' },
];

const NEW_VEHICLES = [
  { vehicleNumber: 'TS09EG5001', capacity: 100 },
  { vehicleNumber: 'TS09EG5002', capacity: 100 },
  { vehicleNumber: 'TS09EG5003', capacity: 150 },
  { vehicleNumber: 'TS09EG5004', capacity: 150 },
];

const EXPENSE_CATEGORIES_SEED = [
  { name: 'Fuel (Diesel)', code: 'FUEL', freq: 'daily', amountRange: [800, 2500] as [number, number] },
  { name: 'Vehicle Maintenance', code: 'MAINT', freq: 'weekly', amountRange: [500, 5000] as [number, number] },
  { name: 'Toll Charges', code: 'TOLL', freq: 'daily', amountRange: [100, 400] as [number, number] },
  { name: 'Vehicle Insurance', code: 'INS', freq: 'quarterly', amountRange: [8000, 15000] as [number, number] },
  { name: 'Office Rent', code: 'RENT', freq: 'monthly', amountRange: [45000, 45000] as [number, number] },
  { name: 'Salaries', code: 'SAL', freq: 'monthly', amountRange: [180000, 220000] as [number, number] },
  { name: 'Electricity', code: 'ELEC', freq: 'monthly', amountRange: [8000, 15000] as [number, number] },
  { name: 'Miscellaneous', code: 'MISC', freq: 'weekly', amountRange: [200, 1500] as [number, number] },
];

// ─── Utility functions ────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickWeighted<T>(weightedArr: readonly { item: T; weight: number }[]): T {
  const total = weightedArr.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const w of weightedArr) {
    r -= w.weight;
    if (r <= 0) return w.item;
  }
  return weightedArr[weightedArr.length - 1].item;
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt;
}

// ─── Main seed function ──────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== Sharma Gas (dist-002) demo data seed ===`);
  console.log(`Marker: ${SEED_MARKER}`);
  console.log(`Window: ${dayKey(START_DATE)} → ${dayKey(END_DATE)}\n`);

  // ── Idempotence check ──────────────────────────────────────────────
  // 2026-08-06: the primary block (orders/invoices/payments/expenses/events)
  // still short-circuits when >100 marked orders exist. The secondary block
  // (CNs/DNs/opening balance/accountability/customer inventory balances)
  // ALWAYS runs — it has its own per-marker idempotence.
  const existing = await prisma.order.count({
    where: { distributorId: DISTRIBUTOR_ID, specialInstructions: SEED_MARKER },
  });
  const skipPrimary = existing > 100;
  if (skipPrimary) {
    console.log(`Primary seed already applied (${existing} orders found). Running secondary block only.`);
  }

  // Fixtures ALWAYS run (idempotent per-row by phone/name/code) so the
  // secondary block below has access to allCustomers/allDrivers/etc.
  console.log('Step 1: Ensuring fixtures exist (customers/drivers/vehicles/categories)…');

  // Customers — insert only missing
  const existingCustomers = await prisma.customer.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, customerName: true, phone: true },
  });
  const existingPhones = new Set(existingCustomers.map((c) => c.phone));
  const customersToCreate = NEW_CUSTOMERS.filter((c) => !existingPhones.has(c.phone));
  if (customersToCreate.length > 0) {
    await prisma.customer.createMany({
      data: customersToCreate.map((c) => ({
        id: randomUUID(),
        distributorId: DISTRIBUTOR_ID,
        customerName: c.name,
        phone: c.phone,
        customerType: c.type,
        billingAddressLine1: 'Hyderabad',
        billingCity: 'Hyderabad',
        billingState: 'Telangana',
        creditPeriodDays: 30,
      })),
    });
  }
  console.log(`  Customers: ${customersToCreate.length} added (${existingCustomers.length} existing)`);

  const allCustomers = await prisma.customer.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, customerName: true },
  });

  // Drivers — insert only missing by name
  const existingDrivers = await prisma.driver.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, driverName: true, phone: true },
  });
  const existingDriverPhones = new Set(existingDrivers.map((d) => d.phone));
  const driversToCreate = NEW_DRIVERS.filter((d) => !existingDriverPhones.has(d.phone));
  if (driversToCreate.length > 0) {
    await prisma.driver.createMany({
      data: driversToCreate.map((d) => ({
        id: randomUUID(),
        distributorId: DISTRIBUTOR_ID,
        driverName: d.driverName,
        phone: d.phone,
        licenseNumber: d.licenseNumber,
        // Driver has DriverStatus enum with `active` as default — no isActive bool.
      })),
    });
  }
  console.log(`  Drivers: ${driversToCreate.length} added (${existingDrivers.length} existing)`);

  const allDrivers = await prisma.driver.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, driverName: true },
  });

  // Vehicles — insert only missing by vehicleNumber
  const existingVehicles = await prisma.vehicle.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, vehicleNumber: true },
  });
  const existingVNums = new Set(existingVehicles.map((v) => v.vehicleNumber));
  const vehiclesToCreate = NEW_VEHICLES.filter((v) => !existingVNums.has(v.vehicleNumber));
  if (vehiclesToCreate.length > 0) {
    await prisma.vehicle.createMany({
      data: vehiclesToCreate.map((v) => ({
        id: randomUUID(),
        distributorId: DISTRIBUTOR_ID,
        vehicleNumber: v.vehicleNumber,
        capacity: v.capacity,
        // Vehicle has VehicleStatus enum with `idle` as default — no isActive bool.
      })),
    });
  }
  console.log(`  Vehicles: ${vehiclesToCreate.length} added (${existingVehicles.length} existing)`);

  const allVehicles = await prisma.vehicle.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, vehicleNumber: true },
  });

  // Cylinder types (already seeded — just fetch)
  const cylTypes = await prisma.cylinderType.findMany({
    where: { distributorId: DISTRIBUTOR_ID, isActive: true },
    select: { id: true, typeName: true, capacity: true },
  });
  console.log(`  Cylinder types: ${cylTypes.length} existing`);

  // Expense categories — ensure our seed ones exist
  const existingCats = await prisma.expenseCategory.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, name: true, code: true },
  });
  const existingCatCodes = new Set(existingCats.map((c) => c.code));
  const catsToCreate = EXPENSE_CATEGORIES_SEED.filter((c) => !existingCatCodes.has(c.code));
  if (catsToCreate.length > 0) {
    await prisma.expenseCategory.createMany({
      data: catsToCreate.map((c) => ({
        id: randomUUID(),
        distributorId: DISTRIBUTOR_ID,
        name: c.name,
        code: c.code,
        isActive: true,
      })),
    });
  }
  console.log(`  Expense categories: ${catsToCreate.length} added (${existingCats.length} existing)`);
  const allCats = await prisma.expenseCategory.findMany({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true, name: true, code: true },
  });
  const catByCode = new Map(allCats.map((c) => [c.code, c]));

  // System user for createdBy fields
  const anyUser = await prisma.user.findFirst({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true },
  });
  const creatorId = anyUser?.id ?? 'seed-system';

  // ── Cylinder price seed (needed for line-item totals) ──────────────
  const pricePerCylType = new Map<string, number>();
  for (const ct of cylTypes) {
    // Typical LPG prices — small (5kg) ₹500, large (19kg) ₹2200, jumbo (47kg) ₹5500
    if (ct.capacity <= 5) pricePerCylType.set(ct.id, 500);
    else if (ct.capacity <= 19) pricePerCylType.set(ct.id, 2200);
    else pricePerCylType.set(ct.id, 5500);
  }

  // ── Order + Invoice + Payment generation ───────────────────────────
  if (!skipPrimary) {
  console.log('\nStep 2: Generating 12 months of orders / invoices / payments…');

  const START_MS = START_DATE.getTime();
  const END_MS = END_DATE.getTime();
  const DAY_MS = 86400000;
  const totalDays = Math.floor((END_MS - START_MS) / DAY_MS);

  const orderBatch: Parameters<typeof prisma.order.createMany>[0]['data'] = [];
  const itemBatch: Parameters<typeof prisma.orderItem.createMany>[0]['data'] = [];
  const invoiceBatch: Parameters<typeof prisma.invoice.createMany>[0]['data'] = [];
  const paymentBatch: Parameters<typeof prisma.paymentTransaction.createMany>[0]['data'] = [];
  const eventBatch: Parameters<typeof prisma.inventoryEvent.createMany>[0]['data'] = [];
  const ledgerBatch: Parameters<typeof prisma.customerLedgerEntry.createMany>[0]['data'] = [];
  const expenseBatch: Parameters<typeof prisma.expense.createMany>[0]['data'] = [];

  const paymentMethods: PaymentMethod[] = ['cash', 'upi', 'cheque', 'online', 'bank_transfer'];
  const paymentMethodWeights = [
    { item: 'cash' as PaymentMethod, weight: 40 },
    { item: 'upi' as PaymentMethod, weight: 35 },
    { item: 'cheque' as PaymentMethod, weight: 10 },
    { item: 'online' as PaymentMethod, weight: 10 },
    { item: 'bank_transfer' as PaymentMethod, weight: 5 },
  ];

  let orderSeq = 0;
  let invoiceSeq = 0;

  for (let d = 0; d < totalDays; d++) {
    const day = new Date(START_MS + d * DAY_MS);
    // Skip Sundays for realism
    if (day.getDay() === 0) continue;
    // 3-8 orders per weekday
    const ordersToday = randInt(3, 8);
    for (let i = 0; i < ordersToday; i++) {
      orderSeq++;
      const customer = pick(allCustomers);
      const driver = pick(allDrivers);
      const vehicle = pick(allVehicles);
      const cyl = pick(cylTypes);
      const qty = randInt(1, 5);
      const unitPrice = pricePerCylType.get(cyl.id) ?? 2200;
      const discount = Math.random() < 0.2 ? randInt(50, 200) : 0;
      const lineTotal = (unitPrice - discount) * qty;

      const orderId = randomUUID();
      const orderNumber = `SHM-DEMO-${String(orderSeq).padStart(6, '0')}`;
      // Status distribution: 85% delivered, 8% cancelled, 7% pending
      const rand = Math.random();
      const status = rand < 0.85 ? 'delivered' : rand < 0.93 ? 'cancelled' : 'pending_delivery';
      const tripNumber = randInt(1, 8);

      orderBatch.push({
        id: orderId,
        distributorId: DISTRIBUTOR_ID,
        customerId: customer.id,
        orderNumber,
        orderDate: day,
        deliveryDate: day,
        status: status as 'delivered' | 'cancelled' | 'pending_delivery',
        totalAmount: lineTotal,
        driverId: driver.id,
        vehicleId: vehicle.id,
        tripNumber,
        specialInstructions: SEED_MARKER,
        createdAt: day,
      });
      itemBatch.push({
        id: randomUUID(),
        orderId,
        cylinderTypeId: cyl.id,
        quantity: qty,
        deliveredQuantity: status === 'delivered' ? qty : status === 'cancelled' ? 0 : qty,
        unitPrice,
        totalPrice: lineTotal,
        discountPerUnit: discount,
      });

      // Only delivered orders get invoice + inventory events
      if (status === 'delivered') {
        invoiceSeq++;
        const invId = randomUUID();
        const invNumber = `SHM-INV-${String(invoiceSeq).padStart(6, '0')}`;
        // Payment probability — older orders more likely paid
        const daysAgo = totalDays - d;
        const paidProb = Math.min(0.85, 0.3 + daysAgo / 365);
        const isPaid = Math.random() < paidProb;
        const isPartial = !isPaid && Math.random() < 0.3;
        const amountPaid = isPaid ? lineTotal : isPartial ? Math.floor(lineTotal * randInt(20, 70) / 100) : 0;
        const outstanding = lineTotal - amountPaid;
        const invStatus = amountPaid >= lineTotal ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'issued';

        invoiceBatch.push({
          id: invId,
          distributorId: DISTRIBUTOR_ID,
          customerId: customer.id,
          orderId,
          invoiceNumber: invNumber,
          issueDate: day,
          dueDate: addDays(day, 30),
          totalAmount: lineTotal,
          amountPaid,
          outstandingAmount: outstanding,
          status: invStatus as 'paid' | 'partially_paid' | 'issued',
          createdAt: day,
        });

        // Inventory events: dispatch + delivery + collection
        const commonEvent = {
          distributorId: DISTRIBUTOR_ID,
          cylinderTypeId: cyl.id,
          eventDate: day,
          createdBy: creatorId,
          createdAt: day,
        };
        eventBatch.push(
          { ...commonEvent, id: randomUUID(), eventType: 'dispatch' as const, fullsChange: qty, emptiesChange: 0, referenceId: orderId, referenceType: 'order' },
          { ...commonEvent, id: randomUUID(), eventType: 'delivery' as const, fullsChange: qty, emptiesChange: 0, referenceId: orderId, referenceType: 'order' },
          { ...commonEvent, id: randomUUID(), eventType: 'collection' as const, fullsChange: 0, emptiesChange: randInt(Math.floor(qty * 0.6), qty), referenceId: orderId, referenceType: 'order' },
        );

        // Payment if fully or partially paid
        if (amountPaid > 0) {
          const payDate = addDays(day, randInt(0, 25));
          if (payDate < END_DATE) {
            paymentBatch.push({
              id: randomUUID(),
              distributorId: DISTRIBUTOR_ID,
              customerId: customer.id,
              amount: amountPaid,
              paymentMethod: pickWeighted(paymentMethodWeights),
              transactionDate: payDate,
              referenceNumber: `PAY-${orderSeq}`,
              createdAt: payDate,
            });
          }
        }
      }
    }

    // ── Daily expense: fuel + toll for the day ────────────────────
    if (day.getDay() !== 0) {
      const fuelCat = catByCode.get('FUEL');
      if (fuelCat) {
        expenseBatch.push({
          id: randomUUID(),
          distributorId: DISTRIBUTOR_ID,
          categoryId: fuelCat.id,
          expenseDate: dayKey(day),
          amount: randInt(800, 2500),
          description: `Diesel fill — ${pick(allVehicles).vehicleNumber}`,
          paymentMethod: 'cash',
          vendorName: pick(['HP Petrol Pump', 'Indian Oil Punjagutta', 'Reliance Nampally']),
          vehicleId: pick(allVehicles).id,
          driverId: pick(allDrivers).id,
          createdBy: creatorId,
          createdAt: day,
        });
      }
      const tollCat = catByCode.get('TOLL');
      if (tollCat && Math.random() < 0.6) {
        expenseBatch.push({
          id: randomUUID(),
          distributorId: DISTRIBUTOR_ID,
          categoryId: tollCat.id,
          expenseDate: dayKey(day),
          amount: randInt(100, 400),
          description: 'ORR toll',
          paymentMethod: 'cash',
          vehicleId: pick(allVehicles).id,
          driverId: pick(allDrivers).id,
          createdBy: creatorId,
          createdAt: day,
        });
      }
    }

    // Weekly expense: Maintenance + Misc every Monday
    if (day.getDay() === 1) {
      const maintCat = catByCode.get('MAINT');
      if (maintCat) {
        expenseBatch.push({
          id: randomUUID(),
          distributorId: DISTRIBUTOR_ID,
          categoryId: maintCat.id,
          expenseDate: dayKey(day),
          amount: randInt(500, 5000),
          description: pick(['Oil change', 'Tyre rotation', 'Brake pads', 'Battery service', 'AC gas refill']),
          paymentMethod: pick(['cash', 'upi'] as PaymentMethod[]),
          vendorName: pick(['Modi Motors', 'City Garage', 'Ashok Motor Works']),
          vehicleId: pick(allVehicles).id,
          createdBy: creatorId,
          createdAt: day,
        });
      }
      const miscCat = catByCode.get('MISC');
      if (miscCat) {
        expenseBatch.push({
          id: randomUUID(),
          distributorId: DISTRIBUTOR_ID,
          categoryId: miscCat.id,
          expenseDate: dayKey(day),
          amount: randInt(200, 1500),
          description: pick(['Office supplies', 'Tea + snacks', 'Printer ink', 'Filing charges']),
          paymentMethod: 'cash',
          createdBy: creatorId,
          createdAt: day,
        });
      }
    }

    // Monthly expenses: rent + salaries + electricity on the 1st
    if (day.getDate() === 1) {
      const rentCat = catByCode.get('RENT');
      if (rentCat) {
        expenseBatch.push({
          id: randomUUID(),
          distributorId: DISTRIBUTOR_ID,
          categoryId: rentCat.id,
          expenseDate: dayKey(day),
          amount: 45000,
          description: 'Godown rent',
          paymentMethod: 'bank_transfer',
          vendorName: 'Sharma Properties',
          createdBy: creatorId,
          createdAt: day,
        });
      }
      const salCat = catByCode.get('SAL');
      if (salCat) {
        expenseBatch.push({
          id: randomUUID(),
          distributorId: DISTRIBUTOR_ID,
          categoryId: salCat.id,
          expenseDate: dayKey(day),
          amount: randInt(180000, 220000),
          description: 'Staff salaries',
          paymentMethod: 'bank_transfer',
          createdBy: creatorId,
          createdAt: day,
        });
      }
      const elecCat = catByCode.get('ELEC');
      if (elecCat) {
        expenseBatch.push({
          id: randomUUID(),
          distributorId: DISTRIBUTOR_ID,
          categoryId: elecCat.id,
          expenseDate: dayKey(day),
          amount: randInt(8000, 15000),
          description: 'Telangana State Electricity bill',
          paymentMethod: 'online',
          vendorName: 'TSSPDCL',
          createdBy: creatorId,
          createdAt: day,
        });
      }
    }

    // Quarterly insurance
    if (day.getDate() === 15 && day.getMonth() % 3 === 0) {
      const insCat = catByCode.get('INS');
      if (insCat) {
        for (const veh of allVehicles) {
          expenseBatch.push({
            id: randomUUID(),
            distributorId: DISTRIBUTOR_ID,
            categoryId: insCat.id,
            expenseDate: dayKey(day),
            amount: randInt(8000, 15000),
            description: `Insurance premium ${veh.vehicleNumber}`,
            paymentMethod: 'online',
            vendorName: 'ICICI Lombard',
            vehicleId: veh.id,
            createdBy: creatorId,
            createdAt: day,
          });
        }
      }
    }
  }

  console.log(`\n  Batches prepared:`);
  console.log(`    Orders:      ${orderBatch.length}`);
  console.log(`    Items:       ${itemBatch.length}`);
  console.log(`    Invoices:    ${invoiceBatch.length}`);
  console.log(`    Payments:    ${paymentBatch.length}`);
  console.log(`    Events:      ${eventBatch.length}`);
  console.log(`    Expenses:    ${expenseBatch.length}`);

  // ── Deposit ledger entries — 30 charged, 5 refunded, spread across the year ─
  console.log('\nStep 3: Deposit ledger entries…');
  const depositCustomers = allCustomers.slice(0, 30);
  for (const cust of depositCustomers) {
    const depDay = new Date(START_MS + Math.floor(Math.random() * totalDays) * DAY_MS);
    const cyl = pick(cylTypes);
    const depQty = randInt(2, 6);
    const depAmt = 1500 * depQty; // ₹1500 per cylinder deposit
    ledgerBatch.push({
      id: randomUUID(),
      distributorId: DISTRIBUTOR_ID,
      customerId: cust.id,
      entryType: 'deposit_charged',
      referenceId: `dep-charged-${cust.id}`,
      amountDelta: depAmt,
      entryDate: depDay,
      cylinderTypeId: cyl.id,
      qtyDelta: depQty,
      narration: 'Cylinder deposit collected',
      createdBy: creatorId,
      createdAt: depDay,
    });
  }
  // 5 refunds
  for (const cust of depositCustomers.slice(0, 5)) {
    const refDay = new Date(START_MS + Math.floor((totalDays / 2) + Math.random() * (totalDays / 2)) * DAY_MS);
    const cyl = pick(cylTypes);
    const refQty = randInt(1, 2);
    const refAmt = -1500 * refQty;
    ledgerBatch.push({
      id: randomUUID(),
      distributorId: DISTRIBUTOR_ID,
      customerId: cust.id,
      entryType: 'deposit_refunded',
      referenceId: `dep-refunded-${cust.id}`,
      amountDelta: refAmt,
      entryDate: refDay,
      cylinderTypeId: cyl.id,
      qtyDelta: -refQty,
      narration: 'Cylinder deposit refunded (customer closure)',
      createdBy: creatorId,
      createdAt: refDay,
    });
  }
  console.log(`    Deposit entries: ${ledgerBatch.length}`);

  // ── Batched inserts (createMany in chunks) ─────────────────────────
  console.log('\nStep 4: Inserting to DB (batched)…');

  async function insertChunked<T extends { id?: string }>(name: string, arr: T[], fn: (chunk: T[]) => Promise<{ count: number }>): Promise<void> {
    const CHUNK = 200;
    let inserted = 0;
    for (let i = 0; i < arr.length; i += CHUNK) {
      const chunk = arr.slice(i, i + CHUNK);
      const result = await fn(chunk);
      inserted += result.count;
    }
    console.log(`    ${name}: ${inserted}`);
  }

  await insertChunked('Orders', orderBatch, (c) => prisma.order.createMany({ data: c }));
  await insertChunked('Items', itemBatch, (c) => prisma.orderItem.createMany({ data: c }));
  await insertChunked('Invoices', invoiceBatch, (c) => prisma.invoice.createMany({ data: c }));
  await insertChunked('Payments', paymentBatch, (c) => prisma.paymentTransaction.createMany({ data: c }));
  await insertChunked('Events', eventBatch, (c) => prisma.inventoryEvent.createMany({ data: c }));
  await insertChunked('Expenses', expenseBatch, (c) => prisma.expense.createMany({ data: c }));
  await insertChunked('Ledger', ledgerBatch, (c) => prisma.customerLedgerEntry.createMany({ data: c }));
  }
  // ─── SECONDARY BLOCK (2026-08-06 · Fix 2) ────────────────────────────
  // Populate the tables the primary block missed: credit_notes, debit_notes,
  // opening-balance invoices, accountability_logs, customer_inventory_balances.
  // Each sub-step has its own idempotence check via a marker on the row.
  console.log('\n── Secondary block (CN / DN / OB / Accountability / Balances) ──');

  const CN_MARKER = `${SEED_MARKER}-CN`;
  const DN_MARKER = `${SEED_MARKER}-DN`;
  const OB_MARKER = `${SEED_MARKER}-OB`;
  const ACC_MARKER = `${SEED_MARKER}-ACC`;

  // 1. Credit Notes — pick 30 recent delivered invoices, credit some/all of them.
  const existingCns = await prisma.creditNote.count({ where: { reason: { contains: CN_MARKER } } });
  if (existingCns > 0) {
    console.log(`  Credit Notes: skipped (${existingCns} existing marked rows)`);
  } else {
    const cnInvoices = await prisma.invoice.findMany({
      where: { distributorId: DISTRIBUTOR_ID, status: { in: ['paid', 'partially_paid'] }, deletedAt: null },
      orderBy: { issueDate: 'desc' },
      take: 30,
      select: { id: true, totalAmount: true, issueDate: true },
    });
    const cnStatuses = ['pending_cn', 'approved_cn', 'issued', 'rejected_cn'] as const;
    const cnReasons = [
      'Damaged cylinder returned',
      'Rate correction — discount not applied',
      'Duplicate billing',
      'Short delivery — 1 cylinder shortfall',
      'Customer dispute resolved in favor of buyer',
    ];
    const cnBatch: Parameters<typeof prisma.creditNote.createMany>[0]['data'] = [];
    let cnSeq = 0;
    for (const inv of cnInvoices) {
      cnSeq++;
      const total = Number(inv.totalAmount);
      const cnAmt = Math.random() < 0.3 ? total : Math.round(total * (0.1 + Math.random() * 0.5));
      cnBatch.push({
        id: randomUUID(),
        invoiceId: inv.id,
        creditNoteNumber: `SHM-CN-${String(cnSeq).padStart(4, '0')}`,
        totalAmount: cnAmt,
        reason: `${pick(cnReasons)} — ${CN_MARKER}`,
        status: pick(cnStatuses),
        issueDate: inv.issueDate,
      });
    }
    if (cnBatch.length > 0) {
      await prisma.creditNote.createMany({ data: cnBatch });
    }
    console.log(`  Credit Notes: ${cnBatch.length} inserted`);
  }

  // 2. Debit Notes — pick 15 delivered invoices, add debit for extra charges.
  const existingDns = await prisma.debitNote.count({ where: { reason: { contains: DN_MARKER } } });
  if (existingDns > 0) {
    console.log(`  Debit Notes: skipped (${existingDns} existing marked rows)`);
  } else {
    const dnInvoices = await prisma.invoice.findMany({
      where: { distributorId: DISTRIBUTOR_ID, status: 'paid', deletedAt: null },
      orderBy: { issueDate: 'desc' },
      take: 15,
      skip: 5,
      select: { id: true, totalAmount: true, issueDate: true },
    });
    const dnStatuses = ['pending_dn', 'approved_dn', 'issued_dn', 'rejected_dn'] as const;
    const dnReasons = [
      'Additional delivery charge — after-hours',
      'Missed toll billed separately',
      'GST rate revision back-charge',
      'Extra empties handling fee',
      'Late collection surcharge',
    ];
    const dnBatch: Parameters<typeof prisma.debitNote.createMany>[0]['data'] = [];
    let dnSeq = 0;
    for (const inv of dnInvoices) {
      dnSeq++;
      const dnAmt = randInt(100, 2500);
      dnBatch.push({
        id: randomUUID(),
        invoiceId: inv.id,
        debitNoteNumber: `SHM-DN-${String(dnSeq).padStart(4, '0')}`,
        totalAmount: dnAmt,
        reason: `${pick(dnReasons)} — ${DN_MARKER}`,
        status: pick(dnStatuses),
        issueDate: inv.issueDate,
      });
    }
    if (dnBatch.length > 0) {
      await prisma.debitNote.createMany({ data: dnBatch });
    }
    console.log(`  Debit Notes: ${dnBatch.length} inserted`);
  }

  // 3. Opening Balance Certificates — mark 8 synthetic invoices as opening.
  // These represent pre-go-live debt seeded at Sharma's ledger start.
  const existingObs = await prisma.invoice.count({
    where: { distributorId: DISTRIBUTOR_ID, isOpeningBalance: true, invoiceNumber: { contains: 'OB' } },
  });
  if (existingObs > 0) {
    console.log(`  Opening Balance certs: skipped (${existingObs} existing)`);
  } else {
    const obCustomers = await prisma.customer.findMany({
      where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
      take: 8,
      select: { id: true },
    });
    const obBatch: Parameters<typeof prisma.invoice.createMany>[0]['data'] = [];
    let obSeq = 0;
    const obDate = new Date('2025-08-01T00:00:00.000Z'); // go-live date
    for (const cust of obCustomers) {
      obSeq++;
      const amount = randInt(5000, 50000);
      const paid = Math.random() < 0.4 ? amount : Math.floor(amount * Math.random() * 0.6);
      const outstanding = amount - paid;
      obBatch.push({
        id: randomUUID(),
        distributorId: DISTRIBUTOR_ID,
        customerId: cust.id,
        invoiceNumber: `SHM-OB-${String(obSeq).padStart(4, '0')}`,
        issueDate: obDate,
        dueDate: obDate,
        totalAmount: amount,
        amountPaid: paid,
        outstandingAmount: outstanding,
        status: paid >= amount ? 'paid' : paid > 0 ? 'partially_paid' : 'issued',
        isOpeningBalance: true,
        createdAt: obDate,
      });
    }
    if (obBatch.length > 0) {
      await prisma.invoice.createMany({ data: obBatch });
    }
    console.log(`  Opening Balance certs: ${obBatch.length} inserted`);
  }

  // 4. Accountability Logs — spread across the year with mixed types + statuses.
  const existingAccs = await prisma.accountabilityLog.count({
    where: { distributorId: DISTRIBUTOR_ID, description: { contains: ACC_MARKER } },
  });
  if (existingAccs > 0) {
    console.log(`  Accountability Logs: skipped (${existingAccs} existing marked rows)`);
  } else {
    const accTypes = ['lost_cylinder', 'damaged_cylinder', 'missing_cylinder', 'delivery_shortage', 'customer_dispute'] as const;
    const accStatuses = ['open_accountability', 'investigating', 'resolved_recovered', 'resolved_written_off', 'resolved_charged', 'closed'] as const;
    const accDescriptions: Record<typeof accTypes[number], string[]> = {
      lost_cylinder: ['Cylinder lost during return trip', 'Empty not returned by customer', 'Cylinder unaccounted after night trip'],
      damaged_cylinder: ['Valve damaged in transit', 'Body dent — customer refused', 'Regulator broken on delivery'],
      missing_cylinder: ['Cylinder count short at depot reconciliation', 'One cylinder missing after route return'],
      delivery_shortage: ['Delivered 4 instead of 5 (customer complaint)', '1 cylinder short — driver noted en-route'],
      customer_dispute: ['Customer says received 3, invoiced 4', 'Discount not honoured — under review'],
    };
    // Cross-tenant-safe local pools (dist-002 only)
    const accLocalCustomers = await prisma.customer.findMany({ where: { distributorId: DISTRIBUTOR_ID, deletedAt: null }, take: 20, select: { id: true } });
    const accLocalDrivers = await prisma.driver.findMany({ where: { distributorId: DISTRIBUTOR_ID, deletedAt: null }, select: { id: true } });
    const accLocalCyls = await prisma.cylinderType.findMany({ where: { distributorId: DISTRIBUTOR_ID, isActive: true }, select: { id: true } });
    const accBatch: Parameters<typeof prisma.accountabilityLog.createMany>[0]['data'] = [];
    for (let i = 0; i < 20; i++) {
      const type = pick(accTypes);
      const status = pick(accStatuses);
      const dayOffset = randInt(0, 365);
      const incidentDate = new Date(START_DATE.getTime() + dayOffset * 86400000);
      const qty = randInt(1, 3);
      accBatch.push({
        id: randomUUID(),
        distributorId: DISTRIBUTOR_ID,
        driverId: accLocalDrivers.length > 0 ? pick(accLocalDrivers).id : null,
        customerId: accLocalCustomers.length > 0 ? pick(accLocalCustomers).id : null,
        cylinderTypeId: accLocalCyls.length > 0 ? pick(accLocalCyls).id : null,
        incidentType: type,
        incidentDate,
        quantity: qty,
        costAmount: type === 'lost_cylinder' ? 1500 * qty : type === 'damaged_cylinder' ? 500 * qty : 0,
        description: `${pick(accDescriptions[type])} — ${ACC_MARKER}`,
        status,
        resolutionNotes: status.startsWith('resolved') || status === 'closed' ? 'Charged to driver salary as per policy' : null,
      });
    }
    if (accBatch.length > 0) {
      await prisma.accountabilityLog.createMany({ data: accBatch });
    }
    console.log(`  Accountability Logs: ${accBatch.length} inserted`);
  }

  // 5. Customer Inventory Balances — derive from delivered orders so
  // Cylinder Rotation + Empties in Transit reports have data.
  // Compute (customer, cyl) → net fulls delivered minus empties collected;
  // upsert one row per pair with withCustomerQty = max(0, net).
  const existingBalances = await prisma.customerInventoryBalance.count({
    where: { customer: { distributorId: DISTRIBUTOR_ID } },
  });
  if (existingBalances > 0) {
    console.log(`  Customer Inventory Balances: skipped (${existingBalances} existing rows)`);
  } else {
    const deliveredOrders = await prisma.order.findMany({
      where: { distributorId: DISTRIBUTOR_ID, status: 'delivered', deletedAt: null },
      select: { id: true, customerId: true, items: { select: { cylinderTypeId: true, deliveredQuantity: true, quantity: true } } },
    });
    // key = customerId|cylTypeId → net qty (fulls delivered assumed as
    // outstanding-with-customer for the demo; real system tracks empties
    // collection separately, but for report visibility a modest positive
    // balance per (cust, cyl) is what matters).
    const netByPair = new Map<string, { customerId: string; cylinderTypeId: string; qty: number }>();
    for (const o of deliveredOrders) {
      for (const it of o.items) {
        const k = `${o.customerId}|${it.cylinderTypeId}`;
        const cur = netByPair.get(k) ?? { customerId: o.customerId, cylinderTypeId: it.cylinderTypeId, qty: 0 };
        cur.qty += it.deliveredQuantity ?? it.quantity;
        netByPair.set(k, cur);
      }
    }
    // Only surface a fraction as "still with customer" — realistic ratio
    // (most cylinders come back same-day, some don't). Randomly 5-20% of
    // total delivered stays outstanding per pair.
    const balanceBatch: Parameters<typeof prisma.customerInventoryBalance.createMany>[0]['data'] = [];
    for (const pair of netByPair.values()) {
      const outstandingFrac = 0.05 + Math.random() * 0.15;
      const withCustomer = Math.max(0, Math.floor(pair.qty * outstandingFrac));
      if (withCustomer === 0) continue;
      balanceBatch.push({
        id: randomUUID(),
        customerId: pair.customerId,
        cylinderTypeId: pair.cylinderTypeId,
        withCustomerQty: withCustomer,
        pendingReturns: Math.random() < 0.15 ? randInt(1, 2) : 0,
        missingQty: Math.random() < 0.05 ? 1 : 0,
      });
    }
    if (balanceBatch.length > 0) {
      // Chunk to avoid huge single insert
      const CHUNK = 200;
      let inserted = 0;
      for (let i = 0; i < balanceBatch.length; i += CHUNK) {
        const result = await prisma.customerInventoryBalance.createMany({
          data: balanceBatch.slice(i, i + CHUNK),
          skipDuplicates: true, // uniq on (customerId, cylinderTypeId)
        });
        inserted += result.count;
      }
      console.log(`  Customer Inventory Balances: ${inserted} inserted`);
    } else {
      console.log(`  Customer Inventory Balances: 0 (no delivered orders to derive from)`);
    }
  }

  // 6. Stock-Adjustment events — realistic monthly reconciliation deltas.
  // Uses eventType 'manual_adjustment' with a mix of positive/negative
  // fullsChange / emptiesChange and human-readable notes. Reference type
  // is NULL (matches the stock-audit report's include filter).
  const existingAdjs = await prisma.inventoryEvent.count({
    where: {
      distributorId: DISTRIBUTOR_ID,
      eventType: 'manual_adjustment',
      notes: { contains: ACC_MARKER.replace('-ACC', '-ADJ') },
    },
  });
  const ADJ_MARKER = SEED_MARKER + '-ADJ';
  if (existingAdjs > 0) {
    console.log(`  Stock Adjustments: skipped (${existingAdjs} existing marked rows)`);
  } else {
    const adjReasons = [
      'Monthly physical count reconciliation — 2 fulls short',
      'Damaged cylinder pending write-off',
      'Depot recount — found 1 empty behind rack',
      'Corrected mis-classified return (was empties, actually fulls)',
      'Physical count matched — no delta (audit trail entry)',
      'Wrote off 1 valve-damaged cylinder',
      'Recovered 3 empties from customer premises after route reconciliation',
      'Corrected data entry error in dispatch log',
      'Physical stock count — 1 full missing',
      'Recovered 2 fulls that were mis-scanned as empties',
    ];
    const adjLocalCyls = await prisma.cylinderType.findMany({
      where: { distributorId: DISTRIBUTOR_ID, isActive: true },
      select: { id: true },
    });
    const adjBatch: Parameters<typeof prisma.inventoryEvent.createMany>[0]['data'] = [];
    let adjSeq = 0;
    for (let i = 0; i < 15; i++) {
      adjSeq++;
      // Spread across the last 12 months, cluster at month-ends (typical
      // reconciliation cadence).
      const dayOffset = randInt(0, 365);
      const eventDate = new Date(START_DATE.getTime() + dayOffset * 86400000);
      // 60% adjust fulls, 40% adjust empties. 60% negative, 40% positive.
      const isFulls = Math.random() < 0.6;
      const magnitude = randInt(1, 5);
      const sign = Math.random() < 0.6 ? -1 : 1;
      adjBatch.push({
        id: randomUUID(),
        distributorId: DISTRIBUTOR_ID,
        cylinderTypeId: adjLocalCyls.length > 0 ? pick(adjLocalCyls).id : '',
        eventType: 'manual_adjustment',
        fullsChange: isFulls ? sign * magnitude : 0,
        emptiesChange: isFulls ? 0 : sign * magnitude,
        eventDate,
        documentNumber: `ADJ-${String(adjSeq).padStart(4, '0')}`,
        notes: `${pick(adjReasons)} — ${ADJ_MARKER}`,
        createdBy: creatorId,
        createdAt: eventDate,
      });
    }
    if (adjBatch.length > 0) {
      await prisma.inventoryEvent.createMany({ data: adjBatch });
    }
    console.log(`  Stock Adjustments: ${adjBatch.length} inserted`);
  }

  // 7. CustomerCylinderDiscount configs — per (customer, cyl) rates so the
  // Rate Variance / Discount Leakage report has something to compare.
  // Actual delivered-order discounts vary (0-200/unit per seed) so most
  // configured discounts here (200-500/unit) will show as leakage-negative
  // (configured > actual), which is the boring healthy case. A couple are
  // set LOW so at least one row shows positive variance (leakage).
  const existingDiscConfigs = await prisma.customerCylinderDiscount.count({
    where: { customer: { distributorId: DISTRIBUTOR_ID } },
  });
  if (existingDiscConfigs > 0) {
    console.log(`  CustomerCylinderDiscount configs: skipped (${existingDiscConfigs} existing rows)`);
  } else {
    const discCustomers = await prisma.customer.findMany({
      where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
      take: 15,
      select: { id: true },
    });
    const discCyls = await prisma.cylinderType.findMany({
      where: { distributorId: DISTRIBUTOR_ID, isActive: true },
      select: { id: true },
    });
    const discBatch: Parameters<typeof prisma.customerCylinderDiscount.createMany>[0]['data'] = [];
    for (let i = 0; i < discCustomers.length; i++) {
      const cust = discCustomers[i];
      const cyl = discCyls.length > 0 ? pick(discCyls) : null;
      if (!cyl) continue;
      // First 12 rows: healthy — configured ≥ actual (variance <= 0)
      // Last 3 rows: leakage — configured LOW (₹50/unit) but actual is
      // higher (0-200/unit seeded), so variance > 0 → margin leak.
      const configured = i < 12 ? randInt(200, 500) : 50;
      discBatch.push({
        id: randomUUID(),
        customerId: cust.id,
        cylinderTypeId: cyl.id,
        discountPerUnit: configured,
      });
    }
    if (discBatch.length > 0) {
      await prisma.customerCylinderDiscount.createMany({
        data: discBatch,
        skipDuplicates: true, // uniq on (customerId, cylinderTypeId)
      });
    }
    console.log(`  CustomerCylinderDiscount configs: ${discBatch.length} inserted`);
  }

  // 8. Backdated orders — inserted via the real backdated service so the
  // 2026-08-06 auto-inventory-adjustment fires. Yields ~30 orders scattered
  // across the last month (backdated schema only allows current month +
  // grace window), each with driver + vehicle + tripNumber so Vehicle
  // Ledger + Driver Daily Log show them properly.
  const BACKDATED_MARKER = SEED_MARKER + '-BACKDATED';
  const existingBackdated = await prisma.order.count({
    where: {
      distributorId: DISTRIBUTOR_ID,
      isBackdated: true,
      specialInstructions: { contains: BACKDATED_MARKER },
    },
  });
  if (existingBackdated > 0) {
    console.log(`  Backdated orders: skipped (${existingBackdated} existing marked rows)`);
  } else {
    const { createBackdatedOrder } = await import('../src/services/backdatedOrderService.js');
    const bdCustomers = await prisma.customer.findMany({
      where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
      take: 30,
      select: { id: true },
    });
    const bdDrivers = await prisma.driver.findMany({
      where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
      take: 5,
      select: { id: true },
    });
    const bdVehicles = await prisma.vehicle.findMany({
      where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
      take: 4,
      select: { id: true },
    });
    const bdCyls = await prisma.cylinderType.findMany({
      where: { distributorId: DISTRIBUTOR_ID, isActive: true },
      select: { id: true },
    });
    // Backdated schema requires (this month || first-10-days grace window
    // pointing at previous month). Emit dates over the last 25 days to
    // safely land inside both. Skip today (must be strictly before).
    const now = new Date();
    const bdDates: string[] = [];
    for (let daysBack = 25; daysBack >= 1; daysBack--) {
      const d = new Date(now.getTime() - daysBack * 86400000);
      bdDates.push(d.toISOString().slice(0, 10));
    }

    let bdInserted = 0;
    let bdFailed = 0;
    const anyAdminUser = await prisma.user.findFirst({
      where: { distributorId: DISTRIBUTOR_ID, role: 'distributor_admin', deletedAt: null },
      select: { id: true },
    });
    const bdCreator = anyAdminUser?.id ?? creatorId;

    for (let i = 0; i < 30; i++) {
      const cust = pick(bdCustomers);
      const drv = pick(bdDrivers);
      const veh = pick(bdVehicles);
      const cyl = pick(bdCyls);
      const qty = randInt(1, 4);
      const empties = Math.max(0, qty - randInt(0, 2)); // usually returns most fulls
      const issueDate = pick(bdDates);
      try {
        await createBackdatedOrder(DISTRIBUTOR_ID, bdCreator, {
          customerId: cust.id,
          issueDate,
          items: [{ cylinderTypeId: cyl.id, quantity: qty, emptiesCollected: empties }],
          driverId: drv.id,
          vehicleId: veh.id,
          tripNumber: randInt(1, 2),
          specialInstructions: `Backdated demo entry — ${BACKDATED_MARKER}`,
        });
        bdInserted++;
      } catch (err) {
        bdFailed++;
        if (bdFailed <= 3) {
          console.log(`    Backdated order ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    console.log(`  Backdated orders: ${bdInserted} inserted (${bdFailed} failed)`);
  }

  console.log(`\n✅ Seed complete.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
