/**
 * Trip 2 wrong-customer cleanup — Step 1 of 2: cancel 3 standalone EWBs at NIC.
 *
 * Context: 2026-07-11 Suresh's Trip 2 (Vanasthali) dispatched with 3 orders
 * mis-attributed to the wrong customers:
 *   OVGS2627000340 → MEGHANA TIFFINS       (should be Manikjanta Tiffins)
 *   OVGS2627000343 → SRINIVASA TIFFIN CENTRE (should be Srinivas Hotel)
 *   OVGS2627000344 → ASWAD KITCHEN         (should be Swaad Kitchen)
 *
 * Physical cylinders reached the RIGHT customers. Only the app records + the
 * standalone EWBs at NIC carry the wrong trade names / addresses. We cancel
 * the 3 EWBs at NIC first (24h window closes 2026-07-12 20:00 IST) so the
 * DB-side wipe (Step 2) leaves NIC clean too.
 *
 * SAFETY
 * ------
 *   * Hard-coded to the 3 known invoice numbers.
 *   * Scoped to Vanasthali distributor ID only.
 *   * Reason code 3 (Data Entry Mistake) — NIC standard for party details.
 *   * Cancels via existing gstService.cancelEwb — same path used in RCM
 *     Phase 2 (task #76). Handles ewb_status update + gst_documents stamp
 *     + gst_api_logs audit trail.
 *   * Dry-run by default. Requires --apply to actually fire NIC calls.
 *
 * USAGE
 * -----
 *   pnpm exec tsx scripts/cancel-ewb-trip2-wrong-customers.ts             # dry-run
 *   pnpm exec tsx scripts/cancel-ewb-trip2-wrong-customers.ts --apply     # commit
 *
 * NEXT STEP
 * ---------
 *   After all 3 EWBs cancelled successfully, run:
 *     pnpm exec tsx scripts/wipe-trip2-wrong-customer-records.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { cancelEwb } from '../src/services/gst/gstService.js';

const VANASTHALI_DIST_ID = '6a749f20-5a82-4b74-9977-51eac69049f2';
const TARGET_INVOICES = [
  'IVGS2627000330', // Meghana Tiffins (wrong)
  'IVGS2627000333', // Srinivasa Tiffin Centre (wrong)
  'IVGS2627000334', // Aswad Kitchen (wrong)
];
const REASON = 'Incorrect party — reissuing invoice for correct customer';
const REASON_CODE = '3'; // NIC standard: Data Entry Mistake

interface Args {
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true };
  for (const a of argv) {
    if (a === '--apply') args.dryRun = false;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== Trip 2 wrong-customer EWB cancel ===');
  console.log(`Mode:      ${args.dryRun ? 'DRY RUN (no NIC calls)' : 'APPLY (NIC calls will fire)'}`);
  console.log(`Reason:    ${REASON} (code=${REASON_CODE})\n`);

  let anyFailed = false;

  for (const invoiceNumber of TARGET_INVOICES) {
    const inv = await prisma.invoice.findFirst({
      where: {
        invoiceNumber,
        distributorId: VANASTHALI_DIST_ID,
      },
      select: { id: true, invoiceNumber: true, ewbStatus: true, status: true, customerId: true },
    });
    if (!inv) {
      console.error(`  ✗ ${invoiceNumber}: NOT FOUND on Vanasthali — aborting`);
      anyFailed = true;
      continue;
    }

    const gstDoc = await prisma.gstDocument.findFirst({
      where: { invoiceId: inv.id, isLatest: true, ewbNo: { not: null } },
      select: { ewbNo: true, ewbStatus: true, ewbDate: true, ewbValidTill: true, cancelledAt: true },
    });
    if (!gstDoc?.ewbNo) {
      console.error(`  ✗ ${invoiceNumber}: no active EWB found — skip`);
      continue;
    }
    if (gstDoc.cancelledAt) {
      console.log(`  ○ ${invoiceNumber}: EWB ${gstDoc.ewbNo} already cancelled at ${gstDoc.cancelledAt.toISOString()} — skip`);
      continue;
    }

    console.log(`  → ${invoiceNumber}:`);
    console.log(`      ewb_no:         ${gstDoc.ewbNo}`);
    console.log(`      ewb_status:     ${gstDoc.ewbStatus}`);
    console.log(`      ewb_date:       ${gstDoc.ewbDate?.toISOString()}`);
    console.log(`      ewb_valid_till: ${gstDoc.ewbValidTill?.toISOString()}`);

    if (args.dryRun) {
      console.log(`      would call:     cancelEwb(invoiceId, distributorId, reason, "3")`);
      console.log(`      would set:      invoice.ewb_status='cancelled', gst_documents.cancelled_at=NOW()`);
      console.log();
      continue;
    }

    try {
      const response = await cancelEwb(inv.id, VANASTHALI_DIST_ID, REASON, REASON_CODE, null);
      const statusCd = (response as { status_cd?: string; header?: { status_cd?: string } })?.status_cd
        ?? (response as { header?: { status_cd?: string } })?.header?.status_cd;
      console.log(`      ✓ NIC status_cd=${statusCd ?? '(unknown)'}`);
      console.log();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`      ✗ FAILED: ${msg}`);
      anyFailed = true;
    }
  }

  if (anyFailed) {
    console.error('\nOne or more cancels failed. Do NOT proceed to wipe script until every EWB is cancelled at NIC.');
    process.exit(2);
  }
  console.log('\n=== Done ===');
  if (args.dryRun) {
    console.log('Re-run with --apply to fire the NIC calls.');
  } else {
    console.log('Next step: pnpm exec tsx scripts/wipe-trip2-wrong-customer-records.ts --apply');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
