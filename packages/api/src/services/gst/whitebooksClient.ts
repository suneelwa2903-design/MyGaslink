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
 * Authenticate with WhiteBooks for e-Invoice API
 * Returns auth token (cached in memory)
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

  // Parse expiry
  let expiresAt = new Date(Date.now() + 14 * 60 * 1000); // Default 14 minutes
  if (json.data?.TokenExpiry) {
    expiresAt = new Date(json.data.TokenExpiry);
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
