/**
 * Mini-op #5 (2026-07-27) — Dummy expense seeder.
 *
 * Usage:
 *   pnpm --filter @gaslink/api exec tsx scripts/seed-expenses.ts [distributorId]
 *
 * If no distributorId is passed, seeds against the first mini_operator
 * tenant found. Idempotent-ish: skips insertion if any expense already
 * exists whose description starts with "SEED:" (marker used by every
 * row this script inserts).
 *
 * Seeds ~35 rows across the 13 categories, spread over the last 90 days.
 */
import { prisma } from '../src/lib/prisma.js';

type Row = {
  daysAgo: number;
  category: string;
  amount: number;
  description: string;
  paymentMethod: string;
  vendorName?: string;
  referenceNumber?: string;
  attachVehicle?: boolean;
  attachDriver?: boolean;
};

const ROWS: Row[] = [
  // fuel — 4 entries, spread across the period, always attached to vehicle
  { daysAgo: 3,  category: 'fuel', amount: 3450,  description: 'SEED: Diesel top-up 45L',        paymentMethod: 'upi',   vendorName: 'HP Petrol Pump - Kondapur',  referenceNumber: 'HP/2026/07/1122', attachVehicle: true, attachDriver: true },
  { daysAgo: 12, category: 'fuel', amount: 4200,  description: 'SEED: Diesel + AdBlue',           paymentMethod: 'upi',   vendorName: 'IOCL - Gachibowli',           referenceNumber: 'IOCL-7788',       attachVehicle: true, attachDriver: true },
  { daysAgo: 28, category: 'fuel', amount: 3800,  description: 'SEED: Diesel refill',             paymentMethod: 'cash',  vendorName: 'BPCL - Miyapur',              referenceNumber: 'BPCL-4451',       attachVehicle: true, attachDriver: false },
  { daysAgo: 55, category: 'fuel', amount: 4100,  description: 'SEED: Diesel + air check',        paymentMethod: 'upi',   vendorName: 'HP Petrol Pump - Kondapur',  referenceNumber: 'HP/2026/06/9081', attachVehicle: true, attachDriver: true },

  // vehicle_maintenance — 3 entries, attached to vehicle
  { daysAgo: 8,  category: 'vehicle_maintenance', amount: 2850,  description: 'SEED: Oil change + air filter', paymentMethod: 'cheque',        vendorName: 'Bosch Service - Kukatpally', referenceNumber: 'BS-2026-4451', attachVehicle: true },
  { daysAgo: 34, category: 'vehicle_maintenance', amount: 12500, description: 'SEED: Brake pads + clutch plate', paymentMethod: 'bank_transfer', vendorName: 'Tata Motors Authorized',       referenceNumber: 'TATA-INV-8823', attachVehicle: true },
  { daysAgo: 71, category: 'vehicle_maintenance', amount: 1450,  description: 'SEED: Tyre alignment',           paymentMethod: 'cash',          vendorName: 'MRF Tyre Point',              referenceNumber: 'MRF-3341', attachVehicle: true },

  // salaries_wages — 3 entries, mix of driver-attached + helpers
  { daysAgo: 30, category: 'salaries_wages', amount: 18000, description: 'SEED: Driver monthly salary — June', paymentMethod: 'bank_transfer', vendorName: 'Raju (driver)', attachDriver: true },
  { daysAgo: 30, category: 'salaries_wages', amount: 12000, description: 'SEED: Helper monthly wages — June',  paymentMethod: 'cash',          vendorName: 'Ramu (loader)' },
  { daysAgo: 1,  category: 'salaries_wages', amount: 18000, description: 'SEED: Driver monthly salary — July', paymentMethod: 'bank_transfer', vendorName: 'Raju (driver)', attachDriver: true },

  // rent — 3 monthly entries
  { daysAgo: 88, category: 'rent', amount: 22000, description: 'SEED: Godown rent — May',  paymentMethod: 'bank_transfer', vendorName: 'Sri Ramesh (owner)', referenceNumber: 'RENT/MAY/2026' },
  { daysAgo: 57, category: 'rent', amount: 22000, description: 'SEED: Godown rent — June', paymentMethod: 'bank_transfer', vendorName: 'Sri Ramesh (owner)', referenceNumber: 'RENT/JUN/2026' },
  { daysAgo: 26, category: 'rent', amount: 22000, description: 'SEED: Godown rent — July', paymentMethod: 'bank_transfer', vendorName: 'Sri Ramesh (owner)', referenceNumber: 'RENT/JUL/2026' },

  // utilities — 3 entries
  { daysAgo: 15, category: 'utilities', amount: 3450, description: 'SEED: TSSPDCL electricity bill', paymentMethod: 'online', vendorName: 'TSSPDCL',        referenceNumber: 'TSS-9922-JUN' },
  { daysAgo: 15, category: 'utilities', amount: 850,  description: 'SEED: Metro water bill',           paymentMethod: 'online', vendorName: 'HMWSSB',         referenceNumber: 'HMW-4471' },
  { daysAgo: 46, category: 'utilities', amount: 3120, description: 'SEED: TSSPDCL electricity bill', paymentMethod: 'online', vendorName: 'TSSPDCL',        referenceNumber: 'TSS-9922-MAY' },

  // loading_unloading — 3 entries
  { daysAgo: 4,  category: 'loading_unloading', amount: 450, description: 'SEED: Loading charges - HPCL depot', paymentMethod: 'cash', vendorName: 'Depot loaders' },
  { daysAgo: 18, category: 'loading_unloading', amount: 600, description: 'SEED: Loading charges - HPCL depot', paymentMethod: 'cash', vendorName: 'Depot loaders', attachDriver: true },
  { daysAgo: 42, category: 'loading_unloading', amount: 500, description: 'SEED: Loading charges - HPCL depot', paymentMethod: 'cash', vendorName: 'Depot loaders' },

  // cylinder_deposits — 2 entries
  { daysAgo: 20, category: 'cylinder_deposits', amount: 15000, description: 'SEED: 10× 14.2kg cylinder deposit', paymentMethod: 'bank_transfer', vendorName: 'HPCL Depot',    referenceNumber: 'HPCL-DEP-8811' },
  { daysAgo: 63, category: 'cylinder_deposits', amount: 7500,  description: 'SEED: 5× 14.2kg cylinder deposit',  paymentMethod: 'bank_transfer', vendorName: 'HPCL Depot',    referenceNumber: 'HPCL-DEP-7702' },

  // office_supplies — 2 entries
  { daysAgo: 9,  category: 'office_supplies', amount: 850,  description: 'SEED: Bill book + stationery', paymentMethod: 'cash', vendorName: 'Sri Sai Stationers',     referenceNumber: 'SAI-1188' },
  { daysAgo: 48, category: 'office_supplies', amount: 1400, description: 'SEED: Printer cartridges',      paymentMethod: 'upi',  vendorName: 'Reliance Digital',        referenceNumber: 'RD-4471' },

  // communication — 2 entries
  { daysAgo: 6,  category: 'communication', amount: 599,  description: 'SEED: Airtel postpaid — driver', paymentMethod: 'online', vendorName: 'Airtel', referenceNumber: 'AIR-99887711' },
  { daysAgo: 6,  category: 'communication', amount: 999,  description: 'SEED: Jio Fiber office',         paymentMethod: 'online', vendorName: 'Jio',    referenceNumber: 'JIO-44112288' },

  // insurance — 2 entries (one vehicle policy, one staff health)
  { daysAgo: 40, category: 'insurance', amount: 18500, description: 'SEED: Vehicle insurance renewal',  paymentMethod: 'bank_transfer', vendorName: 'Bajaj Allianz', referenceNumber: 'POL-VEH-2026-8811', attachVehicle: true },
  { daysAgo: 65, category: 'insurance', amount: 4200,  description: 'SEED: Driver health cover',        paymentMethod: 'bank_transfer', vendorName: 'HDFC Ergo',     referenceNumber: 'POL-HLT-2026-7702', attachDriver: true },

  // taxes_licenses — 2 entries
  { daysAgo: 50, category: 'taxes_licenses', amount: 3500, description: 'SEED: Trade license renewal',        paymentMethod: 'online', vendorName: 'GHMC',           referenceNumber: 'GHMC-CHN-4471' },
  { daysAgo: 20, category: 'taxes_licenses', amount: 2200, description: 'SEED: Vehicle road tax quarterly',   paymentMethod: 'online', vendorName: 'RTO Telangana',  referenceNumber: 'RTO-CH-8811', attachVehicle: true },

  // bank_charges — 3 entries
  { daysAgo: 5,  category: 'bank_charges', amount: 45,  description: 'SEED: NEFT transfer charges', paymentMethod: 'bank_transfer', vendorName: 'HDFC Bank', referenceNumber: 'HDFC-TXN-8811' },
  { daysAgo: 35, category: 'bank_charges', amount: 100, description: 'SEED: Quarterly SMS charges', paymentMethod: 'bank_transfer', vendorName: 'HDFC Bank', referenceNumber: 'HDFC-SMS-Q1' },
  { daysAgo: 60, category: 'bank_charges', amount: 250, description: 'SEED: DD issuance charges',   paymentMethod: 'bank_transfer', vendorName: 'HDFC Bank', referenceNumber: 'HDFC-DD-4471' },

  // other — 2 catch-all entries
  { daysAgo: 22, category: 'other', amount: 1800, description: 'SEED: Diwali gifts for staff',        paymentMethod: 'cash', vendorName: 'Local sweet shop' },
  { daysAgo: 76, category: 'other', amount: 950,  description: 'SEED: Godown pest-control treatment', paymentMethod: 'upi',  vendorName: 'Pest Control India' },
];

function isoDayLocal(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const argDistId = process.argv[2];
  const distributor = argDistId
    ? await prisma.distributor.findUnique({ where: { id: argDistId } })
    : await prisma.distributor.findFirst({ where: { accountType: 'mini_operator', deletedAt: null } })
      ?? await prisma.distributor.findFirst({ where: { deletedAt: null } });
  if (!distributor) {
    console.error('No distributor found. Pass a distributorId as arg.');
    process.exit(1);
  }
  console.log(`Seeding into distributor: ${distributor.businessName} (${distributor.id})`);

  // Idempotency guard — never seed twice.
  const already = await prisma.expense.count({
    where: { distributorId: distributor.id, description: { startsWith: 'SEED:' } },
  });
  if (already > 0) {
    console.log(`Found ${already} existing SEED expenses; skipping. Delete them first if you want a re-seed.`);
    process.exit(0);
  }

  // Pick a system user for createdBy. Prefer a distributor_admin / mini_operator_admin
  // in this tenant; fall back to any super_admin.
  const user = await prisma.user.findFirst({
    where: {
      distributorId: distributor.id,
      role: { in: ['distributor_admin', 'mini_operator_admin', 'finance'] },
      deletedAt: null,
    },
  }) ?? await prisma.user.findFirst({ where: { role: 'super_admin', deletedAt: null } });
  if (!user) {
    console.error('No user available for createdBy. Aborting.');
    process.exit(1);
  }

  // Pick one vehicle + one driver in the tenant to attach.
  const vehicle = await prisma.vehicle.findFirst({
    where: { distributorId: distributor.id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const driver = await prisma.driver.findFirst({
    where: { distributorId: distributor.id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Attribution seeds: vehicle=${vehicle?.vehicleNumber ?? '(none)'}, driver=${driver?.driverName ?? '(none)'}`);

  let created = 0;
  for (const r of ROWS) {
    await prisma.expense.create({
      data: {
        distributorId: distributor.id,
        expenseDate: isoDayLocal(r.daysAgo),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        category: r.category as any,
        amount: r.amount,
        description: r.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        paymentMethod: r.paymentMethod as any,
        vendorName: r.vendorName ?? null,
        referenceNumber: r.referenceNumber ?? null,
        vehicleId: r.attachVehicle && vehicle ? vehicle.id : null,
        driverId: r.attachDriver && driver ? driver.id : null,
        createdBy: user.id,
      },
    });
    created += 1;
  }
  console.log(`Seeded ${created} expense rows.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
