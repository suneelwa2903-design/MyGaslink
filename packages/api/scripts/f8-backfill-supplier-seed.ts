/**
 * F8 (2026-08-06) — Backfill script: seed SourceDistributor rows from every
 * existing tenant's providerCodes[] array.
 *
 * WHAT IT DOES
 * ────────────
 * For every distributor row (deletedAt IS NULL) with providerCodes.length > 0,
 * call seedSuppliersFromProviderCodes() which idempotently creates the
 * missing SourceDistributor rows. Case-insensitive dedup so a manually-
 * added "IOCL" won't spawn a duplicate.
 *
 * WHY IT EXISTS
 * ─────────────
 * Pre-F8, providerCodes[] on regular distributors was set at tenant creation
 * but no SourceDistributor rows were auto-created (that flow was mini-op
 * only). Sharma, Bhargava, Vanasthali, and any other pre-F8 tenant needs a
 * one-shot backfill to catch up before the F8 UI (Purchases page, Record CN
 * modal, supplier statement PDF) becomes useful for them.
 *
 * SAFETY
 * ──────
 * — Dry-run by default. Prints exactly what WOULD be created per tenant.
 * — Pass `--apply` to actually write. Every insert goes through the same
 *   seedSuppliersFromProviderCodes helper the createDistributor hook uses,
 *   so behaviour is bit-identical to a fresh tenant creation.
 * — Idempotent: safe to re-run. Existing rows (case-insensitive) are
 *   skipped; only genuinely missing OMC codes get inserted.
 * — Does NOT touch soft-deleted distributors.
 * — Does NOT touch any other supplier rows (manually-added local depots,
 *   private marketers, mini-op suppliers). Those stay untouched.
 *
 * USAGE
 * ─────
 *   # Preview what will change (safe):
 *   pnpm --filter @gaslink/api exec tsx scripts/f8-backfill-supplier-seed.ts
 *
 *   # Apply the changes:
 *   pnpm --filter @gaslink/api exec tsx scripts/f8-backfill-supplier-seed.ts --apply
 */

import { prisma } from '../src/lib/prisma.js';
import { seedSuppliersFromProviderCodes } from '../src/services/sourceDistributorService.js';

async function main() {
  const apply = process.argv.includes('--apply');

  console.log('─'.repeat(72));
  console.log(`F8 supplier backfill — ${apply ? 'APPLY MODE' : 'DRY RUN'}`);
  console.log('─'.repeat(72));

  const tenants = await prisma.distributor.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      businessName: true,
      accountType: true,
      providerCodes: true,
      sourceDistributors: {
        where: { deletedAt: null },
        select: { name: true },
      },
    },
    orderBy: { businessName: 'asc' },
  });

  let totalCreates = 0;
  let totalAlreadyPresent = 0;
  let touchedTenants = 0;
  let skippedNoProviderCodes = 0;

  for (const t of tenants) {
    if (!t.providerCodes || t.providerCodes.length === 0) {
      skippedNoProviderCodes++;
      continue;
    }
    const existingUpper = new Set(t.sourceDistributors.map((s) => s.name.toUpperCase().trim()));
    const cleaned = Array.from(
      new Set(t.providerCodes.map((c) => (c ?? '').trim().toUpperCase()).filter(Boolean)),
    );
    const missing = cleaned.filter((c) => !existingUpper.has(c));
    const alreadyPresent = cleaned.filter((c) => existingUpper.has(c));

    if (missing.length === 0) {
      console.log(
        `  [${t.accountType.padEnd(14)}] ${t.businessName} — all ${cleaned.length} provider(s) already have supplier rows`,
      );
      totalAlreadyPresent += alreadyPresent.length;
      continue;
    }

    console.log(
      `  [${t.accountType.padEnd(14)}] ${t.businessName}`,
    );
    console.log(`      providerCodes:   ${cleaned.join(', ') || '(none)'}`);
    console.log(`      already present: ${alreadyPresent.join(', ') || '(none)'}`);
    console.log(`      will create:     ${missing.join(', ')}`);

    touchedTenants++;
    totalCreates += missing.length;
    totalAlreadyPresent += alreadyPresent.length;

    if (apply) {
      const created = await seedSuppliersFromProviderCodes(t.id, cleaned);
      console.log(`      ✓ created:       ${created.join(', ') || '(none — race?)'}`);
    }
  }

  console.log('─'.repeat(72));
  console.log(`Tenants scanned:              ${tenants.length}`);
  console.log(`Skipped (no providerCodes):   ${skippedNoProviderCodes}`);
  console.log(`Tenants with missing seeds:   ${touchedTenants}`);
  console.log(`Suppliers to create:          ${totalCreates}`);
  console.log(`Suppliers already present:    ${totalAlreadyPresent}`);
  if (!apply && totalCreates > 0) {
    console.log('');
    console.log('  ➜ Re-run with --apply to actually create the missing supplier rows.');
  }
  console.log('─'.repeat(72));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('BACKFILL FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
