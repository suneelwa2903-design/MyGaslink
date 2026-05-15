/**
 * One-off cleanup for invalid vehicle mappings created during manual
 * testing before the validation rules were added in
 * fix(api): vehicle mapping validation (one vehicle per driver, ...).
 *
 * The validation rules now block these from being created, but historical
 * rows pre-dating the validation may still violate them. This script
 * surfaces and removes the two specific patterns we've seen:
 *
 *   1. Mappings whose vehicleId no longer exists in the vehicles table.
 *   2. Duplicate mappings for the same vehicle on the same day —
 *      keep the most recent (createdAt DESC), drop the older ones.
 *
 * The script only touches CURRENT_DATE and forward. Historical mappings
 * (past dates) are left alone — they're audit records of what actually
 * happened, not constraints on future behaviour.
 *
 * Usage:
 *   pnpm --filter @gaslink/api exec tsx scripts/clean-vehicle-mappings.ts
 *   pnpm --filter @gaslink/api exec tsx scripts/clean-vehicle-mappings.ts --dry-run
 */

import { prisma } from '../src/lib/prisma.js';

const DRY = process.argv.includes('--dry-run');

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  console.log(`Cleanup target: assignment_date >= ${today.toISOString().split('T')[0]} (DRY=${DRY})`);

  // ─── 1. Orphan mappings (vehicleId points to a deleted vehicle) ──────────
  const allMappings = await prisma.driverVehicleAssignment.findMany({
    where: { assignmentDate: { gte: today } },
    select: { id: true, driverId: true, vehicleId: true, assignmentDate: true },
  });

  const existingVehicleIds = new Set(
    (await prisma.vehicle.findMany({ select: { id: true } })).map((v) => v.id),
  );

  const orphans = allMappings.filter((m) => !existingVehicleIds.has(m.vehicleId));
  console.log(`Orphan mappings (vehicle deleted): ${orphans.length}`);
  for (const o of orphans) {
    console.log(`  - ${o.id} driver=${o.driverId} vehicle=${o.vehicleId} date=${o.assignmentDate.toISOString().split('T')[0]}`);
  }

  if (!DRY && orphans.length > 0) {
    await prisma.driverVehicleAssignment.deleteMany({
      where: { id: { in: orphans.map((o) => o.id) } },
    });
  }

  // ─── 2. Duplicate vehicle on the same date — keep most recent ────────────
  const grouped = new Map<string, typeof allMappings>();
  for (const m of allMappings) {
    if (!existingVehicleIds.has(m.vehicleId)) continue; // already handled
    const key = `${m.assignmentDate.toISOString().split('T')[0]}|${m.vehicleId}`;
    const arr = grouped.get(key) ?? [];
    arr.push(m);
    grouped.set(key, arr);
  }

  const duplicateRowsToDelete: string[] = [];
  for (const [key, rows] of grouped) {
    if (rows.length <= 1) continue;
    // Refetch with createdAt to pick the most recent winner
    const sorted = await prisma.driverVehicleAssignment.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, driverId: true },
    });
    const [keep, ...drop] = sorted;
    console.log(`  Duplicate ${key}: keep ${keep.id} (driver=${keep.driverId}), drop ${drop.length}`);
    duplicateRowsToDelete.push(...drop.map((d) => d.id));
  }

  console.log(`Duplicate mappings to remove: ${duplicateRowsToDelete.length}`);
  if (!DRY && duplicateRowsToDelete.length > 0) {
    await prisma.driverVehicleAssignment.deleteMany({
      where: { id: { in: duplicateRowsToDelete } },
    });
  }

  console.log(DRY ? 'Dry run complete — no rows changed.' : 'Cleanup complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
