/**
 * backfill-backdated-adjustment-dates.ts
 *
 * Option A (2026-07-10) migration companion. Before this script:
 *   applyBackdatedInventoryAdjustment wrote every event with
 *   `event_date = today`. On dist-002 alone that produced 6 backdated
 *   orders whose stock movement lands on the entry day instead of the
 *   delivery day the operator picked.
 *
 * This script rewrites those historical event rows to sit on
 * `order.delivery_date` (the same source of truth the service now uses)
 * and cascades inventory_summaries forward through every touched
 * (distributor, cylinder_type) pair. Locked days are respected by
 * recalculateSummariesFromDate — they silently skip and everything
 * past them still recomputes correctly.
 *
 * USAGE
 * -----
 *   # dry-run (default) — prints the plan, DOES NOT change anything
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-backdated-adjustment-dates.ts
 *
 *   # scope to one distributor
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-backdated-adjustment-dates.ts --distributor dist-002
 *
 *   # actually apply
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-backdated-adjustment-dates.ts --apply
 *
 * SAFETY NOTES
 * ------------
 *   * Only touches events where `reference_type='backdated_inventory_adjustment'`
 *     — no other stock event is at risk.
 *   * Skips events whose `event_date` already equals `delivery_date`
 *     (idempotent — safe to re-run).
 *   * Runs the whole plan inside one transaction so a mid-run failure
 *     rolls back cleanly.
 *   * Prints a per-event before/after diff in --apply mode.
 *   * Recalculates summaries once per (distributor, cylinder_type)
 *     pair after the event UPDATEs commit, from the OLDEST-touched
 *     delivery date onward.
 */
import { prisma } from '../src/lib/prisma.js';
import { recalculateSummariesFromDate } from '../src/services/inventoryService.js';
import { logger } from '../src/utils/logger.js';

interface Args {
  apply: boolean;
  distributorId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--distributor' || a === '-d') {
      args.distributorId = argv[i + 1];
      i++;
    }
  }
  return args;
}

interface PlannedFix {
  eventId: string;
  distributorId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  orderId: string;
  orderNumber: string;
  fromDate: string;
  toDate: string;
  fullsChange: number;
  emptiesChange: number;
  eventType: string;
}

async function buildPlan(distributorId?: string): Promise<PlannedFix[]> {
  const events = await prisma.inventoryEvent.findMany({
    where: {
      referenceType: 'backdated_inventory_adjustment',
      ...(distributorId ? { distributorId } : {}),
    },
    include: {
      cylinderType: { select: { typeName: true } },
    },
    orderBy: [{ distributorId: 'asc' }, { eventDate: 'asc' }],
  });

  const orderIds = Array.from(
    new Set(events.map((e) => e.referenceId).filter((x): x is string => !!x)),
  );
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderNumber: true, deliveryDate: true, distributorId: true },
      })
    : [];
  const orderMap = new Map(orders.map((o) => [o.id, o]));

  const plan: PlannedFix[] = [];
  for (const ev of events) {
    if (!ev.referenceId) continue;
    const order = orderMap.get(ev.referenceId);
    if (!order) {
      logger.warn('Backfill: skipping event with no matching order', {
        eventId: ev.id,
        referenceId: ev.referenceId,
      });
      continue;
    }
    const fromDay = ev.eventDate.toISOString().slice(0, 10);
    const toDay = order.deliveryDate.toISOString().slice(0, 10);
    if (fromDay === toDay) continue; // already correct — idempotent

    plan.push({
      eventId: ev.id,
      distributorId: ev.distributorId,
      cylinderTypeId: ev.cylinderTypeId,
      cylinderTypeName: ev.cylinderType?.typeName ?? '—',
      orderId: order.id,
      orderNumber: order.orderNumber,
      fromDate: fromDay,
      toDate: toDay,
      fullsChange: ev.fullsChange,
      emptiesChange: ev.emptiesChange,
      eventType: ev.eventType,
    });
  }
  return plan;
}

function printPlan(plan: PlannedFix[]) {
  if (plan.length === 0) {
    console.log('Nothing to backfill — every backdated_inventory_adjustment event is already dated on its order delivery_date.');
    return;
  }
  console.log(`\n${plan.length} event(s) to re-date:\n`);
  const byDist = new Map<string, PlannedFix[]>();
  for (const p of plan) {
    const list = byDist.get(p.distributorId) ?? [];
    list.push(p);
    byDist.set(p.distributorId, list);
  }
  for (const [dist, rows] of byDist) {
    console.log(`── ${dist} (${rows.length} event(s)) ──`);
    for (const r of rows) {
      const delta = r.fullsChange !== 0 ? `fulls ${r.fullsChange}` : `empties ${r.emptiesChange > 0 ? '+' : ''}${r.emptiesChange}`;
      console.log(
        `  ${r.orderNumber}  ${r.cylinderTypeName}  ${r.eventType}  ${delta}  ${r.fromDate} → ${r.toDate}`,
      );
    }
    console.log('');
  }
}

async function applyPlan(plan: PlannedFix[]): Promise<void> {
  const cascadeKey = new Map<string, Date>();

  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      await tx.inventoryEvent.update({
        where: { id: p.eventId },
        data: { eventDate: new Date(p.toDate) },
      });
      const key = `${p.distributorId}|${p.cylinderTypeId}`;
      const already = cascadeKey.get(key);
      const target = new Date(p.toDate);
      if (!already || target < already) cascadeKey.set(key, target);
    }
  });

  console.log('Event dates rewritten — cascading summaries…');
  for (const [key, from] of cascadeKey) {
    const [dist, ct] = key.split('|');
    console.log(`  ${dist} / ${ct} — cascade from ${from.toISOString().slice(0, 10)}`);
    await recalculateSummariesFromDate(dist, ct, from);
  }
  console.log(`\nDone. ${plan.length} event(s) re-dated. ${cascadeKey.size} (dist, cyl) pair(s) cascaded.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Backfill: re-date backdated_inventory_adjustment events onto order.delivery_date');
  if (args.distributorId) console.log(`Scope: distributor=${args.distributorId}`);
  else console.log('Scope: all distributors');
  console.log(`Mode:  ${args.apply ? 'APPLY (writes will commit)' : 'DRY RUN (no writes)'}\n`);

  const plan = await buildPlan(args.distributorId);
  printPlan(plan);
  if (!args.apply) {
    console.log('Re-run with --apply to commit these changes.');
    return;
  }
  if (plan.length === 0) return;
  await applyPlan(plan);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
