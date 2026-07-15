# iOS Account Deletion — Specification (request-and-queue, v1.0 + v1.1)

**Status:** SPEC (no code yet)
**Author:** Claude (Opus 4.7)
**Date:** 2026-06-08 (rewritten 2026-06-08 — split into v1.0 / v1.1)
**Owner:** Suneel
**Target:** Mobile (iOS App Store + Google Play) + API
**Estimate:** ~5.5 working days total — **v1.0 ≈ 2 days (iOS ship-blocker)**, **v1.1 ≈ 3.5 days (must land within 25 days of v1.0)**. See §12.

---

## 1. Problem statement + legal landscape

### 1.1 What we have today

The current implementation ([packages/mobile/src/components/DeleteAccountButton.tsx](../packages/mobile/src/components/DeleteAccountButton.tsx)) is a `mailto:info@mygaslink.com` link with a pre-filled subject + body. The user is told their request "will be processed within 30 days." This is wired into:

- [packages/mobile/app/(admin)/more.tsx](../packages/mobile/app/(admin)/more.tsx)
- [packages/mobile/app/(super-admin)/settings.tsx](../packages/mobile/app/(super-admin)/settings.tsx)
- [packages/mobile/app/(customer)/account.tsx](../packages/mobile/app/(customer)/account.tsx)
- [packages/mobile/app/(driver)/profile.tsx](../packages/mobile/app/(driver)/profile.tsx)
- [packages/mobile/app/(finance)/profile.tsx](../packages/mobile/app/(finance)/profile.tsx)
- [packages/mobile/app/(inventory)/profile.tsx](../packages/mobile/app/(inventory)/profile.tsx)

This was acceptable for Google Play under the "off-app deletion path is allowed if disclosed" rule. **It is NOT acceptable for Apple.**

### 1.2 Apple App Store Review Guideline 5.1.1(v) — verbatim

> "Apps that support account creation must also offer account deletion within the app. […] Deleting an account should completely delete the account from the developer's records, including any associated personal data, except where the developer is required to retain data for legitimate legal purposes. Deleting an account should not just deactivate or disable the account. Apps in regulated industries may be required to confirm the user's identity prior to account deletion."
>
> "Account deletion must be initiated from within the app and the deletion must be completed from within the app, with no further interaction required beyond confirmation. Sending the user to a website to complete account deletion creates unnecessary friction."

— Apple App Store Review Guidelines, §5.1.1(v), as of 2024-04 (still current 2026-06).

**Implication:** the `mailto:` path fails on three counts: (a) user is forced out of the app, (b) deletion is not initiated from within the app — it is initiated by Suneel reading an email and running SQL, (c) no in-app confirmation flow.

### 1.3 India DPDP Act §12 — Right to Erasure

The Digital Personal Data Protection Act 2023 (DPDP), §12(1):

> "A Data Principal shall have the right to […] (a) the erasure of her personal data, where the personal data is no longer necessary for the purpose for which it was processed, **unless retention is necessary for a legal purpose**."

§12(3) adds the duty on the Data Fiduciary to "erase the personal data unless retention is necessary for compliance with any law for the time being in force."

### 1.4 Indian Income Tax + GST statutory retention — 8 years

- **Income Tax Act, §44AA + Rule 6F(5):** books of account retained 6 years from end of relevant AY. **§149 reassessment window** extended to 10 years by Finance Act 2021 for high-value cases.
- **CGST Act, §36 + Rule 56(15):** retain "until the expiry of seventy-two months [6 years] from the due date of furnishing of annual return" — effective ~6.75 years from invoice date.
- **PESO + LPG control orders:** distribution records 3 years.

**We pick 8 years.** Single retention window, safely covers §149, easy to communicate. CA confirmation pending (see §13).

### 1.5 Why request-and-queue, NOT synchronous deletion

The previous revision of this spec assumed an immediate synchronous wipe at `DELETE /api/users/me` time. Suneel correctly pushed back: this is neither industry standard nor required by Apple. Every consumer app of comparable scale — **Instagram, X, LinkedIn, Reddit, Snap, TikTok, Discord** — runs a **request-and-30-day-queue** model. Apple's reviewer accepts it; DPDP §12 accepts it (the right to erasure does not specify "instant"); and a 30-day cancellation window measurably reduces (a) impulsive-deletion regret support tickets, and (b) account-takeover-driven malicious-deletion attacks.

For Re-New GasLink specifically there is a third, stronger argument: **we are inside the live first-distributor onboarding window.** A synchronous wipe touching 14 PII-bearing models in one transaction during the first months of production is exactly the kind of feature that ships, runs once, and silently anonymizes a row it shouldn't. A 30-day queue gives us:

- An audit trail (`AccountDeletionRequest` row sits visible) before any data is touched.
- A cancellation path for users who deleted by mistake or had their account taken over.
- A nightly worker we can monitor + dry-run on staging with real volume before it runs on production.
- A 5-day operational buffer (§9) between v1.0 going live and the first user's request maturing.

**The split:**
- **v1.0 (iOS ship-blocker, ~2 working days):** the in-app request flow + the request endpoint + login block. Submits a row to `AccountDeletionRequest`. Does NOT anonymize PII.
- **v1.1 (≤25 days post-v1.0, hard deadline):** the background worker that performs the 46-model PII anonymization captured in §10 + a `Driver.userId` FK migration.

This is the design the rest of the spec describes.

---

## 2. Architecture — request-and-queue

Two-phase architecture. v1.0 is fully shippable on its own (Apple sees a working in-app deletion flow with a clear 30-day disclosure). v1.1 must follow it within 25 days or the in-app disclosure becomes a false statement.

### 2.1 Sequence diagram

```
                v1.0 (DAY D — iOS ship)                            v1.1 (DAY D + ~30 — nightly worker)
                ──────────────────────                            ────────────────────────────────────

  User (mobile)              API                Postgres                Cron (00:30 IST)         API/Worker
       │                      │                     │                          │                    │
       │ tap "Delete Account" │                     │                          │                    │
       │ ── disclosure ──┐    │                     │                          │                    │
       │                 │    │                     │                          │                    │
       │ type confirm    │    │                     │                          │                    │
       │ ─── POST ──────►│    │                     │                          │                    │
       │  /deletion-      │   │                     │                          │                    │
       │   request        │   │                     │                          │                    │
       │                  │   │── INSERT ──────────►│                          │                    │
       │                  │   │  AccountDeletion    │                          │                    │
       │                  │   │  Request            │                          │                    │
       │                  │   │  status='pending'   │                          │                    │
       │                  │   │  scheduledCompletion│                          │                    │
       │                  │   │   = now() + 30d     │                          │                    │
       │                  │   │── DELETE ──────────►│                          │                    │
       │                  │   │  RefreshToken       │                          │                    │
       │                  │   │  WHERE userId=...   │                          │                    │
       │                  │   │── enqueue email ────┤                          │                    │
       │                  │   │                     │                          │                    │
       │ ◄─── 200 OK ─────┤                         │                          │                    │
       │  { requestId,    │                         │                          │                    │
       │   scheduledAt }  │                         │                          │                    │
       │                  │                         │                          │                    │
       │  client wipes    │                         │                          │                    │
       │  SecureStore +   │                         │                          │                    │
       │  routes /login   │                         │                          │                    │
       │                  │                         │                          │                    │
       │                  │  ── while pending ──    │                          │                    │
       │  user logs in    │                         │                          │                    │
       │  ─── POST /auth/login ─►                   │                          │                    │
       │                  │  ◄── 200 + JWT ──┤                                 │                    │
       │  next API call   │                         │                          │                    │
       │  ─── GET /orders ──►                       │                          │                    │
       │                  │── joined query sees     │                          │                    │
       │                  │   pending deletion ─────┤                          │                    │
       │  ◄── 403 with    │                         │                          │                    │
       │   "account_pending_deletion" + scheduledAt │                          │                    │
       │                  │                         │                          │                    │
       │  mobile routes to /(shared)/pending-deletion (countdown screen)       │                    │
       │  shows "23 days remaining" + Cancel button                            │                    │
       │  ─── POST /deletion-request/cancel ────►                              │                    │
       │                  │── UPDATE status='cancelled' ────────►              │                    │
       │  ◄── 204 ────────┤                         │                          │                    │
       │  normal login resumes                      │                          │                    │
       │                                                                       │                    │
       │                                                                       │ runs daily 00:30   │
       │                                                                       │ ─── SELECT ───────►│
       │                                                                       │  WHERE status='pending'
       │                                                                       │    AND scheduledCompletionAt <= now()
       │                                                                       │                    │
       │                                                                       │                    │ for each row:
       │                                                                       │                    │  • re-check sole-admin
       │                                                                       │                    │  • $transaction:
       │                                                                       │                    │     - anonymize 14 PII models (§10)
       │                                                                       │                    │     - statutory rows untouched
       │                                                                       │                    │     - mark request completed
       │                                                                       │                    │  • send final email
       │                                                                       │                    │
       │ (user can never log in again — email is now deleted-<hash>@anon...)   │                    │
```

### 2.2 The split, in plain English

| Phase | When | What ships | What does NOT ship |
|-------|------|------------|--------------------|
| **v1.0** | Day D (iOS submission) | `AccountDeletionRequest` table + 3 endpoints + auth-middleware login block + 5 mobile screens + email "we received your request" | Any PII anonymization. The User row remains intact for 30 days. |
| **v1.1** | Day D+25 (hard) | Nightly cron worker + 46-model anonymization function + `Driver.userId` FK migration + final-confirmation email + observability | Nothing — v1.1 is the deferred half of the same feature. |

Anything that mutates user PII lives in v1.1. v1.0 only writes one row.

---

## 3. v1.0 schema — `AccountDeletionRequest`

Single new table. One Prisma migration, additive, safe.

```prisma
/// v1.0: tracks user-initiated account deletion requests. Inserted by
/// POST /api/users/me/deletion-request; processed by the v1.1 cron worker
/// once scheduledCompletionAt is reached. While status='pending' the auth
/// middleware blocks the user from every endpoint except cancel + status
/// + logout.
model AccountDeletionRequest {
  id                       String   @id @default(uuid())
  userId                   String   @unique @map("user_id")
  /// preserved at request time so the v1.1 worker can still locate tenant
  /// scope even after the User row's distributorId is set NULL during anonymization
  distributorId            String   @map("distributor_id")
  requestedAt              DateTime @default(now()) @map("requested_at")
  /// requestedAt + 30 days. The v1.1 worker only acts when now() >= this.
  scheduledCompletionAt    DateTime @map("scheduled_completion_at")
  completedAt              DateTime? @map("completed_at")
  cancelledAt              DateTime? @map("cancelled_at")
  status                   AccountDeletionStatus @default(pending)
  /// optional free-text reason captured on the confirm screen. Plain string.
  reason                   String?  @db.Text
  requestIp                String?  @map("request_ip")
  requestUserAgent         String?  @map("request_user_agent") @db.Text

  user                     User @relation(fields: [userId], references: [id])

  @@index([status, scheduledCompletionAt])  // the v1.1 cron query
  @@index([distributorId])
  @@map("account_deletion_requests")
}

enum AccountDeletionStatus {
  pending
  cancelled
  completed
}
```

### 3.1 Why `@unique` on `userId`

A user can have at MOST one open deletion request. The unique constraint enforces this at the DB level — a buggy client that double-submits gets a Postgres unique-violation, not two parallel pending rows. If the user cancels (status=cancelled) and later re-requests, we either (a) `upsert` to flip cancelled → pending and reset timestamps, or (b) delete the cancelled row and insert. Recommended: **(a) upsert**, so the cancelled history is preserved in `cancelledAt` for one cycle. After a second request the previous cancelled row is overwritten — acceptable.

### 3.2 Why store `distributorId` on the request row

Defence in depth. By the time the v1.1 worker runs the anonymization, `User.distributorId` could in principle have been nulled (it shouldn't, but the worker should not depend on the User row's tenant fields being intact). Storing `distributorId` at request time guarantees the worker can scope its anonymization queries even if the User row is mid-transform.

### 3.3 Migration

One additive migration: `CREATE TABLE account_deletion_requests` + `CREATE TYPE AccountDeletionStatus`. No backfill needed. Safe to run on production. Filename: `prisma/migrations/<timestamp>_add_account_deletion_requests/migration.sql`. Per the schema rule in CLAUDE.md anti-pattern #2, this is an **incremental migration**, not a reset.

---

## 4. v1.0 API contracts

Three endpoints. All mounted under `/api/users` in [packages/api/src/app.ts](../packages/api/src/app.ts). All go through the standard `sendSuccess` / `sendError` envelope ([utils/apiResponse.ts](../packages/api/src/utils/apiResponse.ts)). Implementation lives in a new route file `packages/api/src/routes/accountDeletionRoutes.ts` or as a section in the existing `userRoutes.ts`.

### 4.1 `POST /api/users/me/deletion-request` — submit a request

**Auth:** authenticated user. Goes through `authenticate` middleware ([packages/api/src/middleware/auth.ts:41](../packages/api/src/middleware/auth.ts)). NO `requireDistributor` — customer-portal users have implicit distributorId from `User.customerId.distributorId`.

**Request body:**

```json
{
  "confirmText": "DELETE MY ACCOUNT",
  "reason": "Optional free-text reason (max 500 chars)"
}
```

Zod schema:

```ts
const submitDeletionSchema = z.object({
  confirmText: z.literal('DELETE MY ACCOUNT'),
  reason: z.string().max(500).optional(),
});
```

**Side-effects (in a single Prisma `$transaction`):**

1. **Validate confirmText** (zod literal). On mismatch → 400 `{ code: 'INVALID_CONFIRMATION' }`. This is the server-side enforcement of the in-app force-typed confirmation — a client cannot skip the modal.

2. **Sole-admin block.** If `req.user.role === 'distributor_admin'`:
   ```ts
   const otherAdmins = await prisma.user.count({
     where: {
       distributorId: req.user.distributorId,
       role: 'distributor_admin',
       id: { not: req.user.userId },
       status: 'active',
       deletedAt: null,
     },
   });
   if (otherAdmins === 0) return sendError(res, 423, 'SOLE_ADMIN_BLOCK', '...');
   ```
   Returns **423 Locked** with body:
   ```json
   { "error": { "code": "SOLE_ADMIN_BLOCK",
                "message": "You are the only admin for this distributor; add a second admin before deleting your account." } }
   ```

3. **Super-admin block.** If `role === 'super_admin'` → 423 with code `SUPERADMIN_SELF_DELETE_BLOCKED`. (Same response shape as #2.)

4. **Duplicate-request guard.** If an `AccountDeletionRequest` already exists with `userId=req.user.userId AND status='pending'` → 409 `{ code: 'DELETION_ALREADY_PENDING', context: { scheduledCompletionAt } }`. The mobile client should never hit this (we redirect to the pending-deletion screen instead), but the server enforces it.

5. **Outstanding-balance check (customer role only).**
   ```ts
   if (req.user.role === 'customer' && req.user.customerId) {
     const balance = await sumLedger(req.user.customerId); // existing helper
     if (balance > 100) return sendError(res, 409, 'OUTSTANDING_BALANCE',
       `You have ₹${balance} outstanding...`, { context: { type: 'outstanding_balance', balance } });
   }
   ```
   Threshold is ₹100 (allows rounding-error tails). Reuse the existing customer-ledger sum helper if one exists; otherwise inline a `customerLedgerEntries` `groupBy/sum`. **Important:** the `where` MUST include `distributorId` (CLAUDE.md anti-pattern #13).

6. **Insert `AccountDeletionRequest`:**
   ```ts
   const scheduled = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
   await tx.accountDeletionRequest.upsert({
     where: { userId: req.user.userId },
     update: {
       status: 'pending',
       requestedAt: new Date(),
       scheduledCompletionAt: scheduled,
       cancelledAt: null,
       reason: body.reason ?? null,
       requestIp: req.ip,
       requestUserAgent: req.headers['user-agent'] ?? null,
     },
     create: {
       userId: req.user.userId,
       distributorId: req.user.distributorId!,
       scheduledCompletionAt: scheduled,
       reason: body.reason ?? null,
       requestIp: req.ip,
       requestUserAgent: req.headers['user-agent'] ?? null,
     },
   });
   ```
   The `upsert` covers the cancel-then-re-request case (§3.1).

7. **Revoke refresh tokens.** Delete all `RefreshToken` rows (or null `User.refreshToken` per the current schema) for this user. Forces the next refresh attempt to fail; the access token will naturally expire within 15 minutes.

8. **Enqueue confirmation email.** Call the existing `sendEmail` helper ([packages/api/src/utils/email.ts](../packages/api/src/utils/email.ts) — nodemailer-based; verify by inspection whether a generic `sendEmail` exists, or add one alongside `sendOtpEmail`). Subject: "Your GasLink account deletion request". Body includes `scheduledCompletionAt`, the cancellation steps, and an FAQ link. Best-effort — failure to send must NOT roll back the transaction; log + Sentry-capture instead.

**Response — 200 OK:**

```json
{
  "success": true,
  "data": {
    "requestId": "<uuid>",
    "requestedAt": "2026-06-08T10:23:45Z",
    "scheduledCompletionAt": "2026-07-08T10:23:45Z",
    "cancellationDeadline": "2026-07-08T10:23:45Z"
  }
}
```

The mobile client uses the response to render Screen 4 (success) and then forcibly logs the user out — token wipe via `expo-secure-store` per CLAUDE.md Mobile Rule #1.

### 4.2 `POST /api/users/me/deletion-request/cancel` — cancel

**Auth:** the special middleware described in §5. Reachable WHILE the user has a pending deletion request (this is the whole point — the auth middleware otherwise blocks them).

**Request body:** none.

**Side-effects:**
- Find the user's pending request. If none → 404.
- Set `status='cancelled'`, `cancelledAt=now()`.

**Response — 204 No Content.**

After cancellation the user's normal flow resumes on their next API call. (The session that called cancel is still authenticated; the auth middleware on the next request sees `status='cancelled'` and lets the call through.)

### 4.3 `GET /api/users/me/deletion-request` — read status

**Auth:** same special middleware.

**Response — 200 OK:**

```json
{
  "success": true,
  "data": {
    "requestId": "<uuid>",
    "status": "pending",
    "requestedAt": "2026-06-08T10:23:45Z",
    "scheduledCompletionAt": "2026-07-08T10:23:45Z",
    "daysRemaining": 23
  }
}
```

Used by the mobile "pending-deletion" screen (§6, screen 5) to render the countdown. `daysRemaining = ceil((scheduledCompletionAt - now()) / 1 day)`.

---

## 5. v1.0 auth middleware change — login block

This is the most-important change in v1.0. It's what makes the request meaningful — without it, a user could "delete their account" and continue using the app for 30 days as if nothing happened.

### 5.1 The change

[packages/api/src/middleware/auth.ts:41](../packages/api/src/middleware/auth.ts) — `authenticate()` — currently does:

```ts
const user = await prisma.user.findUnique({
  where: { id: decoded.userId },
  select: { id: true, status: true, role: true, distributorId: true, customerId: true },
});
```

Extend the select to include the pending-deletion-request status via a left join:

```ts
const user = await prisma.user.findUnique({
  where: { id: decoded.userId },
  select: {
    id: true, status: true, role: true, distributorId: true, customerId: true,
    accountDeletionRequest: {
      where: { status: 'pending' },
      select: { id: true, scheduledCompletionAt: true },
    },
  },
});
```

(`User.accountDeletionRequest` is the back-relation auto-generated by the new `AccountDeletionRequest` model in §3 — Prisma generates it from the `@relation` on the child side.)

Then after the existing `if (!user || user.status !== 'active')` block, add:

```ts
if (user.accountDeletionRequest?.[0]) {
  const path = req.path;
  const ALLOWED_DURING_PENDING_DELETION = [
    'POST /api/users/me/deletion-request/cancel',
    'GET /api/users/me/deletion-request',
    'POST /api/auth/logout',
  ];
  const requestKey = `${req.method} ${req.baseUrl}${req.path}`;
  if (!ALLOWED_DURING_PENDING_DELETION.includes(requestKey)) {
    return res.status(403).json({
      success: false,
      data: null,
      error: 'account_pending_deletion',
      code: 'ACCOUNT_PENDING_DELETION',
      context: { scheduledCompletionAt: user.accountDeletionRequest[0].scheduledCompletionAt },
    });
  }
  // fall through — request is one of the three special endpoints
  req.user = { /* same as before */ };
  return next();
}
```

The exact allowlist matching uses whatever pattern matches the project's actual mount points — verify the cancel/status routes are at `/api/users/me/deletion-request*` and not somewhere else.

### 5.2 Mobile client behaviour on `account_pending_deletion`

The mobile axios interceptor ([packages/mobile/src/lib/api.ts](../packages/mobile/src/lib/api.ts), reference for SecureStore pattern at :13) special-cases `error === 'account_pending_deletion'`:

```ts
if (response.status === 403 && response.data?.error === 'account_pending_deletion') {
  router.replace('/(shared)/pending-deletion');
  return Promise.reject(error);
}
```

The pending-deletion screen reads `GET /api/users/me/deletion-request` for the countdown.

### 5.3 Why this is safer than nulling the password

The previous spec's "anonymize email so login lookup fails" approach was correct only if we anonymized at request time. In the request-and-queue model the User row is still intact for 30 days — login by email/password still works. The middleware-level block is the ONLY thing preventing a "deleted" user from continuing to use the app. Get this right.

---

## 6. v1.0 in-app UX flow (4 deletion screens + 1 special-state screen)

### 6.1 Screen 1 — Entry point

`Settings → Account → Delete Account` on every role's settings/profile screen. Replace the current `mailto:` behaviour in [DeleteAccountButton.tsx](../packages/mobile/src/components/DeleteAccountButton.tsx) with `router.push('/(shared)/delete-account')`.

### 6.2 Screen 2 — Disclosure

```
┌───────────────────────────────────────────┐
│  Delete Your Account                       │
│  ─────────────────                         │
│                                            │
│  Your account deletion request will be     │
│  submitted. Your personal information —    │
│  name, email, phone, address, and photo —  │
│  will be removed within 30 days.           │
│                                            │
│  You can CANCEL this request anytime in    │
│  those 30 days by logging in.              │
│                                            │
│  After 30 days, as required by Indian      │
│  Income Tax and GST law, your invoice and  │
│  payment history will be retained          │
│  ANONYMOUSLY for 8 years. Anonymized       │
│  records are linked to a random ID — not   │
│  to you — and are used only for statutory  │
│  tax compliance and audit, never for       │
│  marketing or analytics.                   │
│                                            │
│  After 8 years, all records will be        │
│  permanently deleted.                      │
│                                            │
│  This cannot be undone after 30 days.      │
│                                            │
│  ┌───────────────────┐  ┌──────────┐       │
│  │     Cancel        │  │ Continue │       │
│  └───────────────────┘  └──────────┘       │
└───────────────────────────────────────────┘
```

### 6.3 Screen 3 — Force-typed confirmation

```
┌───────────────────────────────────────────┐
│  Final Confirmation                        │
│  ─────────────────                         │
│                                            │
│  Type DELETE MY ACCOUNT below to confirm.  │
│                                            │
│  ┌───────────────────────────────────┐     │
│  │                                   │     │
│  └───────────────────────────────────┘     │
│                                            │
│  Reason (optional):                        │
│  ┌───────────────────────────────────┐     │
│  │                                   │     │
│  └───────────────────────────────────┘     │
│                                            │
│  ┌───────────────────┐  ┌──────────┐       │
│  │     Cancel        │  │  Submit  │       │  ← Submit disabled until exact match
│  └───────────────────┘  └──────────┘       │
└───────────────────────────────────────────┘
```

Submit calls `POST /api/users/me/deletion-request`.

### 6.4 Screen 4 — Submitted (forced logout)

```
┌───────────────────────────────────────────┐
│  ✓  Request Submitted                      │
│                                            │
│  Your deletion request has been submitted. │
│  Your account will be removed within 30    │
│  days (by Jul 8, 2026).                    │
│                                            │
│  You'll receive an email confirmation.     │
│                                            │
│  You can cancel anytime within 30 days     │
│  by logging in.                            │
│                                            │
│  The app will now sign you out.            │
│                                            │
│            ┌─────────┐                     │
│            │   OK    │                     │  → /login (after SecureStore wipe)
│            └─────────┘                     │
└───────────────────────────────────────────┘
```

On OK: `queryClient.clear()`, `SecureStore.deleteItemAsync('jwt')`, `SecureStore.deleteItemAsync('refreshToken')`, `useAuthStore.getState().clear()`, `router.replace('/login')`.

### 6.5 Screen 5 — Pending-deletion (NEW — appears when user with pending request logs back in)

```
┌───────────────────────────────────────────┐
│  Account Pending Deletion                  │
│  ─────────────────                         │
│                                            │
│  Your account will be deleted in 23 days.  │
│                                            │
│  ┌─────────────────────────────────────┐   │
│  │ Scheduled completion: Jul 8, 2026   │   │
│  └─────────────────────────────────────┘   │
│                                            │
│  After 30 days from your request, your     │
│  personal information will be removed and  │
│  cannot be recovered.                      │
│                                            │
│  If you've changed your mind, cancel       │
│  below — your account will resume          │
│  normally.                                 │
│                                            │
│  ┌─────────────────────────────────────┐   │
│  │   Cancel Deletion Request           │   │  ← primary
│  └─────────────────────────────────────┘   │
│                                            │
│  ┌─────────────────────────────────────┐   │
│  │   Sign Out                          │   │  ← secondary
│  └─────────────────────────────────────┘   │
└───────────────────────────────────────────┘
```

On Cancel tap → `POST /api/users/me/deletion-request/cancel` → on 204, `queryClient.invalidateQueries()` and `router.replace('/')` (the user's role-appropriate home).
On Sign Out tap → SecureStore wipe + `/login`.

### 6.6 Files to add

- [packages/mobile/app/(shared)/delete-account/index.tsx](../packages/mobile/app/(shared)/delete-account/index.tsx) — Screen 2 (disclosure)
- [packages/mobile/app/(shared)/delete-account/confirm.tsx](../packages/mobile/app/(shared)/delete-account/confirm.tsx) — Screen 3 (force-typed)
- [packages/mobile/app/(shared)/delete-account/success.tsx](../packages/mobile/app/(shared)/delete-account/success.tsx) — Screen 4
- [packages/mobile/app/(shared)/pending-deletion/index.tsx](../packages/mobile/app/(shared)/pending-deletion/index.tsx) — Screen 5
- [packages/mobile/src/api/account.ts](../packages/mobile/src/api/account.ts) — three API client methods: `submitDeletionRequest`, `cancelDeletionRequest`, `getDeletionRequest`. All via `useApiMutation` / `useApiQuery` per CLAUDE.md Mobile Rule #3.

### 6.7 Files to modify

- [packages/mobile/src/components/DeleteAccountButton.tsx](../packages/mobile/src/components/DeleteAccountButton.tsx) — replace the `Linking.openURL('mailto:...')` call with `router.push('/(shared)/delete-account')`. Grep'd locations (verify with `grep -rn DeleteAccountButton packages/mobile`) — there should be no change to the 6 entry-point screens that already render `<DeleteAccountButton />`.
- [packages/mobile/src/lib/api.ts](../packages/mobile/src/lib/api.ts) — axios interceptor for the `account_pending_deletion` 403 redirect (§5.2).
- [packages/mobile/app/(super-admin)/settings.tsx](../packages/mobile/app/(super-admin)/settings.tsx) — wrap `<DeleteAccountButton />` with `{user.role !== 'super_admin' && ...}` (belt + braces alongside the 423 server response).

### 6.8 Loading / error / empty states (CLAUDE.md Mobile Rule #2)

- Submit button shows inline spinner during the mutation.
- 409 `outstanding_balance` → modal "You have ₹X outstanding. Please contact the distributor to settle before deleting." OK → back to Screen 1.
- 423 `SOLE_ADMIN_BLOCK` → modal "You are the only admin for this distributor; please add a second admin before deleting your account."
- 423 `SUPERADMIN_SELF_DELETE_BLOCKED` → modal "Super-admin accounts cannot be self-deleted. Contact another super-admin." (Should never reach this — UI hides the entry point.)
- 500 → modal "Something went wrong. Please try again or contact support."
- Network error on the pending-deletion screen → keep cached countdown if available, else "Couldn't refresh status. You can still cancel." with a retry chip.

---

## 7. v1.0 disclosure copy — locked

**This is the user-facing source of truth for the v1.1 deadline discipline.** Whatever this says, v1.1 must make true.

The exact text on Screen 2:

> **Delete Your Account**
>
> Your account deletion request will be submitted. Your personal information — name, email, phone, address, and photo — will be removed within 30 days.
>
> You can cancel this request anytime in those 30 days by logging in.
>
> After 30 days, as required by Indian Income Tax and GST law, your invoice and payment history will be retained anonymously for 8 years. Anonymized records are linked to a random ID — not to you — and are used only for statutory tax compliance and audit, never for marketing or analytics.
>
> After 8 years, all records will be permanently deleted.
>
> This cannot be undone after 30 days.

The shorter Screen 3 prompt:

> Type **DELETE MY ACCOUNT** below to confirm. You can cancel this request within 30 days.

**Locked.** Do not paraphrase without re-reviewing against Apple §5.1.1(v). If CA confirms a retention period other than 8 years (§13 q.1), this is the only copy that changes.

---

## 8. v1.1 background worker — design

### 8.1 Trigger — existing cron infrastructure

The API already runs `node-cron` jobs. Reference: [packages/api/src/jobs/overdueInvoicesJob.ts](../packages/api/src/jobs/overdueInvoicesJob.ts) (the `runOverdueSweep` daily sweep at midnight server-local time), kicked off in [packages/api/src/server.ts:6](../packages/api/src/server.ts) via `startOverdueInvoicesCron()`.

**No new infrastructure needed.** Add `packages/api/src/jobs/accountDeletionWorker.ts` modelled on the same pattern; wire it into `server.ts` next to `startOverdueInvoicesCron()`. Schedule: `00 30 * * *` IST (00:30 — one hour after the overdue sweep so the two don't compete for connections).

### 8.2 The query

```ts
const due = await prisma.accountDeletionRequest.findMany({
  where: {
    status: 'pending',
    scheduledCompletionAt: { lte: new Date() },
  },
  select: { id: true, userId: true, distributorId: true },
  // deterministic order — oldest first, so a partial-batch failure
  // doesn't randomize which subset got processed
  orderBy: { scheduledCompletionAt: 'asc' },
});
```

### 8.3 Per-request loop

For each due row, in its own `$transaction`:

1. **Re-fetch** the User + the request inside the txn (defends against a cancel that landed between the SELECT and the UPDATE).
2. **Skip if** the request is no longer `status='pending'` (raced with a cancel) OR the User's `deletedAt IS NOT NULL` (already anonymized somehow).
3. **Sole-admin re-check.** Conditions in the 30-day window may have changed. If the user is the last `distributor_admin` for this tenant NOW (even though they weren't at request time), DO NOT anonymize. Instead: mark the request `status='completed'` with `completedAt=now()` BUT leave PII intact, AND send TWO emails:
   - To the user at their (still-real) email: "Your deletion request could not be completed because you are now the sole admin for your distributor. Please add a second admin and re-submit."
   - To `suneel@mygaslink.com`: alert with `userId`, `distributorId`, `requestedAt`.
   This is a known edge case; manual resolution.
4. **Apply the §10 anonymization mapping** (the full 46-model audit). Order matters — see §8.5.
5. **Mark the request** `status='completed'`, `completedAt=now()`.
6. **Commit.**
7. **Enqueue final email** (best-effort, out of txn): "Your GasLink account has been deleted as requested."

### 8.4 Idempotency

- `status='completed'` rows are skipped on the next run by the `WHERE status='pending'` filter.
- Within a single run, the `for` loop processes one txn per request; a per-row failure rolls back THAT row and leaves it `status='pending'` for tomorrow.
- The anonymization function itself uses `prisma.<model>.updateMany({ where: { ... } })` (not `update`), so re-running on an already-anonymized row is a no-op.

### 8.5 Anonymization order — avoid FK contention

1. Cancel pending Orders / draft Invoices / pending CN/DN that survived the 30-day window (rare but possible — see §10 for the rules; these are now hard-blocked at v1.1 deletion time same way the v1.0 request was blocked, BUT a long-lived `pending_delivery` order from before the request could still exist).
2. Resolve open `PendingAction` rows for the user.
3. Mark `PaymentCommitment` rows broken where applicable.
4. Anonymize related Driver row (if `role='driver'` AND `Driver.userId === user.id` per the v1.1 FK from §8.6).
5. Anonymize related Customer row (if `role='customer'` AND no OTHER active Users link to the same `customerId`).
6. Anonymize related CustomerContact / CustomerModificationRequest / CustomerAuditTrail (NULL free-text only; statutory rows like CustomerLedgerEntry are skipped).
7. NULL free-text + geo on Orders / OrderStatusLog / InventoryEvent / CancelledStockEvent / AccountabilityLog / StockMismatchRecord linked to this user.
8. Redact `AuditLog.details` JSON + null `ipAddress`, `userAgent` for `userId = <deleted>`.
9. Anonymize the User row itself (last, so all FK lookups still resolve while we're updating children).
10. Write a final `AuditLog` row: `action='user.account.deleted_completed'`, `entityType='user'`, `entityId=userId`, `details={ requestId, requestedAt, scheduledCompletionAt, completedAt }` — no PII payload.

### 8.6 `Driver.userId` FK migration (lands in v1.1)

Current schema ([prisma/schema.prisma:761](../packages/api/prisma/schema.prisma)) has `Driver` with `driverName` + `phone` but NO foreign key to `User`. The v1 driver/user linkage is by-convention (same `distributorId` + matching `phone`), which is fragile.

v1.1 adds a proper FK:

```prisma
model Driver {
  // ...existing fields...
  userId        String?  @unique @map("user_id")
  user          User?    @relation("DriverUser", fields: [userId], references: [id])

  @@index([userId])
}
```

Migration:
1. Add nullable `userId` column.
2. Backfill via a one-time script that joins `Driver(distributorId, phone)` to `User(distributorId, phone, role='driver')`. Rows that don't match get left NULL (with a logged report — Suneel reviews manually).
3. After backfill confirmation, leave nullable (some Drivers may be pre-User legacy).

Adds ~4h to v1.1; covered in §12.

### 8.7 Observability

- Every completion + every per-row failure logged via Winston (`logger.info` / `logger.error` per [packages/api/src/utils/logger.ts](../packages/api/src/utils/logger.ts)).
- Failures captured to Sentry with tags `{ kind: 'accountDeletionWorker', userId, distributorId }`.
- Daily summary log line: `{ processed: N, succeeded: N, failed: N, soleAdminBlocked: N }`.
- (Stretch) Daily email to `suneel@mygaslink.com` only if `failed > 0 OR soleAdminBlocked > 0`.

### 8.8 Manual override

A separate admin endpoint `POST /api/admin/account-deletion-requests/:id/run-now` (super_admin only) for the rare case Suneel needs to force-process a request ahead of schedule. **Out of scope for v1.1** unless it's trivial; flag as v1.2.

---

## 9. v1.1 hard deadline — discipline

**This section is the operational reason §7's disclosure copy must match v1.1's behaviour.**

If v1.0 ships on day **D** (iOS goes live), the FIRST user who requests deletion that same day will have their request mature on day **D+30**. The v1.1 worker MUST be running in production by day **D+25 at the latest**.

If it isn't:
- The in-app disclosure ("removed within 30 days") becomes a false statement.
- DPDP Act §12 + Apple §5.1.1(v) are both violated by inaction.
- A single user filing a DPDP complaint at that point is enough to attract regulator attention to the live first-distributor onboarding window — exactly the worst possible timing.

### 9.1 The 5-day buffer (D+25, not D+30)

The 5 days between D+25 and D+30 exist for:

1. **CA's final retention-period sanity check** — if CA confirms a period other than 8 years, the disclosure copy in §7 changes; a thin v1.0 redeploy may be needed BEFORE any user's request matures.
2. **Worker dry-run on staging with production-scale volume** — even with zero pending requests on day D, on D+25 we want one full staging run against a seeded request to prove the 46-model anonymization works end-to-end on real-shape data.
3. **One-day rollback window** if the v1.1 deploy itself goes wrong.

### 9.2 Action items the day v1.0 ships

- [ ] Calendar reminder set for **D+15**: "v1.1 anonymization worker must be code-complete and in staging."
- [ ] Calendar reminder set for **D+22**: "v1.1 staging dry-run must have passed."
- [ ] Calendar reminder set for **D+25**: "v1.1 MUST be in production today."
- [ ] Monitoring alert: count of `AccountDeletionRequest WHERE status='pending' AND scheduledCompletionAt < now()` — should be 0 once v1.1 is live; alert immediately if it goes >0.

**This is not optional.** The disclosure copy is a legal commitment.

---

## 10. v1.1 PII mapping — preserved from previous spec

The 46-model audit from the previous revision of this document is **executed by the v1.1 worker, not the v1.0 endpoint**. The audit's content is unchanged — only the timing moved. Reproduced inline below so the spec stays self-contained.

**Legend (Action):** `NULL` | `ANON` (replace with `ANON-<hash>` or fixed literal) | `RETAIN` | `DELETE` | `REVOKE` | `SKIP`.

### 10.1 Role-based scope matrix

| Role | Deletes own User? | Cascades to Customer? | Cascades to Driver? |
|------|-------------------|------------------------|----------------------|
| `customer` | Yes — anonymize | Yes IF no other Users link to the same Customer | No |
| `driver` | Yes — anonymize | No | Yes (via the v1.1 `Driver.userId` FK — §8.6) |
| `finance`, `inventory` | Yes — anonymize | No | No |
| `distributor_admin` | Yes — anonymize, after sole-admin check (§4.1 step 2 + §8.3 step 3) | No | No |
| `super_admin` | **BLOCKED (423)** | — | — |

### 10.2 Per-model summary table

Models are referenced by their location in [packages/api/prisma/schema.prisma](../packages/api/prisma/schema.prisma) (1694 lines as of 2026-06-08). Line numbers are approximate; re-check on implementation.

| # | Model | Location | Action | Notes |
|---|-------|----------|--------|-------|
| 1 | Distributor | :320 | SKIP | Tenant-level. |
| 2 | **User** | :395 | **ANON** | Primary target: `email → deleted-<hash>@anon.mygaslink.local`, `firstName='Deleted'`, `lastName='User'`, `phone NULL`, `passwordHash → random-unreachable`, `refreshToken NULL`, `status='inactive'`, `deletedAt=now()`. RETAIN: `id`, `role`, `distributorId`, `customerId`, `createdAt`. |
| 3 | **Customer** | :433 | ANON if cascading | `customerName='Deleted Customer'`, `phone=''`, `email NULL`, address lines NULL. RETAIN: `gstin`, `billingState`, `shippingState`, `customerType`, `id`, `distributorId`. Set `status='inactive'`, `stopSupply=true`, `deletedAt=now()`. |
| 4 | CustomerContact | :485 | ANON if Customer cascading | `name='Deleted'`, `phone=''`, `email NULL`. |
| 5 | CustomerCylinderDiscount | :498 | RETAIN | No PII. |
| 6 | CustomerInventoryBalance | :511 | RETAIN | Aggregates. |
| 7 | CustomerModificationRequest | :527 | Partial | `reason NULL`, `changes` JSON NULL. RETAIN FKs. |
| 8 | CustomerAuditTrail | :546 | REDACT | `oldValue`/`newValue` JSON → `{"redacted": "user-deletion-<date>"}` for affected rows. RETAIN rest. |
| 9 | **CustomerLedgerEntry** | :563 | **RETAIN** | Statutory spine. Touch nothing. |
| 10 | CylinderType | :585 | SKIP | Tenant-level. |
| 11 | CylinderPrice | :620 | SKIP | Tenant-level. |
| 12 | EmptyCylinderPrice | :635 | SKIP | Tenant-level. |
| 13 | CylinderThreshold | :649 | SKIP | Tenant-level. |
| 14 | Order | :665 | Partial | `specialInstructions NULL`, `deliveryNotes NULL`, geo fields NULL on cancelled (RETAIN on delivered — they're delivery proof), `cancellationReason NULL`, dispute reasons NULL. RETAIN: status, totals, customerId, driverId. |
| 15 | OrderItem | :727 | RETAIN | Statutory. |
| 16 | OrderStatusLog | :744 | Partial | `notes NULL`. RETAIN FKs. |
| 17 | **Driver** | :761 | ANON if cascading | `driverName='Deleted Driver'`, `phone=''`, `licenseNumber NULL`, `status='inactive'`, `availableToday=false`, `deactivatedAt=now()`, `deletedAt=now()`, `deactivationNotes='User-initiated account deletion'`. RETAIN: `joiningDate` (HR), `distributorId`. **v1.1 cascade key: `Driver.userId === user.id`** (FK added in §8.6). |
| 18 | Vehicle | :791 | SKIP | Asset, not PII. |
| 19 | DriverVehicleAssignment | :816 | RETAIN | Statutory (links to EWB trip-sheet). |
| 20 | ReconciliationEmptiesReturned | :865 | RETAIN | No PII. |
| 21 | DriverAssignment | :880 | Partial | `notes NULL`. RETAIN FKs. |
| 22 | VehicleInventory | :897 | RETAIN | No PII. |
| 23 | InvoiceCounter | :918 | SKIP | Tenant-level. |
| 24 | **Invoice** | :933 | **RETAIN** | Statutory. Touch nothing — IRN/EWB/QR included. |
| 25 | InvoiceRevision | :988 | RETAIN | Statutory. |
| 26 | InvoiceItem | :1008 | RETAIN | Statutory. |
| 27 | CreditNote | :1026 | Partial | `note NULL`. RETAIN rest. |
| 28 | DebitNote | :1048 | Partial | Same as CN. |
| 29 | **PaymentTransaction** | :1071 | Partial | `notes NULL`. RETAIN `referenceNumber`, FKs, statutory fields. |
| 30 | PaymentAllocation | :1095 | RETAIN | No PII. |
| 31 | InventoryEvent | :1110 | Partial | `driverName='Deleted Driver'` (denorm snapshot), `notes NULL`. RETAIN FKs + vehicleNumber. |
| 32 | InventorySummary | :1144 | RETAIN | Aggregates. |
| 33 | CancelledStockEvent | :1175 | Partial | `notes NULL`. RETAIN FKs. |
| 34 | **GstDocument** | :1206 | **RETAIN** | Statutory + NIC audit chain. requestPayload/responsePayload kept. |
| 35 | GstCredential | :1252 | SKIP | Tenant-level. |
| 36 | BillingCycle / BillingItem | :1277, :1302 | SKIP | Tenant-level. |
| 37 | PricingTier | :1327 | SKIP | Reference. |
| 38 | GstApiUsage | :1355 | SKIP | Tenant-level. |
| 39 | GstApiLog | :1379 | RETAIN | Statutory (same argument as GstDocument). |
| 40 | SeatRequest | :1404 | Partial | `reason NULL`. RETAIN FKs. |
| 41 | PendingAction | :1424 | Partial | Resolve open rows for this user (`status='skipped'`); REDACT `description`/`resolutionNotes` JSON for affected rows. |
| 42 | PaymentCommitment | :1462 | RETAIN | Statutory (collections). |
| 43 | AccountabilityLog | :1489 | Partial | REDACT `description`/`resolutionNotes` for affected rows. |
| 44 | **AuditLog** | :1519 | Partial | REDACT `details` JSON, NULL `ipAddress` + `userAgent` for rows where `userId === deleted user`. RETAIN `action`, `entityType`, `entityId`, `userId` FK. The deletion-completed row itself is written here. |
| 45 | DistributorSetting | :1542 | SKIP | Tenant-level. |
| 46 | License | :1558 | SKIP | Tenant-level. |
| 47 | ContactSubmission | :1577 | DEFERRED | Pre-auth lead form. Opportunistic anonymization (rows matching deleted user's `phone`/`email`) is a v1.2 nice-to-have. |
| 48 | StockMismatchRecord | :1659 | Partial | `resolutionNotes NULL`. RETAIN FKs. |
| 49 | **AccountDeletionRequest** | (new in §3) | RETAIN | The audit trail of the deletion itself. `status='completed'`, `completedAt=now()`. |
| 50 | **DeliveryProof** | (new in proof-of-collection Phase 1) | **ANON** | Per-order proof-of-delivery artifact for customers with `requireDeliveryVerification=true`. When cascading a customer/user deletion: `capturedLat NULL`, `capturedLng NULL`, `signingPartyPhone NULL`, `capturedBy='ANONYMIZED'`, `s3Key NULL` **after** the corresponding S3 object is deleted via `deleteDeliveryProofObject()` in `lib/s3.ts`. RETAIN: `id`, `orderId`, `distributorId`, `proofType`, `capturedAt`, `otpVerifiedAt` (audit trail of "delivery was verified via method X at time Y" survives without PII). **⚠️ S3-object deletion is net-new work** — no S3 delete function exists yet in the deployed codebase; it lands in Step 3 of the proof-of-collection feature. The account-deletion worker MUST call `deliveryProofService.deleteProofForDpdp(distributorId, customerId)` in the same phase as Customer/Order anonymization. |

**Coverage summary:** 15 models with anonymization writes (+1 for DeliveryProof), 8 statutory full-retain, ~15 tenant-level/skip, ~4 reference-data/skip. Net: the worker touches ≤21 of 50 models per request.

### 10.3 Statutory anchor — what we PROMISE to retain

For Apple-reviewer audit AND DPDP compliance trail: Invoice, InvoiceRevision, InvoiceItem, CreditNote, DebitNote, PaymentTransaction, PaymentAllocation, CustomerLedgerEntry, GstDocument, GstApiLog. These are NEVER touched by the v1.1 worker, period.

---

## 11. Test plan — v1.0 + v1.1

### 11.1 v1.0 tests

**Unit** ([packages/api/src/__tests__/account-deletion-request.unit.test.ts](../packages/api/src/__tests__/account-deletion-request.unit.test.ts)):
- `confirmText` literal validation — accept exact `"DELETE MY ACCOUNT"`, reject anything else (case-sensitive, no trailing whitespace).
- `scheduledCompletionAt` math — `requestedAt + 30 days` exact, no DST drift (uses ms arithmetic).
- Sole-admin gate — given a tenant with 2 admins, deleting one is allowed; deleting the second is blocked with 423.

**Integration** ([packages/api/src/__tests__/account-deletion-request.test.ts](../packages/api/src/__tests__/account-deletion-request.test.ts), seeded via the test helpers in [packages/api/src/__tests__/helpers.ts](../packages/api/src/__tests__/helpers.ts)):
- End-to-end happy path: customer → POST /deletion-request (200) → next GET /orders (403 `account_pending_deletion`) → POST /deletion-request/cancel (204) → next GET /orders (200).
- Duplicate request: second POST returns 409 with `scheduledCompletionAt` in context.
- Outstanding balance: customer with ₹500 ledger debit → 409 `OUTSTANDING_BALANCE`.
- Sole-admin block: distributor_admin who's the only admin → 423 `SOLE_ADMIN_BLOCK`.
- Super-admin block: super_admin → 423 `SUPERADMIN_SELF_DELETE_BLOCKED`.
- **Multi-tenant guard** (CLAUDE.md tenant rule + anti-pattern #13): dist-001 user requests deletion; assert dist-002 customers/orders/audit-logs unchanged (snapshot-compare via `prisma.customer.findMany({ where: { distributorId: 'dist-002' } })`).
- Cancel after timeout: simulate `scheduledCompletionAt < now()` (no v1.1 worker yet) and confirm cancel still works — v1.0 must NOT auto-process; it only acknowledges requests.
- Login block special-endpoint allowlist: with a pending request, `POST /deletion-request/cancel`, `GET /deletion-request`, `POST /auth/logout` all return 200/204; everything else returns 403.

**Manual E2E** (add tab to [docs/E2E_Testing_Guide.xlsx](E2E_Testing_Guide.xlsx)):
1. Log in `royal@kitchen.com`. Settings → Account → Delete Account. Confirm disclosure copy matches §7.
2. Continue → type `delete my account` (lowercase) → Submit disabled.
3. Type `DELETE MY ACCOUNT` → Submit enabled → tap. Success screen.
4. Tap OK → /login.
5. Log in `royal@kitchen.com` again → pending-deletion screen with "30 days remaining".
6. Tap Cancel Deletion Request → routed to customer home, normal flow.
7. Repeat 1-4, do NOT cancel. Verify in DB (`pnpm db:studio`): `account_deletion_requests` row, `status='pending'`, `scheduled_completion_at ≈ requested_at + 30d`. `refresh_token` on User row NULL.

### 11.2 v1.1 tests

**Unit** ([packages/api/src/__tests__/account-deletion-anonymization.unit.test.ts](../packages/api/src/__tests__/account-deletion-anonymization.unit.test.ts)):
- Anonymization function applied to a mock customer User — every field listed in §10.2 row 2 is mutated; every statutory field unchanged.
- Same for a driver User — Driver row anonymized via `Driver.userId` FK; statutory rows untouched.
- Anti-pattern guard: every Prisma `updateMany`/`update` issued by the anonymization function has `distributorId` in its `where` clause. Same pattern as [packages/api/src/__tests__/anti-pattern-guards.test.ts](../packages/api/src/__tests__/anti-pattern-guards.test.ts).

**Integration** ([packages/api/src/__tests__/account-deletion-worker.test.ts](../packages/api/src/__tests__/account-deletion-worker.test.ts)):
- Seed a customer with: 5 historical Invoices (irn=success), 3 historical Orders, 1 PaymentTransaction, an AuditLog with PII, 0 open Orders.
- Insert an `AccountDeletionRequest` with `scheduledCompletionAt = now() - 1 day`.
- Run the worker.
- Assert per §10: User anonymized, Customer anonymized, 5 Invoices bit-identical (snapshot), 3 Orders have `specialInstructions/deliveryNotes NULL` but status unchanged, PaymentTransaction `notes NULL` and `referenceNumber` intact, AuditLog rows `details={redacted...}` + IP/UA NULL. Request row `status='completed'`, `completedAt` set.
- **Idempotency**: run the worker a second time on the same DB state; assert nothing changes (no errors, request stays `completed`).
- **Partial failure rollback**: monkey-patch one of the anonymization sub-steps to throw; assert the txn rolls back, User row UNCHANGED, request stays `status='pending'` for retry.
- **Sole-admin re-check edge case**: seed a distributor with 2 admins, request deletion as admin A, then in the 30-day window DEACTIVATE admin B, run the worker — assert User A NOT anonymized, request marked `completed` with PII intact, log line indicates `soleAdminBlocked`, alert email enqueued (verify via test spy on the email helper).
- **Multi-tenant guard**: same as v1.0 — assert no dist-002 rows touched.

**Manual E2E**:
- Stage a v1.0 request with `scheduledCompletionAt = now() - 1 day` via direct DB update.
- Trigger the cron task manually (export a function from the worker module that the dev can invoke).
- Verify: User row anonymized in `pnpm db:studio`. Invoices unchanged. `accountDeletionRequest` row `status='completed'`.

### 11.3 Apple-reviewer test account

Identical to the previous spec: create `apple-reviewer@mygaslink.com` (role `customer`, dist Bhargava, 1 paid invoice, 0 pending). Seed nightly. Document in App Store Connect "Notes for Reviewer": "Account deletion: log in → Settings → Account → Delete Account → follow 3 screens. Request will be submitted; in our implementation the actual personal-data wipe happens within 30 days as disclosed in-app, consistent with Instagram/LinkedIn/Reddit. Account rebuilt nightly so you may re-test."

This wording is honest and matches Apple's published acceptance of queued deletion in §5.1.1(v).

### 11.4 Security review

- Re-run `/secure` skill on the v1.0 diff AND on the v1.1 diff separately.
- Verify (per CLAUDE.md anti-pattern #13): every Prisma write in both phases includes `distributorId` in `where` for tenant-scoped models.
- Verify the `confirmText` literal is server-validated AND the auth middleware's 403 is hit before any other middleware that might leak data.

---

## 12. Effort — v1.0 + v1.1

### 12.1 v1.0 — ~16h ≈ 2 working days (iOS ship-blocker)

| Section | Work | Hours |
|---------|------|-------|
| §3 | `AccountDeletionRequest` schema + migration | 2 |
| §4 | Three API endpoints + transactions + sole-admin/balance gates + zod schemas | 4 |
| §5 | Auth-middleware login block (the joined query, the special-endpoint allowlist, mobile axios interceptor) | 2 |
| §6 | Mobile screens (×4 deletion + ×1 pending-deletion) + API client + entry-point rewire | 5 |
| §11.1 | v1.0 unit + integration + manual E2E | 3 |
| **Total v1.0** | | **~16h** |

### 12.2 v1.1 — ~28h ≈ 3.5 working days (must land within 25 days of v1.0)

| Section | Work | Hours |
|---------|------|-------|
| §8.6 | `Driver.userId` FK migration + backfill script | 4 |
| §8.1–§8.5 | Background worker + cron wiring + per-request transaction loop | 4 |
| §10 | Anonymization function across 14 anonymizing models | 10 |
| §11.2 | v1.1 unit + integration + manual E2E (including sole-admin re-check + idempotency + partial-failure rollback) | 4 |
| §8.7 | Observability (logger + Sentry tags + daily summary) | 2 |
| §8.3 step 3 | Sole-admin re-check edge-case path + alert email | 2 |
| §9.1 | Staging dry-run with seeded production-shape data + buffer | 2 |
| **Total v1.1** | | **~28h** |

### 12.3 Combined

**Total:** ~44h ≈ 5.5 working days, split across two releases.

**Comparison to the previous (synchronous) spec:** the previous spec was 27.5h ≈ 3.5 days for a single-release synchronous wipe. The split adds ~16h (mostly: the schema + 3 endpoints + the login block + the pending-deletion screen + the worker + the FK migration + the sole-admin re-check). The added cost buys: a cancel path, a worker we can monitor, the 5-day operational buffer, the FK migration, and a v1.0 that ships in 2 days instead of 3.5.

---

## 13. Open questions

1. **Statutory retention period.** Locked at 8 years in disclosure copy. CA confirmation still pending. If CA says 6 or 10, only the §7 copy changes (one-line); v1.1 code is retention-period-agnostic — it just stops at "anonymized," and a future 8-year-from-now job permanently deletes.

2. **Email service for confirmation + final emails.** Existing helper [packages/api/src/utils/email.ts](../packages/api/src/utils/email.ts) is nodemailer-based and currently exports `sendOtpEmail`. Need a generic `sendEmail(to, subject, html, text)` or two new helpers (`sendAccountDeletionRequestEmail`, `sendAccountDeletionCompletedEmail`). Verify on implementation; if a generic doesn't exist, the wrap is ~30 min — already in the §12 estimate.

3. **`AuditLog` row for the deletion request itself.** Currently v1.0 inserts only the `AccountDeletionRequest` row. Should we ALSO write an `AuditLog` entry at request time (separate from the v1.1 completion entry)? Recommended: yes — `action='user.account.deletion_requested'`, `details={requestId, scheduledCompletionAt}`. Cheap; helps the eventual audit log for DPDP grievance redressal. Confirm.

4. **Cron schedule timezone.** Current cron jobs run at "server local time" per [overdueInvoicesJob.ts](../packages/api/src/jobs/overdueInvoicesJob.ts). EC2 prod has `TZ=Asia/Kolkata` per CLAUDE.md PRODUCTION STATE. Worker should run at IST 00:30. Confirm node-cron's parsing matches (it does — verified in existing job).

5. **Customer-on-Customer references (e.g. husband/wife B2B account, husband as contact on wife's record).** Recommended: leave — contacts are operational metadata, not the deleting user's "owned" PII. Confirm.

6. **Idempotency response code for `GET /deletion-request` after completion.** Once v1.1 anonymizes the user, the request row is `status='completed'` but the user can no longer authenticate (email anonymized). So this endpoint is unreachable post-completion. No code path needs to handle the case — confirm we're OK leaving it undefined.

7. **Customer cascade with multiple Users.** Is multi-user-per-Customer actually used in production? If "no," the §3.2.3 / §10 cascade check (anonymize Customer only if no other Users link to it) is dead defence. If "yes," we need explicit integration coverage.

8. **`ContactSubmission` deferred to v1.2 — explicit acknowledgement.** Confirm we are OK deferring opportunistic anonymization of pre-auth lead-form rows matching the deleted user's phone/email. They are NOT in the JWT-authenticated user's "owned data" by strict reading of DPDP §12.

9. **Concurrent web session.** With the auth-middleware login block in §5, a web session held by the same user gets 403'd on its next API call and the web client should detect `error === 'account_pending_deletion'` and redirect to a web equivalent of Screen 5. Web-side changes are NOT in scope for v1.0 iOS submission, but they should be tracked for the next web release. Confirm scope.

10. **Real-time NIC reversal for already-filed IRN.** v1.1 anonymizes the Customer row but RETAINS the Invoice row (with `gstin` on it for GSTR-1 audit). The Apple disclosure says "personal information removed" — does a customer's GSTIN/name/address on a retained NIC-filed invoice count as "personal information"? My read: no — it's a tax document under the "legitimate legal purposes" exemption. CA + legal sign-off on the disclosure copy is still recommended before App Store submission.

---

## Appendix A — Privacy Policy + Store Metadata

`mygaslink.com/privacy` currently states "Account deletion is processed within 30 days." This MUST be updated before v1.0 ships, and the disclosure must match §7 verbatim. Owner: Suneel (content) + dev (publish).

App Store Connect → "App Privacy" → "Account Deletion" → "Yes, in-app." Data Retention section should mention the 30-day request window AND the 8-year anonymized retention.

Google Play Console → "Data Safety" → same disclosures.

---

*End of spec. Implementation should produce two WI specs (`/work-new`) referencing this document — one for v1.0 (iOS ship-blocker) and one for v1.1 (must follow within 25 days).*
