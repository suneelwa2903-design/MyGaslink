// One-shot helper to apply the driver_user_fk migration against the dev DB.
// Same drift workaround as scripts/apply-email-logs-migration.cjs — prisma
// migrate dev refuses to run because of the IrnStatus.cancel_failed enum.
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
(async () => {
  const prisma = new PrismaClient();
  const sqlPath = path.join(__dirname, '..', 'prisma', 'migrations', '20260610210000_driver_user_fk', 'migration.sql');
  const sqlRaw = fs.readFileSync(sqlPath, 'utf8');
  const sql = sqlRaw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of statements) {
    try {
      await prisma.$executeRawUnsafe(s);
      console.log('OK:', s.split('\n')[0].slice(0, 80));
    } catch (e) {
      console.log('SKIP/FAIL:', s.split('\n')[0].slice(0, 80), '—', e.message.slice(0, 140));
    }
  }
  await prisma.$executeRawUnsafe(`
    INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
    VALUES (gen_random_uuid()::text, 'manual-driver-user-fk', NOW(), '20260610210000_driver_user_fk', NOW(), 1)
    ON CONFLICT (id) DO NOTHING
  `);
  await prisma.$disconnect();
  console.log('Done.');
})();
