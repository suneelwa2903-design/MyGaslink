/**
 * RCM Phase 2 — surgical cancel + reissue for Vanasthali (24h NIC window).
 *
 * Cancels EWB then IRN at NIC via WhiteBooks (correct order enforced by
 * gstService.cancelIrn's EWB_ACTIVE hard gate). Inside one Prisma
 * $transaction: soft-deletes the old invoice, disconnects it from its
 * order (the Invoice.orderId @unique constraint requires this so the
 * new invoice can attach to the same order), writes a reversal ledger
 * entry dated on the ORIGINAL issue_date (not today), creates a fresh
 * IVGS...(next-in-seq) invoice with same items + amounts, and writes
 * the new debit ledger entry — also dated on the ORIGINAL issue_date.
 * Then calls processInvoiceGst which regenerates IRN + EWB using the
 * fixed payload builder (RegRev='N').
 *
 * SAFETY
 * ------
 *   * Scoped to Vanasthali distributor only (hard-coded ID).
 *   * Processes ONE invoice per invocation via required --only flag.
 *   * External NIC cancels happen OUTSIDE the $transaction because they
 *     have real side effects on NIC; the $transaction only covers DB
 *     mutations for atomicity.
 *   * Verifies RegRev='N' and NIC status_cd=1 in gst_api_logs before
 *     declaring success. Non-success exit code 2.
 *   * Appends an audit row to docs/RCM-RERAISED-LOG.md.
 *
 * USAGE
 * -----
 *   pnpm exec tsx scripts/rcm-reissue-vanasthali-24h.ts --only IVGS2627000265
 *
 *   Optional:
 *     --user <userId>   Attribute cancel + ledger writes to this userId.
 *                       Defaults to null (system).
 *     --dry-run         Report the plan but perform no writes / no NIC calls.
 *
 * PREREQUISITE
 * ------------
 *   payloadBuilders.ts must carry the fix `RegRev: 'N'` — verified by
 *   asserting the outgoing gst_api_logs.request_payload.TranDtls.RegRev
 *   after IRN regeneration.
 */
import { prisma } from '../src/lib/prisma.js';
import { cancelEwb, cancelIrn, processInvoiceGst } from '../src/services/gst/gstService.js';
import { allocateNumber } from '../src/services/numberingService.js';
import { promises as fs } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VANASTHALI_DIST_ID = '6a749f20-5a82-4b74-9977-51eac69049f2';
const REASON = 'RCM correction: reissuing to fix Table 4B classification';
const REASON_CODE = '4'; // NIC code for "Others"

// docs/ path anchor relative to this script file.
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = pathResolve(__dirname, '../../../docs/RCM-RERAISED-LOG.md');

interface Args {
  only: string;
  userId: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { userId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = argv[++i];
    else if (a === '--user') args.userId = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (!args.only) {
    throw new Error('Usage: --only <invoiceNumber> [--user <userId>] [--dry-run]');
  }
  return args as Args;
}

async function ensureLogHeader(): Promise<void> {
  try {
    await fs.access(LOG_PATH);
  } catch {
    await fs.writeFile(
      LOG_PATH,
      '# RCM Reissued — Vanasthali (24h window)\n\n' +
      '| timestamp | old_invoice | old_irn | new_invoice | new_irn | buyer | amount | irn_status | ewb_status | RegRev | status_cd |\n' +
      '|---|---|---|---|---|---|---|---|---|---|---|\n',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== RCM Phase 2 — cancel + reissue ===');
  console.log(`Target:    ${args.only}`);
  console.log(`Mode:      ${args.dryRun ? 'DRY RUN (no writes)' : 'APPLY (writes + NIC calls commit)'}`);
  console.log(`Operator:  ${args.userId ?? '(null = system)'}\n`);

  const inv = await prisma.invoice.findFirst({
    where: {
      invoiceNumber: args.only,
      distributorId: VANASTHALI_DIST_ID,
      deletedAt: null,
    },
    include: {
      items: { orderBy: { id: 'asc' } },
      customer: { select: { customerName: true, gstin: true, businessName: true } },
      order: { select: { orderNumber: true, driverId: true, vehicleId: true } },
    },
  });
  if (!inv) throw new Error(`Invoice ${args.only} not found in Vanasthali scope`);
  if (inv.orderId === null) throw new Error(`Invoice ${args.only} has no orderId — cannot reuse order`);
  if (inv.status === 'cancelled') throw new Error(`Invoice ${args.only} is already cancelled`);
  if (!inv.customerId) throw new Error(`Invoice ${args.only} has no customerId — bad data`);

  console.log('=== Original invoice ===');
  console.log(`invoice_id:      ${inv.id}`);
  console.log(`invoice_number:  ${inv.invoiceNumber}`);
  console.log(`issue_date:      ${inv.issueDate.toISOString().slice(0, 10)}`);
  console.log(`total_amount:    ${inv.totalAmount.toString()}`);
  console.log(`customer:        ${inv.customer?.businessName ?? inv.customer?.customerName}`);
  console.log(`gstin:           ${inv.customer?.gstin}`);
  console.log(`order_id:        ${inv.orderId}`);
  console.log(`order_number:    ${inv.order?.orderNumber}`);
  console.log(`irn:             ${inv.irn?.slice(0, 16)}…`);
  console.log(`irn_status:      ${inv.irnStatus}`);
  console.log(`ewb_status:      ${inv.ewbStatus}`);
  console.log(`items:           ${inv.items.length}`);
  console.log();

  if (args.dryRun) {
    console.log('DRY RUN — would perform:');
    console.log('  A. cancelEwb() on original');
    console.log('  B. cancelIrn() on original');
    console.log('  C. $transaction:');
    console.log('       - soft-delete old invoice + disconnect from order');
    console.log(`       - write reversal ledger entry: -${inv.totalAmount.toString()} on ${inv.issueDate.toISOString().slice(0, 10)}`);
    console.log(`       - allocate new number IVGS${inv.issueDate.getFullYear() >= 2026 ? '2627' : '?'}...`);
    console.log('       - create new invoice with same items + amounts, issue_date=' + inv.issueDate.toISOString().slice(0, 10));
    console.log(`       - write new invoice_entry ledger: +${inv.totalAmount.toString()} on ${inv.issueDate.toISOString().slice(0, 10)}`);
    console.log('  D. processInvoiceGst() → new IRN + EWB');
    console.log('  E. verify RegRev=N + status_cd=1 in gst_api_logs');
    return;
  }

  const distributor = await prisma.distributor.findUniqueOrThrow({
    where: { id: VANASTHALI_DIST_ID },
    select: { docCode: true },
  });
  const docCode = distributor.docCode;
  if (!docCode || !/^[A-Z]{3}$/.test(docCode)) {
    throw new Error(`Vanasthali docCode invalid: ${docCode}`);
  }

  // ─── Step A — Cancel EWB at NIC ─────────────────────────────────────
  console.log('Step A — cancelling EWB at NIC...');
  if (inv.ewbStatus === 'active') {
    await cancelEwb(inv.id, VANASTHALI_DIST_ID, REASON, REASON_CODE, args.userId);
    console.log('  ✓ EWB cancelled');
  } else {
    console.log(`  skipped — ewb_status=${inv.ewbStatus}`);
  }

  // ─── Step B — Cancel IRN at NIC ─────────────────────────────────────
  console.log('Step B — cancelling IRN at NIC...');
  if (inv.irnStatus === 'success') {
    await cancelIrn(inv.id, VANASTHALI_DIST_ID, REASON, REASON_CODE, args.userId);
    console.log('  ✓ IRN cancelled');
  } else {
    console.log(`  skipped — irn_status=${inv.irnStatus}`);
  }

  // ─── Step C — Ledger reversal + new invoice + new ledger debit ──────
  console.log('Step C — DB transaction (soft-delete, reversal, new invoice, new debit)...');
  const originalIssueDate = inv.issueDate;
  const originalTotal = inv.totalAmount;
  const orderNumber = inv.order?.orderNumber ?? '?';

  const { newInvoiceId, newInvoiceNumber } = await prisma.$transaction(async (tx) => {
    // Soft-delete old + disconnect from order (Invoice.orderId is @unique
    // — must free before creating the new invoice against the same order).
    await tx.invoice.update({
      where: { id: inv.id },
      data: {
        status: 'cancelled',
        deletedAt: new Date(),
        order: { disconnect: true },
      },
    });

    // Reversal ledger — same entry_date as original, amount negated,
    // entryType='adjustment' (LedgerEntryType has no reversal enum).
    await tx.customerLedgerEntry.create({
      data: {
        distributorId: VANASTHALI_DIST_ID,
        customerId: inv.customerId!,
        entryType: 'adjustment',
        referenceId: inv.id,
        invoiceId: inv.id,
        amountDelta: originalTotal.mul(-1),
        narration: `RCM correction: Invoice ${inv.invoiceNumber} cancelled — reissue below`,
        entryDate: originalIssueDate,
        createdBy: args.userId,
      },
    });

    // Allocate NEW invoice number keyed on the ORIGINAL issueDate so the
    // FY segment matches (2027 vs 2627 boundary). Same counter as the
    // regular invoice flow.
    const newInvoiceNumber = await allocateNumber(
      tx, VANASTHALI_DIST_ID, 'I', originalIssueDate, docCode,
    );

    // Create new invoice — copy essential fields verbatim from original.
    const newInvoice = await tx.invoice.create({
      data: {
        invoiceNumber: newInvoiceNumber,
        distributorId: VANASTHALI_DIST_ID,
        customerId: inv.customerId,
        orderId: inv.orderId, // safe — old invoice disconnected above
        issueDate: originalIssueDate,
        dueDate: inv.dueDate,
        totalAmount: originalTotal,
        outstandingAmount: originalTotal, // Phase 0 confirmed no allocations
        status: 'issued',
        irnStatus: 'pending',
        ewbStatus: 'pending',
        cgstValue: inv.cgstValue,
        sgstValue: inv.sgstValue,
        igstValue: inv.igstValue,
        taxableValue: inv.taxableValue,
        placeOfSupplyCode: inv.placeOfSupplyCode,
        reverseCharge: false,
        customerGstinSnapshot: inv.customerGstinSnapshot,
        poNumber: inv.poNumber,
        isGaslinkBilling: inv.isGaslinkBilling,
        isOpeningBalance: inv.isOpeningBalance,
        issuedBy: args.userId,
        items: {
          create: inv.items.map((it) => ({
            cylinderTypeId: it.cylinderTypeId,
            description: it.description,
            hsnCode: it.hsnCode,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountPerUnit: it.discountPerUnit,
            gstRate: it.gstRate,
            totalPrice: it.totalPrice,
            taxableValue: it.taxableValue,
            uom: it.uom,
          })),
        },
      },
      select: { id: true, invoiceNumber: true },
    });

    // New debit ledger — dated on ORIGINAL issue_date, NOT today.
    await tx.customerLedgerEntry.create({
      data: {
        distributorId: VANASTHALI_DIST_ID,
        customerId: inv.customerId!,
        entryType: 'invoice_entry',
        referenceId: newInvoice.id,
        invoiceId: newInvoice.id,
        amountDelta: originalTotal,
        narration: `Invoice ${newInvoiceNumber} for order ${orderNumber} — RCM reissue of ${inv.invoiceNumber}`,
        entryDate: originalIssueDate,
        createdBy: args.userId,
      },
    });

    return { newInvoiceId: newInvoice.id, newInvoiceNumber: newInvoice.invoiceNumber };
  });
  console.log(`  ✓ New invoice created: ${newInvoiceNumber} (id=${newInvoiceId})`);
  console.log('  ✓ Reversal + new-debit ledger entries written on 2026-07-09');

  // ─── Step D — Generate new IRN + EWB via prod code path ────────────
  console.log('Step D — generating new IRN + EWB via processInvoiceGst...');
  await processInvoiceGst(newInvoiceId, VANASTHALI_DIST_ID);
  console.log('  ✓ processInvoiceGst returned');

  // ─── Step E — Verify final DB state ────────────────────────────────
  const after = await prisma.invoice.findUniqueOrThrow({
    where: { id: newInvoiceId },
    select: {
      invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true,
      issueDate: true, totalAmount: true, orderId: true, ackNo: true,
    },
  });
  const gstDoc = await prisma.gstDocument.findFirst({
    where: { invoiceId: newInvoiceId, isLatest: true },
    select: { ewbNo: true, ewbStatus: true, ewbValidTill: true },
  });
  const lastLog = await prisma.gstApiLog.findFirst({
    where: { invoiceId: newInvoiceId, apiType: 'IRN_GENERATE' },
    orderBy: { createdAt: 'desc' },
    select: { requestPayload: true, responsePayload: true, httpStatus: true },
  });
  const req = lastLog?.requestPayload as { TranDtls?: { RegRev?: string } } | null;
  const res = lastLog?.responsePayload as { status_cd?: string | number } | null;
  const regRev = req?.TranDtls?.RegRev ?? '?';
  const statusCd = res?.status_cd ?? '?';

  console.log('\n=== FINAL STATE (new invoice) ===');
  console.log(`invoice_number:  ${after.invoiceNumber}`);
  console.log(`orderId:         ${after.orderId}`);
  console.log(`issue_date:      ${after.issueDate.toISOString().slice(0, 10)}  (expect 2026-07-09)`);
  console.log(`total_amount:    ${after.totalAmount.toString()}`);
  console.log(`irn_status:      ${after.irnStatus}`);
  console.log(`irn:             ${after.irn?.slice(0, 32)}…`);
  console.log(`ack_no:          ${after.ackNo}`);
  console.log(`ewb_status:      ${after.ewbStatus}`);
  console.log(`ewb_no:          ${gstDoc?.ewbNo ?? '(none)'}`);
  console.log(`ewb_valid_till:  ${gstDoc?.ewbValidTill?.toISOString() ?? '(none)'}`);
  console.log(`RegRev in payload sent to NIC:  ${regRev}   (expect 'N')`);
  console.log(`NIC status_cd:                  ${statusCd}   (expect 1 or '1')`);

  // Ledger snapshot
  const ledgerEntries = await prisma.customerLedgerEntry.findMany({
    where: {
      distributorId: VANASTHALI_DIST_ID,
      customerId: inv.customerId!,
      OR: [{ invoiceId: inv.id }, { invoiceId: newInvoiceId }],
    },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
    select: { entryType: true, amountDelta: true, entryDate: true, narration: true },
  });
  console.log('\n=== Ledger entries for this customer (old + new) ===');
  for (const e of ledgerEntries) {
    console.log(`  ${e.entryDate.toISOString().slice(0, 10)}  ${e.entryType.padEnd(15)} ${e.amountDelta.toString().padStart(12)}   ${e.narration}`);
  }

  await ensureLogHeader();
  const logLine = [
    new Date().toISOString(),
    inv.invoiceNumber,
    inv.irn?.slice(0, 16) ?? '?',
    after.invoiceNumber,
    (after.irn ?? '?').slice(0, 16),
    inv.customer?.businessName ?? inv.customer?.customerName ?? '?',
    originalTotal.toString(),
    after.irnStatus,
    after.ewbStatus,
    regRev,
    String(statusCd),
  ].map((s) => `| ${s}`).join(' ') + ' |';
  await fs.appendFile(LOG_PATH, logLine + '\n');
  console.log(`\nAudit line appended to ${LOG_PATH}`);

  const ok =
    regRev === 'N' &&
    (statusCd === 1 || statusCd === '1') &&
    after.irnStatus === 'success' &&
    after.issueDate.toISOString().slice(0, 10) === originalIssueDate.toISOString().slice(0, 10);
  if (!ok) {
    console.error('\n⛔ Verification failed — some invariant not met. See values above.');
    process.exit(2);
  }
  console.log('\n✅ RCM reissue completed successfully');
}

main()
  .catch((err) => {
    console.error('\n⛔ Reissue failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
