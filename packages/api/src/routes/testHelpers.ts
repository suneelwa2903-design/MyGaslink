/**
 * Development / integration-test helper routes.
 *
 * These endpoints let test scripts manipulate server-side state that is
 * normally only accessible inside the process (e.g. the in-memory
 * WhiteBooks token cache). They are mounted ONLY when
 * NODE_ENV !== 'production' — see app.ts.
 *
 * Available endpoints:
 *   POST /test/inject-stale-token   — put an expired entry in the token cache
 *   GET  /test/token-cache-state    — inspect current cache entry
 *
 * DO NOT import this router in production code. DO NOT add business-logic
 * mutations here — only state inspection / injection for test purposes.
 */

import { Router } from 'express';
import { sendSuccess, sendForbidden } from '../utils/apiResponse.js';
import { injectStaleCacheEntry, getCacheEntry } from '../services/gst/whitebooksClient.js';

const router = Router();

/** Runtime guard — belt-and-suspenders on top of the mount-time NODE_ENV check. */
function guardProd(_req: any, res: any, next: () => void) {
  if (process.env.NODE_ENV === 'production') {
    return sendForbidden(res, 'Test helpers are not available in production');
  }
  return next();
}

/**
 * POST /test/inject-stale-token
 * Body: { distributorId?: string | null, scope?: 'einvoice' | 'ewaybill' }
 *
 * Sets a synthetic cache entry with expiresAt 1 hour in the past. The
 * next getAuthToken() call for this (distributorId, scope) will see an
 * expired entry, skip the cache, and call doAuthFetch — exercising the
 * WI-085 stale-token retry path if WhiteBooks also returns a stale expiry.
 */
router.post('/inject-stale-token', guardProd, (req, res) => {
  const { distributorId = null, scope = 'einvoice' } = req.body as {
    distributorId?: string | null;
    scope?: 'einvoice' | 'ewaybill';
  };
  injectStaleCacheEntry(distributorId, scope);
  const entry = getCacheEntry(distributorId, scope);
  return sendSuccess(res, {
    injected: true,
    tokenPrefix: entry ? entry.token.slice(0, 24) + '…' : null,
    expiresAt: entry?.expiresAt?.toISOString() ?? null,
    isStale: entry ? entry.expiresAt.getTime() < Date.now() : false,
  });
});

/**
 * GET /test/token-cache-state
 * Query: ?distributorId=dist-002&scope=einvoice
 *
 * Returns whether there is a cached token and whether it is currently valid
 * (expiresAt > now). Used by test scripts to assert that a stale entry was
 * replaced with a fresh one after a successful re-auth.
 */
router.get('/token-cache-state', guardProd, (req, res) => {
  const distributorId = (req.query.distributorId as string) || null;
  const scope = ((req.query.scope as string) || 'einvoice') as 'einvoice' | 'ewaybill';
  const entry = getCacheEntry(distributorId, scope);
  if (!entry) {
    return sendSuccess(res, { cached: false, isValid: false, isStale: false });
  }
  const now = Date.now();
  return sendSuccess(res, {
    cached: true,
    tokenPrefix: entry.token.slice(0, 24) + '…',
    expiresAt: entry.expiresAt.toISOString(),
    isValid: entry.expiresAt.getTime() > now,
    isStale: entry.expiresAt.getTime() <= now,
  });
});

export default router;
