/**
 * F8 v2 — Corporation Ledger seed (2026-08-06).
 *
 * Seeds Bhargava's IOCL corporation with a Confidence-style month of
 * activity so the /app/corporations page renders like the reference PDF:
 *   • Multi-line gas invoices (COMM 18% + DOM 5% + freight)
 *   • Cylinder deposit invoice (Nil GST)
 *   • Payments (bank transfer)
 *   • Credit notes (volume incentive from OMC)
 *   • ERV empties return
 *
 * Idempotent: cleans up prior F8V2-SEED-* rows on each run before writing.
 * Safe to re-run; safe to run against dev DB only.
 *
 * Usage:
 *   pnpm --filter @gaslink/api exec tsx scripts/seed-f8v2-corp-ledger.ts
 */
import { prisma } from '../src/lib/prisma.js';
import { recordIncomingFulls } from '../src/services/inventoryService.js';
import { createPurchaseCreditNote } from '../src/services/purchaseCreditNoteService.js';
import { createPurchasePayment } from '../src/services/purchasePaymentService.js';

const TAG = 'F8V2-SEED';
const DIST = 'dist-001'; // Bhargava
const USER = 'user-admin';

async function cleanup() {
  console.log('Cleaning up prior seed rows…');
  // Find any purchase entries whose supplier_document_number starts with our tag.
  const entries = await prisma.purchaseEntry.findMany({
    where: { distributorId: DIST, supplierDocumentNumber: { startsWith: TAG } },
    select: { id: true },
  });
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await prisma.purchaseCreditNoteAllocation.deleteMany({
      where: { purchaseEntryId: { in: entryIds } },
    });
    await prisma.purchaseDebitNoteAllocation.deleteMany({
      where: { purchaseEntryId: { in: entryIds } },
    });
    await prisma.purchasePaymentAllocation.deleteMany({
      where: { purchaseEntryId: { in: entryIds } },
    });
    await prisma.purchaseEntryCharge.deleteMany({
      where: { purchaseEntryId: { in: entryIds } },
    });
    await prisma.purchaseEntryItem.deleteMany({
      where: { purchaseEntryId: { in: entryIds } },
    });
    await prisma.purchaseEntry.deleteMany({ where: { id: { in: entryIds } } });
  }
  await prisma.purchaseCreditNote.deleteMany({
    where: { distributorId: DIST, creditNoteNumber: { startsWith: TAG } },
  });
  await prisma.purchasePayment.deleteMany({
    where: { distributorId: DIST, referenceNumber: { startsWith: TAG } },
  });
  // ERVs (InventoryEvent) — skip cleanup; those are physical events that
  // downstream reports depend on. Re-running the seed adds a new day's ERV.
}

async function main() {
  console.log('─'.repeat(70));
  console.log('F8 v2 — Corporation Ledger seed');
  console.log('─'.repeat(70));

  await cleanup();

  // Find IOCL supplier for Bhargava.
  const iocl = await prisma.sourceDistributor.findFirst({
    where: { distributorId: DIST, name: 'IOCL', deletedAt: null },
    select: { id: true, name: true },
  });
  if (!iocl) {
    console.error('IOCL supplier not found for Bhargava. Run f8-backfill-supplier-seed first.');
    process.exit(1);
  }

  // Pick two cyl types (19KG commercial + 14.2KG domestic if available).
  const cylTypes = await prisma.cylinderType.findMany({
    where: { distributorId: DIST, isActive: true },
    select: { id: true, typeName: true },
    orderBy: { typeName: 'asc' },
    take: 2,
  });
  if (cylTypes.length === 0) {
    console.error('No cylinder types found for Bhargava.');
    process.exit(1);
  }
  const cyl19 = cylTypes[0];
  const cyl14 = cylTypes[1] ?? cylTypes[0];

  console.log(`Using IOCL (${iocl.id.slice(0, 8)}), cyl types: ${cyl19.typeName}, ${cyl14.typeName}`);

  // ─── 1. Invoice #1 — 18-Jun (COMM 18% + freight) ─────────────────────
  const inv1 = await recordIncomingFulls(DIST, USER, {
    cylinderTypeId: cyl19.id,
    quantity: 150,
    documentType: 'OMC Invoice',
    documentNumber: `${TAG}-INV-1`,
    documentDate: '2026-06-18',
    unitPrice: 4718.29, // per cyl, GST-incl
    gstRate: 18,
    plantName: 'Sanaswadi',
    sourceDistributorId: iocl.id,
    charges: [{ chargeType: 'freight', amount: 12000, notes: 'Kolhapur → Pune leg' }],
  });
  console.log(`✓ Invoice #1 (150× 19KG COMM + freight): ${inv1.eventDate.toISOString().slice(0, 10)}`);

  // ─── 2. Payment on 18-Jun — ICICI bank transfer ──────────────────────
  await createPurchasePayment(DIST, USER, {
    sourceDistributorId: iocl.id,
    transactionDate: '2026-06-18',
    amount: 610560,
    paymentMethod: 'bank_transfer',
    referenceNumber: `${TAG}-BANK-ICICI-6242510000022`,
    notes: 'Partial payment against Jun invoices',
  });
  console.log('✓ Payment (₹6,10,560 ICICI)');

  // ─── 3. Credit Note on 20-Jun — volume incentive ─────────────────────
  const entry1 = await prisma.purchaseEntry.findFirst({
    where: { distributorId: DIST, supplierDocumentNumber: `${TAG}-INV-1` },
  });
  if (entry1) {
    await createPurchaseCreditNote(DIST, USER, {
      sourceDistributorId: iocl.id,
      creditNoteNumber: `${TAG}-CN-1`,
      creditNoteDate: '2026-06-20',
      receivedDate: '2026-06-21',
      totalAmount: 119692,
      reason: 'volume_incentive',
      notes: 'May-Jun volume slab hit',
      allocations: [{ purchaseEntryId: entry1.id, amount: 119692 }],
    });
    console.log('✓ Credit Note #1 (₹1,19,692 volume incentive)');
  }

  // ─── 4. Invoice #2 — 24-Jun (COMM + DOM mix) ─────────────────────────
  await recordIncomingFulls(DIST, USER, {
    cylinderTypeId: cyl19.id,
    quantity: 100,
    documentType: 'OMC Invoice',
    documentNumber: `${TAG}-INV-2`,
    documentDate: '2026-06-24',
    unitPrice: 4750, // per cyl, GST-incl
    gstRate: 18,
    plantName: 'Sanaswadi',
    sourceDistributorId: iocl.id,
    charges: [{ chargeType: 'freight', amount: 8000 }],
  });
  console.log('✓ Invoice #2 (100× 19KG COMM)');

  // ─── 5. Deposit Invoice — 04-Aug (Nil GST) ────────────────────────────
  // recordIncomingFulls always writes documentType='invoice'; a deposit
  // invoice needs documentType='deposit_invoice'. Write directly with
  // Prisma to sidestep the service's default. Same shape as the service
  // otherwise so ledger reader picks it up correctly.
  const now = new Date();
  const distributor = await prisma.distributor.findUnique({
    where: { id: DIST },
    select: { docCode: true },
  });
  const purchaseNumber = distributor?.docCode
    ? `P${distributor.docCode}${String(now.getFullYear()).slice(-2)}${String(now.getFullYear() + 1).slice(-2)}DEP001`
    : `P-DEP-${Date.now().toString(36).toUpperCase()}`;
  await prisma.purchaseEntry.create({
    data: {
      purchaseNumber,
      distributorId: DIST,
      sourceDistributorId: iocl.id,
      sourceDistributorName: iocl.name,
      purchaseDate: '2026-08-04',
      supplierDocumentNumber: `${TAG}-DEP-1`,
      supplierDocumentDate: '2026-08-04',
      plantName: 'Sanaswadi',
      documentType: 'deposit_invoice',
      notes: '200 new cylinders added to pool',
      createdBy: USER,
      items: {
        create: [
          {
            cylinderTypeId: cyl19.id,
            fullsReceived: 200,
            emptiesGivenOut: 0,
            unitPrice: 2100,
            gstRate: 0, // Nil GST for deposit
          },
        ],
      },
    },
  });
  console.log('✓ Deposit Invoice (200× 19KG @ ₹2,100 = ₹4,20,000 Nil GST)');

  // ─── 6. Invoice #3 — 04-Aug (COMM) ───────────────────────────────────
  await recordIncomingFulls(DIST, USER, {
    cylinderTypeId: cyl19.id,
    quantity: 120,
    documentType: 'OMC Invoice',
    documentNumber: `${TAG}-INV-3`,
    documentDate: '2026-08-04',
    unitPrice: 4788,
    gstRate: 18,
    plantName: 'Kolhapur Plant',
    sourceDistributorId: iocl.id,
    charges: [{ chargeType: 'freight', amount: 9600 }],
  });
  console.log('✓ Invoice #3 (120× 19KG COMM · Kolhapur Plant)');

  // Summary
  const balances = await prisma.$queryRaw<Array<{ outstanding: string; deposits: string }>>`
    SELECT
      COALESCE(SUM(CASE WHEN pe.document_type = 'invoice' THEN pei.total ELSE 0 END), 0)::text AS outstanding,
      COALESCE(SUM(CASE WHEN pe.document_type = 'deposit_invoice' THEN pei.total ELSE 0 END), 0)::text AS deposits
    FROM purchase_entries pe
    JOIN (
      SELECT purchase_entry_id, SUM(unit_price * fulls_received) AS total
      FROM purchase_entry_items GROUP BY purchase_entry_id
    ) pei ON pei.purchase_entry_id = pe.purchase_entry_id
    WHERE pe.distributor_id = ${DIST}
      AND pe.source_distributor_id = ${iocl.id}
      AND pe.deleted_at IS NULL
      AND pe.supplier_document_number LIKE ${TAG + '%'}
  `;
  console.log('─'.repeat(70));
  console.log('Seeded — verify at /app/corporations (login: bhargava@gasagency.com / Distadmin@123)');
  console.log(`Purchases (gas): ₹${Number(balances[0]?.outstanding).toLocaleString('en-IN')}`);
  console.log(`Deposits:        ₹${Number(balances[0]?.deposits).toLocaleString('en-IN')}`);
  console.log('─'.repeat(70));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('SEED FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
