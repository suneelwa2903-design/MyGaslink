/**
 * WhiteBooks API Client
 * Handles authentication, token caching, and all HTTP calls to WhiteBooks GSP.
 *
 * Two credential sets:
 * 1. GasLink-level (distributorId = null) — for GasLink's own billing
 * 2. Per-distributor — for distributor→customer invoicing
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import type {
  AuthResponse,
  EwbErrorBody,
  NicError,
  WhiteBooksEnvelope,
} from './nicTypes.js';

const SANDBOX_BASE = 'https://apisandbox.whitebooks.in';
const PROD_BASE = 'https://api.whitebooks.in';
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry
const DEFAULT_IP = '127.0.0.1';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // UTC+5:30

/**
 * WI-060 — Parse a WhiteBooks/NIC datetime string as IST regardless of
 * the host process timezone.
 *
 * NIC returns TokenExpiry / AckDt / EwbDt / etc. as naive
 * `YYYY-MM-DD HH:MM:SS` strings with NO timezone suffix. The values are
 * wall-clock IST (NIC infrastructure is in India). The JS `Date()`
 * constructor parses such strings as the host's LOCAL time:
 *
 *   - On an IST host: 09:00:19 IST → correct (03:30:19 UTC)
 *   - On a UTC host:  09:00:19 UTC → 5.5 h AHEAD of the real expiry
 *
 * The UTC case (which is most cloud VMs in default config) would cache
 * a token as valid for 5.5 hours after NIC actually expired it, and
 * every call after real expiry would return NIC's generic 5002 — easy
 * to misdiagnose as a NIC outage when it's our parse. This helper
 * removes the host-TZ dependency entirely by building the absolute
 * UTC instant explicitly from the IST wall-clock parts.
 *
 * Tolerant of both " " and "T" separators (the few different shapes
 * WhiteBooks has returned over time).
 */
export function parseNicDateTime(str: string): Date {
  // If the input carries an explicit timezone — trailing "Z" (UTC) or
  // "+HH:MM" / "-HH:MM" — it's already unambiguous; let JS parse it.
  // The IST-offset trick below is ONLY needed for the naive shape NIC
  // emits ("YYYY-MM-DD HH:MM:SS" with no zone). Mocks and any caller
  // that already passes ISO 8601 should round-trip correctly.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(str)) {
    return new Date(str);
  }
  const [datePart, timePart] = str.split(/[ T]/);
  const [year, month, day] = datePart.split('-').map(Number);
  // The seconds component can be `SS` or `SS.SSS`. Use parseFloat so a
  // fractional value still parses; we drop the fractional millis since
  // NIC only emits whole seconds and the cache safety margin is minutes.
  const [hStr = '0', mStr = '0', sStr = '0'] = (timePart || '0:0:0').split(':');
  const hours = Number(hStr);
  const minutes = Number(mStr);
  const seconds = Math.floor(parseFloat(sStr));
  const utcMs =
    Date.UTC(year, month - 1, day, hours, minutes, seconds) - IST_OFFSET_MS;
  return new Date(utcMs);
}

interface WhiteBooksCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  gstin: string;
  email?: string;
  baseUrl: string;
}

/**
 * Group A — Layer 1 credentials (client_id + client_secret) live in env vars,
 * NOT in the per-distributor gst_credentials table. One pair per scope ×
 * environment, shared by all distributors in the matching mode.
 *
 *   WHITEBOOKS_<einvoice|ewaybill>_<sandbox|prod>_CLIENT_ID
 *   WHITEBOOKS_<einvoice|ewaybill>_<sandbox|prod>_CLIENT_SECRET
 *
 * Returns the credentials if env vars are set. Returns null when sandbox env
 * vars are missing (caller may fall back to DB-stored values for backward
 * compat). Throws NO_PROD_CREDS when live env vars are missing — live mode
 * never falls back to DB.
 */
export function getLayer1Credentials(
  scope: 'einvoice' | 'ewaybill',
  mode: 'sandbox' | 'live',
): { clientId: string; clientSecret: string } | null {
  // Internal mode 'live' maps to externally-named env-var suffix 'PROD' per
  // the Group A spec (human-readable in deploy configs). 'sandbox' → 'SANDBOX'.
  const envSuffix = mode === 'live' ? 'PROD' : 'SANDBOX';
  const prefix = `WHITEBOOKS_${scope.toUpperCase()}_${envSuffix}`;
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }
  if (mode === 'live') {
    throw new GstError(
      'Production WhiteBooks credentials not configured. Contact platform admin.',
      'NO_PROD_CREDS',
    );
  }
  return null;
}

interface CachedToken {
  token: string;
  expiresAt: Date;
  scope: 'einvoice' | 'ewaybill';
}

// In-memory token cache (per distributor + scope)
const tokenCache = new Map<string, CachedToken>();

// WI-059: in-flight auth promise dedup. When N parallel callers ask
// for a token on a cold cache, only ONE underlying /authenticate
// request hits WhiteBooks — the others `await` the same promise.
//
// Without this, runDispatchPreflight kicked off N concurrent
// auth fetches and 1-2 of them got dropped at the TLS layer by
// WhiteBooks with a generic "fetch failed", bouncing orders back
// to pending_dispatch. See logs from 2026-05-16 09:00:28 IST and
// spec at [.session/specs/WI-059-auth-concurrency-dedup.md].
//
// Entry is set BEFORE the fetch begins and cleared in `.finally()` so
// a rejected fetch doesn't permanently lock the key.
const authInFlight = new Map<string, Promise<string>>();

function getCacheKey(distributorId: string | null, scope: string): string {
  return `${distributorId || 'gaslink'}_${scope}`;
}

/**
 * Get WhiteBooks credentials for a distributor (or GasLink-level if null)
 */
export async function getCredentials(distributorId: string | null, scope: 'einvoice' | 'ewaybill' = 'einvoice'): Promise<WhiteBooksCredentials | null> {
  const cred = await prisma.gstCredential.findFirst({
    where: { distributorId, scope },
    include: { distributor: { select: { gstMode: true } } },
  });
  if (!cred) {
    // Fallback: try the other scope's credentials (some distributors may use same creds for both)
    const fallback = await prisma.gstCredential.findFirst({
      where: { distributorId },
      include: { distributor: { select: { gstMode: true } } },
    });
    if (!fallback) return null;
    const isSandbox = fallback.distributor?.gstMode === 'sandbox' || !fallback.distributor;
    const authMode: 'sandbox' | 'live' = isSandbox ? 'sandbox' : 'live';
    // Group A: env-first Layer 1, DB fallback only in sandbox.
    const layer1 = getLayer1Credentials(scope, authMode);
    return {
      clientId: layer1?.clientId ?? fallback.clientId,
      clientSecret: layer1?.clientSecret ?? fallback.clientSecret,
      username: fallback.username,
      password: fallback.password,
      gstin: fallback.gstin,
      email: fallback.email || 'info@mygaslink.com',
      baseUrl: isSandbox ? SANDBOX_BASE : PROD_BASE,
    };
  }

  const isSandbox = cred.distributor?.gstMode === 'sandbox' || !cred.distributor;
  const authMode: 'sandbox' | 'live' = isSandbox ? 'sandbox' : 'live';
  // Group A: env-first Layer 1, DB fallback only in sandbox.
  const layer1 = getLayer1Credentials(scope, authMode);
  return {
    clientId: layer1?.clientId ?? cred.clientId,
    clientSecret: layer1?.clientSecret ?? cred.clientSecret,
    username: cred.username,
    password: cred.password,
    gstin: cred.gstin,
    email: cred.email || 'info@mygaslink.com',
    baseUrl: isSandbox ? SANDBOX_BASE : PROD_BASE,
  };
}

/**
 * Authenticate with WhiteBooks for e-Invoice / EWB API.
 *
 * Returns the auth token (cached in memory). WI-059 adds in-flight
 * promise dedup: concurrent callers for the same `(distributorId, scope)`
 * share one underlying `/authenticate` request instead of stampeding
 * WhiteBooks with N parallel TLS handshakes — see the comment on
 * `authInFlight` above for context.
 */
export async function getAuthToken(
  distributorId: string | null,
  scope: 'einvoice' | 'ewaybill' = 'einvoice'
): Promise<string> {
  const cacheKey = getCacheKey(distributorId, scope);
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresAt.getTime() > Date.now() + TOKEN_SAFETY_MARGIN_MS) {
    return cached.token;
  }

  // Dedup: if another caller is already fetching this key, await its
  // Promise. This is the single source of the "fetch failed" elimination —
  // without it, 4 parallel preflight orders → 4 parallel TLS handshakes,
  // and 1-2 of them got dropped by WhiteBooks on cold cache.
  const inFlight = authInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const fetchPromise = doAuthFetch(distributorId, scope, cacheKey)
    // Always release the slot when the promise settles. Without this a
    // rejected fetch would permanently lock the key for this process.
    .finally(() => {
      authInFlight.delete(cacheKey);
    });

  authInFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * The body of the WhiteBooks `/authenticate` call. Split out from
 * `getAuthToken` so the public function can wrap it in the in-flight
 * dedup map without bloating the cache-hit fast path.
 */
async function doAuthFetch(
  distributorId: string | null,
  scope: 'einvoice' | 'ewaybill',
  cacheKey: string,
  isRetry = false,
): Promise<string> {
  const creds = await getCredentials(distributorId, scope);
  if (!creds) throw new GstError('GST credentials not configured', 'NO_CREDENTIALS');

  const emailParam = encodeURIComponent(creds.email || 'info@mygaslink.com');
  let endpoint: string;
  let headers: Record<string, string>;

  if (scope === 'einvoice') {
    // IRN auth: username + password in HEADERS
    endpoint = `/einvoice/authenticate?email=${emailParam}`;
    headers = {
      'username': creds.username,
      'password': creds.password || creds.clientSecret,
      'ip_address': DEFAULT_IP,
      'client_id': creds.clientId,
      'gstin': creds.gstin,
      'Accept': 'application/json',
    };
    if (creds.clientSecret) headers['client_secret'] = creds.clientSecret;
  } else {
    // EWB auth: username + password in QUERY PARAMS (not headers)
    const ewbParams = new URLSearchParams({
      email: creds.email || 'info@mygaslink.com',
      username: creds.username,
      password: creds.password || creds.clientSecret,
    });
    endpoint = `/ewaybillapi/v1.03/authenticate?${ewbParams.toString()}`;
    headers = {
      'ip_address': DEFAULT_IP,
      'client_id': creds.clientId,
      'gstin': creds.gstin,
      'Accept': 'application/json',
    };
    if (creds.clientSecret) headers['client_secret'] = creds.clientSecret;
  }

  logger.info('WhiteBooks auth request', { distributorId, scope, url: `${creds.baseUrl}${endpoint}` });

  const res = await fetch(`${creds.baseUrl}${endpoint}`, { method: 'GET', headers });
  const json = await res.json() as AuthResponse;

  // WhiteBooks returns "Sucess" (their typo) or "1" for success
  const isSuccess = json.status_cd === '1' || json.status_cd === 1 ||
    json.status_cd === 'Sucess' || json.status_cd === 'Success';
  if (!isSuccess) {
    logger.error('WhiteBooks auth failed', { distributorId, scope, response: json });
    throw new GstError(`WhiteBooks authentication failed: ${json.status_desc || 'Unknown error'}`, 'AUTH_FAILED');
  }

  const token = json.data?.AuthToken || json.data?.authtoken;
  if (!token) {
    // EWB may not return a token (credentials validated only)
    if (scope === 'ewaybill') return 'no-token-needed';
    throw new GstError('No auth token in response', 'AUTH_FAILED');
  }

  // Parse expiry.
  //
  // WI-060: fallback widened from 14 min → 28 min. WhiteBooks support
  // confirmed the token lifetime is 30 min, and we already re-auth
  // 5 min before expiry (TOKEN_SAFETY_MARGIN_MS). A 14-min fallback
  // forced unnecessary re-auths every ~9 min when the upstream
  // happened to omit TokenExpiry (observed occasionally). 28 keeps a
  // 2-min cushion under the documented 30-min cap.
  //
  // TokenExpiry parsing goes through parseNicDateTime so the result is
  // correct on UTC production hosts. Plain `new Date(naiveStr)` is
  // host-TZ-dependent — see the helper's docstring for the failure mode.
  let expiresAt = new Date(Date.now() + 28 * 60 * 1000);
  if (json.data?.TokenExpiry) {
    expiresAt = parseNicDateTime(json.data.TokenExpiry);
  }

  // WI-085 — stale TokenExpiry: retry-once, then 55-min fallback.
  //
  // WhiteBooks sandbox consistently returns status_cd='Sucess' with a
  // freshly-issued token BUT with a TokenExpiry that echoes a PREVIOUS
  // session's expiry (confirmed by WhiteBooks support 2026-05-20:
  // "authtoken is generating right — in sandbox authtoken is valid for
  // 1 hour"). Their backend caches the expiry field independently of
  // the token string, so the field is unreliable on sandbox.
  //
  // WI-085 approach (hybrid):
  //   1. First stale TokenExpiry: evict cache and retry auth once.
  //      On a healthy production backend the retry returns a valid expiry
  //      (the quirk is only a transient/sandbox phenomenon).
  //   2. Retry also stale: accept the token with a 55-min window.
  //      WhiteBooks confirmed the token IS valid for 1 hour from issuance
  //      regardless of what the field says. If NIC actually rejects the
  //      token later (error 1004/1005), apiCall's same-token guard will
  //      surface SESSION_EXPIRED at that point — the right place.
  //
  // isRetry=true prevents infinite recursion: the second doAuthFetch
  // call passes true so the stale branch takes the fallback path.
  if (expiresAt.getTime() <= Date.now()) {
    if (isRetry) {
      // Retry also returned stale TokenExpiry (WhiteBooks sandbox quirk
      // confirmed persistent). Token itself is valid — use 55-min window.
      logger.warn(
        'WhiteBooks returned stale TokenExpiry on retry — using 55-min fallback ' +
        '(WB support confirmed tokens valid 1h from issuance regardless of TokenExpiry field)',
        { distributorId, scope, tokenExpiry: json.data?.TokenExpiry, nowUtc: new Date().toISOString() },
      );
      expiresAt = new Date(Date.now() + 55 * 60 * 1000);
    } else {
      // First call stale — evict cache and retry once to get a fresh token.
      logger.warn('WhiteBooks TokenExpiry is in the past; retrying auth once to get fresh token', {
        distributorId, scope, tokenExpiry: json.data?.TokenExpiry, nowUtc: new Date().toISOString(),
      });
      tokenCache.delete(cacheKey);
      return doAuthFetch(distributorId, scope, cacheKey, true);
    }
  }

  tokenCache.set(cacheKey, { token, expiresAt, scope });

  // Also cache in DB for recovery
  await prisma.gstCredential.updateMany({
    where: { distributorId },
    data: { tokenCache: token, tokenExpiresAt: expiresAt, isValid: true, lastValidated: new Date() },
  });

  logger.info('WhiteBooks auth success', { distributorId, scope, expiresAt: expiresAt.toISOString() });
  return token;
}

/**
 * Optional per-call context. Used by the gst_api_logs caller-side wrapper
 * ([apiLogger.ts](./apiLogger.ts)) so that every outgoing WhiteBooks call is
 * forensically traceable to an invoice/order regardless of which code path
 * triggered it.
 *
 * apiType examples: IRN_GENERATE, IRN_CANCEL, EWB_GENERATE_BY_IRN,
 * EWB_GENERATE_STANDALONE, EWB_CANCEL, GSTIN_LOOKUP, EWB_RECOVER.
 *
 * Logging itself happens in `loggedApiCall` (apiLogger.ts), NOT here — that
 * keeps `apiCall` mockable in the test suite without losing audit coverage.
 */
export interface ApiCallContext {
  apiType?: string;
  invoiceId?: string | null;
  orderId?: string | null;
}

/**
 * Make an authenticated API call to WhiteBooks. Most callers should go
 * through `loggedApiCall` ([apiLogger.ts](./apiLogger.ts)) instead, which
 * wraps this and writes a `gst_api_logs` row on success AND failure
 * (Anti-pattern #11).
 *
 * WI-090: `context.apiType` is now read to distinguish CANCEL calls from
 * dispatch (GENERATE). The same-token guard below short-circuits only for
 * non-cancel calls; cancel calls always retry the real NIC call (see the
 * comment on the guard).
 */
export async function apiCall<T = unknown>(
  distributorId: string | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  scope: 'einvoice' | 'ewaybill' = 'einvoice',
  context?: ApiCallContext
): Promise<T> {
  const creds = await getCredentials(distributorId, scope);
  if (!creds) throw new GstError('GST credentials not configured', 'NO_CREDENTIALS');

  const token = await getAuthToken(distributorId, scope);

  const headers: Record<string, string> = {
    'ip_address': DEFAULT_IP,
    'client_id': creds.clientId,
    'gstin': creds.gstin,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (creds.clientSecret) headers['client_secret'] = creds.clientSecret;
  if (token !== 'no-token-needed') headers['auth-token'] = token;
  if (scope === 'einvoice') headers['username'] = creds.username;

  const url = `${creds.baseUrl}${path}`;
  logger.info('WhiteBooks API call', { distributorId, method, url, scope });

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json() as WhiteBooksEnvelope;

  const apiSuccess = json.status_cd === '1' || json.status_cd === 1 ||
    json.status_cd === 'Sucess' || json.status_cd === 'Success';
  if (!apiSuccess) {
    // Parse error details — IRN uses status_desc, EWB uses error.message
    let errorCode = '';
    let errorMessage = json.status_desc || json.error?.message || 'Unknown error';

    // Try parsing IRN-style errors from status_desc
    if (typeof json.status_desc === 'string') {
      try {
        const errors = JSON.parse(json.status_desc) as NicError[];
        if (Array.isArray(errors) && errors.length > 0) {
          errorCode = errors[0].ErrorCode || '';
          errorMessage = errors.map((e) => `[${e.ErrorCode}] ${e.ErrorMessage}`).join('; ');
        }
      } catch {
        // Not JSON, use as-is
      }
    }

    // Try parsing EWB-style errors from error.message
    if (json.error?.message && typeof json.error.message === 'string') {
      try {
        const errObj = JSON.parse(json.error.message) as EwbErrorBody;
        if (errObj.errorCodes) errorCode = String(errObj.errorCodes).replace(/,+$/, '').trim();
        if (errObj.message) errorMessage = errObj.message;
      } catch {
        errorMessage = json.error.message;
      }
      if (json.error.error_cd) errorCode = errorCode || json.error.error_cd;
    }

    logger.error('WhiteBooks API error', { distributorId, url, errorCode, errorMessage, response: json });

    // Handle token expiry - retry once with a fresh token.
    //
    // WI-090: WhiteBooks pins ONE auth token per session window and returns
    // that SAME string on every re-auth — even when the NIC session is
    // perfectly healthy. Proven live by scripts/probe-nic-session.ts:
    // immediate AND 60s-delayed re-auth both returned the identical token,
    // and GSTNDETAILS + a direct IRN CANCEL both succeeded with it. So
    // "newToken === token" does NOT mean the NIC session is dead — it's just
    // WhiteBooks' normal token-pinning behaviour. The old guard treated the
    // two as equivalent and short-circuited EVERY 1004/1005 to SESSION_EXPIRED.
    //
    //   - For DISPATCH (IRN_GENERATE) we KEEP the conservative short-circuit:
    //     re-issuing GENERATE with a token NIC just rejected risks a duplicate
    //     IRN, and dispatch bounces the order back to pending_dispatch cleanly
    //     anyway (bug #14 — the "1005 looped forever" fix).
    //
    //   - For CANCEL (IRN_CANCEL) we MUST NOT short-circuit. Cancel is a single,
    //     targeted, idempotent-ish op (re-cancelling an already-cancelled IRN
    //     returns a benign error, never corruption). The old guard threw
    //     SESSION_EXPIRED *before sending the cancel to NIC*, stranding the IRN
    //     live at NIC with responsePayload=NULL in gst_api_logs (WI-089
    //     forensics). Instead we always retry the cancel against NIC with the
    //     pinned token: it succeeds whenever the einvoice session is healthy
    //     (the common case — the outage is intermittent and self-heals), and
    //     when NIC genuinely rejects it again we surface the REAL NIC response
    //     body so the failure is diagnosable (no more NULL payload).
    if (errorCode === '1004' || errorCode === '1005' || errorMessage.includes('token') || errorMessage.includes('Token')) {
      tokenCache.delete(getCacheKey(distributorId, scope));
      const newToken = await getAuthToken(distributorId, scope);

      const isCancel = context?.apiType === 'IRN_CANCEL' || context?.apiType === 'EWB_CANCEL';

      if (newToken === token && token !== 'no-token-needed' && !isCancel) {
        // Dispatch / non-cancel path: WhiteBooks served the same pinned token.
        // Don't burn a duplicate GENERATE — surface SESSION_EXPIRED.
        logger.warn('WhiteBooks returned same token after 1005 eviction — NIC session stale (non-cancel path)', {
          distributorId, scope, errorCode, apiType: context?.apiType,
        });
        throw new GstError(
          'NIC session expired on WhiteBooks\' end. Please go to Settings → GST → Test Connection to re-validate, then retry dispatch.',
          'SESSION_EXPIRED',
          json,  // WI-091: persist the original NIC 1004/1005 body to gst_api_logs (was responsePayload=null)
        );
      }

      if (isCancel && newToken === token) {
        logger.warn('Cancel hit 1004/1005; retrying CANCEL against NIC with pinned token (WI-090)', {
          distributorId, scope, errorCode, apiType: context?.apiType,
        });
      }

      if (newToken !== 'no-token-needed') headers['auth-token'] = newToken;
      const retryRes = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const retryJson = await retryRes.json() as WhiteBooksEnvelope;
      const retryOk = retryJson.status_cd === '1' || retryJson.status_cd === 1 || retryJson.status_cd === 'Sucess' || retryJson.status_cd === 'Success';
      if (retryOk) {
        return retryJson as T;
      }

      // Retry also failed. Parse the retry error so the thrown GstError carries
      // the REAL NIC response (responsePayload in gst_api_logs is no longer NULL).
      let retryCode = '';
      let retryMsg = retryJson.status_desc || retryJson.error?.message || errorMessage;
      if (typeof retryJson.status_desc === 'string') {
        try {
          const errs = JSON.parse(retryJson.status_desc) as NicError[];
          if (Array.isArray(errs) && errs.length > 0) {
            retryCode = errs[0].ErrorCode || '';
            retryMsg = errs.map((e) => `[${e.ErrorCode}] ${e.ErrorMessage}`).join('; ');
          }
        } catch { /* not JSON */ }
      }
      const stillTokenErr = retryCode === '1004' || retryCode === '1005' || /token/i.test(retryMsg);
      if (isCancel && stillTokenErr) {
        // NIC rejected the cancel TWICE with a token error → the einvoice NIC
        // session really is in a dead window (WI-089). Surface SESSION_EXPIRED,
        // but WITH the raw NIC body so a side-by-side diff is possible.
        throw new GstError(
          'NIC e-invoice session is temporarily down on WhiteBooks\' end — cancel was rejected after re-auth. Retry in a few minutes via the invoice\'s Retry Cancel action.',
          'SESSION_EXPIRED',
          retryJson,
        );
      }
      throw new GstError(retryMsg, retryCode || 'API_ERROR', retryJson);
    }

    throw new GstError(errorMessage, errorCode || 'API_ERROR', json);
  }

  return json as T;
}

/**
 * WI-091 — read-only NIC e-invoice session health check.
 *
 * Does ONE GSTNDETAILS lookup on the given GSTIN. Resolves if NIC accepts the
 * (pinned) token; throws GstError (SESSION_EXPIRED / 1005) when the einvoice
 * session is in a dead window. The pre-dispatch probe (gstPreflightService)
 * uses this to fail fast before the order loop. Routed as its OWN exported
 * function (not an inline apiCall in the preflight service) so the integration
 * tests can mock this single seam without disturbing their ordered IRN/EWB
 * apiCall mock chains. Goes through apiCall, so a success also warms the
 * einvoice token cache for the dispatch loop that follows.
 */
const PROBE_MAX_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 2000;

export async function pingEinvoiceSession(distributorId: string | null, gstin: string): Promise<void> {
  const creds = await getCredentials(distributorId, 'einvoice');
  const email = encodeURIComponent(creds?.email || 'info@mygaslink.com');

  // WI-091b — bounded retry to ride through the NIC sandbox flicker.
  // Flicker profile (2026-05-22, dist-002, 4 min @3s): NIC e-Invoice is up
  // ~93.8% of the time, dead blips are ≤6s, flips every ~30s. A single-shot
  // probe fails on the FIRST blip while a human in the WhiteBooks UI just
  // retries until a green window. So we do the same: up to 3 attempts, 2s
  // apart, evicting the token cache before EACH attempt to force a fresh auth
  // (re-establishes the NIC session). Any attempt succeeding ⇒ NIC is alive,
  // return normally. All 3 failing ⇒ a genuine outage (or a >~6s dead window)
  // ⇒ re-throw; probeNicEinvoiceSession maps that to PreflightError 503.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    clearTokenCache(distributorId); // fresh auth on every attempt
    try {
      await apiCall<WhiteBooksEnvelope>(
        distributorId, 'GET',
        `/einvoice/type/GSTNDETAILS/version/V1_03?param1=${gstin}&email=${email}`,
        undefined, 'einvoice',
        { apiType: 'NIC_HEALTH_PROBE' },
      );
      return; // alive — probe passed
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < PROBE_MAX_ATTEMPTS) {
        const code = err instanceof GstError ? err.code : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`NIC health probe attempt ${attempt}/${PROBE_MAX_ATTEMPTS} failed, retrying in 2s`, {
          distributorId, code, msg,
        });
        await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr; // all attempts failed — caller converts to PreflightError 503
}

/**
 * Clear cached token for a distributor
 */
export function clearTokenCache(distributorId: string | null) {
  tokenCache.delete(getCacheKey(distributorId, 'einvoice'));
  tokenCache.delete(getCacheKey(distributorId, 'ewaybill'));
}

// ─── Test helpers (dev / script use only — never call from production code) ───

/**
 * Inject a synthetic cache entry with an already-expired token.
 * Allows integration test scripts to force the stale-token re-auth path
 * without waiting for WhiteBooks to naturally return a stale TokenExpiry.
 *
 * Exposed via POST /test/inject-stale-token (mounted in non-production only).
 * NEVER import or call this from application code.
 */
export function injectStaleCacheEntry(
  distributorId: string | null,
  scope: 'einvoice' | 'ewaybill',
): void {
  tokenCache.set(getCacheKey(distributorId, scope), {
    token: `STALE_TEST_TOKEN_${Date.now()}`,
    expiresAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour in the past
    scope,
  });
}

/**
 * Read the current in-memory cache entry (token prefix + expiry) for a
 * given scope. For use by test endpoints that assert post-auth state.
 *
 * Exposed via GET /test/token-cache-state (mounted in non-production only).
 * NEVER import or call this from application code.
 */
export function getCacheEntry(
  distributorId: string | null,
  scope: 'einvoice' | 'ewaybill',
): { token: string; expiresAt: Date; scope: string } | undefined {
  return tokenCache.get(getCacheKey(distributorId, scope));
}

export class GstError extends Error {
  /**
   * `response` carries the raw NIC JSON body (when available) so the
   * caller-side logger (apiLogger.writeApiLog) can persist exactly what
   * the upstream returned, not just our parsed error_message. This is
   * critical for the generic 5002 case where NIC gives no field hint —
   * we want the un-massaged response body in gst_api_logs.
   */
  constructor(message: string, public code: string, public response?: unknown) {
    super(message);
    this.name = 'GstError';
  }
}
