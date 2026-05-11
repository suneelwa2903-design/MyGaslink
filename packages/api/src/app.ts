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
import distributorRoutes from './routes/distributors.js';
import customerRoutes from './routes/customers.js';
import cylinderTypeRoutes from './routes/cylinderTypes.js';
import orderRoutes from './routes/orders.js';
import inventoryRoutes from './routes/inventory.js';
import invoiceRoutes from './routes/invoices.js';
import paymentRoutes from './routes/payments.js';
import { driverRouter, vehicleRouter } from './routes/driversVehicles.js';
import analyticsRoutes from './routes/analytics.js';
import settingsRoutes from './routes/settings.js';
import pendingActionsRoutes from './routes/pendingActions.js';
import billingRoutes from './routes/billing.js';
import accountabilityRoutes from './routes/accountability.js';
import customerPortalRoutes from './routes/customerPortal.js';
import deliveryWorkflowRouter from './routes/deliveryWorkflow.js';
import assignmentsRouter from './routes/assignments.js';
import providerCatalogRoutes from './routes/providerCatalog.js';
import pricingRoutes from './routes/pricing.js';

export function createApp() {
  const app = express();

  // ─── Global Middleware ───────────────────────────────────────────────────────

  app.use(requestId);
  app.use(helmet());

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

  app.use(express.json({ limit: '10mb' }));
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

  // ─── Protected Routes ───────────────────────────────────────────────────────

  app.use('/api/users', authenticate, resolveDistributor, userRoutes);
  app.use('/api/distributors', authenticate, distributorRoutes);
  app.use('/api/customers', authenticate, resolveDistributor, requireDistributor, customerRoutes);
  app.use('/api/cylinder-types', authenticate, resolveDistributor, requireDistributor, cylinderTypeRoutes);
  app.use('/api/orders', authenticate, resolveDistributor, requireDistributor, orderRoutes);
  app.use('/api/inventory', authenticate, resolveDistributor, requireDistributor, inventoryRoutes);
  app.use('/api/invoices', authenticate, resolveDistributor, requireDistributor, invoiceRoutes);
  app.use('/api/payments', authenticate, resolveDistributor, requireDistributor, paymentRoutes);
  app.use('/api/drivers', authenticate, resolveDistributor, requireDistributor, driverRouter);
  app.use('/api/vehicles', authenticate, resolveDistributor, requireDistributor, vehicleRouter);
  app.use('/api/analytics', authenticate, resolveDistributor, requireDistributor, analyticsRoutes);
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
