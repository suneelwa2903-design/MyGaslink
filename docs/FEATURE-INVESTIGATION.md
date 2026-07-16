# Feature Investigation — Customer Group Portal / Proof of Collection / B2C EWB Toggle

**Status:** READ-ONLY investigation. No code or DB changes were made.
**Scope confirmation:** monorepo layout is `packages/api`, `packages/web`, `packages/mobile`, `packages/shared` (not `apps/*`). All paths below use the real layout.
**Author:** Claude — investigation-only pass at `main @ a54d6c8`.

Cross-cutting summary before the per-feature detail:

- **Feature A (HQ portal)** is a mostly-additive, multi-tenant-sensitive read-surface expansion. Auth stack is uniform enough to accept a new role; scoping discipline (anti-pattern #13) is the main risk.
- **Feature B (proof of collection)** is the highest-blast-radius of the three. `confirmDelivery` is one atomic Prisma transaction covering inventory / invoice / ledger / GST-trigger — proof capture must not enter that critical path. Also: signature/photo capture WAS previously built, deleted in `6abbb23` on 2026-06-19, and CLAUDE.md + `docs/IOS-PHASE0-GROUND-TRUTH.md` are stale on this point.
- **Feature C (B2C EWB toggle)** is small in code volume but structurally exposed to the anti-pattern #12/#15 shape — three services (`gstPreflightService`, `gstService`, `gstReissueService`) each maintain their own `Distributor` select and must all be updated in the same commit or the flag silently misbehaves platform-wide.

---

## Feature A — Customer Group Portal

Goal: one HQ login can read (never write) invoices / orders / ledger for N sub-customers of the same corporate parent (e.g. "Vanasthali HQ" → Branch A, B, C), still tenant-isolated.

### A1 — Current auth and customer model

**Role enum — single source at `packages/api/prisma/schema.prisma:14`:**
```prisma
enum UserRole {
  super_admin
  distributor_admin
  finance
  inventory
  driver
  customer
}
```
Mirrored in `packages/shared/src/enums/index.ts` (anti-pattern #9 discipline — both must be kept in lockstep).

**`User` model (`schema.prisma:489`) is the single auth table for every role.** Relevant nullable FKs: `distributorId String?`, `customerId String?`. A `customer`-role user is pinned to exactly ONE `Customer` row — this is the central schema gap the HQ feature must close.

**`Customer` model (`schema.prisma:571`)** — key fields: `distributorId`, `customerName`, `businessName`, `gstin`, `customerType` ("B2B"/"B2C"), `phone` (required), `email`, `creditPeriodDays`. **No `parentId` / `groupId` / `chainId` / any "group" concept exists** (grep confirmed zero matches).

**Auth flows — only one JWT-issuing path.** `packages/api/src/services/authService.ts:65-81` `generateTokens(payload)` is the only production `jwt.sign` call site. `POST /api/auth/login` handles all 6 roles identically, differentiated only by the `User.role` value and which of `distributorId`/`customerId` is populated.

**`JwtPayload` (`packages/shared/src/types/index.ts:43-49`):**
```ts
{ userId, email, role, distributorId: string | null, customerId: string | null }
```
`authenticate()` middleware (`middleware/auth.ts:41-113`) re-fetches the `User` row on every request and reconstructs `req.user.distributorId`/`customerId` from the fresh DB row (not blindly trusting the token). Good defense-in-depth precedent — the same "resolve from DB per request" pattern applies to how a group's visible-customerId set should be resolved (see A3 recommendation below).

**Customer-portal login already exists:** `packages/api/src/routes/customerPortal.ts` (827 lines) mounted at `/api/customer-portal`, gated with `requireRole('customer')` + explicit `if (!req.user!.customerId) return sendError(...)` guards. Login itself still goes through the universal `/api/auth/login`.

### A2 — Data scoping patterns

Every function in `customerPortalService.ts` and the customer-portal-adjacent paths of `paymentService.ts` take `distributorId, customerId` as **explicit parameters** — the service layer does not hardcode "read customerId off req.user." This is the pivotal architectural fact for Feature A: the entire read surface can be reused verbatim, per-customer, by a group router.

Five representative safe scoping patterns:

1. `getMyOrders()` — `{ customerId, distributorId, deletedAt: null }` (customerPortalService.ts:167)
2. `getMyOrderById()` — `findFirst({ where: { id, customerId, distributorId, deletedAt: null } })`
3. `getMyInvoices()` — `{ customerId, distributorId, deletedAt: null, isGaslinkBilling: false, OR: INVOICE_VISIBILITY_OR }`
4. `getCustomerLedger()` — `paymentService.ts:398-415` — validates customer belongs to tenant first, then lists ledger by `{ distributorId, customerId }`.
5. `getMyBalance()` — `customerInventoryBalance.findMany({ where: { customerId, customer: { distributorId, deletedAt: null } } })` — notable because `CustomerInventoryBalance` has no own `distributorId` column and must reach tenant transitively.

**One IDOR-adjacent shape spotted (not currently exploitable, but the pattern the HQ feature must NOT reuse naively):** `reportsService.ts:764-767` and `:982-985` do `customerInventoryBalance.findMany({ where: { customerId: { in: customerIds } } })` with no `distributorId` clause. Safe today only because `customerIds` is derived a few lines earlier from a tenant-scoped `orders` query. **A group portal built by "look up the customer-id list, then query IN(...)" would inherit this exact shape and turn it into a real vulnerability if the id-list source ever regresses.** Precedent for why this matters: anti-pattern #13 (`gstinLookup.findFirst` picked a leaked cross-tenant row for 24h).

**Existing customer-portal API surface** (mounted at `/api/customer-portal`, all reads + several writes):
- **Reads (safe to re-expose to HQ):** `/dashboard`, `/orders`, `/orders/:id`, `/invoices`, `/invoices/with-gst`, `/invoices/download-summary`, `/invoices/:id`, `/invoices/:id/pdf`, `/payments`, `/payments/my-submissions`, `/payments/:id`, `/balance`, `/account`, `/distributor`.
- **Writes (must NOT be re-exposed):** `POST /orders`, `PATCH /orders/:id`, `PATCH /orders/:id/cancel`, `POST /orders/:id/dispute`, `PUT /account`, `POST /invoices/:id/create-payment-order` (Razorpay), `POST /invoices/:id/verify-payment` (Razorpay), `POST /payments/submit`.

**Razorpay integration on the customer-portal side is live** (`customerPortal.ts:523-772`): per-distributor keys (`getDistributorRazorpayCreds()`), money flows directly to the distributor's Razorpay account (never through GasLink), gated by `CROSS_CUSTOMER_ACCESS` 403 checks. **This is the specific write path a read-only HQ portal must not accidentally inherit** — it initiates real money movement.

**Ledger PDF cross-customer guard** (`routes/customers.ts:228`):
```ts
if (req.user!.role === 'customer' && req.user!.customerId !== customerId) {
  return sendForbidden(res, 'You can only download your own statement');
}
```
This is the canonical "is this MY customer id" check today. Widening it to "is this customer id in MY visible set" is the exact contract the HQ role has to satisfy anywhere it consumes shared routes — safest path is to NOT touch this shared route and add a parallel group-scoped endpoint instead.

### A3 — Regression risks

**Top `customerId`-referencing service files (top-10, of 272 total references across 19 files):**

| Rank | File | Count |
|---|---|---|
| 1 | `reportsService.ts` | 49 |
| 2 | `customerPortalService.ts` | 40 |
| 3 | `customerService.ts` | 33 |
| 4 | `orderService.ts` | 27 |
| 5 | `paymentSubmissionService.ts` | 20 |
| 6 | `paymentService.ts` | 17 |
| 7 | `invoiceService.ts` | 12 |
| 8 | `deliveryWorkflowService.ts` | 10 |
| 9 | `inventoryService.ts` | 9 |
| 10 (tie) | `accountabilityService.ts` / `stockMismatchService.ts` / `backdatedTripService.ts` | 8 each |

`reportsService.ts` at 49 refs is the biggest surface — any "consolidated HQ analytics across N branches" scope creep pulls this file in.

**Mobile + web customer surfaces today** — `packages/mobile/app/(customer)/{dashboard,orders,invoices,payments,account}.tsx` + `packages/web/src/pages/customer/{Dashboard,Orders,Invoices,Payments,Account}Page.tsx`. Actions: view (dashboard, orders, invoices+PDF, payments, balance, account, distributor contact) + write (place order, cancel, modify, dispute, edit profile, **Razorpay pay-now**, self-report payment).

### Implementation recommendation — Feature A

1. **New role `customer_hq` on the existing `UserRole` enum** — do NOT create a separate `hq_users` table. Every cross-cutting concern (`RefreshTokenSession`, `LoginHistory`, DPDP audit, account-deletion, OTP reset, lockout) is built around `users + role`; duplicating them would double maintenance. Add the enum value in the same commit to both `packages/api/prisma/schema.prisma` AND `packages/shared/src/enums/index.ts` (anti-pattern #9).
2. **Model group membership as a many-to-many join table**, not a nullable `parentCustomerId`. Concrete shape:
   ```prisma
   model CustomerGroup {
     id            String @id @default(uuid())
     distributorId String @map("distributor_id")   // groups never cross tenants
     name          String
     members       CustomerGroupMember[]
     @@index([distributorId])
   }
   model CustomerGroupMember {
     id         String @id @default(uuid())
     groupId    String @map("group_id")
     customerId String @map("customer_id")
     @@unique([groupId, customerId])
     @@index([customerId])
   }
   ```
   Add `User.groupId String? @map("group_id")` for `customer_hq` users, mirroring the existing `User.customerId` pattern. Purely additive.
3. **New router `packages/api/src/routes/customerGroupPortal.ts`** mounted at its own prefix (e.g. `/api/customer-group-portal`) with its own `requireRole('customer_hq')` gate. Contains **GET handlers only**. Do NOT add `customer_hq` to `requireRole('customer')` on the existing `customerPortal.ts` — that file mixes 8 write endpoints + 2 money endpoints on the same router object, and any future refactor could silently expose them. Second line of defense: small middleware rejecting any non-GET method reaching this mount (mirroring the `ALLOWED`-array pattern already used for the pending-deletion gate in `middleware/auth.ts:87-91`).
4. **JWT carries `groupId`, server resolves visible customerIds per-request.** Do NOT embed the customer-id list in the JWT — group membership changes, refresh tokens live up to 180 days (`REFRESH_TOKEN_SESSION_TTL_DAYS`), a stale embedded list would grant/deny wrong branches for months. Resolve `CustomerGroupMember` rows per request, scoped by `distributorId` (anti-pattern #13):
   ```ts
   const group = await prisma.customerGroup.findFirst({
     where: { id: groupId, distributorId },   // tenant-scoped
     include: { members: { include: { customer: { select: { id: true, deletedAt: true } } } } },
   });
   const visibleCustomerIds = group.members
     .filter(m => !m.customer.deletedAt)
     .map(m => m.customerId);
   // then:
   prisma.order.findMany({ where: { distributorId, customerId: { in: visibleCustomerIds }, deletedAt: null } });
   ```
   Note the DOUBLE clause (`distributorId` AND `customerId IN (...)`) — this preserves the anti-pattern #13 discipline even though the second clause widens from `=` to `IN`.
5. **Reuse vs. new endpoints.** Reusable service functions (no logic changes needed, just call them per visible id or with `customerId: { in: [...] }}` swapped in): every `getMy*` in `customerPortalService.ts`, plus `getCustomerLedger` / `computeCustomerOverdue`. New endpoints: (a) `GET /customers` — the group's member list (branch picker), (b) group-level roll-up dashboard (nothing aggregates across customers today — closest precedent is per-driver aggregation in `reportsService.ts`), (c) consolidated ledger/statement PDF if in scope (extends `customerLedgerPdfService.ts`, which today takes exactly one customerId).

### What will break / what won't (Feature A)

**Won't break** (additive-only, if the recommendation is followed):
- `customerPortal.ts` and every test that exercises it — `requireRole('customer')` is exact-match (`middleware/auth.ts:129` uses `allowedRoles.includes(...)`), so `customer_hq` is correctly rejected there.
- All 6 customer-portal test files (`customer-portal.test.ts`, `customer-portal-invoice-visibility.test.ts`, `customer-portal-payment-allocated-wire.test.ts`, `customer-portal-ob-download.test.ts`, `phaseF-razorpay-customer-portal.test.ts`, `customer-portal-order-modify.test.ts`) — none assert role-enum exhaustiveness.
- Mobile `(customer)/*` and web `pages/customer/*` — untouched; HQ is a different role, different screens.

**Will need explicit updates (regression-prone if skipped):**
- **`packages/mobile/app/index.tsx:18-43`** — role `switch` with `default: router.replace('/(auth)/login')`. A `customer_hq` user with no matching `case` bounces to login. Add `case 'customer_hq':`.
- **`packages/web/src/routes/ProtectedRoute.tsx:58-66`** — `fallback` special-cases `UserRole.CUSTOMER`; needs a `CUSTOMER_HQ` branch and its own route tree, or HQ users get redirected to `/app/analytics` (an admin-only page they'd bounce out of).
- **`packages/api/src/services/userService.ts:74`** — `where.role = { not: 'customer' as $Enums.UserRole }` (default staff-only user list). `customer_hq` would leak into the staff Users page unless this exclusion is widened.
- **`packages/api/src/services/billingService.ts:242-251`** — `customerPortalCount` is billed via `prisma.user.count({ where: { distributorId, role: 'customer', ... } })`. A `customer_hq` login won't be counted/billed unless this query or a new `BillingItemType` is added. Silent revenue-model gap — flag to product/billing owner.
- **`routes/customers.ts:223-246`** (`GET /:id/ledger/pdf`) — mixes staff + customer access with a hardcoded single-id ownership check. Safest path: leave untouched, add a parallel group-scoped endpoint instead.

### Regression-prone modules (Feature A)

Priority order:
1. `packages/api/prisma/schema.prisma` — enum + `CustomerGroup{,Member}` + `User.groupId`. Migration needed; every fixture that enumerates `UserRole` (`scripts/seed.ts`, `src/__tests__/helpers.ts`) needs an exhaustiveness check.
2. `packages/shared/src/enums/index.ts` + `packages/shared/src/types/index.ts` — must be updated in same commit as the Prisma enum.
3. `packages/api/src/middleware/auth.ts` — `authenticate()` / `requireRole()` / `resolveDistributor()`. Adding `groupId` is additive but all 3 sites building `req.user` (authenticate line 72, both `jwtPayload` literals in `authService.ts`) must stay in sync.
4. `packages/api/src/services/authService.ts:235-241, 309-315` — JWT payload construction; both must add `groupId`.
5. `packages/api/src/services/userService.ts:74` — default customer/driver exclusion.
6. `packages/api/src/services/billingService.ts:242-251` — seat billing count.
7. `packages/mobile/app/index.tsx` + `packages/web/src/routes/ProtectedRoute.tsx` — role-based redirect switches.
8. `packages/api/src/routes/customers.ts:223-246` — the shared ledger PDF endpoint (leave alone).
9. `packages/api/src/services/reportsService.ts` — if group analytics scoped into feature.
10. `packages/api/src/routes/customerPortal.ts` — MUST NOT be extended with `customer_hq` in any `requireRole()` call.

---

## Feature B — Proof of Collection

Goal: capture one or more of (signature / photo / OTP) at delivery time and (optionally) render on the invoice PDF.

### Executive framing (must read before B1)

1. **This feature was already built once and ripped out.** Commit `6abbb23` (2026-06-19, "remove receipt photo upload + delivery proof camera") deleted `DeliveryProofCamera.tsx`, `expo-camera`, camera permissions from `app.json`, and the full S3 presigned-upload pipeline (`packages/api/src/lib/s3.ts`, `@aws-sdk/client-s3`, 3 upload endpoints). Commit message: the old delivery-proof photo was **"a placebo — captured to React state, never sent to the API, never persisted, never viewed by anyone."** Any new implementation can recover the deleted S3 design almost verbatim (`git show 6abbb23^:packages/api/src/lib/s3.ts`).
2. **`deliveryLatitude`/`deliveryLongitude` already exist end-to-end** in schema, Zod, and the `confirmDelivery` service — but the mobile UI never populates them. `expo-location` is installed and used only for a separate driver-tracking ping. Wiring location into the existing confirm-delivery call is near-zero-cost.
3. **CLAUDE.md and `docs/IOS-PHASE0-GROUND-TRUTH.md` are stale on this topic** — both still describe `expo-camera`, `DeliveryProofCamera.tsx`, `NSCameraUsageDescription`, and `lib/s3.ts isOwnedPaymentAttachmentUrl` as if live. They aren't (2026-06-19 removal postdates both doc snapshots). Do not plan off those docs; code is ground truth.
4. **No OTP-to-customer-phone channel exists.** The only OTP is email-based password reset for `User` accounts. Zero SMS/WhatsApp integration, no AiSensy, no abstract notification service to plug into.
5. **`Customer.phone` is required but not validated as deliverable.** Zod checks 10–15 chars only; seed data uses `9999999999`. Bulk CSV import rejects empty phone but accepts anything else.
6. **PDF is PDFKit programmatic drawing, not HTML/Puppeteer.** Embedding a signature/photo is easy (`doc.image()` already used for the GST QR code), but raw phone JPEGs would balloon PDF size 50-200× — needs client-side compression before embed.
7. **`confirmDelivery` is a single atomic `prisma.$transaction`** touching orders, order_items, inventory_events, customer_inventory_balances, cancelled_stock_events, invoices, invoice_items, customer_ledger_entries — plus fires GST processing + SSE after commit. Any proof capture must be **before or inside** this atomic step, not layered on after.

### B1 — Current delivery confirmation flow

**Mobile:** `packages/mobile/app/(driver)/orders.tsx` (~870 lines, single file, no separate `deliver.tsx`). Bottom-sheet modal captures per-cylinder **delivered qty** (client-clamped to ordered qty), **empties collected**, and free-text **notes**. Client-side guards: WI-109 zero-qty block, WI-104 mismatch-confirm dialog. Submits to `POST /orders/:id/confirm-delivery` with `{ items, notes }` — no photo, signature, location, or OTP field is sent today. **Offline queue** (`packages/mobile/src/services/deliveryQueue.ts`, SecureStore-backed) already carries `deliveryLatitude`/`deliveryLongitude` optionally but they're dead-but-plumbed.

**API route + Zod:** `packages/api/src/routes/orders.ts:489-504` → `orderService.confirmDelivery()`.
`deliveryConfirmationSchema` (`packages/shared/src/schemas/index.ts:358-374`):
```ts
{
  items: [{ cylinderTypeId, deliveredQuantity, emptiesCollected }],   // min 1, at least one > 0
  deliveryLatitude?: number,
  deliveryLongitude?: number,
  notes?: string (max 500),
}
```
Lat/lng already in contract; only mobile UI gap.

**Atomic transaction** (`orderService.ts:833-1260`, lines 972-1183 are the tx body):

| Table | Write |
|---|---|
| `order_items` | `deliveredQuantity`, `emptiesCollected` |
| `orders` | `status`, `totalAmount`, `deliveredAt`, `deliveryLatitude`, `deliveryLongitude`, `deliveryNotes` |
| `order_status_log` | one row |
| `inventory_events` | delivery debit + collection credit per item |
| `customer_inventory_balances` | upsert `withCustomerQty` |
| `cancelled_stock_events` | one row per short-delivered item |
| `invoices` + `invoice_items` + `customer_ledger_entries` | via `createInvoiceFromOrder(tx, ...)` — called INSIDE the same tx |

After commit (fire-and-forget): inventory summary rebuild, GST reissue-or-fresh-process, `notifyDriver` SSE emit.

**Implication:** proof must be captured client-side and uploaded to S3 **before** the confirm-delivery call fires; only a lightweight reference (S3 key, `otpVerified: true`) rides in the body — mirrors `PaymentSubmission.attachmentUrl` pattern.

### B2 — Mobile permissions and capabilities

**Full `app.json` permissions today:**
- iOS: only `NSLocationWhenInUseUsageDescription`. No camera, no photo library, no mic.
- Android: only `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION`. No camera, no mic.

`expo-notifications` package is listed but plugin entry deliberately removed from `plugins[]` (CLAUDE.md — Apple entitlement-without-handler avoidance).

**`expo-location`** installed (`~19.0.8`), used only in `packages/mobile/src/services/location.ts` for driver breadcrumb tracking (`Location.Accuracy.Balanced`, 60s POST to `/drivers/location`). Never invoked from `(driver)/orders.tsx`.

**Camera / image capture:** none. `expo-camera` and `expo-image-picker` are NOT in `packages/mobile/package.json`. Only camera-related code is `packages/mobile/src/__tests__/microphonePermissions.test.ts` — a regression-guard about the removed feature.

**S3 upload flow:** does not exist. `packages/api/src/lib/s3.ts` was deleted; `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` are NOT in `packages/api/package.json`. Recoverable via `git show 6abbb23^`. Deleted design (reusable verbatim):
- Presigned PUT (5-min expiry), client PUTs directly to S3; API returns CloudFront read URL.
- Path convention: `payment-attachments/${distributorId}/${uuid}.jpg` — distributorId from JWT only, regex `/^[a-zA-Z0-9_-]{1,128}$/`, Content-Type pinned to `image/jpeg`.
- `isOwnedPaymentAttachmentUrl(url, distributorId)` — server-side validator before trusting client-submitted URLs.
- `payment_submissions.attachment_url String?` column was deliberately kept as a dead column when the feature was removed, so re-adding costs zero migration.

### B3 — PDF generation baseline

Stack: **PDFKit** (`"pdfkit": "^0.17.0"`), NOT Puppeteer, NOT HTML templates. Programmatic drawing with manual Y-cursor bookkeeping.

`packages/api/src/services/pdf/invoicePdfService.ts` sequence: `drawHeader` → `drawParties` → `drawItemsTable` → `drawTotals` → `drawComplianceSection` (IRN/EWB cards + QR code via `doc.image()`) → `drawFooter`. Page overflow already handled generically.

**Injection points already exist** (return-0-when-absent pattern):
- `drawComplianceSection` — `if (!hasIrn && !hasEwb) return 0`
- Self-collection caption — `if (meta.isGodownPickup)`
- Opening-balance certificate — separate simplified layout

A `drawProofSection(doc, proof, startY): number` slot fits naturally between `drawComplianceSection` and `drawFooter`.

**PDF size baseline:** current invoice is mostly vector/text + one small PNG (QR code, 95px width, a few KB). Typical invoice is tens of KB.

**Photo embedding risk:** `doc.image()` embeds JPEGs largely as-is (no auto downscale). Full-res phone photo (typically 1.5–3 MB at 2000-4000px @ 80% quality) would multiply invoice PDF size 50–200×. Old `DeliveryProofCamera.tsx` captured at `quality: 0.7` but did NOT resize — quality knob alone is insufficient. Resize+recompress to ~500×375px @ 60-70% JPEG typically lands at 30-80 KB.

### B4 — OTP infrastructure

**AiSensy / WhatsApp:** not integrated anywhere in `packages/api/src`. Only WhatsApp string hit is a comment about a client-side share button. `LSApplicationQueriesSchemes` in `app.json` lists only `mailto`, `tel`.

**Existing OTP flow:** `authService.ts:403-520`, password-reset ONLY, email delivery via `sendOtpEmail` (nodemailer), 10-min expiry, bcrypt-hashed on the `User` row. Rate-limited (`forgotPasswordLimiter`).
```ts
const OTP_EXPIRY_MINUTES = 10;
const otp = generateOtp();                     // 6-digit crypto-random
const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
await prisma.user.update({ data: { resetOtp: otpHash, resetOtpExpiresAt: ... }});
await sendOtpEmail(user.email, otp, userName);
```
Reusable as a **library helper** (crypto-random, bcrypt-hash, expiry). Not reusable as a **channel** — email transport tied to `User` row, not `Customer`.

**Abstract notification/messaging service:** does not exist. `utils/email.ts` is a concrete nodemailer wrapper with its own `EmailLog` audit table and typed `EmailLogType` union — a *single-channel* audit pattern that a new `SmsLog`/`WhatsAppLog` would mirror, but there's no shared interface today. `sseManager.ts notifyDriver` is real-time in-app push, foreground-only, not usable for OTP-to-customer.

**Conclusion: OTP-to-customer-phone is 100% new integration work.** Pick provider (AiSensy for WhatsApp templates, or MSG91/Twilio for SMS), replicate the `email.ts` shape from scratch — no existing abstraction to slot into cleanly.

### B5 — Customer phone data

**Schema** (`schema.prisma:571`): `phone String` — required, no DB-level format constraint.

**Zod** (`packages/shared/src/schemas/index.ts:16-19`):
```ts
z.string().min(10).max(15)   // shape only, no deliverability check
```

**Population reality:**
- `POST /api/customers` — phone required.
- Bulk CSV import — `customerService.ts:718-721` requires normalised phone; `normalisePhone()` tolerates Excel scientific-notation mangling (`9.88E+09`), strips `+91`/spaces/hyphens/leading apostrophes, but **no validity check beyond "non-empty after stripping."**
- Seed data (`packages/api/prisma/seed.ts:34`) uses placeholder `9999999999`.
- Import pipeline uses phone as a de-facto natural key for upsert-by-phone matching — a bad phone can silently merge two real customers.

**Failure mode for OTP-to-customer is NOT "field is null":** it's "field is a landline / office receptionist / stale SIM / typo." None caught by current validation. **OTP verification MUST have a graceful skip-with-reason fallback (signature or photo), or a single bad phone strands the delivery.** This is not an edge case — it's the default state of the customer master today.

### B6 — Regression risk (highest of the three features)

**Test files exercising `confirmDelivery`:**

| File | Approx. cases | `confirmDelivery` sites |
|---|---|---|
| `over-delivery-guard.test.ts` | 5 | 5 |
| `wi109-zero-qty-delivery.test.ts` | 5 | 1 |
| `duplicate-notification-fix.test.ts` | 6 | 5 |
| `godown-pickup.test.ts` | 17 | 6 |
| `gst-dispatch-trip.test.ts` | 23 | 5 |
| `dva-timestamp-reset.test.ts` | 4 | 3 |
| `onboarding-and-imports.test.ts` | 11 | 6 (incidental) |
| `inventory.test.ts` | 13 | 1 |
| `gst-invoicing.test.ts` | 24 | 1 |
| `workflow.test.ts` | 20 | 1 |
| `services/orderService.sse.test.ts` | 5 | 1 (dedicated SSE-emit assertion) |

**~35-40 distinct call sites across 11 files.** Widest test surface in the codebase for any single mutation.

**Full-sequence coverage:** `gst-dispatch-trip.test.ts` and `godown-pickup.test.ts` are the most complete order→dispatch→deliver→invoice/GST→ledger exercises. `orderService.sse.test.ts` pins the SSE-emit contract narrowly.

**Specific invariants proof capture could break:**

1. **Idempotency (`orderService.ts:865-889`).** Duplicate `confirmDelivery` calls: exact-match quantities → 200 no-op, mismatch → 409. **Proof fields are NOT in that comparison.** Decide explicitly whether a retry with same quantities + different proof should 409, silently ignore, or overwrite. Getting it wrong reopens the "driver retries after uncertain network" scenario the offline queue produces routinely.
2. **Atomicity.** All writes in one `prisma.$transaction`. Naively adding a synchronous external call inside (e.g., an OTP-provider verification) violates anti-pattern #12 — external failure could roll back inventory/invoice/ledger writes that should have committed, or leave partial state.
3. **EWB pending-state ordering (anti-pattern #20).** Post-commit GST reissue/process fires asynchronously; any new fire-and-forget added by proof capture must use the same `.catch(logger.warn)` convention or unhandled rejections crash the handler after client got 200.
4. **Ledger balance (anti-pattern #24).** `createInvoiceFromOrder` is wrapped in `try {} catch {}` so invoice failure never blocks delivery. Proof capture must not make invoice creation more likely to fail (don't gate it on photo upload / OTP check inside the tx) — that would silently suppress ledger entries for legitimately-delivered orders.
5. **SSE-emit (anti-pattern #19, WI-100 Gap A pattern).** Any proof-status field the mobile app reads via TanStack Query needs its `notifyDriver`/`notifyDistributor` emit in the same commit as the DB write, or the client cache is stale for 30s+.
6. **Over-delivery / zero-qty / godown-pickup guards** run BEFORE the transaction and only inspect `data.items`. Low risk if proof fields are added as siblings to `items`/`notes` in the Zod schema, not nested inside `items[]`.

### Implementation recommendation — Feature B (per method)

**Common: separate `delivery_proofs` table** (mirrors `PaymentSubmission` staging-table precedent from anti-pattern #23/#24):
```prisma
model DeliveryProof {
  id            String   @id @default(uuid())
  orderId       String   @map("order_id")
  distributorId String   @map("distributor_id")   // tenant scope, per multi-tenant rule §5
  proofType     ProofType                          // signature | photo | otp
  s3Key         String?  @map("s3_key")
  otpHash       String?  @map("otp_hash")
  otpExpiresAt  DateTime? @map("otp_expires_at")
  otpVerifiedAt DateTime? @map("otp_verified_at")
  capturedAt    DateTime @default(now())
  capturedBy    String   @map("captured_by")       // driver userId
  @@index([distributorId, orderId])
}
```
Do NOT bolt nullable columns onto `orders` — that inflates the highest-blast-radius table and locks in a "one proof type per order" schema decision prematurely.

#### Signature capture
- **Storage:** SVG path or PNG → S3 under `delivery-proofs/${distributorId}/${orderId}/signature-${uuid}.png`. Presigned PUT + ownership validator (verbatim from `6abbb23^`). Persist S3 key only.
- **When:** in-modal signature pad, upload completes before the `confirm-delivery` POST fires; only the key rides in the body.
- **Rollout: SHIP FIRST.** Lowest infra dependency (no new device permission), lowest App Store scrutiny (in-app canvas, not a device sensor), closest to existing precedent (QR code embed).
- **Mandatory/optional:** per-distributor toggle (add a `distributor_settings` EAV key OR a new column — see Feature C recommendation, likely a column). Default to optional.
- **App Store risk:** none new (no permission).
- **PDF:** embed directly at small size, same treatment as existing QR code.

#### Photo capture
- **Storage:** S3 same convention, `photo-${uuid}.jpg`.
- **Compress before upload** with `expo-image-manipulator` (new dep). Resize client-side to max 1200px long edge BEFORE upload — keeps S3/CloudFront costs down and gives PDF embed a small source.
- **When:** same modal, same "before confirm-delivery POST" timing.
- **Rollout: SHIP SECOND**, after signature. Requires resurrecting camera permission — new App Store Connect privacy nutrition label declaration and a new first-run driver permission prompt. CLAUDE.md v1.1 backlog item "config plugin with manifest merge `tools:node="remove"` to drop `RECORD_AUDIO`" (currently marked half-day, low priority) MUST be scheduled with this reinstatement, not after — reinstalling `expo-camera` re-tacks-on `RECORD_AUDIO` in the Android manifest merge.
- **Mandatory/optional:** same per-distributor toggle; likely "signature OR photo OR both."
- **App Store / Play Store risk:** yes. New declarations required: `NSCameraUsageDescription`, Android `CAMERA` permission, App Store Connect Photos/Camera privacy label. The 2026-06-19 removal explicitly noted "one less first-install permission prompt, ~3-5 MB smaller AAB" as removal benefits — re-adding should be a deliberate, justified trade.
- **DPDP / account-deletion posture:** `docs/IOS-ACCOUNT-DELETION-SPEC.md`'s 46-model anonymization audit at line 770 covers `Order.deliveryLatitude/Longitude` (retain on delivered = delivery proof). **It does NOT cover a new `delivery_proofs` table or photo S3 objects.** This is a real gap that must close before this ships: (a) add a retention/anonymization row for `delivery_proofs` (photos of premises/cylinders/docket likely contain PII — faces, plates, address plaques), (b) the account-deletion worker needs an S3-object-deletion step that does not exist anywhere in the codebase today (the deleted `lib/s3.ts` had `deletePaymentAttachment()` but was "not wired into any route... for a future cleanup job").

#### OTP (customer phone)
- **Storage:** bcrypt-hashed on `delivery_proofs.otpHash`/`otpExpiresAt`/`otpVerifiedAt`. Never plaintext, never in logs. Match `authService.ts` OTP pattern (`generateOtp()` + `bcrypt.hash` + 10-min expiry).
- **When:** sent to customer phone before/at modal-open; driver enters code the customer reads out; verified client-side gates "Confirm Delivery" button; only `otpVerified: true` rides in the confirm-delivery POST body.
- **Rollout: SHIP LAST**, and only after real SMS/WhatsApp gateway exists. Zero infrastructure today — net-new external-vendor integration (procurement, API keys, WhatsApp Business template approval, delivery-receipt webhooks) before any code.
- **Mandatory/optional:** must default to optional even after gateway exists, with hard graceful-fallback (signature or photo, or admin override) when OTP undeliverable. Bad phone is the default state (§B5).
- **App Store risk:** minimal on its own (no device permission — server-side integration + text-input UI). If WhatsApp channel, `LSApplicationQueriesSchemes` needs `whatsapp` scheme only if the app ever needs to *open* WhatsApp; passive receipt of server-sent messages needs no scheme.

### App Store / Play Store risk assessment (Feature B)

- **Signature:** none new — pure in-app canvas.
- **Photo:** requires re-declaring camera permission + updating both stores' privacy labels. Must also address the returning `RECORD_AUDIO` manifest tombstone with a config plugin, or the Play Console warning that was just resolved returns.
- **OTP:** minimal — server-side integration; only client change is a text input.

**Cross-cutting:** DPDP account-deletion spec must be extended with a `delivery_proofs` row + S3-object-deletion worker step BEFORE any of the three methods ship. No S3-delete code exists anywhere in the tree today.

### GPS accuracy and reliability notes

Only existing GPS usage (`src/services/location.ts`, `Accuracy.Balanced`, ~100m typical) targets driver breadcrumb tracking. For a discrete "where was this delivery confirmed" one-shot, switch to `Accuracy.High` (~10-30m depending on GPS chip / clear sky view). Realistic India expectations: dense urban 10-20m with multi-path degradation, semi-urban best case 5-15m, rural may see slow A-GPS cold start (multi-second delay before accuracy stabilises). Don't over-promise "pinpoint" in customer copy.

### Photo-on-invoice recommendation

**Embed a fixed-size thumbnail (~400×300px, JPEG 65-70%, target 30-60 KB), not full-res, not link-out.**
- Full-res would bloat 50-200× (B3.3).
- Link-out is defensible fallback for distributors worried about size, but a self-contained document is much better customer experience (archived/emailed/printed evidence needs no click-through).
- Separate PDF page is unnecessary complexity for one image — reserve only if a distributor wants multiple photos per delivery.

### What will break / what won't (Feature B)

**Will break or need explicit updates:**
- `orderService.ts:confirmDelivery` — idempotency branch (865-889) doesn't compare proof fields; naive add risks silent drop on retry OR 409 on legitimate re-sync where only proof differs.
- `services/orderService.sse.test.ts` — SSE-emit contract; new async post-commit steps must not disturb the pinned `notifyDriver` shape/ordering.
- All 6 `confirmDelivery`-calling test files — any signature change (new required param, new thrown error) needs all six updated in same commit.
- `packages/mobile/src/services/deliveryQueue.ts` — offline queue's `QueuedDelivery` type carries lat/lng optionally; adding proof means SecureStore-serialised JSON must handle proof data. **SecureStore Android caps ~2KB per key** (per that file's own comment) — a base64 photo/signature CANNOT be queued the same way. Only the post-upload S3 key can be queued. Meaning: **proof upload itself cannot be deferred by the existing offline queue** — driver in a dead zone either blocks on connectivity for the S3 upload, or a new local-file-then-background-sync mechanism must be built. Not "reuse `deliveryQueue.ts` as-is."
- `docs/IOS-PHASE0-GROUND-TRUTH.md` + CLAUDE.md WI-PENDING-PAYMENTS section — need a documentation sweep independent of this feature (describe removed code as if live).
- `docs/IOS-ACCOUNT-DELETION-SPEC.md` — needs a `delivery_proofs` row + S3-delete step.

**Won't break (isolated / low risk):**
- `deliveryWorkflowService.customerConfirmDelivery` (customer dispute flow) — unaffected unless proof is later surfaced there deliberately.
- GST/EWB cancellation-order invariants (anti-pattern #20) — proof doesn't touch payload builders.
- `invoicePdfService.ts` existing sections — `drawProofSection` is additive; existing "return 0 height when absent" convention keeps blast radius small.
- `PaymentSubmission` flow — entirely separate, no shared code path.

### Regression-prone modules (Feature B)

- `packages/api/src/services/orderService.ts` — `confirmDelivery` (highest risk).
- `packages/api/src/routes/orders.ts` — the `deliveryConfirmationSchema`-validated route.
- `packages/shared/src/schemas/index.ts` — `deliveryConfirmationSchema`.
- `packages/mobile/app/(driver)/orders.tsx` — sole screen driving the flow.
- `packages/mobile/src/services/deliveryQueue.ts` — SecureStore 2KB cap is a hard constraint.
- `packages/api/src/services/gst/gstReissueService.ts` — `reissueForDeliveryMismatch` invoked from post-commit block.
- `packages/api/src/services/invoiceService.ts` — `createInvoiceFromOrder` inside the tx, writes ledger.
- `packages/api/src/services/pdf/invoicePdfService.ts` — insertion point + size anchor.
- `packages/api/src/__tests__/services/orderService.sse.test.ts` — SSE-emit contract pin.
- `packages/api/src/services/deliveryWorkflowService.ts` — adjacent dispute flow.
- `docs/IOS-PHASE0-GROUND-TRUTH.md`, `CLAUDE.md`, `docs/IOS-ACCOUNT-DELETION-SPEC.md` — doc drift + DPDP gap.

---

## Feature C — B2C EWB Toggle

Goal: distributor-level `b2c_ewb_enabled` flag (Super Admin-managed) — some distributors have GST activated but B2C volume below EWB threshold and don't want mandatory EWB generation for B2C orders.

### C1 — Current settings model

**`DistributorSettings` does NOT exist as a wide model.** Only an EAV table:
```prisma
model DistributorSetting {
  id            String @id @default(uuid())
  distributorId String @map("distributor_id")
  settingKey    String @map("setting_key")
  settingValue  Json   @map("setting_value")
  @@unique([distributorId, settingKey])
  @@map("distributor_settings")
}
```
(`schema.prisma:1972-1984`). Known keys: `approval_workflows`, `dismissedOnboarding`.

**Wide per-distributor boolean flags actually live on `Distributor`** (`schema.prisma:370-487`):
- `gstMode: GstMode @default(disabled)` (disabled/sandbox/live)
- `isTestTenant: Boolean @default(false)`
- `billingSuspended: Boolean @default(false)`
- `gaslinkBillingEnabled: Boolean @default(false)`
- `razorpayEnabled: Boolean @default(false)`

No B2C/EWB-specific boolean anywhere today.

**Where distributor settings are READ at GST time:** `settingsService.getSettings/getSetting` are **NOT used in the GST flow** — the flow reads directly off `Distributor` via three independently-maintained narrow `select`s:

- `gstPreflightService.ts:53-57` — `DistributorGstFields = Pick<Distributor, 'id'|'gstMode'|'gstin'|'legalName'|...>`. Populated by `prisma.distributor.findUnique({select:...})` at :164.
- `gstService.ts:227-230` — `processInvoiceGst` inline `prisma.distributor.findUnique({select:{gstMode, gstin, legalName, businessName, ...}})`.
- `gstReissueService.ts:45-49` — `DistributorReissueFields` (same shape + `docCode`), own findUnique at :98.

**None include `isTestTenant` or `razorpayEnabled`** — each select is scoped to what that service needs. This is the direct source of the anti-pattern #12/#15 risk for Feature C: **adding `b2cEwbEnabled` to `Distributor` alone is not sufficient — it MUST be added to all three selects/Pick types, or the field silently comes back `undefined` (falsy) in whichever service was missed.**

**Caching:** `settingsService.ts` has zero caching (no in-memory, no Redis). GST services likewise re-query `distributor.findUnique` fresh per call. Only cache in the GST stack is the WhiteBooks auth token in `whitebooksClient.ts` — unrelated. **The new flag takes effect immediately on next request; no invalidation design needed.**

### C2 — B2C EWB code path

**B2C/B2B split is computed identically in 3+ places:**
```ts
// gstPreflightService.ts:848
const isB2C = !order.customer?.gstin || order.customer.gstin === 'URP';
// gstService.ts:246
const isB2B = !!invoice.customer?.gstin && invoice.customer.gstin !== 'URP';
// payloadBuilders.ts:201
const isB2C = !data.buyer.gstin || data.buyer.gstin === 'URP';
```

**No invoice-value gate for B2C** — comment at `gstPreflightService.ts:7`: *"B2C (gstin null/URP): standalone EWB (always — no invoice-value gate)"*. Proven by tests at `gst-preflight.test.ts:356` (₹60,000) and `:384` (₹4,000) both generating EWB.

**Enumerated B2C EWB trigger sites** (3 independent decision points + 1 manual):

| # | Site | Function | Trigger |
|---|------|----------|---------|
| 1 | `gstPreflightService.ts:940-948` → `runB2cPreflight` (`:1468-1611`) | Dispatch/preflight | Driver dispatch batch |
| 2 | `gstService.ts:668-764` (`processInvoiceGst` B2C branch, `else if (!skipEwb)`) | Post-delivery / manual | Called from `routes/invoices.ts:211` (manual "Generate GST" button), `invoiceService.ts:542` (fire-and-forget on invoice creation), `orderService.ts:1240` (confirm-delivery), `backdatedOrderService.ts:189`, `backdatedTripService.ts:271` |
| 3 | `gstReissueService.ts:402-413` → `regenerateB2cEwb` (`:630-708`) | Delivery-mismatch reissue | `reissueForDeliveryMismatch` when !isB2B |
| 4 | Cancel path (`cancelEwb`, `gstService.ts:1022`) — inert when no EWB exists, no gating needed. |

**No single chokepoint `shouldGenerateB2cEwb(distributor)` exists today** — a new flag either needs to introduce one (recommended) or be duplicated 3×.

**B2C vs B2B field divergence** (`payloadBuilders.ts`):
- `SupTyp: isB2C ? 'B2C' : 'B2B'` (:288)
- `Gstin: isB2C ? 'URP' : data.buyer.gstin!` (:316)
- No IRN ever for B2C (`gstService.ts:9`; B2C skips "Step 1: Generate IRN" and jumps to EWB-only at :668)
- Anti-pattern #14: `payloadBuilders.ts:537-635`, esp. :632 — for B2C, `shipToGSTIN`/`shipToTradeName` emitted (depot = Ship-To), `dispatchFromGSTIN`/`dispatchFromTradeName` OMITTED. `transactionType=1` for both B2B and B2C.

**The new flag must NEVER touch payload-shape logic.** It only decides *whether* the NIC call happens.

**Existing B2C EWB generation-trigger test coverage:**
- `gst-preflight.test.ts` — 3 B2C tests at `:356, :384, :414` (mock `whitebooksClient.apiCall`, assert `toHaveBeenCalledTimes(1)`, path includes `/genewaybill`).
- `gst-reissue.test.ts` — `"B2C reissue..."` :437, `"B2C zero delivery..."` :807.
- `godown-pickup.test.ts` — B2C + `isGodownPickup` → `skipEwb` (closest existing precedent for "B2C legitimately gets NO EWB").
- `gst-b2c-urp-investigation.test.ts`, `gst-payload-shape.test.ts` — payload-shape only, no generation-trigger.

**No existing test exercises a "should EWB be skipped" flag** — new test needed.

### C3 — Super Admin UI pattern

Two surfaces today:

**A. `packages/web/src/pages/DistributorsPage.tsx`** (911 lines, RHF-driven, `PUT /api/distributors/:id`). Super-admin-only fields (gated by `useAuthStore(selectIsSuperAdmin)` + mirrored server-side at `routes/distributors.ts:119-135`):
- `isTestTenant` checkbox (:773-777) — amber warning box, `{...register('isTestTenant')}`
- `razorpayEnabled` checkbox (:842-852) — local `useState`, conditionally reveals key inputs, merged into submit payload `if (isSuperAdmin)` at :408-417
- Plus: `docCode`, `subscriptionPlan`, `billingTier`, `gaslinkBillingEnabled`, bank/UPI, addresses.

**B. `packages/web/src/pages/admin/GstActivationPage.tsx`** (617 lines) — multi-step wizard for credential-bearing GST mode transitions. Overkill for a boolean.

**Copy the (A) pattern, specifically `isTestTenant`/`razorpayEnabled`:**
- `<input type="checkbox" {...register('b2cEwbEnabled')} />` in `DistributorsPage.tsx` edit form.
- Add `b2cEwbEnabled: z.boolean().optional()` to `updateDistributorSchema` in `packages/shared/src/schemas/index.ts:667+`.
- Reuse existing `apiPut('/distributors/:id', payload)` mutation — no new endpoint.
- Add strip-if-not-super-admin block in `routes/distributors.ts` alongside :119-135.
- Add to `distributorService.updateDistributor` partial type (:180-225) and `distributorSelect` (:4-56).
- Add `b2cEwbEnabled?: boolean` to `Distributor` interface in `packages/shared/src/types/index.ts:159-170`. `mapDistributor` (`utils/mappers.ts:597-600`) is a generic `renameId` pass-through — no manual mapper change.
- No new query key; extend existing distributor-detail cache invalidation.

### Implementation recommendation — Feature C

**Where the flag lives:** on `distributors` (a real column `b2cEwbEnabled Boolean @default(true) @map("b2c_ewb_enabled")`), NOT `distributor_settings`. Reasons:
1. Must be read on every dispatch/invoice/reissue — adding a `select` field to existing narrow findUnique is free; EAV would need a second query + JSON unwrap + default-fallback on every call site.
2. `isTestTenant`/`razorpayEnabled`/`gstMode` — the three most structurally similar flags — all live on `Distributor`. That's the actual convention for GST/compliance-relevant booleans.
3. Not sensitive (no PII/credentials) — CLAUDE.md plaintext-columns caveat doesn't apply. Worth calling out explicitly so it isn't bundled into any future encryption pass.

**Code sites that must consult the flag** (all three C2 decision points):
1. `gstPreflightService.ts:940-948` — the `if (!isB2C) { runB2bPreflight } else { runB2cPreflight }` branch. Gate exactly like the existing `skipEwb`/godown-pickup precedent: if `isB2C && !distributor.b2cEwbEnabled`, skip to `transitionToPendingDelivery` with `mode: 'B2C', success: true`, no `ewbNo`; do NOT call `runB2cPreflight`, do NOT touch `invoice.ewbStatus` (leave at Prisma default `not_attempted`), do NOT `createPendingAction`. Mirrors `skipEwb` behaviour for godown-pickup B2C at `gstService.ts:668-671`.
2. `gstService.ts:668` — `else if (!skipEwb)` becomes `else if (!skipEwb && distributor.b2cEwbEnabled)`. Single call site covers all 5 callers (manual button, invoice creation, confirm-delivery, both backdated flows).
3. `gstReissueService.ts:409-413` — `isB2B ? regenerateB2bIrn : regenerateB2cEwb` — if `!isB2B && !distributor.b2cEwbEnabled`, skip `regenerateB2cEwb` entirely; revision row records the quantity correction with `newEwbNo: null`.

**Must NOT touch:** IRN generation (B2C never generates IRN regardless — `gstService.ts:9`). B2B EWB/IRN logic (mutually exclusive branch — never read the flag inside `isB2B`). Payload-shape logic in `payloadBuilders.ts` (anti-pattern #14).

**Default:** `true`. Behaviour-preserving. `@default(true)` in migration = no backfill script needed. Super Admin flips per-distributor for opt-outs.

**Preventing split-brain (anti-pattern #12/#15):** The three independently-maintained selects are the exact bug shape. Recommendation:
1. Add `b2cEwbEnabled` to all three selects AND both `Pick<>` types in the SAME commit.
2. Add a guard test (anti-pattern-guards style) asserting all three services' distributor-fetch queries include `b2cEwbEnabled`. Concretely: a shared-fixture integration test seeding `b2cEwbEnabled: false` and asserting zero `apiCall` invocations from each of the three entry points (preflight, `processInvoiceGst`, reissue) in one file.
3. Because `@default(true)`, a regressed missing `select` field makes Prisma return `undefined` (falsy) → would silently **suppress** EWB generation platform-wide through that one un-updated path. Failure mode worth a dedicated test.

**New tests needed:**
- "When `b2cEwbEnabled=false`, no `apiCall` fires" for EACH of the three entry points (reuse existing `vi.mock('../services/gst/whitebooksClient.js', ...)` / `vi.mocked(whitebooksClient.apiCall)` pattern from `gst-preflight.test.ts:6-56`). Specifically:
  - Preflight — assert `apiCallMock).not.toHaveBeenCalled()`, `result.results[0].success === true`, `mode === 'B2C'`, order reaches `pending_delivery`.
  - `processInvoiceGst` — assert `result.ewb` is absent, no pending action row created.
  - Reissue — assert `newEwbNo === null`, no `EWB_GENERATION`/`EWB_REGENERATION_FAILED` pending action.
- Pending-state must NOT be created: `prisma.pendingAction.findFirst({where: {actionType: 'EWB_GENERATION', orderId}})` returns null, and `invoice.ewbStatus` stays `'not_attempted'` (not `'failed'`). Distinguishes "deliberately skipped" from the existing "NIC failed" state — important because `tryAdvanceTripAfterRetry`'s blocker query (`gstPreflightService.ts:1745-1749`) only treats `ewbStatus in ('failed','pending')` as blocking. `not_attempted` is safe and won't wedge driver trip advance.
- Wire-shape guard (anti-pattern #9): `GET /api/distributors/:id` and `PUT /api/distributors/:id` round-trip `b2cEwbEnabled`.

**Interaction with `gstMode`:** Toggle only meaningful when `gstMode !== 'disabled'` — when disabled, `processInvoiceGst` and preflight both short-circuit before reaching the B2C branch (`gstPreflightService.ts:905`, `gstService.ts:232`). Recommendation: keep the flag *settable* regardless of `gstMode` (matches `isTestTenant` precedent — settable while GST disabled), but grey out or annotate the checkbox with "Only applies once GST is activated" — avoids adding a new transition-guard class for a no-op state.

### What will break / what won't (Feature C)

**Nothing breaks by default** because of `@default(true)`. All existing B2C EWB tests keep passing unmodified (seeded distributors implicitly get `true`).

**To re-verify (not expected to change):**
- `gst-preflight.test.ts` — B2C tests :356, :384, :414 (branch condition at :940-948 being edited).
- `gst-reissue.test.ts` — `"B2C reissue..."` :437, `"B2C zero delivery..."` :807.
- `godown-pickup.test.ts` — confirm the new flag's `else if` doesn't interact badly with `skipEwb`. Both conditions must be evaluated together, not as separate nested branches, or a godown-pickup + flag-enabled B2C order could incorrectly re-enable EWB.
- `gst-b2c-urp-investigation.test.ts`, `gst-payload-shape.test.ts` — payload-shape only, unaffected. Good regression insurance the flag doesn't leak into payload construction.
- `gst-dispatch-trip.test.ts` — B2C orders for trip-advance scenarios; confirm a "flag-skipped" B2C order behaves like a successful one (`status='pending_delivery'`, `ewbStatus='not_attempted'` is NOT in the blocker list).
- `distributorSwitch.test.ts`, `settings.test.ts` (web) — unaffected unless a strict-shape assertion breaks; low risk since field is optional.

**Screens to re-verify manually:** `DistributorsPage.tsx` (add checkbox + wire), `GstActivationPage.tsx` (confirm still reads `gstMode`/`isTestTenant`), `DistributorDetailPage.tsx` (if flag surfaced read-only), driver dispatch/trip-sheet mobile screens (confirm `not_attempted` renders sensibly, not scary "pending" chip).

### Regression-prone modules (Feature C)

Ranked by blast radius:
1. `packages/api/src/services/gst/gstPreflightService.ts` — highest. Primary dispatch-time decision (:940-948), `runB2cPreflight` (:1468-1611) with Fix 4 commit-forward branches (:1576-1586), `DistributorGstFields` type/select (:53-57, :164), trip-advance blocker (`tryAdvanceTripAfterRetry`, :1673-1779).
2. `packages/api/src/services/gst/gstService.ts` — second highest. `processInvoiceGst` B2C branch (:668-764) fans in from 5 callers.
3. `packages/api/src/services/gst/gstReissueService.ts` — `regenerateB2cEwb` (:630-708) + call site (:402-413). Lower traffic but same "commit revision row regardless" pattern to preserve.
4. `packages/api/src/services/gst/payloadBuilders.ts` — NOT modified by this feature but highest historical regression risk in the GST stack (anti-pattern #14 lived here). Any refactor touching shared code here needs full payload-shape suite re-run.
5. `packages/api/src/services/distributorService.ts` + `packages/api/src/routes/distributors.ts` — write path; must add field to `distributorSelect`, `updateDistributor` partial type, AND route-level role-strip block in the same commit.
6. `packages/api/src/services/gst/apiLogger.ts` / `whitebooksClient.ts` — no logic change, but "no call fires" tests depend on `vi.mock` + `apiCallMock` scaffolding staying intact; don't let a mock-setup refactor silently make the new "skip" tests pass for the wrong reason.

---

## Cross-cutting concerns

### Shared regression risks across all three features

1. **Anti-pattern #9 (wire-shape drift).** All three features add fields (A: `groupId` on JWT + `User`, B: `delivery_proofs` + optional Zod extensions on `deliveryConfirmationSchema`, C: `b2cEwbEnabled` on `Distributor`). Every one needs the Prisma schema + `packages/shared/src/enums|types|schemas` updated in the same commit, plus a wire-shape guard test (`packages/api/src/__tests__/anti-pattern-guards.test.ts` pattern).
2. **Anti-pattern #13 (tenant-scoped queries without explicit `distributorId`).** Feature A widens `customerId = X` to `customerId IN (...)` — the widened form MUST keep an explicit `distributorId` clause. Features B and C add columns to already-scoped queries; low risk if additions follow existing selects.
3. **Anti-pattern #12/#15 (split-brain flags).** Feature C is the textbook shape (3 independent selects). Feature B's `b2cEwbEnabled`-analog toggle for proof-per-distributor (if added) inherits the same risk if implemented as EAV without a central helper.
4. **Anti-pattern #19 (SSE-emit contract).** Feature B has the highest exposure — any new proof status the mobile app reads via TanStack Query needs a matching `notifyDriver`/`notifyDistributor` in the same commit as the DB write. Feature A likely doesn't need SSE (read-only, refetch on tab focus is fine).
5. **Anti-pattern #21 (UTC date splits).** Not directly triggered by any of the three, but any new default-date field (proof `capturedAt`, group-portal report ranges) must use `localTodayISO()` from `@gaslink/shared`, never `.toISOString().split('T')[0]`.
6. **Documentation drift.** CLAUDE.md WI-PENDING-PAYMENTS section AND `docs/IOS-PHASE0-GROUND-TRUTH.md` currently describe deleted code (`lib/s3.ts`, `expo-camera`, `DeliveryProofCamera.tsx`, `NSCameraUsageDescription`) as if live. A doc sweep should precede Feature B implementation regardless.
7. **DPDP account-deletion spec (`docs/IOS-ACCOUNT-DELETION-SPEC.md`) is incomplete for Feature B.** No row for `delivery_proofs`; no S3-delete step anywhere in the codebase. Feature A adds `CustomerGroup`/`CustomerGroupMember` — those need retention/anonymization entries too. Feature C adds one boolean column — trivial (no PII).
8. **Multi-tenant billing (`billingService.ts`).** Feature A adds a new billable seat type (`customer_hq` login). Product/billing owner sign-off needed on how HQ logins are counted vs. `customer` logins.

### Recommended build order with rationale

1. **Feature C — B2C EWB Toggle first.** Smallest scope, boolean column + three select updates + one Super Admin checkbox. Behaviour-preserving default. Zero DPDP implications. Zero mobile changes. Zero App Store implications. Good confidence-builder and lets us establish the anti-pattern #12/#15 guard-test pattern for the GST stack that Feature B will benefit from.
2. **Feature A — Customer Group Portal second.** Purely additive schema + new router + new role. Zero write endpoints = zero money-flow risk. Widest test-suite touch (billing, role guards, mobile+web redirect switches) but each individual site is a small change. Independent of Feature B.
3. **Feature B — Proof of Collection last, in phases.**
   - **Phase 1: Signature only.** Lowest infra risk (no new permission, no external vendor). Establishes S3 pipeline (recovered from `6abbb23^`), `delivery_proofs` table, per-distributor toggle pattern, PDF `drawProofSection`, DPDP retention entry.
   - **Phase 2: Photo.** Reintroduces `expo-camera`. Requires App Store Connect privacy label update + `RECORD_AUDIO` manifest fix + Play Console re-review + client-side compression dep (`expo-image-manipulator`). New iOS/Android permission grants for existing driver users.
   - **Phase 3: OTP.** Only after WhatsApp/SMS gateway is procured, integrated, and delivery-receipts wired. Non-blocking on Phases 1-2.

   Rationale for last: highest blast radius (`confirmDelivery` is the most-tested mutation in the codebase, 35-40 sites across 11 files), most doc drift to clear first, and the phased rollout means each phase can ship independently without gating the next.

### Doc sweep prerequisites (regardless of build order)

Before touching Feature B code:
- Update `docs/IOS-PHASE0-GROUND-TRUTH.md` to reflect the 2026-06-19 removal (delete camera / S3 / `DeliveryProofCamera.tsx` references).
- Update CLAUDE.md WI-PENDING-PAYMENTS section to mark `lib/s3.ts isOwnedPaymentAttachmentUrl` as deleted-and-recoverable (not live).
- Add a `delivery_proofs` retention row to `docs/IOS-ACCOUNT-DELETION-SPEC.md`.

---

## Backlog: Multi-Godown

**Likely architectural entail based on current code:** the schema already has `Godown`/`GodownStock` models and inventory events already reference `godownId` in some paths (search for `isGodownPickup` and `godownStock` in `packages/api/src/services/inventoryService.ts` and `orderService.ts`). Godowns exist as first-class entities but the multi-godown-per-distributor experience is uneven — most read paths assume one godown per distributor, and dispatch/reconciliation flows are wired around a single "primary" godown. Full multi-godown likely means: (a) explicit godown selection on order create / dispatch preflight, (b) godown-scoped stock counts in reports (`reportsService.ts` — 49 `customerId` refs, likely as many aggregation sites for stock by location), (c) godown-scoped opening-balance seeding, (d) per-godown float-vs-DVA reconciliation, (e) driver assignment to a home godown (currently `Driver` has no godown FK — check schema), (f) GST implications if a godown has a distinct `dispatchFrom` address (touches anti-pattern #14 `dispatchFromGSTIN` rules and would need `payloadBuilders.ts` changes).

**Questions before scoping:**
1. Do all godowns share the same GSTIN or can they each have their own (which changes `dispatchFromGSTIN` payload logic and expands anti-pattern #14 territory)?
2. Are drivers pinned to one godown or can a driver route from any godown on a given day?
3. Do customers belong to a godown (nearest-godown routing) or is godown selected per-order?
4. What's the reconciliation story when stock is transferred between godowns of the same distributor — new event type, or reuse existing dispatch/return events?
5. Does the mobile app need a godown picker at driver login, or is godown inferred from the order?

---

## Backlog: Resellers / 3rd Party

**Likely architectural entail based on current code:** the current tenant model is strictly `Distributor → Customer` (a customer belongs to exactly one distributor). Reseller support would introduce an intermediate layer — either a `Reseller` model between `Distributor` and `Customer` (three-tier), or a `Reseller` as a peer of `Distributor` with its own commercial terms. Either way it disturbs the single-tenant-scope invariant that every route and service enforces via `distributorId = req.user.distributorId`. Very likely touches: (a) auth stack (new role `RESELLER_ADMIN` or role scoped to a Reseller entity), (b) tenant-isolation middleware (`resolveDistributor` in `middleware/auth.ts` — resellers might legitimately span multiple distributors, breaking the "one distributor per request" invariant), (c) GST/invoice generation (who's the seller of record — distributor or reseller?), (d) Razorpay routing (per-distributor keys today at `Distributor.razorpayKeyId/Secret` — where does reseller money flow?), (e) commission/margin tracking (new schema territory — no analog today), (f) `billingService.ts` seat billing (who pays for the reseller's seats?).

**Questions before scoping:**
1. Is a reseller a downstream buyer (buys from distributor, resells to end customer — invoice chain implication) or an upstream service provider (like a broker, without taking title)?
2. Does the reseller see distributor-priced or reseller-marked-up prices in the app?
3. Whose GSTIN is on the invoice to the end customer — distributor's or reseller's? (Big anti-pattern #14 territory.)
4. Do resellers get their own login/app or piggy-back on the customer portal / mobile customer app?
5. How does inventory flow — physical fulfilment still by distributor's driver, or does reseller carry own stock?
6. Are commissions tracked as ledger entries (extend `CustomerLedgerEntry` with a reseller_id?), separate tables, or off-platform?
