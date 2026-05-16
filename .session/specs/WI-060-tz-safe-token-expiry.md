# WI-060 — TZ-safe parsing of WhiteBooks TokenExpiry

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)

---

## Problem

WhiteBooks returns `TokenExpiry` as a naive datetime string with NO
timezone suffix:

```json
"TokenExpiry": "2026-05-16 09:00:19"
```

That string is wall-clock IST (WhiteBooks / NIC servers are in India).

Our code parses it with the JS Date constructor:

```ts
expiresAt = new Date(json.data.TokenExpiry);
```

`new Date(<naive-datetime-string>)` interprets the value as **the host
process's local timezone** (`process.env.TZ` or OS default). The
behaviour diverges between deployments:

| Host TZ | `new Date("2026-05-16 09:00:19")` interprets as | Stored UTC |
|---|---|---|
| IST (dev box) | 09:00:19 IST | 03:30:19 UTC ✅ |
| UTC (most cloud VMs) | 09:00:19 UTC | 09:00:19 UTC ❌ |

On a UTC host the cache thinks the token is valid for **5.5 hours
longer** than reality. From minute 30 (real expiry) to minute 360
(fake expiry), every call uses a NIC-expired token and returns
`5002 Application error` — same generic NIC catch-all as today's
unrelated IRP outage. We'd spend hours misdiagnosing it as a NIC
problem when it's our TZ parse.

Production deployments are typically UTC. The dev box is IST so this
isn't biting us today — but it's a guaranteed-to-bite landmine on the
first prod deploy. Fix before any cloud host runs this code.

## Fix

### A. New helper `parseNicDateTime`

In `whitebooksClient.ts`:

```ts
/**
 * WhiteBooks returns NIC datetime strings as naive `YYYY-MM-DD HH:MM:SS`
 * with no timezone suffix. The values are wall-clock IST (NIC servers
 * are in India). Parse them EXPLICITLY as IST so the resulting Date
 * object is correct regardless of the host process's local timezone.
 *
 * Without this, a UTC production host parses "2026-05-16 09:00:19" as
 * 09:00:19 UTC = 14:30:19 IST — 5.5 hours AHEAD of the real expiry.
 * The cached token then appears valid long after NIC has expired it,
 * and every API call returns 5002 (NIC's generic catch-all for any
 * expired/invalid auth state). See WI-060.
 */
export function parseNicDateTime(str: string): Date {
  // Tolerant of ISO separator ("T") too.
  const [datePart, timePart] = str.split(/[ T]/);
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes, seconds] = (timePart || '00:00:00')
    .split(':').map(Number);
  // IST = UTC + 5:30. Build the absolute UTC instant explicitly.
  const utcMs =
    Date.UTC(year, month - 1, day, hours, minutes, seconds) -
    (5 * 60 + 30) * 60 * 1000;
  return new Date(utcMs);
}
```

### B. Use the helper at the call site

Replace:
```ts
expiresAt = new Date(json.data.TokenExpiry);
```
with:
```ts
expiresAt = parseNicDateTime(json.data.TokenExpiry);
```

### C. Widen the fallback from 14 → 28 minutes

WhiteBooks confirmed the token is good for 30 minutes. 14 was overly
conservative for the case where the response omits TokenExpiry (rare
but observed). 28 keeps a 2-minute safety margin under the documented
30-min cap (which combined with the existing 5-minute pre-expiry
re-auth window still keeps us safely refreshing before any real expiry).

```ts
// Fallback when TokenExpiry is missing — 28 min keeps a 2 min margin
// under the documented 30 min WhiteBooks token lifetime.
let expiresAt = new Date(Date.now() + 28 * 60 * 1000);
```

## Tests

New file `gst-token-expiry.test.ts`:

1. **`parseNicDateTime` produces correct UTC.** Input `"2026-05-16 09:00:19"`,
   expected `.toISOString() === "2026-05-16T03:30:19.000Z"`.
2. **`parseNicDateTime` is TZ-independent.** Temporarily mutate the
   process timezone via `Intl.DateTimeFormat` check (or document that
   the helper uses `Date.UTC` so it's TZ-immune by construction);
   asserts a UTC-host parse equals an IST-host parse for the same input.
3. **Token cache uses the parsed expiry.** Mock the auth fetch to
   return `TokenExpiry: "2026-05-16 09:00:19"`; call `getAuthToken`;
   assert the cached expiry equals `parseNicDateTime("2026-05-16 09:00:19")`.
4. **Fallback is ~28 minutes.** Mock auth response with NO TokenExpiry;
   assert the cached expiry is within ±2 seconds of `now + 28 min`.

## Acceptance
- Typecheck clean.
- Vitest ≥ 388 (384 + 4 new).
- TZ-independence test passes regardless of host TZ.
