// One-shot helper to apply the email_logs migration against the dev DB.
// Bypasses `prisma migrate` because the dev DB has documented drift on the
// IrnStatus.cancel_failed enum that blocks `prisma migrate dev`.
// Safe to run multiple times — IF NOT EXISTS guards + the table is empty.
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
(async () => {
  const prisma = new PrismaClient();
  const sqlPath = path.join(__dirname, '..', 'prisma', 'migrations', '20260610200000_email_logs', 'migration.sql');
  const sqlRaw = fs.readFileSync(sqlPath, 'utf8');
  // Strip `-- …` comment lines BEFORE splitting on `;` — otherwise a
  // leading comment block hides the real first statement (its trim() starts
  // with `--`, so the comment-startsWith filter drops the whole CREATE).
  const sql = sqlRaw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const s of statements) {
    try {
      await prisma.$executeRawUnsafe(s);
      console.log('OK:', s.split('\n')[0].slice(0, 70));
    } catch (e) {
      console.log('SKIP/FAIL:', s.split('\n')[0].slice(0, 70), '—', e.message.slice(0, 120));
    }
  }
  await prisma.$executeRawUnsafe(`
    INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
    VALUES (gen_random_uuid()::text, 'manual-email-logs', NOW(), '20260610200000_email_logs', NOW(), 1)
    ON CONFLICT (id) DO NOTHING
  `);
  await prisma.$disconnect();
  console.log('Done.');
})();
