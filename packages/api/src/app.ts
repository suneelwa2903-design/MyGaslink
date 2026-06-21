import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { Sentry } from './lib/sentry.js';
import { logger } from './utils/logger.js';
import { requestId } from './middleware/requestId.js';
import { sendError } from './utils/apiResponse.js';
import { authenticate, resolveDistributor, requireDistributor } from './middleware/auth.js';
import { setupSwagger } from './swagger.js';

// ─── Route Imports ──────────────────────────────────────────────────────────

import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import contactRoutes from './routes/contact.js';
import userRoutes from './routes/users.js';
import superAdminDeletionRoutes from './routes/superAdminDeletionRoutes.js';
import distributorRoutes from './routes/distributors.js';
import customerRoutes from './routes/customers.js';
import cylinderTypeRoutes from './routes/cylinderTypes.js';
import orderRoutes from './routes/orders.js';
import inventoryRoutes from './routes/inventory.js';
import invoiceRoutes from './routes/invoices.js';
import paymentRoutes from './routes/payments.js';
import { driverRouter, vehicleRouter } from './routes/driversVehicles.js';
import analyticsRoutes from './routes/analytics.js';
import reportsRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import pendingActionsRoutes from './routes/pendingActions.js';
import billingRoutes from './routes/billing.js';
import accountabilityRoutes from './routes/accountability.js';
import customerPortalRoutes from './routes/customerPortal.js';
import deliveryWorkflowRouter from './routes/deliveryWorkflow.js';
import assignmentsRouter from './routes/assignments.js';
import providerCatalogRoutes from './routes/providerCatalog.js';
import pricingRoutes from './routes/pricing.js';
import licensesRoutes from './routes/licenses.js';
import testHelpersRouter from './routes/testHelpers.js';
import adminGstActivationRoutes from './routes/adminGstActivation.js';
import loginHistoryRoutes from './routes/loginHistory.js';
import razorpayWebhookRoutes from './routes/razorpayWebhook.js';
import razorpayCustomerWebhookRoutes from './routes/razorpayCustomerWebhook.js';
import tallySettingsRoutes from './routes/tallySettings.js';
import manifestsRoutes from './routes/manifests.js';

export function createApp() {
  const app = express();

  // Trust the FIRST hop (nginx on the EC2 box in front of us). Without this,
  // express-rate-limit refuses to honour `X-Forwarded-For` and logs
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request, defaulting to
  // socket.remoteAddress (always 127.0.0.1 via nginx) — so rate limits would
  // bucket every client into the same key. `1` = exactly one trusted proxy.
  // SECURITY: do NOT raise this without first confirming nothing reaches
  // Express directly bypassing nginx (i.e., security group must NOT expose
  // port 5000 to the public internet). A higher value would let attackers
  // spoof X-Forwarded-For by adding their own hops.
  app.set('trust proxy', 1);

  // ─── Global Middleware ───────────────────────────────────────────────────────

  app.use(requestId);
  // Helmet defaults Cross-Origin-Resource-Policy to 'same-origin', which
  // blocks the SPA at mygaslink.com from reading responses served by
  // api.mygaslink.com (different origins). Use 'same-site' so any origin
  // under the mygaslink.com registrable domain can consume the API while
  // still blocking unrelated external sites.
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'same-site' },
  }));

  app.use(cors({
    origin: config.cors.origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Distributor-Id', 'X-Request-Id'],
  }));

  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, data: null, error: 'Too many requests', code: 'RATE_LIMITED' },
  }));

  // Phase E (2026-06-12): capture rawBody on /api/billing/webhooks/*
  // so the Razorpay webhook handler can run HMAC over the exact bytes
  // Razorpay sent. JSON.stringify(req.body) re-encoded would differ
  // (whitespace, key ordering) and break signature verification.
  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      // Capture raw body on every webhook route. Phase E:
      // /api/billing/webhooks/razorpay. Phase F:
      // /api/customer-portal/webhooks/razorpay/:distributorId.
      if (req.url?.startsWith('/api/billing/webhooks/') || req.url?.startsWith('/api/customer-portal/webhooks/')) {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      }
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.use((req, _res, next) => {
    if (req.path !== '/api/health') {
      logger.info(`${req.method} ${req.path}`, {
        requestId: req.requestId,
        ip: req.ip,
      });
    }
    next();
  });

  // ─── Public Routes ───────────────────────────────────────────────────────────

  app.use('/api/auth', authRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/contact', contactRoutes);
  // Phase E (2026-06-12): Razorpay webhook. Public — Razorpay calls
  // this from their server, no JWT possible. Signature is the only
  // gate. MUST be mounted BEFORE /api/billing so the authenticate
  // middleware on the billing router doesn't claim the route first.
  app.use('/api/billing/webhooks/razorpay', razorpayWebhookRoutes);
  // Phase F (2026-06-12): per-distributor Razorpay webhook. Same
  // rationale + mounting order — must precede the authenticated
  // /api/customer-portal mount. Distributor id is in the path so the
  // handler can look up that tenant's webhook secret.
  app.use('/api/customer-portal/webhooks/razorpay', razorpayCustomerWebhookRoutes);

  // ─── Protected Routes ───────────────────────────────────────────────────────

  app.use('/api/users', authenticate, resolveDistributor, userRoutes);
  app.use('/api/distributors', authenticate, distributorRoutes);
  // Group A: super-admin GST activation flow. No resolveDistributor — the :id
  // path param IS the target distributor. The route handlers enforce super_admin.
  app.use('/api/admin/distributors/:id/gst', authenticate, adminGstActivationRoutes);
  // Group DPDP (2026-06-11): super-admin maintenance endpoints for the
  // login_history table. Currently exposes /purge-old; a scheduled job
  // should replace this in a follow-up sprint.
  app.use('/api/admin/login-history', loginHistoryRoutes);
  // M14 v1.0 — super-admin read-only deletion-request monitor.
  app.use('/api/super-admin', authenticate, superAdminDeletionRoutes);
  app.use('/api/customers', authenticate, resolveDistributor, requireDistributor, customerRoutes);
  app.use('/api/cylinder-types', authenticate, resolveDistributor, requireDistributor, cylinderTypeRoutes);
  app.use('/api/orders', authenticate, resolveDistributor, requireDistributor, orderRoutes);
  app.use('/api/inventory', authenticate, resolveDistributor, requireDistributor, inventoryRoutes);
  app.use('/api/invoices', authenticate, resolveDistributor, requireDistributor, invoiceRoutes);
  app.use('/api/payments', authenticate, resolveDistributor, requireDistributor, paymentRoutes);
  app.use('/api/drivers', authenticate, resolveDistributor, requireDistributor, driverRouter);
  app.use('/api/vehicles', authenticate, resolveDistributor, requireDistributor, vehicleRouter);
  app.use('/api/analytics', authenticate, resolveDistributor, requireDistributor, analyticsRoutes);
  app.use('/api/reports', authenticate, resolveDistributor, requireDistributor, reportsRoutes);
  // settings + pending-actions GET / handlers gracefully return an empty
  // response when super_admin has no distributor selected; other handlers in
  // these routers guard distributorId inline. See WI-002 pattern.
  app.use('/api/settings', authenticate, resolveDistributor, settingsRoutes);
  app.use('/api/pending-actions', authenticate, resolveDistributor, pendingActionsRoutes);
  app.use('/api/accountability', authenticate, resolveDistributor, requireDistributor, accountabilityRoutes);
  app.use('/api/billing', authenticate, resolveDistributor, billingRoutes);
  app.use('/api/customer-portal', authenticate, resolveDistributor, requireDistributor, customerPortalRoutes);
  app.use('/api/delivery', authenticate, resolveDistributor, requireDistributor, deliveryWorkflowRouter);
  app.use('/api/assignments', authenticate, resolveDistributor, requireDistributor, assignmentsRouter);
  app.use('/api/provider-catalog', authenticate, providerCatalogRoutes);
  app.use('/api/pricing', authenticate, resolveDistributor, pricingRoutes);
  app.use('/api/licenses', authenticate, resolveDistributor, requireDistributor, licensesRoutes);
  app.use('/api/tally-settings', authenticate, resolveDistributor, requireDistributor, tallySettingsRoutes);
  // FLOAT-001 (2026-06-17): vehicle load manifests.
  app.use('/api/manifests', authenticate, resolveDistributor, requireDistributor, manifestsRoutes);

  // ─── Dev / test helpers (never mounted in production) ─────────────────────
  // Provides POST /test/inject-stale-token and GET /test/token-cache-state
  // for integration test scripts. Mount guard is NODE_ENV; a runtime check
  // inside the router itself provides belt-and-suspenders protection.
  if (process.env.NODE_ENV !== 'production') {
    app.use('/test', testHelpersRouter);
  }

  // ─── API Documentation (super_admin only) ─────────────────────────────────

  setupSwagger(app);

  // ─── 404 handler ─────────────────────────────────────────────────────────────

  app.use((_req, res) => {
    sendError(res, 'Route not found', 404, 'NOT_FOUND');
  });

  // ─── Global error handler ────────────────────────────────────────────────────

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    Sentry.captureException(err);
    sendError(res, config.isDev ? err.message : 'Internal server error', 500, 'INTERNAL_ERROR');
  });

  return app;
}
