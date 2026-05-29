/**
 * Investigation only — no writes. Diagnoses the dist-002 double-reconcile
 * symptom (emptiesOnVehicle = -1) after a Report Mismatch followed by a
 * Confirm & Reconcile click.
 *
 * Run from packages/api:
 *   pnpm tsx scripts/diag-wi4-double-reconcile.ts
 */
import { prisma } from '../src/lib/prisma.js';
import { startOfUtcDay } from '../src/utils/dateOnly.js';

const DIST = 'dist-002';

async function main() {
  const today = startOfUtcDay();
  console.log(`\n=== Investigation: dist-002 vehicle return → mismatch → double reconcile ===`);
  console.log(`Today (UTC date): ${today.toISOString()}`);

  // 1) 19KG cylinder type
  const cyl19 = await prisma.cylinderType.findFirst({
    where: { distributorId: DIST, capacity: 19 },
    select: { id: true, typeName: true },
  });
  if (!cyl19) {
    console.log('No 19KG cylinder type for dist-002 — aborting.');
    return;
  }
  console.log(`\n— 19KG cylinder type: ${cyl19.id} (${cyl19.typeName})`);

  // 2) All reconciliation_empties_return events today for 19KG
  const reconEvents = await prisma.inventoryEvent.findMany({
    where: {
      distributorId: DIST,
      cylinderTypeId: cyl19.id,
      eventType: 'reconciliation_empties_return',
      eventDate: { gte: today, lt: new Date(today.getTime() + 24 * 3600 * 1000) },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      createdAt: true,
      emptiesChange: true,
      referenceType: true,
      referenceId: true,
      vehicleNumber: true,
      notes: true,
    },
  });
  console.log(`\n— reconciliation_empties_return events today (19KG): ${reconEvents.length}`);
  for (const e of reconEvents) {
    console.log(
      `   • ${e.createdAt.toISOString()} +${e.emptiesChange} ref=${e.referenceType}:${e.referenceId} vehicle=${e.vehicleNumber} notes="${e.notes ?? ''}"`,
    );
  }

  // 3) Daily summary snapshot for 19KG today
  const summary = await prisma.inventorySummary.findFirst({
    where: { distributorId: DIST, cylinderTypeId: cyl19.id, summaryDate: today },
    select: {
      id: true,
      collectedEmpties: true,
      emptiesReturnedVerified: true,
      closingEmpties: true,
      closingFulls: true,
      dispatchedQty: true,
      deliveredQty: true,
    },
  });
  console.log(`\n— daily_inventory_summary today (19KG):`);
  if (!summary) {
    console.log('   (no row)');
  } else {
    console.log(`   collectedEmpties        = ${summary.collectedEmpties}`);
    console.log(`   emptiesReturnedVerified = ${summary.emptiesReturnedVerified}`);
    console.log(`   closingEmpties          = ${summary.closingEmpties}`);
    console.log(`   emptiesOnVehicle = collected - verified = ${Number(summary.collectedEmpties) - Number(summary.emptiesReturnedVerified)}`);
  }

  // 4) Find the recent vehicle: the one with today's reconciliation_empties_return events
  const refVehicleNumbers = [...new Set(reconEvents.map((e) => e.vehicleNumber).filter((v): v is string => !!v))];
  console.log(`\n— vehicles touched by today's reconciliation events: ${JSON.stringify(refVehicleNumbers)}`);

  for (const vn of refVehicleNumbers) {
    const v = await prisma.vehicle.findFirst({
      where: { distributorId: DIST, vehicleNumber: vn, deletedAt: null },
      select: { id: true, vehicleNumber: true, status: true, updatedAt: true },
    });
    if (!v) {
      console.log(`   • vehicle ${vn} — not found`);
      continue;
    }
    console.log(`\n— vehicle ${v.vehicleNumber} (${v.id})`);
    console.log(`   status    = ${v.status}`);
    console.log(`   updatedAt = ${v.updatedAt.toISOString()}`);

    const dvas = await prisma.driverVehicleAssignment.findMany({
      where: { vehicleId: v.id, distributorId: DIST, assignmentDate: today },
      orderBy: { tripNumber: 'asc' },
      select: {
        id: true,
        tripNumber: true,
        status: true,
        isReconciled: true,
        reconciledAt: true,
        driver: { select: { driverName: true } },
      },
    });
    console.log(`   DVAs today (${dvas.length}):`);
    for (const d of dvas) {
      console.log(
        `     · trip=${d.tripNumber} status=${d.status} isReconciled=${d.isReconciled} reconciledAt=${d.reconciledAt?.toISOString() ?? 'null'} driver=${d.driver?.driverName ?? '—'}`,
      );
    }

    // 5) Reconciliation_empties_returned child rows for THIS vehicle's DVAs today
    const dvaIds = dvas.map((d) => d.id);
    if (dvaIds.length > 0) {
      const recRows = await prisma.reconciliationEmptiesReturned.findMany({
        where: { distributorId: DIST, dvaId: { in: dvaIds } },
        select: {
          id: true,
          dvaId: true,
          cylinderTypeId: true,
          quantity: true,
          createdAt: true,
        },
      });
      console.log(`   reconciliation_empties_returned child rows: ${recRows.length}`);
      for (const r of recRows) {
        const ctName =
          r.cylinderTypeId === cyl19.id
            ? '19KG'
            : r.cylinderTypeId;
        console.log(
          `     · ${r.createdAt.toISOString()} dva=${r.dvaId} cyl=${ctName} qty=${r.quantity}`,
        );
      }
    }
  }

  // 6) Today's stock_mismatch_records for context
  const mismatchRows = await prisma.stockMismatchRecord.findMany({
    where: {
      distributorId: DIST,
      tripDate: today,
      cylinderTypeId: cyl19.id,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      reportId: true,
      vehicleNumber: true,
      mismatchType: true,
      qtyUnaccounted: true,
      resolutionAction: true,
      status: true,
      createdAt: true,
    },
  });
  console.log(`\n— stock_mismatch_records today (19KG): ${mismatchRows.length}`);
  for (const m of mismatchRows) {
    console.log(
      `   • ${m.createdAt.toISOString()} vehicle=${m.vehicleNumber} type=${m.mismatchType} qty=${m.qtyUnaccounted} resolution=${m.resolutionAction} status=${m.status}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
