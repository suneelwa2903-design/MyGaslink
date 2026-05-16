# WI-059 — Deduplicate concurrent auth fetches + pre-warm before parallel preflight

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)

---

## Problem

`runDispatchPreflight` processes N orders concurrently (one `runB2bPreflight`
/ `runB2cPreflight` per order, all kicked off in a `Promise.all`-style fan-out).
Each order's preflight independently calls `apiCall(...)` which in turn
calls `getAuthToken(distributorId, scope)`. On a cold token cache, **every
parallel caller starts its own fetch to `/einvoice/authenticate`**.

Server logs from the 2026-05-16 09:00:28 dispatch confirm the race:
- 4 orders → 4 simultaneous auth requests fired.
- 2 of the 4 fetched OK and received tokens.
- 2 of the 4 came back as `"fetch failed"` after 49 ms and 91 ms — too
  fast for DNS / full TLS; consistent with a connection drop at the
  TLS/TCP layer when several handshakes hit WhiteBooks within a single
  millisecond.

These fetch-level failures bubble straight to the preflight error path,
which bounces the order to `pending_dispatch` with a generic
`UNKNOWN: fetch failed`. The admin sees a misleading "network error"
when in reality our own code was the load source.

A direct `curl` to the same endpoint succeeds every time — proves
WhiteBooks is fine, the failure mode is concurrency-driven on our side.

## Goal

Eliminate the cold-cache stampede:

1. **In-flight promise dedup** inside `getAuthToken`. The first cold-cache
   caller starts a single fetch; concurrent callers within the same
   `(distributorId, scope)` key `await` the same promise. N parallel
   callers → 1 fetch, 1 token.

2. **Pre-warm** the einvoice (and EWB scope when relevant) token once
   inside `runDispatchPreflight` BEFORE the parallel per-order loop
   starts. Belt-and-braces — even if the dedup map were ever bypassed,
   the cache is already hot before any per-order code runs.

3. **Tests** that hammer `getAuthToken` from N concurrent callers and
   assert exactly one underlying fetch fired.

## Scope

### `whitebooksClient.ts`
- Add module-level `authInFlight = new Map<string, Promise<string>>()`.
- Reshape `getAuthToken` flow:
  ```
  cache hit (token + safety margin) → return cached
  in-flight hit for same key       → return the same Promise
  else: build doAuthFetch() Promise,
        store in authInFlight,
        attach `.finally(() => authInFlight.delete(key))`,
        return the Promise.
  ```
- Promise body unchanged from today's logic (parse, cache, retry token-expiry,
  log). Just lifted into a helper so the storage/dedup wrapping is clean.

### `gstPreflightService.ts`
- In `runDispatchPreflight`, immediately after resolving the distributor
  + driver context and before the per-order loop fan-out, call:
  ```ts
  const { getAuthToken } = await import('./whitebooksClient.js');
  try {
    await getAuthToken(distributorId, 'einvoice');
    await getAuthToken(distributorId, 'ewaybill');
  } catch (warmErr) {
    logger.warn('Auth pre-warm failed; per-order calls will retry',
                { distributorId, err: (warmErr as Error).message });
  }
  ```
  Pre-warm errors don't abort the dispatch — per-order calls will surface
  the same failure with their own forensic context.

### Tests — new file `gst-auth-concurrency.test.ts`
- **Dedup:** 10 concurrent `getAuthToken('dist-002', 'einvoice')` calls;
  spy on `global.fetch`; assert exactly **1** call to `/authenticate`;
  assert all 10 resolved tokens identical.
- **Cache hit after pre-warm:** call `getAuthToken` once, then 5 more
  times serially; assert only 1 fetch.
- **Separate keys don't share:** concurrent calls for `einvoice` + `ewaybill`
  scopes must each produce 1 fetch (not collapse into 1).
- **Failure cleanup:** when the auth fetch rejects, the in-flight map
  must release the key so a subsequent retry isn't permanently stuck.

## Out of scope
- Distributed locking across replicas. The dedup is in-process; a
  multi-replica deployment with N replicas can still produce N parallel
  fetches. Acceptable until we go multi-replica.
- Fixing the NIC 5002 errors — that's external and tracked separately.

## Acceptance
- Typecheck clean.
- Vitest ≥ 382 (378 + 4 new).
- Live dispatch retry against the seeded orders: 0 "fetch failed"
  errors. Any remaining failures are NIC-side (5002) which is the
  outstanding WhiteBooks ticket.
