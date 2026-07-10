/**
 * D1 backfill — subtract phantom cyls that the pre-D1-fix over-return
 * mechanism deposited into depot for each cancelled walk-in that was
 * physically on the truck at cancel time.
 *
 * Detection heuristic:
 *   For each vehicle-cyl-day pair, count:
 *     - cancelled_stock cancellation_returns (correct, one per cancelled walk-in)
 *     - dva_load_manifest cancellation_returns (has the pre-fix inflation)
 *   Compare against the manifest's floatQty − (sum of walk-in orders'
 *   `quantity` that reached pending_delivery / delivered on this
 *   (driver, tripNumber, cylinderType)). The DELTA between what the
 *   manifest returned and what it SHOULD HAVE returned is the phantom qty.
 *
 * For live evidence, this script also lists the affected orders so an
 * operator can eyeball the report before applying.
 *
 * SAFETY
 *   * Dry-run by default. --apply commits per-affected-manifest in a
 *     single Prisma $transaction.
 *   * Writes a compensating `manual_adjustment` event (fullsChange = −phantomQty)
 *     on the same (distributor, cylinderType, eventDate) with a narration
 *     pointing back at the manifest.id. Idempotent via a marker in the
 *     notes column: re-runs skip manifests whose adjustment marker is
 *     already present.
 *   * Cascades summaries once per (dist, cyl) from the event_date forward.
 *
 * USAGE
 *   # dry-run — all distributors
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-d1-walkin-overreturn.ts
 *
 *   # scope to one distributor
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-d1-walkin-overreturn.ts --distributor dist-002
 *
 *   # commit
 *   pnpm --filter @gaslink/api exec tsx scripts/backfill-d1-walkin-overreturn.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { recalculateSummariesFromDate } from '../src/services/inventoryService.js';

const MARKER = 'D1-backfill-phantom-correction';

interface Args {
  apply: boolean;
  distributorId?: string;
}
function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--distributor' || a === '-d') { args.distributorId = argv[++i]; }
  }
  return args;
}

interface Adjustment {
  distributorId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  manifestId: string;
  eventDate: Date;
  manifestCredit: number;      // what was actually posted by pre-fix manifest cancellation_return
  correctCredit: number;       // what should have been posted (post-fix accounting)
  phantomQty: number;          // = manifestCredit − correctCredit (subtract as compensating manual_adjustment)
  cancelledWalkInIds: string[];
  cseTotalCredit: number;
}

async function buildPlan(distributorId?: string): Promise<Adjustment[]> {
  // Every manifest cancellation_return event — one per manifest row that ever
  // returned float to depot. referenceType='dva_load_manifest', referenceId=manifest.id.
  const manifestReturns = await prisma.inventoryEvent.findMany({
    where: {
      eventType: 'cancellation_return',
      referenceType: 'dva_load_manifest',
      ...(distributorId ? { distributorId } : {}),
    },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const adjustments: Adjustment[] = [];

  for (const ev of manifestReturns) {
    if (!ev.referenceId) continue;
    const manifest = await prisma.dVALoadManifest.findUnique({
      where: { id: ev.referenceId },
      select: {
        id: true, dvaId: true, floatQty: true, cylinderTypeId: true, tripNumber: true,
        dva: { select: { driverId: true, assignmentDate: true, distributorId: true } },
      },
    });
    if (!manifest || !manifest.dva) continue;

    // Correct fromFloatQty = sum of qty across:
    //   - walk-in orders that reached pending_delivery/delivered
    //   - regular add-to-trip orders (no per-order dispatch event)
    //   - cancelled walk-in orders that had a CSE for this cylinder type
    // Anti-double-count: subtract orders that DO have a per-order dispatch event.
    const tripOrders = await prisma.order.findMany({
      where: {
        distributorId: manifest.dva.distributorId,
        driverId: manifest.dva.driverId,
        deliveryDate: manifest.dva.assignmentDate,
        tripNumber: manifest.tripNumber,
        deletedAt: null,
        items: { some: { cylinderTypeId: manifest.cylinderTypeId } },
      },
      select: {
        id: true, status: true,
        items: {
          where: { cylinderTypeId: manifest.cylinderTypeId },
          select: { quantity: true },
        },
      },
    });

    const perOrderDispatched = new Set(
      (await prisma.inventoryEvent.findMany({
        where: {
          distributorId: manifest.dva.distributorId,
          eventType: 'dispatch',
          referenceType: 'order',
          referenceId: { in: tripOrders.map((o) => o.id) },
          cylinderTypeId: manifest.cylinderTypeId,
        },
        select: { referenceId: true },
      })).map((e) => e.referenceId).filter((v): v is string => v !== null),
    );

    // Include cancelled orders that HAD a CSE for this cyl (post-D1 rule).
    const cancelledWithCse = await prisma.order.findMany({
      where: {
        distributorId: manifest.dva.distributorId,
        driverId: manifest.dva.driverId,
        deliveryDate: manifest.dva.assignmentDate,
        tripNumber: manifest.tripNumber,
        status: 'cancelled',
        cancelledStockEvents: { some: { cylinderTypeId: manifest.cylinderTypeId } },
        items: { some: { cylinderTypeId: manifest.cylinderTypeId } },
      },
      select: {
        id: true,
        items: {
          where: { cylinderTypeId: manifest.cylinderTypeId },
          select: { quantity: true },
        },
      },
    });

    // fromFloatQty by D1 semantics: sum of active-tripOrder qty (excluding depot-dispatched)
    // + sum of cancelled-with-CSE qty (excluding depot-dispatched — walk-ins never have per-order dispatch).
    const activeFromFloat = tripOrders
      .filter((o) => !perOrderDispatched.has(o.id) && o.status !== 'cancelled')
      .reduce((s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0), 0);
    const cancelledFromFloat = cancelledWithCse
      .filter((o) => !perOrderDispatched.has(o.id))
      .reduce((s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0), 0);

    const correctSold = Math.min(activeFromFloat + cancelledFromFloat, manifest.floatQty);
    const correctUnsold = manifest.floatQty - correctSold;
    const phantom = ev.fullsChange - correctUnsold;
    if (phantom <= 0) continue;

    // CSE credit for reporting only.
    const cseSum = (await prisma.inventoryEvent.aggregate({
      where: {
        distributorId: manifest.dva.distributorId,
        cylinderTypeId: manifest.cylinderTypeId,
        eventType: 'cancellation_return',
        referenceType: 'cancelled_stock',
        eventDate: manifest.dva.assignmentDate,
      },
      _sum: { fullsChange: true },
    }))._sum.fullsChange ?? 0;

    // Skip if we already wrote a correction for this manifest.
    const already = await prisma.inventoryEvent.findFirst({
      where: {
        distributorId: manifest.dva.distributorId,
        cylinderTypeId: manifest.cylinderTypeId,
        eventType: 'manual_adjustment',
        notes: { contains: `${MARKER}:${manifest.id}` },
      },
      select: { id: true },
    });
    if (already) continue;

    adjustments.push({
      distributorId: manifest.dva.distributorId,
      cylinderTypeId: manifest.cylinderTypeId,
      cylinderTypeName: ev.cylinderType?.typeName ?? '—',
      manifestId: manifest.id,
      eventDate: ev.eventDate,
      manifestCredit: ev.fullsChange,
      correctCredit: correctUnsold,
      phantomQty: phantom,
      cancelledWalkInIds: cancelledWithCse.map((o) => o.id),
      cseTotalCredit: cseSum,
    });
  }
  return adjustments;
}

function printPlan(adjustments: Adjustment[]) {
  if (adjustments.length === 0) {
    console.log('Nothing to backfill — every dva_load_manifest cancellation_return already matches the D1-correct total.');
    return;
  }
  console.log(`\n${adjustments.length} manifest(s) over-credited pre-D1. Compensating manual_adjustments planned:\n`);
  const byDist = new Map<string, Adjustment[]>();
  for (const a of adjustments) {
    const list = byDist.get(a.distributorId) ?? [];
    list.push(a); byDist.set(a.distributorId, list);
  }
  for (const [dist, rows] of byDist) {
    console.log(`── ${dist} (${rows.length} manifest(s)) ──`);
    for (const r of rows) {
      console.log(
        `  ${r.eventDate.toISOString().slice(0, 10)}  ${r.cylinderTypeName}  ` +
        `manifest posted +${r.manifestCredit}, correct +${r.correctCredit} → phantom ${r.phantomQty}. ` +
        `Compensating manual_adjustment: ${r.phantomQty > 0 ? '-' : '+'}${Math.abs(r.phantomQty)}. ` +
        `(CSE total: +${r.cseTotalCredit}, cancelled-w-CSE walk-ins: ${r.cancelledWalkInIds.length})`,
      );
    }
    console.log('');
  }
}

async function applyPlan(adjustments: Adjustment[], userId: string): Promise<void> {
  const cascadeKey = new Map<string, Date>();
  for (const a of adjustments) {
    await prisma.$transaction(async (tx) => {
      await tx.inventoryEvent.create({
        data: {
          distributorId: a.distributorId,
          cylinderTypeId: a.cylinderTypeId,
          eventType: 'manual_adjustment',
          fullsChange: -a.phantomQty,
          emptiesChange: 0,
          eventDate: a.eventDate,
          referenceId: a.manifestId,
          referenceType: 'dva_load_manifest',
          notes: `${MARKER}:${a.manifestId} — subtract ${a.phantomQty} phantom cyls from pre-D1 over-return`,
          createdBy: userId,
        },
      });
    });
    const key = `${a.distributorId}|${a.cylinderTypeId}`;
    const already = cascadeKey.get(key);
    if (!already || a.eventDate < already) cascadeKey.set(key, a.eventDate);
  }

  console.log('Corrections written — cascading summaries…');
  for (const [key, from] of cascadeKey) {
    const [dist, ct] = key.split('|');
    console.log(`  ${dist} / ${ct} — cascade from ${from.toISOString().slice(0, 10)}`);
    await recalculateSummariesFromDate(dist, ct, from);
  }
  console.log(`\nDone. ${adjustments.length} manifest phantom correction(s) written.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('D1 backfill — subtract phantom cyls from pre-D1 over-return manifest events');
  if (args.distributorId) console.log(`Scope: distributor=${args.distributorId}`);
  else console.log('Scope: all distributors');
  console.log(`Mode:  ${args.apply ? 'APPLY' : 'DRY RUN'}\n`);

  const adjustments = await buildPlan(args.distributorId);
  printPlan(adjustments);
  if (!args.apply) {
    console.log('Re-run with --apply to commit these corrections.');
    return;
  }
  if (adjustments.length === 0) return;
  const userId = process.env.RCM_OPERATOR_USER_ID ?? 'd1-backfill-script';
  await applyPlan(adjustments, userId);
}

main().catch((e) => { console.error('Backfill failed:', e); process.exit(1); }).finally(() => prisma.$disconnect());
