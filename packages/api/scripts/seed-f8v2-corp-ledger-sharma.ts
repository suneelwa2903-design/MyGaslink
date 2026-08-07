/**
 * F8v2-FIX-B (2026-08-06) — Sharma / HPCL Corporation seed.
 *
 * Mirror of seed-f8v2-corp-ledger.ts for dist-002 (Sharma) → HPCL so
 * Suneel can compare Bhargava PDF vs Sharma PDF side by side.
 *
 * Sharma is GST-LIVE — landed-cost report will use GST-EXCLUSIVE math
 * (they claim ITC). Confirms the tenant-gstMode branch works end-to-end.
 */
import { prisma } from '../src/lib/prisma.js';
import { recordIncomingFulls } from '../src/services/inventoryService.js';
import { createPurchaseCreditNote } from '../src/services/purchaseCreditNoteService.js';
import { createPurchaseDebitNote } from '../src/services/purchaseDebitNoteService.js';
import { createPurchasePayment } from '../src/services/purchasePaymentService.js';

const TAG = 'F8V2-SHARMA';
const DIST = 'dist-002';
const USER = 'user-admin';

async function cleanup() {
  console.log('Cleaning up prior Sharma seed rows…');
  const entries = await prisma.purchaseEntry.findMany({
    where: { distributorId: DIST, supplierDocumentNumber: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = entries.map((e) => e.id);
  if (ids.length > 0) {
    await prisma.purchaseCreditNoteAllocation.deleteMany({ where: { purchaseEntryId: { in: ids } } });
    await prisma.purchaseDebitNoteAllocation.deleteMany({ where: { purchaseEntryId: { in: ids } } });
    await prisma.purchasePaymentAllocation.deleteMany({ where: { purchaseEntryId: { in: ids } } });
    await prisma.purchaseEntryCharge.deleteMany({ where: { purchaseEntryId: { in: ids } } });
    await prisma.purchaseEntryItem.deleteMany({ where: { purchaseEntryId: { in: ids } } });
    await prisma.purchaseEntry.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.purchaseCreditNote.deleteMany({
    where: { distributorId: DIST, creditNoteNumber: { startsWith: TAG } },
  });
  await prisma.purchaseDebitNote.deleteMany({
    where: { distributorId: DIST, debitNoteNumber: { startsWith: TAG } },
  });
  await prisma.purchasePayment.deleteMany({
    where: { distributorId: DIST, referenceNumber: { startsWith: TAG } },
  });
}

async function main() {
  console.log('─'.repeat(72));
  console.log('F8 v2 Sharma / HPCL Corporation Ledger seed');
  console.log('─'.repeat(72));

  await cleanup();

  const hpcl = await prisma.sourceDistributor.findFirst({
    where: { distributorId: DIST, name: 'HPCL', deletedAt: null },
    select: { id: true, name: true },
  });
  if (!hpcl) {
    console.error('HPCL supplier not found for Sharma. Run f8-backfill-supplier-seed first.');
    process.exit(1);
  }

  const cylTypes = await prisma.cylinderType.findMany({
    where: { distributorId: DIST, isActive: true },
    select: { id: true, typeName: true },
    orderBy: { typeName: 'asc' },
    take: 2,
  });
  if (cylTypes.length === 0) {
    console.error('No cylinder types found for Sharma.');
    process.exit(1);
  }
  const cyl1 = cylTypes[0];

  console.log(`Using HPCL (${hpcl.id.slice(0, 8)}), cyl types: ${cylTypes.map((c) => c.typeName).join(', ')}`);

  // Invoice #1 — 15-Nov (HPCL 19KG COMM + freight)
  await recordIncomingFulls(DIST, USER, {
    cylinderTypeId: cyl1.id,
    quantity: 168,
    documentType: 'OMC Invoice',
    documentNumber: `${TAG}-INV-1`,
    documentDate: '2026-11-15',
    unitPrice: 1632.85, // Rs per cyl GST-incl (matches HPCL sample scale)
    gstRate: 18,
    plantName: 'Cherlapally',
    sourceDistributorId: hpcl.id,
    charges: [{ chargeType: 'freight', amount: 8500 }],
  });
  console.log(`✓ Invoice #1 (168× COMM + freight)`);

  // Payment on 18-Nov
  await createPurchasePayment(DIST, USER, {
    sourceDistributorId: hpcl.id,
    transactionDate: '2026-11-18',
    amount: 250000,
    paymentMethod: 'bank_transfer',
    referenceNumber: `${TAG}-BANK-SBI-11223344`,
    notes: 'Partial payment against Nov invoices',
  });
  console.log('✓ Payment #1 (₹2,50,000 SBI)');

  // Invoice #2 — 22-Nov (mixed 47.5KG if present, else same cyl)
  const cyl475 = cylTypes.find((c) => c.typeName.includes('47')) ?? cyl1;
  await recordIncomingFulls(DIST, USER, {
    cylinderTypeId: cyl475.id,
    quantity: 20,
    documentType: 'OMC Invoice',
    documentNumber: `${TAG}-INV-2`,
    documentDate: '2026-11-22',
    unitPrice: 4082.13,
    gstRate: 18,
    plantName: 'Cherlapally',
    sourceDistributorId: hpcl.id,
    charges: [{ chargeType: 'freight', amount: 3200 }],
  });
  console.log(`✓ Invoice #2 (20× ${cyl475.typeName} COMM + freight)`);

  // Credit Note 25-Nov — quality incentive
  const invEntries = await prisma.purchaseEntry.findMany({
    where: { distributorId: DIST, supplierDocumentNumber: { startsWith: TAG } },
    orderBy: { purchaseDate: 'asc' },
    select: { id: true, supplierDocumentNumber: true },
  });
  await createPurchaseCreditNote(DIST, USER, {
    sourceDistributorId: hpcl.id,
    creditNoteNumber: `${TAG}-CN-1`,
    creditNoteDate: '2026-11-25',
    receivedDate: '2026-11-26',
    totalAmount: 12000,
    reason: 'quality_incentive',
    notes: 'Nov quality slab bonus',
    allocations: [{ purchaseEntryId: invEntries[0].id, amount: 12000 }],
  });
  console.log('✓ CN #1 (₹12,000 quality incentive)');

  // Debit Note 28-Nov — short supply
  await createPurchaseDebitNote(DIST, USER, {
    sourceDistributorId: hpcl.id,
    debitNoteNumber: `${TAG}-DN-1`,
    debitNoteDate: '2026-11-28',
    receivedDate: '2026-11-30',
    totalAmount: 3200,
    reason: 'short_supply',
    notes: '2× cyls short vs invoice qty',
    allocations: [{ purchaseEntryId: invEntries[0].id, amount: 3200 }],
  });
  console.log('✓ DN #1 (₹3,200 short supply)');

  // Deposit invoice 30-Nov (Nil GST)
  const now = new Date();
  const distributor = await prisma.distributor.findUnique({
    where: { id: DIST },
    select: { docCode: true },
  });
  const purchaseNumber = distributor?.docCode
    ? `P${distributor.docCode}${String(now.getFullYear()).slice(-2)}${String(now.getFullYear() + 1).slice(-2)}SDEP01`
    : `P-DEP-${Date.now().toString(36).toUpperCase()}`;
  await prisma.purchaseEntry.create({
    data: {
      purchaseNumber,
      distributorId: DIST,
      sourceDistributorId: hpcl.id,
      sourceDistributorName: hpcl.name,
      purchaseDate: '2026-11-30',
      supplierDocumentNumber: `${TAG}-DEP-1`,
      supplierDocumentDate: '2026-11-30',
      plantName: 'Cherlapally',
      documentType: 'deposit_invoice',
      notes: '150 new 19KG cylinders + 20× 47.5KG deposit',
      createdBy: USER,
      items: {
        create: [
          {
            cylinderTypeId: cyl1.id,
            fullsReceived: 150,
            emptiesGivenOut: 0,
            unitPrice: 2100,
            gstRate: 0,
          },
        ],
      },
    },
  });
  console.log('✓ Deposit invoice (150× cyls × ₹2,100 = ₹3,15,000 Nil GST)');

  // Payment #2 — 03-Dec
  await createPurchasePayment(DIST, USER, {
    sourceDistributorId: hpcl.id,
    transactionDate: '2026-12-03',
    amount: 75000,
    paymentMethod: 'bank_transfer',
    referenceNumber: `${TAG}-BANK-HDFC-99887766`,
  });
  console.log('✓ Payment #2 (₹75,000 HDFC)');

  console.log('─'.repeat(72));
  console.log('Sharma / HPCL seeded — verify at /app/corporations');
  console.log('Login: sharma@gasdist.com / Gstadmin@123 (Sharma is GST-LIVE)');
  console.log('─'.repeat(72));
}

main().finally(() => prisma.$disconnect());
