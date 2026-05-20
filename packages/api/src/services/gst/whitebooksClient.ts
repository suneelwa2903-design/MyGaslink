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
    return {
      clientId: fallback.clientId,
      clientSecret: fallback.clientSecret,
      username: fallback.username,
      password: fallback.password,
      gstin: fallback.gstin,
      email: fallback.email || 'info@mygaslink.com',
      baseUrl: isSandbox ? SANDBOX_BASE : PROD_BASE,
    };
  }

  const isSandbox = cred.distributor?.gstMode === 'sandbox' || !cred.distributor;
  return {
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
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
  const json = await res.json() as any;

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

  // WI-083 amendment — stale TokenExpiry fallback.
  //
  // WhiteBooks sandbox returns status_cd='Sucess' with a freshly-issued
  // token, but the `TokenExpiry` field echoes a PREVIOUS session's expiry
  // (a caching quirk on their backend). WhiteBooks confirmed: sandbox
  // tokens are valid for 1 hour from issuance regardless of what
  // TokenExpiry says.
  //
  // Original guard (hard SESSION_EXPIRED throw) was too strict: it blocked
  // the valid fresh token because the stale field made it LOOK expired.
  // Fix: when TokenExpiry is in the past, log a warning and fall back to a
  // 55-min window (1 h sandbox lifetime minus 5-min safety margin). If NIC
  // actually rejects the token with 1005 (truly stale), apiCall's retry
  // logic evicts the cache and re-fetches, surfacing the real error.
  //
  // Observed 2026-05-20 dist-002: auth at 18:40 IST returned
  // TokenExpiry="2026-05-20 16:45:00" (1h55m in past) — token itself
  // worked fine on NIC.
  if (expiresAt.getTime() <= Date.now()) {
    logger.warn('WhiteBooks TokenExpiry is in the past; using 55-min fallback (sandbox quirk)', {
      distributorId, scope, tokenExpiry: json.data?.TokenExpiry, nowUtc: new Date().toISOString(),
    });
    expiresAt = new Date(Date.now() + 55 * 60 * 1000);
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
 * The `context` parameter is accepted but unused here — it's only present so
 * call sites that already pass it for the logged path keep typechecking when
 * they accidentally hit this function directly.
 */
export async function apiCall<T = any>(
  distributorId: string | null,
  method: 'GET' | 'POST',
  path: string,
  body?: any,
  scope: 'einvoice' | 'ewaybill' = 'einvoice',
  _context?: ApiCallContext
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

  const json = await res.json() as any;

  const apiSuccess = json.status_cd === '1' || json.status_cd === 1 ||
    json.status_cd === 'Sucess' || json.status_cd === 'Success';
  if (!apiSuccess) {
    // Parse error details — IRN uses status_desc, EWB uses error.message
    let errorCode = '';
    let errorMessage = json.status_desc || json.error?.message || 'Unknown error';

    // Try parsing IRN-style errors from status_desc
    if (typeof json.status_desc === 'string') {
      try {
        const errors = JSON.parse(json.status_desc);
        if (Array.isArray(errors) && errors.length > 0) {
          errorCode = errors[0].ErrorCode || '';
          errorMessage = errors.map((e: any) => `[${e.ErrorCode}] ${e.ErrorMessage}`).join('; ');
        }
      } catch {
        // Not JSON, use as-is
      }
    }

    // Try parsing EWB-style errors from error.message
    if (json.error?.message && typeof json.error.message === 'string') {
      try {
        const errObj = JSON.parse(json.error.message);
        if (errObj.errorCodes) errorCode = String(errObj.errorCodes).replace(/,+$/, '').trim();
        if (errObj.message) errorMessage = errObj.message;
      } catch {
        errorMessage = json.error.message;
      }
      if (json.error.error_cd) errorCode = errorCode || json.error.error_cd;
    }

    logger.error('WhiteBooks API error', { distributorId, url, errorCode, errorMessage, response: json });

    // Handle token expiry - retry once
    if (errorCode === '1004' || errorMessage.includes('token') || errorMessage.includes('Token')) {
      tokenCache.delete(getCacheKey(distributorId, scope));
      // Retry with fresh token
      const newToken = await getAuthToken(distributorId, scope);
      if (newToken !== 'no-token-needed') headers['auth-token'] = newToken;
      const retryRes = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const retryJson = await retryRes.json() as any;
      const retryOk = retryJson.status_cd === '1' || retryJson.status_cd === 1 || retryJson.status_cd === 'Sucess' || retryJson.status_cd === 'Success';
      if (retryOk) {
        return retryJson as T;
      }
    }

    throw new GstError(errorMessage, errorCode || 'API_ERROR', json);
  }

  return json as T;
}

/**
 * Clear cached token for a distributor
 */
export function clearTokenCache(distributorId: string | null) {
  tokenCache.delete(getCacheKey(distributorId, 'einvoice'));
  tokenCache.delete(getCacheKey(distributorId, 'ewaybill'));
}

export class GstError extends Error {
  /**
   * `response` carries the raw NIC JSON body (when available) so the
   * caller-side logger (apiLogger.writeApiLog) can persist exactly what
   * the upstream returned, not just our parsed error_message. This is
   * critical for the generic 5002 case where NIC gives no field hint —
   * we want the un-massaged response body in gst_api_logs.
   */
  constructor(message: string, public code: string, public response?: any) {
    super(message);
    this.name = 'GstError';
  }
}
