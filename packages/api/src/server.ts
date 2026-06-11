import { config, validateEnv } from './config/index.js';
import { logger } from './utils/logger.js';
import { Sentry } from './lib/sentry.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';
import { startOverdueInvoicesCron } from './jobs/overdueInvoicesJob.js';
import { startBillingCron } from './jobs/billingCron.js';

// ─── Validate Environment ────────────────────────────────────────────────────

validateEnv();

// ─── Process-level Error Handlers ────────────────────────────────────────────

// unhandledRejection — log + report, do NOT exit. Some rejections are
// recoverable (e.g. transient network failures inside non-blocking work).
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection', {
    error: err.message,
    stack: err.stack,
    promise: String(promise),
  });
  Sentry.captureException(err, { tags: { kind: 'unhandledRejection' } });
});

// uncaughtException — process is in an undefined state. Log, flush, exit 1.
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception — exiting', {
    error: error.message,
    stack: error.stack,
  });
  Sentry.captureException(error, { tags: { kind: 'uncaughtException' } });
  // Give Sentry a moment to flush, then bail.
  Sentry.close(2000).finally(() => process.exit(1));
});

// ─── Start Server ────────────────────────────────────────────────────────────

const app = createApp();
const port = config.port;

// Host binding: 0.0.0.0 in dev so phones on the LAN can reach the API for
// Expo Go testing. 127.0.0.1 in production — NGINX / reverse proxy on the
// same host handles all external traffic, so the Node process must never be
// world-reachable. Override with HOST env var only if you know what you're doing.
const host = process.env.HOST
  ?? (config.nodeEnv === 'production' ? '127.0.0.1' : '0.0.0.0');

const server = app.listen(port, host, () => {
  logger.info(`GasLink API server running on ${host}:${port}`, {
    env: config.nodeEnv,
    cors: config.cors.origins,
  });
  // WI-132: schedule the daily overdue-invoice sweep. Non-blocking — only
  // registers the cron; first run is the next midnight.
  startOverdueInvoicesCron();
  // Phase 4b (2026-06-12): schedule the monthly SaaS billing sweep that
  // marks BillingCycle rows overdue + raises pending actions for expiring
  // subscriptions. Runs 00:05 IST on the 1st of every month.
  startBillingCron();
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

// SIGTERM (pm2/Docker) and SIGINT (Ctrl-C in dev). Stop accepting new
// connections, drain in-flight requests, disconnect Prisma, exit cleanly.
// Hard 30s timeout in case a request hangs.

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Shutdown signal received: ${signal}`);

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 30s — forcing exit');
    process.exit(1);
  }, 30_000);
  // Don't let the timer keep the event loop alive on a clean exit.
  forceExitTimer.unref();

  // Stop accepting new HTTP connections; existing ones drain naturally.
  server.close((err) => {
    if (err) {
      logger.error('Error during server.close', { error: err.message });
    } else {
      logger.info('HTTP server closed — no new connections');
    }

    prisma.$disconnect()
      .then(() => {
        logger.info('Prisma disconnected');
      })
      .catch((dbErr: Error) => {
        logger.error('Error disconnecting Prisma', { error: dbErr.message });
      })
      .finally(() => {
        clearTimeout(forceExitTimer);
        process.exit(err ? 1 : 0);
      });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
