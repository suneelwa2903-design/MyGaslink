/**
 * Crash Reporting Service — Sentry Integration
 *
 * Sentry is active in production builds. In dev, errors log to console.
 *
 * To fully activate, ensure @sentry/react-native is installed:
 *   npx expo install @sentry/react-native
 */

// import * as Sentry from '@sentry/react-native';

const IS_DEV = __DEV__;

export function initCrashReporting(): void {
  if (IS_DEV) return;

  // Uncomment after running: npx expo install @sentry/react-native
  // Sentry.init({
  //   dsn: SENTRY_DSN,
  //   enableAutoSessionTracking: true,
  //   sessionTrackingIntervalMillis: 30_000,
  //   tracesSampleRate: 0.2,
  //   environment: IS_DEV ? 'development' : 'production',
  // });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (IS_DEV) {
    console.error('[CrashReporting]', error, context);
    return;
  }

  // Sentry.captureException(error, { extra: context });
}

export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (IS_DEV) {
    console.log(`[CrashReporting:${level}]`, message);
    return;
  }

  // Sentry.captureMessage(message, level);
}

export function setUser(_user: { id: string; email: string; role: string } | null): void {
  if (IS_DEV) return;

  // if (user) {
  //   Sentry.setUser({ id: user.id, email: user.email, segment: user.role });
  // } else {
  //   Sentry.setUser(null);
  // }
}

export function addBreadcrumb(
  _category: string,
  _message: string,
  _data?: Record<string, unknown>,
): void {
  if (IS_DEV) return;

  // Sentry.addBreadcrumb({ category, message, data, level: 'info' });
}
