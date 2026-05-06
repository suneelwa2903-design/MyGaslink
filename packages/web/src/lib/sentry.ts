import * as Sentry from '@sentry/browser';

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION ?? '1.0.0',
    tracesSampleRate: 0.2,
    beforeSend(event) {
      // Stay silent in dev — DSN may be set in .env.local for testing without
      // sending real noise.
      if (import.meta.env.DEV) return null;
      return event;
    },
  });
}

export { Sentry };
