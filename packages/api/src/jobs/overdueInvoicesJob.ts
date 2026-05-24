import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { markOverdueInvoices } from '../services/invoiceService.js';
import { logger } from '../utils/logger.js';

/**
 * WI-132: daily sweep that flips issued/partially_paid invoices past their
 * due date to status='overdue' (per active distributor). The "overdue" badge
 * and admin counts are otherwise only refreshed when a route happens to call
 * markOverdueInvoices — meaning an untouched tenant's badges go stale.
 *
 * Runs once per day at midnight (server local time). Best-effort: a failure
 * for one distributor is logged and the sweep continues; the whole job never
 * throws into the event loop.
 */
export async function runOverdueSweep(): Promise<void> {
  const distributors = await prisma.distributor.findMany({
    where: { status: 'active' },
    select: { id: true, businessName: true },
  });

  let total = 0;
  for (const d of distributors) {
    try {
      const { markedOverdue } = await markOverdueInvoices(d.id);
      total += markedOverdue;
      if (markedOverdue > 0) {
        logger.info('Overdue sweep: invoices marked overdue', {
          distributorId: d.id,
          businessName: d.businessName,
          markedOverdue,
        });
      }
    } catch (err) {
      logger.error('Overdue sweep failed for distributor', {
        distributorId: d.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Overdue sweep complete', {
    distributors: distributors.length,
    totalMarkedOverdue: total,
  });
}

let task: ScheduledTask | null = null;

/**
 * Register the daily midnight cron. Non-blocking on startup — it only
 * schedules; the first run happens at the next midnight. Returns the
 * ScheduledTask so callers/tests can stop it.
 */
export function startOverdueInvoicesCron(): ScheduledTask {
  if (task) return task;
  task = cron.schedule('0 0 * * *', () => {
    runOverdueSweep().catch((err) => {
      logger.error('Overdue sweep crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  logger.info('Overdue-invoices cron scheduled (daily @ 00:00)');
  return task;
}
