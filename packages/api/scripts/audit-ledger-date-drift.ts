/**
 * Audit — orders with ledger-date drift from the "regular createOrder used
 * for a past delivery" bug (Bhargava/Mannava symptom, 2026-07-28).
 *
 * Symptom class:
 *   Order.deliveryDate is in the past when the order was CREATED, but
 *   Invoice.issueDate and CustomerLedgerEntry.entryDate landed on
 *   createdAt-day (the day the user tapped Create Order), not on
 *   deliveryDate. Customer statement PDFs display the wrong date; running
 *   balances aggregate into the wrong month; aging buckets shift.
 *
 * Discriminator vs legitimate backdated orders:
 *   Order.isBackdated=true rows came in through backdatedOrderService
 *   which already stamps issueDate/entryDate correctly. We EXCLUDE those.
 *
 * Discriminator vs same-day orders:
 *   deliveryDate === createdAt-day → no drift, exclude.
 *
 * Report shape (per row):
 *   distributorName, accountType, customerName, orderNumber,
 *   deliveryDate (intended), invoiceIssueDate (actual, wrong),
 *   drift_days, totalAmount
 *
 * Run:
 *   pnpm --filter @gaslink/api exec tsx scripts/audit-ledger-date-drift.ts
 *
 * Optional args:
 *   --distributor=<id>   only that tenant
 *   --min-drift=<days>   default 1 (drift ≥ 1 day)
 *   --format=csv         csv to stdout (default: pretty table)
 *
 * Read-only. Zero writes.
 */
import { PrismaClient } from '@prisma/client';
import { toNum } from '../src/utils/decimal.js';

const prisma = new PrismaClient();

function daysBetween(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / (24 * 3600 * 1000));
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--distributor='))?.split('=')[1];
  const minDrift = Number(args.find((a) => a.startsWith('--min-drift='))?.split('=')[1] ?? '1');
  const format = args.find((a) => a.startsWith('--format='))?.split('=')[1] ?? 'table';

  // Fetch every non-cancelled non-backdated order that has an invoice.
  // Then filter in JS by date comparison — Prisma can't compare
  // deliveryDate (Date @db.Date) with invoice.issueDate (Date @db.Date)
  // in a single `where` clause portably.
  const orders = await prisma.order.findMany({
    where: {
      isBackdated: false,
      status: { in: ['delivered', 'modified_delivered'] },
      deletedAt: null,
      ...(only ? { distributorId: only } : {}),
      invoice: { isNot: null },
    },
    select: {
      id: true,
      orderNumber: true,
      orderDate: true,
      deliveryDate: true,
      deliveredAt: true,
      createdAt: true,
      totalAmount: true,
      customer: { select: { id: true, customerName: true } },
      distributor: { select: { id: true, businessName: true, accountType: true } },
      invoice: { select: { id: true, invoiceNumber: true, issueDate: true, status: true } },
    },
  });

  type Row = {
    distributor: string;
    tenantType: string;
    customer: string;
    orderNumber: string;
    invoiceNumber: string | null;
    deliveryDate: string;
    invoiceIssueDate: string;
    driftDays: number;
    amount: number;
  };

  const drift: Row[] = [];

  for (const o of orders) {
    if (!o.invoice) continue;
    const delivery = new Date(o.deliveryDate);
    const issue = new Date(o.invoice.issueDate);
    // Normalise to midnight of each day for a clean day-diff
    delivery.setHours(0, 0, 0, 0);
    issue.setHours(0, 0, 0, 0);
    const days = daysBetween(issue, delivery);
    if (days < minDrift) continue;

    drift.push({
      distributor: o.distributor.businessName ?? '—',
      tenantType: o.distributor.accountType ?? 'regular',
      customer: o.customer?.customerName ?? '—',
      orderNumber: o.orderNumber,
      invoiceNumber: o.invoice.invoiceNumber,
      deliveryDate: o.deliveryDate.toISOString().slice(0, 10),
      invoiceIssueDate: o.invoice.issueDate.toISOString().slice(0, 10),
      driftDays: days,
      amount: toNum(o.totalAmount),
    });
  }

  // Sort by tenant → customer → deliveryDate
  drift.sort(
    (a, b) =>
      a.distributor.localeCompare(b.distributor) ||
      a.customer.localeCompare(b.customer) ||
      a.deliveryDate.localeCompare(b.deliveryDate),
  );

  if (format === 'csv') {
    console.log(
      'distributor,tenantType,customer,orderNumber,invoiceNumber,deliveryDate,invoiceIssueDate,driftDays,amount',
    );
    for (const r of drift) {
      console.log(
        [
          `"${r.distributor.replace(/"/g, '""')}"`,
          r.tenantType,
          `"${r.customer.replace(/"/g, '""')}"`,
          r.orderNumber,
          r.invoiceNumber ?? '',
          r.deliveryDate,
          r.invoiceIssueDate,
          r.driftDays,
          r.amount.toFixed(2),
        ].join(','),
      );
    }
  } else {
    // Grouped summary + per-row table
    const byDist = new Map<string, { tenantType: string; count: number; amt: number }>();
    for (const r of drift) {
      const cur = byDist.get(r.distributor) ?? { tenantType: r.tenantType, count: 0, amt: 0 };
      cur.count++;
      cur.amt += r.amount;
      byDist.set(r.distributor, cur);
    }

    console.log('\n=== Ledger-date drift summary ===\n');
    console.log('Threshold: drift ≥', minDrift, 'day(s)');
    console.log('Universe: non-cancelled non-backdated delivered orders with an invoice\n');

    const summary = [...byDist.entries()]
      .map(([d, v]) => ({ distributor: d, tenantType: v.tenantType, orders: v.count, totalAmount: v.amt }))
      .sort((a, b) => b.orders - a.orders);
    console.table(summary);

    console.log('\n=== Per-order detail ===\n');
    console.table(drift);
    console.log(`\nTotal affected orders: ${drift.length}`);
    console.log(`Total affected amount: ₹${drift.reduce((s, r) => s + r.amount, 0).toFixed(2)}\n`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
