/**
 * Seed a BRAND NEW, clean, GST-enabled distributor: "Vijaya Gas Services"
 * (id: dist-vijaya).
 *
 * Unlike seed-sharma-demo-data.ts (which deliberately seeds a messy 12-month
 * dataset with negative reconciliation deltas), this script produces a CLEAN
 * distributor whose depot inventory reconciles to strictly non-negative
 * closing fulls + empties. Every delivered order emits the full InventoryEvent
 * chain (dispatch + delivery + collection + reconciliation_empties_return)
 * per CLAUDE.md anti-pattern #26, and enough incoming fulls are purchased up
 * front to cover all dispatch.
 *
 * All GST e-invoice fields (IRN / EWB / signed QR) are MOCK values written
 * directly to the DB — this script NEVER calls NIC / WhiteBooks.
 *
 * Idempotent: deletes ALL dist-vijaya data (FK-safe order) at the top, then
 * recreates from scratch. Safe to re-run.
 *
 * Run:
 *   cd packages/api
 *   npx tsx scripts/seed-new-distributor.ts
 */

import { prisma } from '../src/lib/prisma.js';
import { recalculateSummariesFromDate } from '../src/services/inventoryService.js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────
const DIST_ID = 'dist-vijaya';
const PASSWORD = 'Demo@1234';
const HSN = '27111900';
const GST_RATE = 18; // percent, GST-inclusive convention (anti-pattern #16)

// This month, days 1..12 (today = 2026-08-12). All dates are UTC-midnight so
// they map cleanly onto Prisma @db.Date columns and computeSummaryForDate's
// exact-date event aggregation.
const YEAR = 2026;
const MONTH0 = 7; // August (0-indexed)

/** UTC-midnight Date for a given day-of-month in the seed month. */
function d(day: number): Date {
  return new Date(Date.UTC(YEAR, MONTH0, day));
}
/** YYYY-MM-DD string for a day (used by PurchaseEntry.purchaseDate: String). */
function ds(day: number): string {
  return d(day).toISOString().slice(0, 10);
}

// ─── Mock GST document field generators (NO NIC calls) ─────────────────────
function mockIrn(): string {
  // NIC IRN is a 64-char lowercase hex hash.
  return randomBytes(32).toString('hex');
}
function mockAckNo(): string {
  // NIC AckNo is a ~15-digit numeric string.
  return '112' + String(Math.floor(1e11 + Math.random() * 8e11));
}
function mockSignedQr(): string {
  // Real signed QR is a long JWT; a base64 blob is a faithful-enough mock.
  return 'eyJ' + randomBytes(150).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
function mockEwbNo(): string {
  // NIC EWB number is 12 digits.
  return String(Math.floor(1e11 + Math.random() * 8.9e11));
}

/** GST split for a GST-INCLUSIVE total (intra-state → CGST+SGST). */
function gstSplit(totalIncl: number, rate = GST_RATE) {
  const taxable = totalIncl / (1 + rate / 100);
  const tax = totalIncl - taxable;
  return {
    taxable: round2(taxable),
    cgst: round2(tax / 2),
    sgst: round2(tax / 2),
    igst: 0,
  };
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  console.log('\n=== Seeding CLEAN GST distributor: Vijaya Gas Services (dist-vijaya) ===\n');

  // ─── 0. DELETE existing dist-vijaya data (FK-safe order) ─────────────────
  // Every deleteMany is a no-op on a fresh DB (returns count 0). Order matters
  // only for foreign-key constraints. Children first, distributor last.
  console.log('Step 0: Clearing any existing dist-vijaya data…');
  await prisma.paymentAllocation.deleteMany({ where: { payment: { distributorId: DIST_ID } } });
  await prisma.gstDocument.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.paymentSubmission.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.invoice.deleteMany({ where: { distributorId: DIST_ID } }); // cascades InvoiceItem
  await prisma.order.deleteMany({ where: { distributorId: DIST_ID } });   // cascades OrderItem
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.customerInventoryBalance.deleteMany({ where: { customer: { distributorId: DIST_ID } } });
  await prisma.customerLedgerEntry.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.customerCylinderDiscount.deleteMany({ where: { customer: { distributorId: DIST_ID } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.pendingAction.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.purchaseEntryItem.deleteMany({ where: { purchaseEntry: { distributorId: DIST_ID } } });
  await prisma.purchaseEntry.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.sourceDistributor.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.cylinderThreshold.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.cylinderPrice.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.emptyCylinderPrice.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.gstCredential.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.expenseCategory.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.distributorSetting.deleteMany({ where: { distributorId: DIST_ID } });
  // Null out Driver.userId so deleting the User rows isn't blocked by the FK.
  await prisma.driver.updateMany({ where: { distributorId: DIST_ID }, data: { userId: null } });
  await prisma.user.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.customerGroupMember.deleteMany({ where: { group: { distributorId: DIST_ID } } });
  await prisma.customerGroup.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.customer.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.driver.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.vehicle.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.cylinderType.deleteMany({ where: { distributorId: DIST_ID } });
  await prisma.distributor.deleteMany({ where: { id: DIST_ID } });
  console.log('  Cleared.\n');

  const pwHash = await bcrypt.hash(PASSWORD, 12);

  // ─── 1. GST reference data (idempotent, platform-level) ──────────────────
  await prisma.gstState.upsert({
    where: { stateCode: '36' }, update: {}, create: { stateCode: '36', stateName: 'Telangana' },
  });
  await prisma.hsnCode.upsert({
    where: { hsnCode: HSN }, update: {},
    create: { hsnCode: HSN, description: 'Liquefied petroleum gases (LPG)' },
  });

  // ─── 2. Distributor (GST-enabled, sandbox demo) ──────────────────────────
  // gstMode='sandbox' turns on the GST UI. The sandbox value is only valid on
  // an internal test tenant (Group A guard), so isTestTenant=true is required.
  const distributor = await prisma.distributor.create({
    data: {
      id: DIST_ID,
      businessName: 'Vijaya Gas Services',
      legalName: 'Vijaya Gas Services Pvt Ltd',
      gstin: '36AABCV1234V1Z8', // 15-char, Telangana (state code 36)
      address: '14-72 Kondapur Main Road, Hyderabad',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500084',
      phone: '9848100100',
      email: 'admin@vijaya.com',
      status: 'active',
      gstMode: 'sandbox',
      isTestTenant: true, // required for sandbox gstMode (Group A guard)
      accountType: 'distributor',
      docCode: 'VJY', // WI-108 document-numbering tenant code
      providerCodes: ['IOCL'],
      subscriptionPlan: 'business',
      billingTier: 'tier_3',
      gaslinkBillingEnabled: false,
      goLiveDate: new Date(Date.UTC(YEAR, MONTH0, 1)),
      godownAddress: 'Plot 22, IDA Kukatpally, Hyderabad',
      godownCity: 'Hyderabad',
      godownState: 'Telangana',
      godownPincode: '500037',
      bankName: 'HDFC Bank',
      bankAccountNumber: '50200012345678',
      bankBranchName: 'Kondapur',
      ifscCode: 'HDFC0001234',
      upiId: 'vijayagas@hdfcbank',
    },
  });
  console.log('Distributor created:', distributor.businessName, `(${distributor.id})`);

  // System expense taxonomy (mirrors prisma/seed.ts). Best-effort.
  try {
    const { seedSystemExpenseCategoriesForDistributor } = await import(
      '../src/services/expenseCategoryService.js'
    );
    await seedSystemExpenseCategoriesForDistributor(distributor.id);
    console.log('  Expense categories seeded.');
  } catch (e) {
    console.log('  (Skipped expense-category seed:', e instanceof Error ? e.message : String(e), ')');
  }

  // ─── 3. Source distributor (OMC = IOCL) ──────────────────────────────────
  const source = await prisma.sourceDistributor.create({
    data: { distributorId: DIST_ID, name: 'Indian Oil Corporation (IOCL) Depot' },
  });
  console.log('Source distributor (OMC):', source.name);

  // ─── 4. Cylinder types + prices (GST-inclusive) ──────────────────────────
  // shortName is used to link the global provider catalog (seeded by
  // prisma/seed.ts) if present; the link is optional (nullable FK).
  const cylSpecs = [
    { typeName: '19 KG',   capacity: 19,   shortName: '19KG',   price: 2200, purchaseCost: 1900, warning: 20, critical: 5, emptyPrice: 3500 },
    { typeName: '5 KG',    capacity: 5,    shortName: '5KG',    price: 550,  purchaseCost: 470,  warning: 15, critical: 4, emptyPrice: 1200 },
    { typeName: '47.5 KG', capacity: 47.5, shortName: '47.5KG', price: 5500, purchaseCost: 4900, warning: 10, critical: 2, emptyPrice: 8000 },
  ];

  const cyl: Record<string, { id: string; typeName: string; price: number; purchaseCost: number }> = {};
  for (const s of cylSpecs) {
    const catalog = await prisma.providerCatalogCylinderType.findFirst({
      where: { providerCode: 'IOCL', shortName: s.shortName },
    });
    const ct = await prisma.cylinderType.create({
      data: {
        distributorId: DIST_ID,
        typeName: s.typeName,
        capacity: s.capacity,
        unit: 'KG',
        hsnCode: HSN,
        providerCatalogId: catalog?.id ?? null,
      },
    });
    await prisma.cylinderPrice.create({
      data: { distributorId: DIST_ID, cylinderTypeId: ct.id, price: s.price, effectiveDate: new Date('2024-01-01') },
    });
    await prisma.emptyCylinderPrice.create({
      data: { distributorId: DIST_ID, cylinderTypeId: ct.id, emptyCylinderPrice: s.emptyPrice, effectiveDate: new Date('2020-01-01') },
    });
    await prisma.cylinderThreshold.create({
      data: { distributorId: DIST_ID, cylinderTypeId: ct.id, warningLevel: s.warning, criticalLevel: s.critical },
    });
    cyl[s.typeName] = { id: ct.id, typeName: s.typeName, price: s.price, purchaseCost: s.purchaseCost };
  }
  console.log('Cylinder types + prices:', Object.keys(cyl).join(', '));

  // ─── 5. Staff users (admin / finance / inventory) ────────────────────────
  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@vijaya.com', passwordHash: pwHash, firstName: 'Vijaya', lastName: 'Admin',
      phone: '9848100100', role: 'distributor_admin', status: 'active', provisioningStatus: 'active',
      distributorId: DIST_ID, requiresPasswordReset: false,
    },
  });
  await prisma.user.create({
    data: {
      email: 'finance@vijaya.com', passwordHash: pwHash, firstName: 'Vijaya', lastName: 'Finance',
      phone: '9848100101', role: 'finance', status: 'active', provisioningStatus: 'active',
      distributorId: DIST_ID, requiresPasswordReset: false,
    },
  });
  await prisma.user.create({
    data: {
      email: 'inventory@vijaya.com', passwordHash: pwHash, firstName: 'Vijaya', lastName: 'Inventory',
      phone: '9848100102', role: 'inventory', status: 'active', provisioningStatus: 'active',
      distributorId: DIST_ID, requiresPasswordReset: false,
    },
  });
  console.log('Staff users: admin@vijaya.com, finance@vijaya.com, inventory@vijaya.com');

  // ─── 6. Drivers + Vehicles (+ driver logins) ─────────────────────────────
  const vehicles = await Promise.all([
    prisma.vehicle.create({ data: { distributorId: DIST_ID, vehicleNumber: 'TS07UA1111', vehicleType: 'Truck', capacity: 100, status: 'idle' } }),
    prisma.vehicle.create({ data: { distributorId: DIST_ID, vehicleNumber: 'TS07UB2222', vehicleType: 'Tempo', capacity: 60, status: 'idle' } }),
  ]);

  const driverSpecs = [
    { name: 'Ravi Teja',    phone: '9848100201', license: 'TS07-2024-001', email: 'driver1@vijaya.com', firstName: 'Ravi', lastName: 'Teja' },
    { name: 'Naveen Kumar', phone: '9848100202', license: 'TS07-2024-002', email: 'driver2@vijaya.com', firstName: 'Naveen', lastName: 'Kumar' },
  ];
  const drivers: { id: string; name: string }[] = [];
  for (const s of driverSpecs) {
    const drv = await prisma.driver.create({
      data: {
        distributorId: DIST_ID, driverName: s.name, phone: s.phone, licenseNumber: s.license,
        employmentType: 'permanent', status: 'active', availableToday: true,
      },
    });
    const du = await prisma.user.create({
      data: {
        email: s.email, passwordHash: pwHash, firstName: s.firstName, lastName: s.lastName, phone: s.phone,
        role: 'driver', status: 'active', provisioningStatus: 'active',
        distributorId: DIST_ID, requiresPasswordReset: false,
      },
    });
    // Link Driver → User login (Driver.userId FK; mobile driver login resolves via this).
    await prisma.driver.update({ where: { id: drv.id }, data: { userId: du.id } });
    drivers.push({ id: drv.id, name: s.name });
  }
  console.log('Drivers + vehicles:', drivers.map(x => x.name).join(', '), '|', vehicles.map(v => v.vehicleNumber).join(', '));

  // ─── 7. Standalone customers (3 B2B + 2 B2C) + customer logins ───────────
  type Cust = { id: string; name: string; type: 'B2B' | 'B2C'; gstin: string | null };
  const standaloneSpecs = [
    { name: 'Annapurna Tiffins',   type: 'B2B' as const, gstin: '36AABCA1111A1Z5', email: 'customer1@vijaya.com', phone: '9848100301', city: 'Hyderabad', credit: 30 },
    { name: 'Blue Fox Restaurant', type: 'B2B' as const, gstin: '36AABCB2222B1Z4', email: 'customer2@vijaya.com', phone: '9848100302', city: 'Hyderabad', credit: 15 },
    { name: 'Sri Sai Caterers',    type: 'B2B' as const, gstin: '36AABCS3333C1Z3', email: 'customer3@vijaya.com', phone: '9848100303', city: 'Hyderabad', credit: 30 },
    { name: 'Lakshmi Home Kitchen', type: 'B2C' as const, gstin: null,             email: 'customer4@vijaya.com', phone: '9848100304', city: 'Hyderabad', credit: 7 },
    { name: 'Ganesh Tea Stall',     type: 'B2C' as const, gstin: null,             email: 'customer5@vijaya.com', phone: '9848100305', city: 'Hyderabad', credit: 7 },
  ];
  const standalone: Cust[] = [];
  for (const s of standaloneSpecs) {
    const c = await prisma.customer.create({
      data: {
        distributorId: DIST_ID, customerName: s.name,
        businessName: s.type === 'B2B' ? s.name : null,
        gstin: s.gstin, customerType: s.type, phone: s.phone, email: s.email,
        billingAddressLine1: `${s.city} branch`, billingCity: s.city, billingState: 'Telangana', billingPincode: '500084',
        creditPeriodDays: s.credit, status: 'active',
      },
    });
    await prisma.user.create({
      data: {
        email: s.email, passwordHash: pwHash, firstName: s.name.split(' ')[0], lastName: 'Customer', phone: s.phone,
        role: 'customer', status: 'active', provisioningStatus: 'active',
        distributorId: DIST_ID, customerId: c.id, requiresPasswordReset: false,
      },
    });
    standalone.push({ id: c.id, name: s.name, type: s.type, gstin: s.gstin });
  }
  console.log('Standalone customers:', standalone.map(c => `${c.name} [${c.type}]`).join(', '));

  // ─── 8. Hotel groups (3) with B2B members + customer_hq logins ───────────
  const groupSpecs = [
    {
      groupName: 'Kinara Grand Hotels', hqEmail: 'hq-kinara@vijaya.com',
      members: [
        { name: 'Kinara Grand Banjara Hills', gstin: '36KINAR1111K1Z2', phone: '9848100401' },
        { name: 'Kinara Grand Gachibowli',    gstin: '36KINAR2222K1Z1', phone: '9848100402' },
      ],
    },
    {
      groupName: 'Taj Deccan Group', hqEmail: 'hq-taj@vijaya.com',
      members: [
        { name: 'Taj Deccan Kitchen',  gstin: '36TAJDE1111T1Z6', phone: '9848100411' },
        { name: 'Taj Deccan Banquets',  gstin: '36TAJDE2222T1Z5', phone: '9848100412' },
        { name: 'Taj Deccan Cafe',      gstin: '36TAJDE3333T1Z4', phone: '9848100413' },
      ],
    },
    {
      groupName: 'Novotel Group', hqEmail: 'hq-novotel@vijaya.com',
      members: [
        { name: 'Novotel HICC Kitchen',    gstin: '36NOVOT1111N1Z8', phone: '9848100421' },
        { name: 'Novotel Airport Kitchen', gstin: '36NOVOT2222N1Z7', phone: '9848100422' },
      ],
    },
  ];

  const groupMemberCustomers: Cust[] = [];
  for (const g of groupSpecs) {
    const group = await prisma.customerGroup.create({ data: { distributorId: DIST_ID, name: g.groupName } });
    for (const m of g.members) {
      const c = await prisma.customer.create({
        data: {
          distributorId: DIST_ID, customerName: m.name, businessName: m.name,
          gstin: m.gstin, customerType: 'B2B', phone: m.phone,
          billingAddressLine1: `${m.name}, Hyderabad`, billingCity: 'Hyderabad', billingState: 'Telangana', billingPincode: '500081',
          creditPeriodDays: 30, status: 'active',
        },
      });
      await prisma.customerGroupMember.create({ data: { groupId: group.id, customerId: c.id } });
      groupMemberCustomers.push({ id: c.id, name: m.name, type: 'B2B', gstin: m.gstin });
    }
    // HQ portal login for the group.
    await prisma.user.create({
      data: {
        email: g.hqEmail, passwordHash: pwHash, firstName: g.groupName.split(' ')[0], lastName: 'HQ',
        role: 'customer_hq', status: 'active', provisioningStatus: 'active',
        distributorId: DIST_ID, groupId: group.id, requiresPasswordReset: false,
      },
    });
    console.log(`Group "${g.groupName}": ${g.members.length} members + ${g.hqEmail}`);
  }

  // Every customer that can receive an order (standalone + group members).
  const allCustomers: Cust[] = [...standalone, ...groupMemberCustomers];

  // ─── 9. Orders (all DELIVERED, days 1..12) + invoices + payments + events ─
  // Deterministic order plan spread across the 12 days, cycling customers /
  // drivers / vehicles / cylinder types. Every order is delivered with the
  // full InventoryEvent chain (anti-pattern #26).
  type ItemSpec = { type: string; qty: number };
  type OrderPlan = { day: number; custIdx: number; drvIdx: number; trip: number; items: ItemSpec[] };

  const plan: OrderPlan[] = [
    { day: 1,  custIdx: 0, drvIdx: 0, trip: 1, items: [{ type: '19 KG', qty: 8 }] },
    { day: 1,  custIdx: 5, drvIdx: 1, trip: 1, items: [{ type: '19 KG', qty: 6 }, { type: '5 KG', qty: 4 }] },
    { day: 2,  custIdx: 1, drvIdx: 0, trip: 1, items: [{ type: '47.5 KG', qty: 3 }] },
    { day: 2,  custIdx: 3, drvIdx: 1, trip: 1, items: [{ type: '5 KG', qty: 10 }] },
    { day: 3,  custIdx: 6, drvIdx: 0, trip: 1, items: [{ type: '19 KG', qty: 12 }] },
    { day: 3,  custIdx: 2, drvIdx: 1, trip: 1, items: [{ type: '19 KG', qty: 5 }, { type: '47.5 KG', qty: 2 }] },
    { day: 4,  custIdx: 7, drvIdx: 0, trip: 1, items: [{ type: '47.5 KG', qty: 4 }] },
    { day: 4,  custIdx: 4, drvIdx: 1, trip: 1, items: [{ type: '5 KG', qty: 6 }] },
    { day: 5,  custIdx: 8, drvIdx: 0, trip: 1, items: [{ type: '19 KG', qty: 10 }] },
    { day: 5,  custIdx: 0, drvIdx: 1, trip: 2, items: [{ type: '19 KG', qty: 7 }] },
    { day: 6,  custIdx: 9, drvIdx: 0, trip: 1, items: [{ type: '47.5 KG', qty: 3 }, { type: '19 KG', qty: 4 }] },
    { day: 6,  custIdx: 3, drvIdx: 1, trip: 1, items: [{ type: '5 KG', qty: 8 }] },
    { day: 7,  custIdx: 10, drvIdx: 0, trip: 1, items: [{ type: '19 KG', qty: 9 }] },
    { day: 8,  custIdx: 1, drvIdx: 1, trip: 1, items: [{ type: '47.5 KG', qty: 5 }] },
    { day: 8,  custIdx: 11, drvIdx: 0, trip: 1, items: [{ type: '19 KG', qty: 6 }] },
    { day: 9,  custIdx: 2, drvIdx: 1, trip: 1, items: [{ type: '19 KG', qty: 8 }, { type: '5 KG', qty: 5 }] },
    { day: 9,  custIdx: 4, drvIdx: 0, trip: 1, items: [{ type: '5 KG', qty: 4 }] },
    { day: 10, custIdx: 5, drvIdx: 1, trip: 1, items: [{ type: '19 KG', qty: 11 }] },
    { day: 10, custIdx: 6, drvIdx: 0, trip: 1, items: [{ type: '47.5 KG', qty: 2 }] },
    { day: 11, custIdx: 7, drvIdx: 1, trip: 1, items: [{ type: '19 KG', qty: 7 }] },
    { day: 11, custIdx: 3, drvIdx: 0, trip: 1, items: [{ type: '5 KG', qty: 9 }] },
    { day: 12, custIdx: 0, drvIdx: 1, trip: 1, items: [{ type: '19 KG', qty: 6 }, { type: '47.5 KG', qty: 2 }] },
    { day: 12, custIdx: 8, drvIdx: 0, trip: 1, items: [{ type: '19 KG', qty: 5 }] },
  ];

  // Accumulators to size the incoming-fulls purchase + track empties flow.
  const dispatchedByType: Record<string, number> = { '19 KG': 0, '5 KG': 0, '47.5 KG': 0 };
  const collectedByType: Record<string, number> = { '19 KG': 0, '5 KG': 0, '47.5 KG': 0 };
  // Net cylinders still with each (customer, type) after empties returned.
  const balanceKey = (custId: string, typeName: string) => `${custId}|${typeName}`;
  const customerBalances = new Map<string, { customerId: string; typeName: string; net: number }>();

  let orderSeq = 0;
  let invSeq = 0;
  let paidCount = 0, partialCount = 0, issuedCount = 0;
  let b2bIrn = 0, b2cIrn = 0, b2cNotAttempted = 0;

  for (const p of plan) {
    orderSeq++;
    const cust = allCustomers[p.custIdx];
    const drv = drivers[p.drvIdx];
    const veh = vehicles[p.drvIdx];
    const orderDate = d(p.day);
    const deliveryDate = d(p.day);
    const orderNumber = `VJY-ORD-${String(orderSeq).padStart(4, '0')}`;

    // Build items: full delivery; collect one empty per delivered full except
    // leave a small residual so the customer carries a non-zero balance.
    const itemData = p.items.map((it) => {
      const ct = cyl[it.type];
      const unitPrice = ct.price; // GST-inclusive
      const delivered = it.qty;
      const empties = Math.max(0, delivered - (delivered >= 4 ? 1 : 0)); // leave ~1 with customer on bigger drops
      const totalPrice = round2(unitPrice * delivered);
      dispatchedByType[it.type] += delivered;
      collectedByType[it.type] += empties;
      // Track customer balance (delivered − empties returned).
      const k = balanceKey(cust.id, it.type);
      const cur = customerBalances.get(k) ?? { customerId: cust.id, typeName: it.type, net: 0 };
      cur.net += delivered - empties;
      customerBalances.set(k, cur);
      return { ct, unitPrice, delivered, empties, totalPrice };
    });

    const orderTotal = round2(itemData.reduce((s, i) => s + i.totalPrice, 0));

    const order = await prisma.order.create({
      data: {
        orderNumber, distributorId: DIST_ID, customerId: cust.id,
        driverId: drv.id, vehicleId: veh.id,
        orderDate, deliveryDate, status: 'delivered', deliveredAt: deliveryDate,
        totalAmount: orderTotal, tripNumber: p.trip,
        items: {
          create: itemData.map((i) => ({
            cylinderTypeId: i.ct.id, quantity: i.delivered, deliveredQuantity: i.delivered,
            emptiesCollected: i.empties, unitPrice: i.unitPrice, discountPerUnit: 0, totalPrice: i.totalPrice,
          })),
        },
      },
    });

    // ── InventoryEvent chain (anti-pattern #26) — dated on deliveryDate,
    // tagged with vehicleNumber + driverName. dispatch + delivery debit fulls;
    // collection + reconciliation_empties_return handle empties.
    for (const i of itemData) {
      const common = {
        distributorId: DIST_ID, cylinderTypeId: i.ct.id, eventDate: deliveryDate,
        referenceId: order.id, referenceType: 'order',
        vehicleNumber: veh.vehicleNumber, driverName: drv.name, createdBy: adminUser.id,
      };
      await prisma.inventoryEvent.createMany({
        data: [
          { ...common, eventType: 'dispatch',  fullsChange: -i.delivered, emptiesChange: 0 },
          { ...common, eventType: 'delivery',  fullsChange: -i.delivered, emptiesChange: 0 },
          ...(i.empties > 0 ? [
            { ...common, eventType: 'collection' as const,                    fullsChange: 0, emptiesChange: i.empties },
            { ...common, eventType: 'reconciliation_empties_return' as const, fullsChange: 0, emptiesChange: i.empties },
          ] : []),
        ],
      });
    }

    // ── Invoice with GST fields ──────────────────────────────────────────
    invSeq++;
    const invoiceNumber = `VJY-INV-${String(invSeq).padStart(4, '0')}`;
    const split = gstSplit(orderTotal);

    // GST document-status decision:
    //  - B2B (has GSTIN)                 → IRN success + EWB active (full e-invoice)
    //  - B2C, total >= 5000              → IRN success, no EWB (typical B2C QR)
    //  - B2C, total < 5000               → not_attempted (below e-invoice threshold)
    let irnStatus: 'success' | 'not_attempted' = 'not_attempted';
    let ewbStatus: 'active' | 'not_attempted' = 'not_attempted';
    let irn: string | null = null;
    let ackNo: string | null = null;
    let signedQr: string | null = null;
    let ewbNo: string | null = null;

    if (cust.type === 'B2B') {
      irnStatus = 'success'; ewbStatus = 'active';
      irn = mockIrn(); ackNo = mockAckNo(); signedQr = mockSignedQr(); ewbNo = mockEwbNo();
      b2bIrn++;
    } else if (orderTotal >= 5000) {
      irnStatus = 'success'; ewbStatus = 'not_attempted';
      irn = mockIrn(); ackNo = mockAckNo(); signedQr = mockSignedQr();
      b2cIrn++;
    } else {
      b2cNotAttempted++;
    }

    // Payment status: ~50% paid, ~25% partial, ~25% issued (deterministic).
    const mod = orderSeq % 4;
    let status: 'paid' | 'partially_paid' | 'issued';
    let amountPaid = 0;
    if (mod === 0 || mod === 1) { status = 'paid'; amountPaid = orderTotal; paidCount++; }
    else if (mod === 2) { status = 'partially_paid'; amountPaid = round2(orderTotal * 0.5); partialCount++; }
    else { status = 'issued'; amountPaid = 0; issuedCount++; }
    const outstanding = round2(orderTotal - amountPaid);

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber, distributorId: DIST_ID, customerId: cust.id, orderId: order.id,
        issueDate: deliveryDate,
        dueDate: d(Math.min(p.day + 30, 12)), // clamp within demo window; real due 30d out
        totalAmount: orderTotal, amountPaid, outstandingAmount: outstanding, status,
        irnStatus, ewbStatus, irn, ackNo, ackDate: irn ? deliveryDate : null,
        cgstValue: split.cgst, sgstValue: split.sgst, igstValue: split.igst,
        taxableValue: split.taxable, placeOfSupplyCode: '36', reverseCharge: false,
        customerGstinSnapshot: cust.gstin,
        items: {
          create: itemData.map((i) => ({
            cylinderTypeId: i.ct.id,
            description: `${i.ct.typeName} LPG Cylinder`,
            hsnCode: HSN, quantity: i.delivered, unitPrice: i.unitPrice, discountPerUnit: 0,
            gstRate: GST_RATE, totalPrice: i.totalPrice,
            taxableValue: round2(i.totalPrice / (1 + GST_RATE / 100)), uom: 'NOS',
          })),
        },
      },
    });

    // ── GstDocument (mock IRN/EWB detail row) for any invoice that got an IRN.
    if (irn) {
      await prisma.gstDocument.create({
        data: {
          invoiceId: invoice.id, orderId: order.id, distributorId: DIST_ID,
          gstDocNo: invoiceNumber, docType: 'INV', isLatest: true,
          irnStatus, ewbStatus, irn, ackNo, ackDate: deliveryDate, signedQr,
          ewbNo, ewbDate: ewbNo ? deliveryDate : null,
          ewbValidTill: ewbNo ? d(Math.min(p.day + 1, 12)) : null,
        },
      });
    }

    // ── Ledger + payment ─────────────────────────────────────────────────
    // Invoice debit row (amountDelta = +total).
    await prisma.customerLedgerEntry.create({
      data: {
        distributorId: DIST_ID, customerId: cust.id, entryType: 'invoice_entry',
        referenceId: invoice.id, invoiceId: invoice.id, amountDelta: orderTotal,
        narration: `Invoice ${invoiceNumber} for order ${orderNumber}`,
        entryDate: deliveryDate, createdBy: adminUser.id,
      },
    });

    if (amountPaid > 0) {
      const methods = ['upi', 'cash', 'bank_transfer', 'cheque'] as const;
      const method = methods[orderSeq % methods.length];
      const payment = await prisma.paymentTransaction.create({
        data: {
          distributorId: DIST_ID, customerId: cust.id, amount: amountPaid,
          paymentMethod: method, referenceNumber: `PAY-${orderSeq}`,
          transactionDate: deliveryDate, allocationStatus: 'fully_allocated',
          notes: `Payment for ${invoiceNumber}`,
        },
      });
      await prisma.paymentAllocation.create({
        data: { paymentId: payment.id, invoiceId: invoice.id, allocatedAmount: amountPaid },
      });
      // Payment credit row (amountDelta = -amount).
      await prisma.customerLedgerEntry.create({
        data: {
          distributorId: DIST_ID, customerId: cust.id, entryType: 'payment_entry',
          referenceId: payment.id, amountDelta: -amountPaid,
          narration: `Payment received via ${method} (Ref: PAY-${orderSeq})`,
          entryDate: deliveryDate, createdBy: adminUser.id,
        },
      });
    }

    // ── Driver-vehicle assignment for the trip (idempotent by natural key).
    await prisma.driverVehicleAssignment.upsert({
      where: { driverId_assignmentDate_tripNumber: { driverId: drv.id, assignmentDate: deliveryDate, tripNumber: p.trip } },
      update: {},
      create: {
        driverId: drv.id, vehicleId: veh.id, distributorId: DIST_ID,
        assignmentDate: deliveryDate, tripNumber: p.trip, status: 'reconciled', isReconciled: true, isSubmitted: true,
      },
    });
  }
  console.log(`Orders created: ${orderSeq} (all delivered) | invoices: ${invSeq}`);
  console.log(`  Invoice payment mix — paid: ${paidCount}, partial: ${partialCount}, issued: ${issuedCount}`);
  console.log(`  GST docs — B2B IRN+EWB: ${b2bIrn}, B2C IRN-only: ${b2cIrn}, B2C not_attempted: ${b2cNotAttempted}`);

  // ─── 10. Customer inventory balances (net cylinders still with customer) ──
  for (const bal of customerBalances.values()) {
    if (bal.net <= 0) continue;
    await prisma.customerInventoryBalance.create({
      data: { customerId: bal.customerId, cylinderTypeId: cyl[bal.typeName].id, withCustomerQty: bal.net, pendingReturns: 0 },
    });
  }
  console.log('Customer inventory balances written.');

  // ─── 11. Incoming fulls (PurchaseEntry from IOCL) + InventoryEvents ───────
  // Buy enough to cover ALL dispatch plus a buffer so depot fulls stay
  // strictly non-negative on every day. The full purchase lands on day 1 (a
  // bulk intake), with a smaller top-up on day 6 as extra headroom.
  const BUFFER = 50;
  const incomingByType: Record<string, number> = {
    '19 KG': dispatchedByType['19 KG'] + BUFFER,
    '5 KG': dispatchedByType['5 KG'] + BUFFER,
    '47.5 KG': dispatchedByType['47.5 KG'] + BUFFER,
  };

  async function writeIncomingPurchase(day: number, docNo: string, qtyByType: Record<string, number>) {
    const entry = await prisma.purchaseEntry.create({
      data: {
        purchaseNumber: `VJY-PUR-${docNo}`, distributorId: DIST_ID,
        sourceDistributorId: source.id, sourceDistributorName: source.name,
        purchaseDate: ds(day), supplierDocumentNumber: `IOCL-${docNo}`, supplierDocumentDate: ds(day),
        documentType: 'invoice', createdBy: adminUser.id,
        items: {
          create: Object.entries(qtyByType)
            .filter(([, q]) => q > 0)
            .map(([typeName, q]) => ({
              cylinderTypeId: cyl[typeName].id, fullsReceived: q, emptiesGivenOut: 0,
              unitPrice: cyl[typeName].purchaseCost, gstRate: GST_RATE,
            })),
        },
      },
    });
    for (const [typeName, q] of Object.entries(qtyByType)) {
      if (q <= 0) continue;
      await prisma.inventoryEvent.create({
        data: {
          distributorId: DIST_ID, cylinderTypeId: cyl[typeName].id, eventType: 'incoming_fulls',
          fullsChange: q, emptiesChange: 0, eventDate: d(day),
          referenceId: entry.id, referenceType: 'purchase_entry',
          documentType: 'invoice', documentNumber: `IOCL-${docNo}`, documentDate: d(day),
          notes: `Incoming fulls from ${source.name}`, createdBy: adminUser.id,
        },
      });
    }
    return entry;
  }

  // Day 1: full required intake. Day 6: pure-buffer top-up.
  await writeIncomingPurchase(1, 'NM26-1001', incomingByType);
  await writeIncomingPurchase(6, 'NM26-1042', { '19 KG': 40, '5 KG': 20, '47.5 KG': 10 });
  console.log('Incoming fulls purchased (2 batches) — covers all dispatch + buffer.');

  // ─── 12. Outgoing empties (ERV to OMC) on the last day ────────────────────
  // Return a fraction of collected empties to the OMC. Placed on day 12 after
  // all empties have accumulated so closing empties never dips negative.
  const ervEntry = await prisma.purchaseEntry.create({
    data: {
      purchaseNumber: 'VJY-ERV-2001', distributorId: DIST_ID,
      sourceDistributorId: source.id, sourceDistributorName: source.name,
      purchaseDate: ds(12), supplierDocumentNumber: 'ERV-2001', supplierDocumentDate: ds(12),
      documentType: 'invoice', notes: 'Empties returned to OMC (ERV)', createdBy: adminUser.id,
      items: {
        create: Object.entries(collectedByType)
          .map(([typeName, collected]) => ({ typeName, out: Math.floor(collected * 0.3) }))
          .filter((x) => x.out > 0)
          .map((x) => ({ cylinderTypeId: cyl[x.typeName].id, fullsReceived: 0, emptiesGivenOut: x.out, unitPrice: 0, gstRate: 0 })),
      },
    },
  });
  const outgoingByType: Record<string, number> = {};
  for (const [typeName, collected] of Object.entries(collectedByType)) {
    const out = Math.floor(collected * 0.3);
    outgoingByType[typeName] = out;
    if (out <= 0) continue;
    await prisma.inventoryEvent.create({
      data: {
        distributorId: DIST_ID, cylinderTypeId: cyl[typeName].id, eventType: 'outgoing_empties',
        fullsChange: 0, emptiesChange: -out, eventDate: d(12),
        referenceId: ervEntry.id, referenceType: 'purchase_entry',
        documentType: 'ERV', documentNumber: 'ERV-2001', documentDate: d(12),
        notes: `Empties returned to ${source.name}`, createdBy: adminUser.id,
      },
    });
  }
  console.log('Outgoing empties (ERV) recorded.');

  // ─── 13. Recalculate inventory summaries (event-sourced) ──────────────────
  console.log('\nRecalculating inventory summaries from day 1…');
  const fromDate = d(1);
  for (const typeName of Object.keys(cyl)) {
    await recalculateSummariesFromDate(DIST_ID, cyl[typeName].id, fromDate);
  }

  // ─── 14. Final summary ────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('CLOSING INVENTORY (latest summary per cylinder type):');
  let anyNegative = false;
  for (const typeName of Object.keys(cyl)) {
    const latest = await prisma.inventorySummary.findFirst({
      where: { distributorId: DIST_ID, cylinderTypeId: cyl[typeName].id },
      orderBy: { summaryDate: 'desc' },
    });
    const cf = latest?.closingFulls ?? 0;
    const ce = latest?.closingEmpties ?? 0;
    if (cf < 0 || ce < 0) anyNegative = true;
    console.log(
      `  ${typeName.padEnd(8)} closingFulls=${cf}  closingEmpties=${ce}` +
      `  (dispatched=${dispatchedByType[typeName]}, incoming=${incomingByType[typeName] + (typeName === '19 KG' ? 40 : typeName === '5 KG' ? 20 : 10)},` +
      ` collected=${collectedByType[typeName]}, ervOut=${outgoingByType[typeName] ?? 0})`,
    );
  }
  console.log(anyNegative ? '  ⚠️  NEGATIVE CLOSING DETECTED — investigate!' : '  ✅ All closing balances non-negative.');

  const custCount = await prisma.customer.count({ where: { distributorId: DIST_ID } });
  const invCount = await prisma.invoice.count({ where: { distributorId: DIST_ID } });
  const ordCount = await prisma.order.count({ where: { distributorId: DIST_ID } });

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`Distributor: ${distributor.businessName} (id: ${DIST_ID})  GST: sandbox`);
  console.log(`Customers: ${custCount}  |  Orders: ${ordCount}  |  Invoices: ${invCount}`);
  console.log('\nLOGINS (all password: ' + PASSWORD + ')');
  console.log('  Admin:      admin@vijaya.com');
  console.log('  Finance:    finance@vijaya.com');
  console.log('  Inventory:  inventory@vijaya.com');
  console.log('  Driver 1:   driver1@vijaya.com  (Ravi Teja)');
  console.log('  Driver 2:   driver2@vijaya.com  (Naveen Kumar)');
  console.log('  Customers:  customer1@vijaya.com … customer5@vijaya.com');
  console.log('  HQ (Kinara):  hq-kinara@vijaya.com');
  console.log('  HQ (Taj):     hq-taj@vijaya.com');
  console.log('  HQ (Novotel): hq-novotel@vijaya.com');
  console.log('──────────────────────────────────────────────────────────────');
  console.log('\n✅ Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
