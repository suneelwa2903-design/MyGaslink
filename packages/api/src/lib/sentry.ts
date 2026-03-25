import * as Sentry from '@sentry/node';
import { config } from '../config/index.js';

const dsn = process.env.SENTRY_DSN;

if (dsn && config.isProd) {
  Sentry.init({
    dsn,
    environment: config.nodeEnv,
    tracesSampleRate: 0.2,
    profilesSampleRate: 0.1,
  });
}

export { Sentry };
