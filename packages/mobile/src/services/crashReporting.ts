/**
 * Crash Reporting Service — Sentry React Native v8 integration.
 *
 * Active in EAS preview + production builds. In dev (__DEV__), Sentry
 * is intentionally NOT initialised — errors log to console only, so
 * developer crash noise doesn't burn the production Sentry quota.
 *
 * DSN is bundled at build time via process.env.EXPO_PUBLIC_SENTRY_DSN
 * (set in eas.json's preview/production profile env blocks). If the
 * DSN is absent at init time (e.g. Expo Go) the init call is a no-op.
 *
 * v1.0 configuration choices (locked 2026-06-08):
 *   - tracesSampleRate: 0.0  — errors only, no performance traces; the
 *     free Sentry tier covers ~5k errors/month and traces eat through
 *     quota fast. Flip ON post-launch with a low sample rate.
 *   - Session replay: OFF (not initialised) — heavy bandwidth, not
 *     needed for v1.0 visibility.
 *   - Auto session tracking: ON — free, gives basic crash-free-users
 *     metric.
 *
 * Source map / dSYM upload requires SENTRY_AUTH_TOKEN as an EAS build
 * secret. Currently deferred (commit-approved 2026-06-08) — crashes
 * will report with Hermes bytecode stacks until the secret lands. The
 * @sentry/react-native/expo plugin in app.json handles the upload
 * automatically once the secret is present.
 */

import * as Sentry from '@sentry/react-native';

const IS_DEV = __DEV__;
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function initCrashReporting(): void {
  if (IS_DEV) return;
  if (!DSN) return;

  Sentry.init({
    dsn: DSN,
    enableAutoSessionTracking: true,
    sessionTrackingIntervalMillis: 30_000,
    tracesSampleRate: 0.0,
    environment: process.env.EXPO_PUBLIC_ENVIRONMENT ?? 'production',
  });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (IS_DEV) {
    console.error('[CrashReporting]', error, context);
    return;
  }

  Sentry.captureException(error, { extra: context });
}

export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (IS_DEV) {
    console.log(`[CrashReporting:${level}]`, message);
    return;
  }

  Sentry.captureMessage(message, level);
}

export function setUser(user: { id: string; email: string; role: string } | null): void {
  if (IS_DEV) return;

  if (user) {
    Sentry.setUser({ id: user.id, email: user.email, segment: user.role });
  } else {
    Sentry.setUser(null);
  }
}

export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (IS_DEV) return;

  Sentry.addBreadcrumb({ category, message, data, level: 'info' });
}
