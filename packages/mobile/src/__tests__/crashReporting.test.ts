/**
 * crashReporting service tests — Sentry v8 integration.
 *
 * Covers:
 * - initCrashReporting respects __DEV__ (no Sentry in dev) and DSN
 *   absence (no Sentry without configuration)
 * - initCrashReporting passes the locked v1.0 config when active
 *   (tracesSampleRate: 0.0 — see service file for rationale)
 * - setUser maps role → segment and passes through to Sentry.setUser
 * - captureException forwards context as Sentry's `extra`
 * - captureMessage forwards the level argument
 * - addBreadcrumb constructs the full breadcrumb payload with level
 *
 * Each test isolates the module so __DEV__ + DSN can be set per-test.
 * The module reads both at import time, so they MUST be set before
 * require() / dynamic import.
 */

const mockSentry = {
  init: jest.fn(),
  setUser: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
};

jest.mock('@sentry/react-native', () => mockSentry);

type CrashReportingModule = {
  initCrashReporting: () => void;
  captureException: (error: unknown, context?: Record<string, unknown>) => void;
  captureMessage: (message: string, level?: 'info' | 'warning' | 'error') => void;
  setUser: (user: { id: string; email: string; role: string } | null) => void;
  addBreadcrumb: (category: string, message: string, data?: Record<string, unknown>) => void;
};

function loadModule(opts: { isDev: boolean; dsn?: string; environment?: string }): CrashReportingModule {
  let mod: CrashReportingModule | undefined;
  jest.isolateModules(() => {
    (global as unknown as { __DEV__: boolean }).__DEV__ = opts.isDev;
    if (opts.dsn === undefined) {
      delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    } else {
      process.env.EXPO_PUBLIC_SENTRY_DSN = opts.dsn;
    }
    if (opts.environment === undefined) {
      delete process.env.EXPO_PUBLIC_ENVIRONMENT;
    } else {
      process.env.EXPO_PUBLIC_ENVIRONMENT = opts.environment;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.isolateModules needs synchronous require; ESM import() would make the helper async and rewrite every test
    mod = require('../services/crashReporting') as CrashReportingModule;
  });
  if (!mod) throw new Error('failed to load crashReporting module');
  return mod;
}

const TEST_DSN = 'https://test-dsn@o123.ingest.sentry.io/456';

describe('crashReporting — initCrashReporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does NOT init Sentry when __DEV__ is true', () => {
    const mod = loadModule({ isDev: true, dsn: TEST_DSN });
    mod.initCrashReporting();
    expect(mockSentry.init).not.toHaveBeenCalled();
  });

  it('does NOT init Sentry when DSN is absent (Expo Go / preview without env)', () => {
    const mod = loadModule({ isDev: false });
    mod.initCrashReporting();
    expect(mockSentry.init).not.toHaveBeenCalled();
  });

  it('inits Sentry with v1.0 locked config in production builds with DSN', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN, environment: 'production' });
    mod.initCrashReporting();

    expect(mockSentry.init).toHaveBeenCalledTimes(1);
    expect(mockSentry.init).toHaveBeenCalledWith({
      dsn: TEST_DSN,
      enableAutoSessionTracking: true,
      sessionTrackingIntervalMillis: 30_000,
      tracesSampleRate: 0.0,
      environment: 'production',
    });
  });

  it('falls back to environment "production" when EXPO_PUBLIC_ENVIRONMENT is unset', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    mod.initCrashReporting();
    expect(mockSentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: 'production' }));
  });

  it('uses EXPO_PUBLIC_ENVIRONMENT when set (e.g. "preview")', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN, environment: 'preview' });
    mod.initCrashReporting();
    expect(mockSentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: 'preview' }));
  });
});

describe('crashReporting — setUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes user with role mapped to segment in production', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    mod.setUser({ id: 'u123', email: 'a@b.com', role: 'driver' });
    expect(mockSentry.setUser).toHaveBeenCalledWith({ id: 'u123', email: 'a@b.com', segment: 'driver' });
  });

  it('clears the user when called with null', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    mod.setUser(null);
    expect(mockSentry.setUser).toHaveBeenCalledWith(null);
  });

  it('is a no-op in dev', () => {
    const mod = loadModule({ isDev: true, dsn: TEST_DSN });
    mod.setUser({ id: 'u123', email: 'a@b.com', role: 'driver' });
    expect(mockSentry.setUser).not.toHaveBeenCalled();
  });
});

describe('crashReporting — captureException', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards error and wraps context as `extra` in production', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    const err = new Error('boom');
    mod.captureException(err, { route: '/x', userId: 'u1' });
    expect(mockSentry.captureException).toHaveBeenCalledWith(err, { extra: { route: '/x', userId: 'u1' } });
  });

  it('handles missing context (extra: undefined)', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    const err = new Error('boom');
    mod.captureException(err);
    expect(mockSentry.captureException).toHaveBeenCalledWith(err, { extra: undefined });
  });

  it('logs to console and skips Sentry in dev', () => {
    const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mod = loadModule({ isDev: true, dsn: TEST_DSN });
    mod.captureException(new Error('boom'), { x: 1 });
    expect(consoleErrSpy).toHaveBeenCalled();
    expect(mockSentry.captureException).not.toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });
});

describe('crashReporting — captureMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards level argument in production', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    mod.captureMessage('hello', 'warning');
    expect(mockSentry.captureMessage).toHaveBeenCalledWith('hello', 'warning');
  });

  it('defaults level to "info" when omitted', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    mod.captureMessage('hello');
    expect(mockSentry.captureMessage).toHaveBeenCalledWith('hello', 'info');
  });
});

describe('crashReporting — addBreadcrumb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('constructs the full breadcrumb payload with level "info"', () => {
    const mod = loadModule({ isDev: false, dsn: TEST_DSN });
    mod.addBreadcrumb('navigation', 'screen-shown', { screen: 'orders' });
    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'navigation',
      message: 'screen-shown',
      data: { screen: 'orders' },
      level: 'info',
    });
  });

  it('is a no-op in dev', () => {
    const mod = loadModule({ isDev: true, dsn: TEST_DSN });
    mod.addBreadcrumb('navigation', 'screen-shown');
    expect(mockSentry.addBreadcrumb).not.toHaveBeenCalled();
  });
});
