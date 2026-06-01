/**
 * nic-reissue-tool.ts
 *
 * READ-ONLY listing tool for the GST double-division bug
 * (CLAUDE.md anti-pattern #16). After gst-unit-price-backfill.ts has
 * corrected the InvoiceItem.unitPrice values in the DB, the NIC e-invoice
 * portal STILL holds the under-reported AssAmt for every IRN successfully
 * generated before the fix shipped. Those need to be cancel-and-re-issued
 * via the existing gstReissueService.reissueForDeliveryMismatch path so
 * NIC has correct values for GSTR-1 auto-population.
 *
 * This tool DOES NOT call NIC. It only lists candidate invoices and
 * prints the exact manual command an operator should run to re-issue
 * each one, one at a time. The reason for not running NIC calls
 * automatically:
 *   - NIC live cancel + re-issue is irreversible.
 *   - The operator should sanity-check 1-2 invoices manually first
 *     (compare AssAmt before/after, confirm customer copy reflects
 *     correct values) before processing the rest in batches.
 *   - Each call consumes the tenant's NIC sandbox quota; rate-limit
 *     control should be in the operator's hands.
 *
 * Usage from packages/api:
 *   pnpm tsx scripts/nic-reissue-tool.ts                          # list all GST-live tenants
 *   pnpm tsx scripts/nic-reissue-tool.ts --distributor=dist-002   # list one tenant
 *   pnpm tsx scripts/nic-reissue-tool.ts --before=2026-06-01T00:00:00Z
 *
 * Output format (per candidate):
 *   <invoiceId>  <invoiceNumber>  <customerName>  <totalAmount>  <issueDate>
 *
 * Manual re-issue (one invoice at a time, after backfill):
 *   pnpm tsx -e "
 *     import { reissueForDeliveryMismatch } from './src/services/gst/gstReissueService.js';
 *     await reissueForDeliveryMismatch({
 *       invoiceId: '<invoiceId>',
 *       distributorId: '<distributorId>',
 *       userId: 'super-admin-or-operator-userId',
 *       mismatchContext: { source: 'AP16-rebackfill' },
 *     });
 *   "
 *
 * Or use the web admin UI: open the invoice → click "Regenerate" (web
 * Cancel-IRN flow → auto-cancel + auto-regenerate via the same service).
 * Reason text: "AP16 backfill — correct GST under-reporting".
 */
import { prisma } from '../src/lib/prisma.js';
import { reissueForDeliveryMismatch } from '../src/services/gst/gstReissueService.js';

function parseArgs(): { distributorId?: string; before: Date; apply: boolean; userId?: string } {
  const args = process.argv.slice(2);
  let distributorId: string | undefined;
  let before = new Date();
  let apply = false;
  let userId: string | undefined;
  for (const a of args) {
    if (a === '--apply') apply = true;
    else if (a.startsWith('--distributor=')) distributorId = a.slice('--distributor='.length);
    else if (a.startsWith('--before=')) before = new Date(a.slice('--before='.length));
    else if (a.startsWith('--user=')) userId = a.slice('--user='.length);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return { distributorId, before, apply, userId };
}

async function processTenant(distributorId: string, before: Date, apply: boolean, operatorUserId?: string) {
  const tenant = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { id: true, businessName: true, gstMode: true },
  });
  if (!tenant) {
    console.log(`[${distributorId}] not found.`);
    return 0;
  }
  if (tenant.gstMode === 'disabled') {
    console.log(`[${distributorId}] ${tenant.businessName} — GST disabled, skipping.`);
    return 0;
  }

  const candidates = await prisma.invoice.findMany({
    where: {
      distributorId,
      irnStatus: 'success',
      createdAt: { lt: before },
      deletedAt: null,
    },
    select: {
      id: true,
      invoiceNumber: true,
      totalAmount: true,
      issueDate: true,
      irn: true,
      customer: { select: { customerName: true, gstin: true } },
    },
    orderBy: { issueDate: 'asc' },
  });

  console.log(`\n[${distributorId}] ${tenant.businessName} — ${tenant.gstMode}`);
  console.log(`Candidates needing NIC re-issue (irn_status=success, created < ${before.toISOString()}):`);
  if (candidates.length === 0) {
    console.log(`  (none)`);
    return 0;
  }

  for (const inv of candidates) {
    console.log(
      `  ${inv.id}  ${inv.invoiceNumber}  ` +
      `${inv.customer?.customerName ?? '-'}  ` +
      `₹${Number(inv.totalAmount).toFixed(2)}  ` +
      `${inv.issueDate.toISOString().slice(0, 10)}  ` +
      `IRN=${inv.irn?.slice(0, 16)}...`,
    );
  }
  console.log(`[${distributorId}] total: ${candidates.length} invoices.`);

  if (!apply) return { total: candidates.length, success: 0, failed: 0 };

  // --apply: actually call gstReissueService for each invoice. This
  // CANCELS the existing IRN at NIC and REGENERATES a fresh one with
  // the corrected amounts. ONLY safe on sandbox / test tenants.
  console.log(`\n[${distributorId}] APPLYING re-issue — calling NIC for ${candidates.length} invoices…`);
  let success = 0;
  let failed = 0;
  for (const inv of candidates) {
    const tag = `${inv.invoiceNumber} (${inv.id})`;
    try {
      const result = await reissueForDeliveryMismatch({
        invoiceId: inv.id,
        distributorId,
        userId: operatorUserId ?? 'ap16-backfill-script',
        mismatchContext: { source: 'AP16-rebackfill' },
      });
      if (result.ok) {
        success++;
        console.log(`  ✅ ${tag}`);
      } else {
        failed++;
        console.log(`  ⚠  ${tag} — ${result.reason ?? 'unknown'}`);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ ${tag} — ${msg}`);
    }
  }
  console.log(`[${distributorId}] re-issue complete: ${success} success, ${failed} failed.`);
  return { total: candidates.length, success, failed };
}

async function main() {
  const { distributorId, before, apply, userId } = parseArgs();
  console.log(apply
    ? `APPLY mode — invoices needing NIC re-issue WILL be cancelled and regenerated`
    : `READ-ONLY listing — invoices that need NIC re-issue after AP16 backfill`);
  console.log(`Cutoff: invoices created before ${before.toISOString()}`);
  if (distributorId) console.log(`Scope: distributor ${distributorId}`);
  if (userId) console.log(`Operator userId: ${userId}`);

  const tenants = distributorId
    ? [{ id: distributorId }]
    : await prisma.distributor.findMany({
        where: { status: 'active', gstMode: { not: 'disabled' } },
        select: { id: true },
      });

  let grandTotal = 0;
  let grandSuccess = 0;
  let grandFailed = 0;
  for (const t of tenants) {
    const r = await processTenant(t.id, before, apply, userId);
    grandTotal += r.total;
    grandSuccess += r.success;
    grandFailed += r.failed;
  }

  console.log(`\nGrand total: ${grandTotal} invoices to re-issue.`);
  if (apply) {
    console.log(`Re-issue results: ${grandSuccess} success, ${grandFailed} failed.`);
  } else {
    console.log(`\nNext step: run gst-unit-price-backfill.ts --apply FIRST, then re-run this with --apply to actually call NIC.`);
  }
}

main()
  .catch((err) => {
    console.error('Listing failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
