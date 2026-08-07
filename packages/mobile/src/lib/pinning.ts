/**
 * SSL-pinning failure detection (JS side of the N4 pinning feature).
 *
 * The actual pin enforcement is OS-level (see plugins/withSslPinning.js):
 * Android network_security_config pin-set + iOS NSPinnedDomains. When a pin
 * check fails, the OS kills the TLS handshake and the app just sees a
 * generic network error — indistinguishable from being offline.
 *
 * This module adds the missing signal: after repeated network-layer failures
 * against the (pinned) API origin, it probes an UNPINNED, differently-hosted
 * URL — https://mygaslink.com/pinning-status.json, served by CloudFront from
 * packages/web/public/. Three outcomes:
 *
 *   probe fails too      → device is genuinely offline → existing offline
 *                          handling (NetworkIndicator + delivery queue) owns it
 *   probe OK, status ok  → internet up but pinned API unreachable → almost
 *                          certainly a pin failure (MITM box on the network,
 *                          or — worst case — a bad pin set we shipped).
 *                          Show the blocking NetworkSecurityScreen.
 *   probe OK, status has → same, but render the server-provided incident
 *   incident message       message (our "kill-switch" messaging channel; the
 *                          OS pin itself cannot be disabled remotely — an
 *                          incident needs an emergency app release, and this
 *                          message is how we tell stranded users that).
 *
 * Dev builds are exempt twice over: the config plugin no-ops without
 * SSL_PINNING=true, and this module only arms itself when the API base URL
 * is https.
 */
import axios from 'axios';
import { create } from 'zustand';

const PROBE_URL = 'https://mygaslink.com/pinning-status.json';
const FAILURE_THRESHOLD = 2; // consecutive network-layer failures before probing
const PROBE_TIMEOUT_MS = 7_000;

const API_IS_HTTPS = (process.env.EXPO_PUBLIC_API_URL ?? '').startsWith('https://');

interface NetworkSecurityState {
  /** True → render the full-screen NetworkSecurityScreen and block the app. */
  blocked: boolean;
  /** Optional operator-supplied incident message from pinning-status.json. */
  advisory: string | null;
  setBlocked: (blocked: boolean, advisory?: string | null) => void;
}

export const useNetworkSecurityStore = create<NetworkSecurityState>((set) => ({
  blocked: false,
  advisory: null,
  setBlocked: (blocked, advisory = null) => set({ blocked, advisory }),
}));

let consecutiveFailures = 0;
let probeInFlight = false;

/** Call on any successful API response — resets the failure streak and unblocks. */
export function reportApiSuccess(): void {
  consecutiveFailures = 0;
  if (useNetworkSecurityStore.getState().blocked) {
    useNetworkSecurityStore.getState().setBlocked(false);
  }
}

/**
 * Call on an API error that had NO http response (network layer failure).
 * Errors WITH a response (4xx/5xx) mean TLS succeeded — they must not count.
 */
export function reportApiNetworkFailure(): void {
  if (!API_IS_HTTPS) return; // dev/LAN http builds — pinning can't be the cause
  consecutiveFailures += 1;
  if (consecutiveFailures < FAILURE_THRESHOLD || probeInFlight) return;
  void runProbe();
}

/** Exposed for the Retry button: re-checks and unblocks if the API is back. */
export async function retryConnectivity(): Promise<boolean> {
  const base = process.env.EXPO_PUBLIC_API_URL ?? '';
  try {
    await axios.get(`${base}/health`, { timeout: PROBE_TIMEOUT_MS });
    reportApiSuccess();
    return true;
  } catch {
    // API still unreachable — re-evaluate which failure mode we're in.
    consecutiveFailures = FAILURE_THRESHOLD;
    await runProbe();
    return false;
  }
}

async function runProbe(): Promise<void> {
  probeInFlight = true;
  try {
    // Plain axios (not the api instance): different origin, no auth headers,
    // cache-busted so CloudFront can't serve a stale advisory.
    const res = await axios.get<{ pinningAdvisory?: string; message?: string }>(
      `${PROBE_URL}?t=${Date.now()}`,
      { timeout: PROBE_TIMEOUT_MS },
    );
    // Probe reachable ⇒ internet is up, but the pinned API origin is failing
    // at the network layer ⇒ treat as pin failure / interception.
    const advisory =
      res.data?.pinningAdvisory === 'incident' && typeof res.data.message === 'string'
        ? res.data.message
        : null;
    useNetworkSecurityStore.getState().setBlocked(true, advisory);
  } catch {
    // Probe also failed ⇒ plain offline. NetworkIndicator + offline queue
    // already handle that; do nothing here.
  } finally {
    probeInFlight = false;
  }
}
