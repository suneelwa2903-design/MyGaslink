/**
 * gst-unit-price-backfill.ts
 *
 * One-shot backfill for CLAUDE.md anti-pattern #16 (the historical GST
 * double-division bug). Before the fix, invoiceService.createInvoiceFromOrder
 * stored InvoiceItem.unitPrice as GST-BASE (÷1.18 applied at write time)
 * for every GST-enabled invoice, while every downstream reader assumed
 * it was inclusive and divided AGAIN — producing under-reported AssAmt
 * to NIC. The same column for createManualInvoice rows was stored as
 * EXCLUSIVE (the raw caller-side pre-tax input). Both conventions need
 * to be promoted to INCLUSIVE so the new readers produce correct values.
 *
 * What this script touches (when --apply is set):
 *   - invoice_items.unit_price ← unit_price × (1 + gst_rate/100)
 *   - For MANUAL invoices only (parent.order_id IS NULL):
 *     invoice_items.discount_per_unit ← discount_per_unit × (1 + gst_rate/100)
 *
 *   Only rows where gst_rate > 0 are affected. The Invoice grand totals
 *   (total_amount, cgst_value, sgst_value, igst_value) are NOT touched —
 *   they were already inclusive/correct under the old code.
 *
 * Safety:
 *   - Default mode is dry-run. Pass --apply to actually update.
 *   - Optional --distributor=<id> scopes the run to one tenant. Recommended
 *     for first prod pass: do one tenant, verify, then the rest.
 *   - Optional --before=<ISO-date> caps the cutoff (default: now).
 *   - Idempotency: each row gets a marker (UPDATED to non-zero) so a
 *     second --apply on the same scope is a no-op. The script keys
 *     idempotency on a marker comment in the invoice notes — see
 *     ANTI_PATTERN_16_MARKER below.
 *   - Runs each tenant in a single transaction.
 *
 * Usage from packages/api:
 *   pnpm tsx scripts/gst-unit-price-backfill.ts                      # dry-run all tenants
 *   pnpm tsx scripts/gst-unit-price-backfill.ts --distributor=dist-002  # dry-run one tenant
 *   pnpm tsx scripts/gst-unit-price-backfill.ts --distributor=dist-002 --apply  # commit
 *   pnpm tsx scripts/gst-unit-price-backfill.ts --before=2026-06-01T00:00:00Z --apply
 */
import { prisma } from '../src/lib/prisma.js';

const ANTI_PATTERN_16_MARKER = 'AP16-backfill-applied';

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parseArgs(): { apply: boolean; distributorId?: string; before: Date } {
  const args = process.argv.slice(2);
  let apply = false;
  let distributorId: string | undefined;
  let before = new Date();
  for (const a of args) {
    if (a === '--apply') apply = true;
    else if (a.startsWith('--distributor=')) distributorId = a.slice('--distributor='.length);
    else if (a.startsWith('--before=')) before = new Date(a.slice('--before='.length));
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return { apply, distributorId, before };
}

async function processTenant(distributorId: string, before: Date, apply: boolean) {
  const candidates = await prisma.invoiceItem.findMany({
    where: {
      invoice: {
        distributorId,
        createdAt: { lt: before },
        // Skip already-marked invoices. Must allow `notes IS NULL` —
        // Prisma's `NOT: { contains }` on a nullable field treats NULL
        // rows as "neither match nor not-match" and silently excludes
        // them, which would make the backfill a no-op on a clean DB
        // (every invoice has notes=NULL until we stamp it).
        OR: [
          { notes: null },
          { NOT: { notes: { contains: ANTI_PATTERN_16_MARKER } } },
        ],
      },
      gstRate: { gt: 0 },
    },
    select: {
      id: true,
      unitPrice: true,
      discountPerUnit: true,
      quantity: true,
      gstRate: true,
      invoice: { select: { id: true, invoiceNumber: true, orderId: true, totalAmount: true, notes: true } },
    },
  });

  if (candidates.length === 0) {
    console.log(`[${distributorId}] no candidate invoice items.`);
    return { rows: 0, invoices: 0 };
  }

  // Group by invoice for the per-invoice marker + transactionality.
  const byInvoice = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = c.invoice.id;
    const arr = byInvoice.get(key) ?? [];
    arr.push(c);
    byInvoice.set(key, arr);
  }

  console.log(`\n[${distributorId}] ${candidates.length} items across ${byInvoice.size} invoices`);

  const sample = candidates.slice(0, 3);
  console.log(`[${distributorId}] sample (first 3):`);
  for (const it of sample) {
    const mult = 1 + Number(it.gstRate) / 100;
    const isManual = !it.invoice.orderId;
    const oldUp = Number(it.unitPrice);
    const newUp = round4(oldUp * mult);
    const oldDisc = Number(it.discountPerUnit);
    const newDisc = isManual ? round4(oldDisc * mult) : oldDisc;
    console.log(
      `  - inv ${it.invoice.invoiceNumber} (${isManual ? 'manual' : 'from order'}) ` +
      `qty=${it.quantity} gst=${it.gstRate}% unitPrice ${oldUp} → ${newUp}` +
      (isManual && oldDisc > 0 ? `  discount ${oldDisc} → ${newDisc}` : ''),
    );
  }

  if (!apply) {
    console.log(`[${distributorId}] DRY-RUN — pass --apply to commit.`);
    return { rows: candidates.length, invoices: byInvoice.size };
  }

  let touchedRows = 0;
  let touchedInvoices = 0;
  await prisma.$transaction(async (tx) => {
    for (const [invoiceId, items] of byInvoice) {
      const parentOrderId = items[0].invoice.orderId;
      const isManual = !parentOrderId;
      for (const it of items) {
        const mult = 1 + Number(it.gstRate) / 100;
        const newUp = round4(Number(it.unitPrice) * mult);
        const newDisc = isManual ? round4(Number(it.discountPerUnit) * mult) : Number(it.discountPerUnit);
        await tx.invoiceItem.update({
          where: { id: it.id },
          data: {
            unitPrice: newUp,
            ...(isManual ? { discountPerUnit: newDisc } : {}),
          },
        });
        touchedRows++;
      }
      const existingNotes = items[0].invoice.notes ?? '';
      const stamp = `${ANTI_PATTERN_16_MARKER}@${new Date().toISOString().slice(0, 10)}`;
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { notes: existingNotes ? `${existingNotes} | ${stamp}` : stamp },
      });
      touchedInvoices++;
    }
  }, { timeout: 5 * 60_000 });

  console.log(`[${distributorId}] APPLIED — ${touchedRows} rows, ${touchedInvoices} invoices.`);
  return { rows: touchedRows, invoices: touchedInvoices };
}

async function main() {
  const { apply, distributorId, before } = parseArgs();
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Cutoff: invoices created before ${before.toISOString()}`);
  if (distributorId) console.log(`Scope: distributor ${distributorId}`);

  const tenants = distributorId
    ? [{ id: distributorId }]
    : await prisma.distributor.findMany({
        where: { status: 'active', gstMode: { not: 'disabled' } },
        select: { id: true },
      });

  if (tenants.length === 0) {
    console.log('No GST-enabled distributors found. Nothing to do.');
    return;
  }

  let totalRows = 0;
  let totalInvoices = 0;
  for (const t of tenants) {
    const r = await processTenant(t.id, before, apply);
    totalRows += r.rows;
    totalInvoices += r.invoices;
  }

  console.log(`\nTotals: ${totalRows} rows across ${totalInvoices} invoices ${apply ? 'updated' : '(would be updated)'}`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
