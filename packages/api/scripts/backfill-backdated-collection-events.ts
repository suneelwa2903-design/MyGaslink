/**
 * backfill-backdated-collection-events.ts
 *
 * F1 (2026-07-10) companion. Before F1 the backdated writer emitted a
 * single `reconciliation_empties_return` event for the empties side of
 * a backdated adjustment. The daily-summary derivation
 *   emptiesOnVehicle = collectedEmpties − emptiesReturnedVerified
 * then went NEGATIVE for those rows (verified++, collected untouched)
 * and the "Collected Empties" display column silently underreported.
 *
 * F1 fixes the writer to emit a paired `collection` event. This script
 * back-adds the missing `collection` twin for every historical
 * `reconciliation_empties_return` row that carries
 * reference_type='backdated_inventory_adjustment' and has no matching
 * `collection` sibling on the same order + cylinder-type + date.
 *
 * SAFETY
 * ------
 *   * Idempotent: skips rows where a `collection` sibling already exists.
 *   * Dry-run by default; --apply commits inside one $transaction.
 *   * Only touches events tagged reference_type='backdated_inventory_adjustment'.
 *   * Cascades summaries once per (distributor, cylinder_type) from the
 *     oldest touched date onward so the summaries pick up the new
 *     `collectedEmpties` accumulator immediately.
 *
 * USAGE
 * -----
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-backdated-collection-events.ts
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-backdated-collection-events.ts --distributor dist-002
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-backdated-collection-events.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { createInventoryEvent, recalculateSummariesFromDate } from '../src/services/inventoryService.js';

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
  distributorId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  orderId: string;
  orderNumber: string | null;
  eventDate: Date;
  emptiesChange: number;
  createdBy: string | null;
  notes: string | null;
}

async function buildPlan(distributorId?: string): Promise<PlannedFix[]> {
  const verifiedEvents = await prisma.inventoryEvent.findMany({
    where: {
      referenceType: 'backdated_inventory_adjustment',
      eventType: 'reconciliation_empties_return',
      ...(distributorId ? { distributorId } : {}),
    },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: [{ distributorId: 'asc' }, { eventDate: 'asc' }],
  });

  const plan: PlannedFix[] = [];
  for (const ev of verifiedEvents) {
    if (!ev.referenceId) continue;
    // Idempotent check — skip if a collection sibling already exists
    // for (distributor, cylinder-type, order, date).
    const sibling = await prisma.inventoryEvent.findFirst({
      where: {
        distributorId: ev.distributorId,
        cylinderTypeId: ev.cylinderTypeId,
        referenceId: ev.referenceId,
        referenceType: 'backdated_inventory_adjustment',
        eventType: 'collection',
        eventDate: ev.eventDate,
      },
      select: { id: true },
    });
    if (sibling) continue;

    const order = await prisma.order.findFirst({
      where: { id: ev.referenceId, distributorId: ev.distributorId },
      select: { orderNumber: true },
    });

    plan.push({
      distributorId: ev.distributorId,
      cylinderTypeId: ev.cylinderTypeId,
      cylinderTypeName: ev.cylinderType?.typeName ?? '—',
      orderId: ev.referenceId,
      orderNumber: order?.orderNumber ?? null,
      eventDate: ev.eventDate,
      emptiesChange: ev.emptiesChange,
      createdBy: ev.createdBy,
      notes: ev.notes,
    });
  }
  return plan;
}

function printPlan(plan: PlannedFix[]) {
  if (plan.length === 0) {
    console.log('Nothing to backfill — every backdated reconciliation_empties_return already has a collection sibling.');
    return;
  }
  console.log(`\n${plan.length} collection event(s) to insert:\n`);
  const byDist = new Map<string, PlannedFix[]>();
  for (const p of plan) {
    const list = byDist.get(p.distributorId) ?? [];
    list.push(p);
    byDist.set(p.distributorId, list);
  }
  for (const [dist, rows] of byDist) {
    console.log(`── ${dist} (${rows.length} event(s)) ──`);
    for (const r of rows) {
      console.log(
        `  ${r.orderNumber ?? '(no order)'}  ${r.cylinderTypeName}  collection empties +${r.emptiesChange}  ${r.eventDate.toISOString().slice(0, 10)}`,
      );
    }
    console.log('');
  }
}

async function applyPlan(plan: PlannedFix[]): Promise<void> {
  const cascadeKey = new Map<string, Date>();
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      await createInventoryEvent(tx, {
        distributorId: p.distributorId,
        cylinderTypeId: p.cylinderTypeId,
        eventType: 'collection',
        fullsChange: 0,
        emptiesChange: p.emptiesChange,
        eventDate: p.eventDate,
        referenceId: p.orderId,
        referenceType: 'backdated_inventory_adjustment',
        notes: p.notes ?? undefined,
        createdBy: p.createdBy ?? undefined,
      });
      const key = `${p.distributorId}|${p.cylinderTypeId}`;
      const already = cascadeKey.get(key);
      if (!already || p.eventDate < already) cascadeKey.set(key, p.eventDate);
    }
  });

  console.log('Collection events inserted — cascading summaries…');
  for (const [key, from] of cascadeKey) {
    const [dist, ct] = key.split('|');
    console.log(`  ${dist} / ${ct} — cascade from ${from.toISOString().slice(0, 10)}`);
    await recalculateSummariesFromDate(dist, ct, from);
  }
  console.log(`\nDone. ${plan.length} event(s) inserted. ${cascadeKey.size} (dist, cyl) pair(s) cascaded.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Backfill: pair backdated reconciliation_empties_return events with a `collection` twin (F1 companion)');
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
