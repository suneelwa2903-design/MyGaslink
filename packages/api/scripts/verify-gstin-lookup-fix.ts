/**
 * Verifies the gstinLookup.ts fix on a live DB (read-only).
 *
 * Two predicates are evaluated against the gst_credentials table:
 *   1. The FIXED predicate (no email filter) — should find Vanasthali's
 *      own row.
 *   2. The CURRENT/BROKEN predicate (email NOT NULL filter) — currently
 *      excludes Vanasthali → falls through to whichever row DOES have
 *      email != null (dist-demo).
 *
 * Plus a check that Layer 1 PROD env vars are present, since the fix
 * relies on them for live tenants.
 *
 * Run on prod EC2:
 *   cd /opt/gaslink && \
 *     pnpm --filter @gaslink/api tsx scripts/verify-gstin-lookup-fix.ts
 *
 * No writes. No external calls. Pure DB read + env var check.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VANASTHALI_ID = '6a749f20-5a82-4b74-9977-51eac69049f2';

async function main(): Promise<void> {
  console.log('=== gstinLookup.ts fix verification ===\n');

  // Check 1: FIXED predicate (no email filter) — what does Vanasthali get?
  const withFix = await prisma.gstCredential.findFirst({
    where: {
      distributorId: VANASTHALI_ID,
      scope: 'einvoice',
      isValid: true,
    },
    include: { distributor: { select: { id: true, gstMode: true } } },
  });
  console.log('CHECK 1 — FIXED predicate (no email filter):');
  console.log('  Row found for Vanasthali:', !!withFix);
  console.log('  distributorId matches:', withFix?.distributorId === VANASTHALI_ID);
  console.log('  gstMode:', withFix?.distributor?.gstMode);
  console.log('  email column:', withFix?.email ?? 'NULL (Group A pattern — env routes)');
  console.log('  client_id prefix:', withFix?.clientId?.substring(0, 15));
  console.log('');

  // Check 2: CURRENT BROKEN predicate (with email filter) — what does Vanasthali get?
  const withoutFix = await prisma.gstCredential.findFirst({
    where: {
      distributorId: VANASTHALI_ID,
      scope: 'einvoice',
      isValid: true,
      email: { not: null }, // ← the bug filter
    },
  });
  console.log('CHECK 2 — CURRENT BROKEN predicate (with email filter):');
  console.log('  Own-row found for Vanasthali:', !!withoutFix, '(expected: false → falls through to fallback)');
  console.log('');

  // Check 3: What does the BROKEN fallback pick instead?
  const fallback = await prisma.gstCredential.findFirst({
    where: {
      scope: 'einvoice',
      isValid: true,
      email: { not: null },
    },
    orderBy: { lastValidated: 'desc' },
    include: { distributor: { select: { id: true, gstMode: true, businessName: true } } },
  });
  console.log('CHECK 3 — BROKEN fallback picks:');
  if (fallback) {
    const leaked = fallback.distributorId !== VANASTHALI_ID;
    console.log('  distributorId:', fallback.distributorId);
    console.log('  business_name:', fallback.distributor?.businessName);
    console.log('  gstMode:', fallback.distributor?.gstMode);
    console.log('  CROSS-TENANT LEAK from Vanasthali to', fallback.distributorId, ':', leaked ? 'CONFIRMED' : 'no');
  } else {
    console.log('  No fallback row found at all');
  }
  console.log('');

  // Check 4: Layer 1 PROD env vars must exist (the fix depends on them)
  const prodEmail = process.env.WHITEBOOKS_EINVOICE_PROD_EMAIL;
  const prodCid = process.env.WHITEBOOKS_EINVOICE_PROD_CLIENT_ID;
  const prodSecret = process.env.WHITEBOOKS_EINVOICE_PROD_CLIENT_SECRET;
  console.log('CHECK 4 — Layer 1 PROD env vars on this host:');
  console.log('  WHITEBOOKS_EINVOICE_PROD_EMAIL:', prodEmail ? `present (len=${prodEmail.length})` : 'MISSING — BLOCKER');
  console.log('  WHITEBOOKS_EINVOICE_PROD_CLIENT_ID:', prodCid ? `present (len=${prodCid.length})` : 'MISSING — BLOCKER');
  console.log('  WHITEBOOKS_EINVOICE_PROD_CLIENT_SECRET:', prodSecret ? `present (len=${prodSecret.length})` : 'MISSING — BLOCKER');
  console.log('');

  // Summary
  const fixNeeded = !withFix || withFix.distributorId !== VANASTHALI_ID;
  const leakConfirmed = fallback ? fallback.distributorId !== VANASTHALI_ID : false;
  const envReady = !!(prodEmail && prodCid && prodSecret);

  console.log('=== Summary ===');
  console.log('Fix needed (Vanasthali invisible with current predicate):', fixNeeded ? 'YES' : 'NO');
  console.log('Cross-tenant leak confirmed (fallback picks foreign tenant):', leakConfirmed ? 'YES' : 'NO');
  console.log('Layer 1 PROD env ready (fix can route correctly):', envReady ? 'YES' : 'NO — BLOCKER');
  console.log('');
  console.log('Safe to deploy fix:', fixNeeded && envReady ? 'YES' : 'NO');
}

main()
  .catch((err) => {
    console.error('Verification script failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
