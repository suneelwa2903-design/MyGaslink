# WI-058 — Tenant isolation in `lookupGstin` + test cleanup

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)

---

## Problem

[`gstinLookup.ts`](../packages/api/src/services/gst/gstinLookup.ts) at
line 131:

```ts
const fallbackCred = await prisma.gstCredential.findFirst({
  where: { scope: 'einvoice' },        // ← NO tenant filter
  include: { distributor: ... },        // ← no orderBy
});
```

Three failure paths converge here:

1. **Anti-pattern #1 violation.** Multi-tenant convention says every
   query on a tenant-scoped table MUST filter by `distributorId`. This
   one doesn't.
2. **Non-deterministic order.** Prisma's `findFirst` with no `orderBy`
   returns rows in implementation-defined order. In Postgres that's
   usually insertion / heap order — so the test-leaked dist-001 row
   wins the race against the real dist-002 row.
3. **No `isValid` / `email` filter.** Even with a tenant filter, the
   fallback would happily pick an invalid row (no email, never validated).

**The real-world consequence on 2026-05-16:**
- A test row was leaked into dist-001 by `settings.test.ts` (no
  `afterAll` cleanup).
- Every Sharma admin's GSTIN lookup picked that row, used its bogus
  `client_id=test-client-id` + fallback email `info@mygaslink.com`,
  and hit **production** WhiteBooks because dist-001's `gst_mode='disabled'`
  evaluates `isSandbox=false`.
- Production WhiteBooks returns `"This email is not registered"`.
- We spent ~24h believing WhiteBooks had suspended both accounts.
  Both accounts were healthy the whole time.

## Fix

### A. `lookupGstin` takes a `distributorId` and filters by it
```ts
export async function lookupGstin(
  gstin: string,
  distributorId: string,
): Promise<GstinDetails> {
  // Prefer the caller's own credentials.
  let creds = await getCredentials(distributorId, 'einvoice');
  let credDistributorId: string | null = distributorId;

  if (!creds) {
    // Fall back to any VALID einvoice credential — but only when the
    // caller's own row is missing. Deterministic order + reject bogus
    // rows (NULL email, isValid=false) so a leaked test row can't
    // hijack the call.
    const fallbackCred = await prisma.gstCredential.findFirst({
      where: {
        scope: 'einvoice',
        isValid: true,
        email: { not: null },
      },
      orderBy: { lastValidated: 'desc' },
      include: { distributor: { select: { id: true, gstMode: true } } },
    });
    if (!fallbackCred) {
      throw new GstError(
        'No GST credentials configured for this distributor. Please set them up in Settings.',
        'NO_CREDENTIALS',
      );
    }
    credDistributorId = fallbackCred.distributorId;
    ...
  }
  ...
}
```

The fallback is still kept (rare super-admin cross-tenant case) but
hardened: must be `isValid=true`, `email` not null, ordered by most
recently validated. A leaked bogus row can't win.

### B. Route passes `req.user.distributorId`

[`distributors.ts`](../packages/api/src/routes/distributors.ts) gstin-lookup
handler:
```ts
const details = await lookupGstin(gstin, req.user!.distributorId!);
```

Web's customer-form GSTIN autofill already runs under an authenticated
admin/finance/inventory user so `req.user.distributorId` is always set.

### C. `settings.test.ts` cleans up its dist-001 row
```ts
afterAll(async () => {
  await prisma.gstCredential.deleteMany({
    where: {
      distributorId: distId,
      clientId: validShape.clientId,
    },
  });
  // Belt-and-braces: also delete any row left over from prior runs
  // that didn't clean up (anti-pattern #2 / shared-DB).
  await prisma.gstCredential.deleteMany({
    where: { clientId: { startsWith: 'TEST-CLIENT' } },
  });
});
```

### D. CLAUDE.md anti-pattern #13

The codebase already has 12 anti-patterns. Add #13 (numbering keeps
moving forward — the spec called it "#12" but #12 is already taken by
the EWB-error/IRN-status overwrite bug):

> **13. Tenant-scoped Prisma queries without an explicit `distributorId`
> filter.** Multi-tenant convention is the only line of defence
> (anti-pattern #1 stated it generally; this one calls out the specific
> trap of `findFirst({ where: { ... } })` with no `distributorId`).
> `lookupGstin` violated this — a `findFirst` for `{ scope: 'einvoice' }`
> picked a test-leaked dist-001 row and routed every Sharma admin's
> GSTIN lookup through production WhiteBooks with bogus credentials.
> Cost: a full day of false "WhiteBooks suspended both accounts"
> diagnosis before we ran a direct curl and saw the live account was
> healthy. **Rule:** every `prisma.gstCredential.*` query (and any
> other tenant-scoped table) MUST include `distributorId` in its
> `where`. The only exception is super-admin-level fallback paths,
> which must additionally include `isValid: true`, exclude NULL keys
> the API depends on (e.g. `email`), and use a deterministic `orderBy`
> so the result is reproducible.

## Tests

- `anti-pattern-guards.test.ts` (new guard): seed credential rows for
  both dist-001 and dist-002; call `lookupGstin('29AAGCB1286Q000', 'dist-002')`;
  assert the fetched URL used dist-002's credentials (mock fetch);
  cleanup both rows.
- `anti-pattern-guards.test.ts` (new guard): seed a credential row with
  `isValid=false` for dist-001 and no row for dist-002; call
  `lookupGstin('...', 'dist-002')`; assert NO_CREDENTIALS thrown (the
  fallback skips invalid rows; never silently hijacks).
- `settings.test.ts`: existing `afterAll` already deletes the test row
  via specific clientId; tighten to also catch `TEST-CLIENT*` prefixes
  from older runs.

## Acceptance

- Typecheck clean (api + shared + web).
- Vitest ≥ 378 (376 + 2).
- After the fix + cleanup, `GET /api/distributors/gstin-lookup/29AAGCB1286Q000`
  as a Sharma admin returns 200 with the real GSTIN details.
