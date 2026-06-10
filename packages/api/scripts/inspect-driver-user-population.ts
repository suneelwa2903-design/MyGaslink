/**
 * Chunk A pre-migration data inspection — Driver ↔ User population audit.
 *
 * Purpose: surface the actual data shape BEFORE writing the migration that
 * adds `Driver.userId String @unique` (per docs/IOS-ACCOUNT-DELETION-SPEC.md
 * Section 3.2). The migration's shape — single-step vs nullable-then-backfill
 * vs orphan-tolerant — depends on whether the current dev data is clean
 * (1:1 / 1:0 mapping, no duplicates) or has orphans / duplicates.
 *
 * The current implicit join key is (phone, distributor_id). The new FK will
 * make that join explicit and permanent. We need to know:
 *   1. Total Driver rows (active, not soft-deleted)
 *   2. Total User rows with role='driver' (active, not soft-deleted)
 *   3. Drivers that WOULD match a User cleanly (1:1 on phone+distributor_id)
 *   4. Drivers with NO matching User (orphans — drivers without app logins)
 *   5. Driver-role Users with NO matching Driver (logins without driver records)
 *   6. Any duplicate pairs that would BREAK a UNIQUE FK
 *
 * Soft-deleted rows are excluded (the FK only governs live rows).
 *
 * Run via: pnpm --filter @gaslink/api exec tsx scripts/inspect-driver-user-population.ts
 */

import { prisma } from '../src/lib/prisma.js';

interface CountRow {
  count: bigint;
}

async function main() {
  console.log('=== Chunk A — Driver ↔ User population inspection ===\n');
  console.log(`DB: ${process.env.DATABASE_URL?.replace(/:[^@]+@/, ':***@') ?? '(unset)'}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // 1. Total live Driver rows
  const [{ count: driverTotal }] = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS count
    FROM drivers
    WHERE deleted_at IS NULL
  `;
  console.log(`1. Live drivers (deleted_at IS NULL):              ${driverTotal}`);

  // 1b. Soft-deleted Driver rows (for context — not in scope but worth noting)
  const [{ count: driverDeleted }] = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS count FROM drivers WHERE deleted_at IS NOT NULL
  `;
  console.log(`   Soft-deleted drivers (excluded from FK scope):  ${driverDeleted}`);

  // 2. Total live User rows with role='driver'
  const [{ count: driverUserTotal }] = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS count
    FROM users
    WHERE role = 'driver' AND deleted_at IS NULL
  `;
  console.log(`\n2. Live users with role='driver':                 ${driverUserTotal}`);

  // 2b. Users with role='driver' and NULL phone (cannot join by phone)
  const [{ count: driverUserNullPhone }] = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS count
    FROM users
    WHERE role = 'driver' AND deleted_at IS NULL AND phone IS NULL
  `;
  console.log(`   Driver-role users with NULL phone (unjoinable): ${driverUserNullPhone}`);

  // 2c. Users with role='driver' and NULL distributor_id (also unjoinable)
  const [{ count: driverUserNullDist }] = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS count
    FROM users
    WHERE role = 'driver' AND deleted_at IS NULL AND distributor_id IS NULL
  `;
  console.log(`   Driver-role users with NULL distributor_id:     ${driverUserNullDist}`);

  // 3. Drivers that would join cleanly to exactly ONE driver-role User
  const cleanlyMatched = await prisma.$queryRaw<{ driver_id: string; user_id: string }[]>`
    SELECT d.driver_id, u.user_id
    FROM drivers d
    JOIN users u
      ON u.phone = d.phone
     AND u.distributor_id = d.distributor_id
     AND u.role = 'driver'
     AND u.deleted_at IS NULL
    WHERE d.deleted_at IS NULL
  `;
  console.log(`\n3. Driver→User matches via (phone, distributor_id, role='driver'):`);
  console.log(`   Total join rows: ${cleanlyMatched.length}`);

  // 4. Orphan Drivers — no matching driver-role User
  const orphanDrivers = await prisma.$queryRaw<
    { driver_id: string; driver_name: string; phone: string; distributor_id: string }[]
  >`
    SELECT d.driver_id, d.driver_name, d.phone, d.distributor_id
    FROM drivers d
    WHERE d.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.phone = d.phone
          AND u.distributor_id = d.distributor_id
          AND u.role = 'driver'
          AND u.deleted_at IS NULL
      )
  `;
  console.log(`\n4. Orphan drivers (no matching User by phone+distributor_id):`);
  console.log(`   Count: ${orphanDrivers.length}`);
  if (orphanDrivers.length > 0 && orphanDrivers.length <= 20) {
    orphanDrivers.forEach((d) =>
      console.log(`   - ${d.driver_id} | ${d.driver_name} | ${d.phone} | dist=${d.distributor_id}`),
    );
  } else if (orphanDrivers.length > 20) {
    console.log(`   (showing first 10)`);
    orphanDrivers.slice(0, 10).forEach((d) =>
      console.log(`   - ${d.driver_id} | ${d.driver_name} | ${d.phone} | dist=${d.distributor_id}`),
    );
  }

  // 5. Driver-role Users with NO matching Driver — logins without driver records
  const usersNoDriver = await prisma.$queryRaw<
    { user_id: string; email: string; phone: string | null; distributor_id: string | null }[]
  >`
    SELECT u.user_id, u.email, u.phone, u.distributor_id
    FROM users u
    WHERE u.role = 'driver'
      AND u.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM drivers d
        WHERE d.phone = u.phone
          AND d.distributor_id = u.distributor_id
          AND d.deleted_at IS NULL
      )
  `;
  console.log(`\n5. Driver-role Users with NO matching Driver record:`);
  console.log(`   Count: ${usersNoDriver.length}`);
  if (usersNoDriver.length > 0 && usersNoDriver.length <= 20) {
    usersNoDriver.forEach((u) =>
      console.log(
        `   - ${u.user_id} | ${u.email} | phone=${u.phone ?? '(null)'} | dist=${u.distributor_id ?? '(null)'}`,
      ),
    );
  } else if (usersNoDriver.length > 20) {
    console.log(`   (showing first 10)`);
    usersNoDriver
      .slice(0, 10)
      .forEach((u) =>
        console.log(
          `   - ${u.user_id} | ${u.email} | phone=${u.phone ?? '(null)'} | dist=${u.distributor_id ?? '(null)'}`,
        ),
      );
  }

  // 6a. Duplicates on Driver side: multiple Driver rows with same phone+distributor_id
  const driverDuplicates = await prisma.$queryRaw<
    { phone: string; distributor_id: string; cnt: bigint }[]
  >`
    SELECT d.phone, d.distributor_id, COUNT(*)::bigint AS cnt
    FROM drivers d
    WHERE d.deleted_at IS NULL
    GROUP BY d.phone, d.distributor_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `;
  console.log(`\n6a. Duplicate Driver rows (same phone+distributor_id, alive):`);
  console.log(`    Distinct duplicate groups: ${driverDuplicates.length}`);
  if (driverDuplicates.length > 0) {
    driverDuplicates.forEach((d) =>
      console.log(`    - phone=${d.phone} dist=${d.distributor_id}: ${d.cnt} rows`),
    );
  }

  // 6b. Duplicates on User side: multiple driver-role Users with same phone+distributor_id
  const userDuplicates = await prisma.$queryRaw<
    { phone: string | null; distributor_id: string | null; cnt: bigint }[]
  >`
    SELECT u.phone, u.distributor_id, COUNT(*)::bigint AS cnt
    FROM users u
    WHERE u.role = 'driver' AND u.deleted_at IS NULL
    GROUP BY u.phone, u.distributor_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `;
  console.log(`\n6b. Duplicate driver-role Users (same phone+distributor_id, alive):`);
  console.log(`    Distinct duplicate groups: ${userDuplicates.length}`);
  if (userDuplicates.length > 0) {
    userDuplicates.forEach((u) =>
      console.log(`    - phone=${u.phone ?? '(null)'} dist=${u.distributor_id ?? '(null)'}: ${u.cnt} rows`),
    );
  }

  // 7. Ambiguous matches: Drivers where the (phone, distributor_id) lookup returns >1 driver-role User
  const ambiguousMatches = await prisma.$queryRaw<
    { driver_id: string; matching_user_count: bigint }[]
  >`
    SELECT d.driver_id, COUNT(u.user_id)::bigint AS matching_user_count
    FROM drivers d
    JOIN users u
      ON u.phone = d.phone
     AND u.distributor_id = d.distributor_id
     AND u.role = 'driver'
     AND u.deleted_at IS NULL
    WHERE d.deleted_at IS NULL
    GROUP BY d.driver_id
    HAVING COUNT(u.user_id) > 1
  `;
  console.log(`\n7. Ambiguous Drivers (1 driver → multiple matching driver-role Users):`);
  console.log(`   Count: ${ambiguousMatches.length}`);
  if (ambiguousMatches.length > 0) {
    ambiguousMatches.forEach((a) =>
      console.log(`   - ${a.driver_id}: ${a.matching_user_count} matching users`),
    );
  }

  // 8. Summary verdict
  console.log('\n=== Verdict ===');
  const cleanMatchDriverCount = new Set(cleanlyMatched.map((m) => m.driver_id)).size;
  console.log(`Drivers with exactly one User match:  ${cleanMatchDriverCount} of ${driverTotal}`);
  console.log(`Drivers that are orphans:             ${orphanDrivers.length}`);
  console.log(`Drivers with ambiguous matches:       ${ambiguousMatches.length}`);
  console.log(`Driver duplicates:                    ${driverDuplicates.length}`);
  console.log(`User duplicates (driver role):        ${userDuplicates.length}`);

  const dataIsClean =
    orphanDrivers.length === 0 &&
    ambiguousMatches.length === 0 &&
    driverDuplicates.length === 0 &&
    userDuplicates.length === 0;

  if (dataIsClean) {
    console.log(`\n✅ Data is clean (1:1 mapping, no duplicates, no orphans).`);
    console.log(`   Recommended migration: single-step "Driver.userId String? @unique" + backfill UPDATE in the same migration.`);
    console.log(`   userId stays NULLABLE so future drivers can be created without an immediate User link.`);
  } else {
    console.log(`\n⚠ Data is NOT clean — surface to Suneel before drafting migration.`);
    if (orphanDrivers.length > 0)
      console.log(`   - ${orphanDrivers.length} orphan drivers will have userId=NULL after backfill`);
    if (ambiguousMatches.length > 0)
      console.log(`   - ${ambiguousMatches.length} ambiguous drivers need a tie-break rule (oldest user wins? newest? flagged for manual?)`);
    if (driverDuplicates.length > 0)
      console.log(`   - ${driverDuplicates.length} duplicate Driver row groups would also need disambiguation before any backfill`);
    if (userDuplicates.length > 0)
      console.log(`   - ${userDuplicates.length} duplicate User-driver-role groups would make the join non-deterministic`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Inspection failed:', err);
  process.exit(1);
});
