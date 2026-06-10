/**
 * SMTP test — sends one canned email and exits 0 on success, 1 on failure.
 *
 * Reads SMTP_* env vars from the same `config` the runtime uses. Defaults
 * the recipient to `info@mygaslink.com` (the inbox we own) but accepts a
 * CLI override:
 *   pnpm --filter @gaslink/api tsx scripts/test-smtp.ts you@example.com
 *
 * Intended use:
 *   - After populating SMTP env on prod EC2, run this with pm2 env loaded:
 *     pm2 list && pm2 env 0 | grep SMTP_ && \
 *     (cd /opt/gaslink/packages/api && node --loader tsx scripts/test-smtp.ts)
 *   - Then check the recipient inbox.
 *
 * The transporter is the SAME singleton the welcome-email path uses, so a
 * success here guarantees the welcome flow will dispatch over the same
 * Gmail session.
 */
import 'dotenv/config';
import { config } from '../src/config/index.js';
import { sendSmtpTestEmail } from '../src/utils/email.js';

async function main() {
  const recipient = process.argv[2] || config.smtp.contactEmail || 'info@mygaslink.com';
  console.log('SMTP host        :', config.smtp.host || '(empty — will fail)');
  console.log('SMTP port        :', config.smtp.port);
  console.log('SMTP user        :', config.smtp.user || '(empty — will fail)');
  console.log('SMTP pass length :', config.smtp.pass ? config.smtp.pass.length : 0);
  console.log('From header      :', `"${config.smtp.fromName}" <${config.smtp.from}>`);
  console.log('Recipient        :', recipient);
  console.log();

  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
    console.error('❌  SMTP env vars are not fully populated. Aborting.');
    process.exit(1);
  }

  try {
    await sendSmtpTestEmail(recipient);
    console.log('✅  SMTP test email dispatched.');
    console.log('   Check the recipient inbox to confirm delivery.');
    process.exit(0);
  } catch (err) {
    console.error('❌  SMTP test failed:', (err as Error).message);
    process.exit(1);
  }
}

main();
