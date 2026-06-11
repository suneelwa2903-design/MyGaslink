/**
 * Phase 5 (2026-06-12) — GSTR-1 column backfill (dry-run by default).
 *
 * Populates the new Phase 5 columns on historical Invoice / InvoiceItem
 * / CreditNote rows so the upcoming GSTR-1 export reads complete data
 * for past quarters. New rows from this point on are populated at write
 * time by invoiceService.createInvoiceFromOrder + createManualInvoice +
 * createCreditNote — this script is the one-shot catch-up for everything
 * that landed before Phase 5.
 *
 * What the script DOES NOT backfill (per Suneel decision 2026-06-12):
 *   - Invoice.customerGstinSnapshot: too much drift risk. A customer
 *     may have edited their GSTIN since issue, and we have no audit log
 *     of when the change happened — we'd be snapshotting today's value
 *     to a past invoice and silently MIS-stating the historical record.
 *     Better to leave NULL and let the GSTR-1 export flag those rows.
 *
 * What it DOES backfill:
 *   - Invoice.taxableValue       = totalAmount / (1 + gstRate/100)
 *                                  (uses the actual per-item gstRate,
 *                                  weighted by line total; falls back
 *                                  to 18% when items have no rate)
 *   - Invoice.placeOfSupplyCode  = first 2 chars of customer GSTIN if
 *                                  set, else 2-digit code derived from
 *                                  customer.billingState via the shared
 *                                  STATE_CODE_BY_NAME map, else NULL.
 *   - InvoiceItem.taxableValue   = item.totalPrice / (1 + item.gstRate/100)
 *   - CreditNote tax splits      = proportional ratio of credit-amount
 *                                  to invoice-total times each of the
 *                                  invoice's cgst/sgst/igst columns.
 *                                  taxableValue = totalAmount minus the
 *                                  three splits.
 *
 * Usage:
 *   # Dry run (default). Prints a per-table summary of what WOULD change.
 *   pnpm --filter @gaslink/api exec tsx scripts/gstr1-backfill.ts
 *
 *   # Commit — actually writes the rows. Pass --commit to opt in.
 *   pnpm --filter @gaslink/api exec tsx scripts/gstr1-backfill.ts --commit
 *
 *   # Limit to a single distributor (cross-tenant runs are slow on RDS).
 *   pnpm --filter @gaslink/api exec tsx scripts/gstr1-backfill.ts --distributor=dist-002
 *
 * Idempotent: only rows where the relevant Phase-5 column IS NULL are
 * considered; running twice does nothing on the second pass.
 */

import { prisma } from '../src/lib/prisma.js';
import { deriveStateCode } from '@gaslink/shared';
import { toNum } from '../src/utils/decimal.js';

const COMMIT = process.argv.includes('--commit');
const DIST_ARG = process.argv.find((a) => a.startsWith('--distributor='));
const DIST_FILTER = DIST_ARG ? DIST_ARG.split('=')[1] : null;

async function backfillInvoiceTaxableAndPos(): Promise<{ examined: number; updated: number }> {
  const where = {
    deletedAt: null as Date | null,
    OR: [{ taxableValue: null }, { placeOfSupplyCode: null }],
    ...(DIST_FILTER ? { distributorId: DIST_FILTER } : {}),
  } as const;
  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      items: { select: { totalPrice: true, gstRate: true } },
      customer: { select: { gstin: true, billingState: true } },
    },
  });

  let updated = 0;
  for (const inv of invoices) {
    // Weighted-average rate so a multi-rate invoice (e.g. 18% cylinders +
    // 5% service line) gets the right base. Falls back to 18% when items
    // collectively report no rate (legacy non-GST rows).
    let weightedRateNum = 0;
    let weightedRateDen = 0;
    for (const it of inv.items) {
      const lineTotal = toNum(it.totalPrice);
      const rate = it.gstRate ?? 18;
      weightedRateNum += rate * lineTotal;
      weightedRateDen += lineTotal;
    }
    const effectiveRate = weightedRateDen > 0 ? weightedRateNum / weightedRateDen : 18;
    const taxable = inv.taxableValue
      ? toNum(inv.taxableValue)
      : Math.round((toNum(inv.totalAmount) / (1 + effectiveRate / 100)) * 100) / 100;
    const pos = inv.placeOfSupplyCode
      ?? deriveStateCode(inv.customer?.gstin ?? null, inv.customer?.billingState ?? null);

    if (taxable === toNum(inv.taxableValue ?? 0) && pos === inv.placeOfSupplyCode) continue;

    if (COMMIT) {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          taxableValue: inv.taxableValue ?? taxable,
          placeOfSupplyCode: inv.placeOfSupplyCode ?? pos,
        },
      });
    }
    updated++;
  }
  return { examined: invoices.length, updated };
}

async function backfillInvoiceItemTaxable(): Promise<{ examined: number; updated: number }> {
  const where = {
    taxableValue: null,
    ...(DIST_FILTER ? { invoice: { distributorId: DIST_FILTER } } : {}),
  };
  const items = await prisma.invoiceItem.findMany({ where });
  let updated = 0;
  for (const item of items) {
    const rate = item.gstRate ?? 18;
    const taxable = Math.round((toNum(item.totalPrice) / (1 + rate / 100)) * 100) / 100;
    if (COMMIT) {
      await prisma.invoiceItem.update({
        where: { id: item.id },
        data: { taxableValue: taxable },
      });
    }
    updated++;
  }
  return { examined: items.length, updated };
}

async function backfillCreditNoteSplits(): Promise<{ examined: number; updated: number }> {
  const where = {
    OR: [{ taxableValue: null }, { cgstValue: null }, { sgstValue: null }, { igstValue: null }],
    ...(DIST_FILTER ? { invoice: { distributorId: DIST_FILTER } } : {}),
  };
  const cns = await prisma.creditNote.findMany({
    where,
    include: {
      invoice: { select: { totalAmount: true, cgstValue: true, sgstValue: true, igstValue: true } },
    },
  });
  let updated = 0;
  for (const cn of cns) {
    const totalInv = toNum(cn.invoice.totalAmount);
    const ratio = totalInv > 0 ? toNum(cn.totalAmount) / totalInv : 0;
    const cgst = Math.round(toNum(cn.invoice.cgstValue) * ratio * 100) / 100;
    const sgst = Math.round(toNum(cn.invoice.sgstValue) * ratio * 100) / 100;
    const igst = Math.round(toNum(cn.invoice.igstValue) * ratio * 100) / 100;
    const taxable = Math.round((toNum(cn.totalAmount) - (cgst + sgst + igst)) * 100) / 100;
    if (COMMIT) {
      await prisma.creditNote.update({
        where: { id: cn.id },
        data: {
          taxableValue: cn.taxableValue ?? taxable,
          cgstValue: cn.cgstValue ?? cgst,
          sgstValue: cn.sgstValue ?? sgst,
          igstValue: cn.igstValue ?? igst,
        },
      });
    }
    updated++;
  }
  return { examined: cns.length, updated };
}

async function main() {
  console.log(`GSTR-1 backfill — mode: ${COMMIT ? 'COMMIT (writing)' : 'DRY RUN (no writes)'}`);
  if (DIST_FILTER) console.log(`  scoped to distributor: ${DIST_FILTER}`);
  console.log('');

  const inv = await backfillInvoiceTaxableAndPos();
  console.log(`Invoice:     ${inv.updated}/${inv.examined} rows ${COMMIT ? 'updated' : 'would be updated'}`);

  const ii = await backfillInvoiceItemTaxable();
  console.log(`InvoiceItem: ${ii.updated}/${ii.examined} rows ${COMMIT ? 'updated' : 'would be updated'}`);

  const cn = await backfillCreditNoteSplits();
  console.log(`CreditNote:  ${cn.updated}/${cn.examined} rows ${COMMIT ? 'updated' : 'would be updated'}`);

  console.log('');
  if (!COMMIT) {
    console.log('Pass --commit to actually write. customerGstinSnapshot is NEVER');
    console.log('backfilled here — too much drift risk. See script header.');
  }
}

main()
  .catch((err) => {
    console.error('GSTR-1 backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
