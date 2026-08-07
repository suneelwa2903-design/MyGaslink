/**
 * N4 SSL pinning — config + heuristic guards.
 *
 * Three layers under test:
 *  1. plugins/withSslPinning.js — pure XML builder + env gating + the
 *     verified ISRG root SPKI pin set (any silent edit to a pin fails here).
 *  2. app.json / eas.json wiring — the plugin is registered, and the
 *     SSL_PINNING env flag is present on preview+production ONLY (a pin on
 *     the development profile would break Metro/LAN dev traffic).
 *  3. src/lib/pinning.ts — the offline-vs-intercepted heuristic: repeated
 *     response-less API failures trigger a probe of the unpinned CloudFront
 *     origin; probe-reachable ⇒ blocked (pin failure), probe-dead ⇒ plain
 *     offline (existing NetworkIndicator/queue handling owns it).
 *
 * The OS-level enforcement itself (network_security_config / NSPinnedDomains)
 * can only be proven on a real build — see docs/RUNBOOK-CERT-ROTATION.md
 * for the mitmproxy verification procedure.
 */
import appJson from '../../app.json';
import easJson from '../../eas.json';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../plugins/withSslPinning.js');

// The three ISRG root SPKI hashes verified 2026-08-07 against the live
// api.mygaslink.com chain AND https://letsencrypt.org/certs/.
const ISRG_ROOT_X1 = 'C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=';
const ISRG_ROOT_X2 = 'diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=';
const ISRG_ROOT_YE = 'sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w=';

describe('withSslPinning plugin — pin set + XML builder', () => {
  it('DEFAULTS pin exactly the three verified ISRG root SPKI hashes', () => {
    expect(plugin.DEFAULTS.pins).toEqual([ISRG_ROOT_X1, ISRG_ROOT_X2, ISRG_ROOT_YE]);
  });

  it('DEFAULTS target api.mygaslink.com only, no subdomains', () => {
    expect(plugin.DEFAULTS.domain).toBe('api.mygaslink.com');
    expect(plugin.DEFAULTS.includeSubdomains).toBe(false);
  });

  it('generated network_security_config has pin-set with expiration + all 3 pins', () => {
    const xml = plugin.buildNetworkSecurityXml(plugin.DEFAULTS);
    expect(xml).toContain('<domain includeSubdomains="false">api.mygaslink.com</domain>');
    expect(xml).toContain(`<pin-set expiration="${plugin.DEFAULTS.expiration}">`);
    for (const pin of plugin.DEFAULTS.pins) {
      expect(xml).toContain(`<pin digest="SHA-256">${pin}</pin>`);
    }
  });

  it('expiration (Android fail-open dead-man switch) is >90 days out — CI tripwire', () => {
    // Deliberate time-bomb-as-a-feature: this test starts failing 90 days
    // BEFORE the pin-set expiration, forcing the annual bump (runbook §2c)
    // through CI instead of relying on a human calendar reminder. When it
    // fires: bump `expiration` in plugins/withSslPinning.js by +15 months,
    // re-verify the served chain per RUNBOOK-CERT-ROTATION.md §3, ship.
    expect(plugin.DEFAULTS.expiration).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(new Date(plugin.DEFAULTS.expiration).getTime()).toBeGreaterThan(Date.now() + ninetyDays);
  });

  it('iOS NSPinnedDomains entry has CA identities in Apple SPKI-SHA256-BASE64 shape', () => {
    // expo prebuild cannot generate the iOS project on Windows, so the plist
    // payload shape is pinned here; the EAS cloud iOS build is the final
    // end-to-end verifier (anti-pattern #6 discipline: test the payload we
    // SEND, not just that machinery ran).
    const entry = plugin.buildPinnedDomainEntry(plugin.DEFAULTS);
    expect(entry.NSIncludesSubdomains).toBe(false);
    expect(entry.NSPinnedCAIdentities).toEqual([
      { 'SPKI-SHA256-BASE64': ISRG_ROOT_X1 },
      { 'SPKI-SHA256-BASE64': ISRG_ROOT_X2 },
      { 'SPKI-SHA256-BASE64': ISRG_ROOT_YE },
    ]);
  });

  it('no-ops (returns config untouched) when SSL_PINNING env is absent', () => {
    const prev = process.env.SSL_PINNING;
    delete process.env.SSL_PINNING;
    try {
      const config = { name: 'x', slug: 'x' };
      expect(plugin(config)).toBe(config);
    } finally {
      if (prev !== undefined) process.env.SSL_PINNING = prev;
    }
  });
});

describe('withSslPinning wiring — app.json + eas.json', () => {
  it('plugin is registered in app.json plugins array', () => {
    const plugins = appJson.expo.plugins as unknown[];
    expect(plugins).toContain('./plugins/withSslPinning');
  });

  it('SSL_PINNING=true on preview AND production build profiles', () => {
    expect((easJson.build.preview.env as Record<string, string>).SSL_PINNING).toBe('true');
    expect((easJson.build.production.env as Record<string, string>).SSL_PINNING).toBe('true');
  });

  it('development profile does NOT set SSL_PINNING (dev builds must stay unpinned)', () => {
    const devEnv = (easJson.build.development.env ?? {}) as Record<string, string>;
    expect(devEnv.SSL_PINNING).toBeUndefined();
  });
});

describe('pinning.ts — offline vs intercepted heuristic', () => {
  const HTTPS_API = 'https://api.mygaslink.com/api';

  // Fresh module instance per test: pinning.ts captures EXPO_PUBLIC_API_URL
  // at import time and keeps module-level failure counters.
  function loadPinning(apiUrl: string, axiosGet: jest.Mock) {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_URL = apiUrl;
    jest.doMock('axios', () => ({
      __esModule: true,
      default: { get: axiosGet },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../lib/pinning') as typeof import('../lib/pinning');
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('single network failure does NOT probe or block', async () => {
    const get = jest.fn();
    const pinning = loadPinning(HTTPS_API, get);
    pinning.reportApiNetworkFailure();
    await flush();
    expect(get).not.toHaveBeenCalled();
    expect(pinning.useNetworkSecurityStore.getState().blocked).toBe(false);
  });

  it('2 failures + probe reachable ⇒ blocked (pin failure signature)', async () => {
    const get = jest.fn().mockResolvedValue({ data: { pinningAdvisory: 'ok' } });
    const pinning = loadPinning(HTTPS_API, get);
    pinning.reportApiNetworkFailure();
    pinning.reportApiNetworkFailure();
    await flush();
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('https://mygaslink.com/pinning-status.json'),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(pinning.useNetworkSecurityStore.getState().blocked).toBe(true);
    expect(pinning.useNetworkSecurityStore.getState().advisory).toBeNull();
  });

  it('incident advisory from the status file is surfaced to the screen', async () => {
    const get = jest.fn().mockResolvedValue({
      data: { pinningAdvisory: 'incident', message: 'Update to v1.3 from the Play Store.' },
    });
    const pinning = loadPinning(HTTPS_API, get);
    pinning.reportApiNetworkFailure();
    pinning.reportApiNetworkFailure();
    await flush();
    expect(pinning.useNetworkSecurityStore.getState().advisory)
      .toBe('Update to v1.3 from the Play Store.');
  });

  it('2 failures + probe ALSO dead ⇒ plain offline, NOT blocked', async () => {
    const get = jest.fn().mockRejectedValue(new Error('Network Error'));
    const pinning = loadPinning(HTTPS_API, get);
    pinning.reportApiNetworkFailure();
    pinning.reportApiNetworkFailure();
    await flush();
    expect(pinning.useNetworkSecurityStore.getState().blocked).toBe(false);
  });

  it('reportApiSuccess resets streak and unblocks', async () => {
    const get = jest.fn().mockResolvedValue({ data: {} });
    const pinning = loadPinning(HTTPS_API, get);
    pinning.reportApiNetworkFailure();
    pinning.reportApiNetworkFailure();
    await flush();
    expect(pinning.useNetworkSecurityStore.getState().blocked).toBe(true);
    pinning.reportApiSuccess();
    expect(pinning.useNetworkSecurityStore.getState().blocked).toBe(false);
  });

  it('disarmed entirely on http dev builds (pinning cannot be the cause)', async () => {
    const get = jest.fn();
    const pinning = loadPinning('http://192.168.1.10:5000/api', get);
    pinning.reportApiNetworkFailure();
    pinning.reportApiNetworkFailure();
    pinning.reportApiNetworkFailure();
    await flush();
    expect(get).not.toHaveBeenCalled();
    expect(pinning.useNetworkSecurityStore.getState().blocked).toBe(false);
  });
});
