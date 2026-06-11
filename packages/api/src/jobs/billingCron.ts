import cron, { type ScheduledTask } from 'node-cron';
import {
  markOverdueBillingCycles,
  checkBillingExpiryAndCreatePendingActions,
} from '../services/billingService.js';
import { logger } from '../utils/logger.js';

/**
 * Phase 4b (2026-06-12): monthly billing sweep.
 *
 * markOverdueBillingCycles + checkBillingExpiryAndCreatePendingActions
 * have lived in billingService.ts since the WI-009 SaaS rollout, but no
 * scheduler ever invoked them. Tenants relied on a super-admin manually
 * running the corresponding routes (POST /api/billing/run-overdue-sweep
 * and similar) — which obviously didn't scale.
 *
 * Runs at 00:05 IST on the 1st of every month, narrowly after the daily
 * overdue-invoices cron (00:00). Best-effort: a failure inside either
 * service call is logged and the other still runs; the cron itself never
 * throws into the event loop.
 *
 * IST is the relevant timezone — every live distributor is in India and
 * GST quarter/month boundaries follow IST. node-cron's `timezone` option
 * resolves to whatever the host's tz database knows for 'Asia/Kolkata'.
 */
export async function runMonthlyBillingSweep(): Promise<void> {
  try {
    const overdue = await markOverdueBillingCycles();
    logger.info('Monthly billing sweep: markOverdueBillingCycles complete', {
      result: overdue,
    });
  } catch (err) {
    logger.error('Monthly billing sweep: markOverdueBillingCycles failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const expiry = await checkBillingExpiryAndCreatePendingActions();
    logger.info('Monthly billing sweep: checkBillingExpiry complete', {
      result: expiry,
    });
  } catch (err) {
    logger.error('Monthly billing sweep: checkBillingExpiry failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let task: ScheduledTask | null = null;

/**
 * Register the monthly cron. Non-blocking — only schedules; the first
 * run happens at the next 1st-of-month 00:05 IST. Returns the
 * ScheduledTask so tests / callers can stop it.
 */
export function startBillingCron(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    '5 0 1 * *',
    () => {
      runMonthlyBillingSweep().catch((err) => {
        logger.error('Monthly billing sweep crashed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    { timezone: 'Asia/Kolkata' },
  );
  logger.info('Monthly billing cron scheduled (1st of month @ 00:05 IST)');
  return task;
}
