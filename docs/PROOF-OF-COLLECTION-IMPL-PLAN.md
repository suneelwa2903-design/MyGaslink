# Proof of Collection — Implementation Plan

**Status:** INVESTIGATION + FUNCTIONAL REQUIREMENTS ONLY. No code or DB changes.
**Baseline:** `main @ a54d6c8`.
**Builds on:** [docs/FEATURE-INVESTIGATION.md](FEATURE-INVESTIGATION.md) §B (first-pass) and [docs/ORDER-TYPE-INVESTIGATION.md](ORDER-TYPE-INVESTIGATION.md) (order-type feasibility). Only new/deeper material is repeated here.

**Feature scope (locked):**
- Applies to orders that reach the **DRIVER** confirm-delivery screen only: regular pre-orders + walk-in.
- Excluded: godown pickup (structurally excluded by null `driverId`), backdated (never reaches confirmDelivery), returns-only (out of scope), admin web/mobile confirm-delivery modals.
- Per-customer toggle: new `Customer.requireDeliveryVerification: Boolean @default(false)`. When false, delivery works exactly as today. When true, driver sees 3 options, must complete any one.
- Three methods when enabled: **Signature** (canvas + signing-party phone), **Photo** (camera → S3), **OTP** (server-generated, shown on customer app, driver types it in). If customer has no portal login, OTP generation returns a clear error → driver picks another method.
- All methods capture GPS (`Accuracy.High`) + **server** timestamp.
- Invoice PDF: small "Delivery Verified" box (method, timestamp, GPS). Signature image + signing-party phone shown for signature. OTP shows "OTP Verified" label only. Photo-on-PDF deferred to Phase 2 discussion.
- Build order: **Phase 1 Signature** → **Phase 2 Photo** → **Phase 3 OTP**.

---

## Section 1 — Contract changes needed

### 1.1 `deliveryConfirmationSchema` — additions

Current schema ([packages/shared/src/schemas/index.ts:358-374](../packages/shared/src/schemas/index.ts:358)) is a plain `z.object({...})`, which defaults to **strip mode** (extra keys silently dropped). The validation middleware replaces `req.body` with `result.data`, so adding optional fields is **additive-safe for all 4 clients** (driver mobile, admin mobile, admin web, offline queue) — old clients keep working unchanged.

Additions (all optional):
```ts
proofType: z.enum(['signature', 'photo', 'otp']).optional(),
proofS3Key: z.string().max(200).optional(),
proofSigningPartyPhone: z.string().min(10).max(15).optional(),
otpCode: z.string().length(6).optional(),
```

Business validation (which of the four fields is required together) is enforced in the service layer, not Zod — matches the existing pattern where the Zod schema declares wire shape and the service enforces cross-field invariants.

### 1.2 `Customer` model — new column

Current `Customer` model ([schema.prisma:571-632](../packages/api/prisma/schema.prisma:571)) — confirmed no `requireDeliveryVerification` exists. Add:
```prisma
requireDeliveryVerification Boolean @default(false) @map("require_delivery_verification")
```
Placement: after `stopSupply` (closest structural precedent — same shape, same default-false-safe pattern). `@default(false)` = no backfill script needed; the migration is behaviour-preserving.

**Zod flow:** add `requireDeliveryVerification: z.boolean().optional()` to `createCustomerSchema` ([schemas/index.ts:146-179](../packages/shared/src/schemas/index.ts:146)). `updateCustomerSchema` inherits automatically via `.partial().extend()` — single addition point.

**Service surface:** `customerService.createCustomer` accepts fields 1:1 with `?? default` fallbacks at [customerService.ts:154-184](../packages/api/src/services/customerService.ts:154). Add `requireDeliveryVerification: data.requireDeliveryVerification ?? false` in the same idiom.

**Route:** `PUT /api/customers/:id` at [routes/customers.ts:270-296](../packages/api/src/routes/customers.ts:270). Existing per-field role guard is only on `status` (`inventory` blocked). Product decision needed: should `inventory` be able to flip `requireDeliveryVerification`? Default: yes (inherits current unrestricted behaviour); can tighten with a second role guard mirroring `status`.

### 1.3 New `delivery_proofs` table — validated design

**Validated changes from the proposed schema:**

```prisma
model DeliveryProof {
  id                String    @id @default(uuid())
  orderId           String    @unique @map("order_id")   // one proof per order — see §1.3.1
  distributorId     String    @map("distributor_id")     // keep — see §1.3.2
  proofType         ProofType
  s3Key             String?   @map("s3_key")             // signature PNG or photo JPG on S3
  signingPartyPhone String?   @map("signing_party_phone") // signature method only
  otpCode           String?   @map("otp_code")            // plaintext; see §1.3.3
  otpExpiresAt      DateTime? @map("otp_expires_at")
  otpVerifiedAt     DateTime? @map("otp_verified_at")
  capturedLat       Float?    @map("captured_lat")
  capturedLng       Float?    @map("captured_lng")
  capturedAt        DateTime  @map("captured_at")        // no @default(now()); see §1.3.4
  capturedBy        String    @map("captured_by")        // driver userId

  order         Order       @relation(fields: [orderId], references: [id])
  distributor   Distributor @relation(fields: [distributorId], references: [id])

  @@index([distributorId, orderId])
  @@map("delivery_proofs")
}

enum ProofType {
  signature
  photo
  otp
}
```

**Validation notes:**

**§1.3.1 — `@unique` on `orderId`:** keep it. Spec says "must complete **any one**" (singular), matching one-row-per-order. Combined with `upsert()` in the write path (`{ where: { orderId }, update: {...}, create: {...} }`), driver retries with different proof become idempotent overwrites, not P2002 crashes. If product later wants multiple layered methods per order, drop the unique and switch to `@@index`; not needed for v1.

**§1.3.2 — `distributorId` alongside unique `orderId`:** keep it. Codebase precedent is explicit — `Invoice.orderId` is also `@unique` ([schema.prisma:1193](../packages/api/prisma/schema.prisma:1193)) and still carries its own `distributorId`. Same for `PaymentTransaction`, `PaymentSubmission`. Only pure line-item tables (`OrderItem`) omit `distributorId`. `DeliveryProof` will have direct tenant-scoped queries (DPDP retention sweeps, admin dashboards) → follow the `Invoice` convention.

**§1.3.3 — `otpCode` plaintext, drop `otpHash`:** proposed schema had both; keep only `otpCode` plaintext. Rationale:
- The customer app must **display** the OTP for the driver to read. A bcrypt hash can't be reversed.
- No Redis / cache layer exists in this codebase (confirmed — `settingsService.ts` and GST stack are both cache-free; the only cache is the WhiteBooks auth token in `whitebooksClient.ts`). A hash-plus-cache design would introduce net-new infra.
- Delivered via already-authenticated channel (customer must be logged into portal to see the order card). OTP is short-lived (~10 min) and single-purpose — not more sensitive than the invoice/order data already on that same card.
- Simpler leak-prevention: use a narrow `select` in the customer-portal query, not a general-purpose `orderInclude`. Discipline mirrors the Feature C anti-pattern #12/#15 narrow-select convention.

**§1.3.4 — `capturedAt` set explicitly by server, no `@default(now())`:** direct precedent — `Order.deliveredAt` ([schema.prisma:54](../packages/api/prisma/schema.prisma:54)) has no `@default(now())` and is set via `new Date()` in `orderService.ts:1007`. Ideally reuse the same `new Date()` value for both `deliveredAt` and `capturedAt` within one transaction so timestamps agree exactly. `otpExpiresAt` computed as `new Date(Date.now() + 10*60*1000)`, mirroring [authService.ts:441](../packages/api/src/services/authService.ts:441).

**Anti-pattern #21 clarification:** `capturedAt`/`otpExpiresAt` are full `DateTime` timestamps compared with `<`/`>` — the `.toISOString().split('T')[0]` anti-pattern is about date **strings**, not timestamps. `localTodayISO()` does not apply here.

### 1.4 Customer-portal `/orders` response — `otpCode` addition

Route: `GET /api/customer-portal/orders` → `customerPortalService.getMyOrders` → `mapOrders` → `mapOrder` at [utils/mappers.ts:132-174](../packages/api/src/utils/mappers.ts:132).

Add a flat alias field on the mapped order:
```ts
mapped.otpCode = <computed> ?? null;
```
Following the exact pattern of the existing `mapped.driverName = o.driver?.driverName ?? null` at :156.

**Eligibility computation lives in the service, not the mapper** (mapper is a pure flattener today, no business logic). `customerPortalService.getMyOrders` decides whether to include the OTP based on:
```
(order.status === 'pending_delivery') AND
(order.customer.requireDeliveryVerification === true) AND
(deliveryProof.otpCode !== null AND deliveryProof.otpExpiresAt > now() AND deliveryProof.otpVerifiedAt === null)
```
Include `deliveryProof: { select: { otpCode, otpExpiresAt, otpVerifiedAt } }` on the Prisma query — **narrow select, never `include: true`** — so it never leaks into any other consumer of `mapOrder`.

---

## Section 2 — New endpoints needed

Ordered by phase.

| Phase | Method | Path | Auth role | Purpose |
|---|---|---|---|---|
| 1 | POST | `/api/orders/:id/delivery-proof-upload-url` | `driver` | Issue presigned S3 PUT URL for a signature PNG (Phase 1) or photo JPG (Phase 2). Body: `{ proofType: 'signature' \| 'photo' }`. Response: `{ uploadUrl, finalUrl, s3Key }`. Server validates order belongs to `req.user.distributorId` AND the caller is the assigned driver AND `Customer.requireDeliveryVerification === true`. Mirrors the deleted `POST /me/payment-submissions/attachment-upload-url` pattern from [driversVehicles.ts (pre-6abbb23)](../packages/api/src/routes/driversVehicles.ts). |
| 1 | POST | `/api/orders/:id/delivery-proof` | `driver` | Persist proof metadata. Body: `{ proofType, s3Key?, signingPartyPhone?, otpCode?, capturedLat, capturedLng }`. Server sets `capturedAt = new Date()`, `capturedBy = req.user.userId`. Upserts by `orderId`. Called BEFORE `POST /confirm-delivery` from the driver client — decouples proof idempotency from delivery idempotency (§7 R1 mitigation). Returns `201 { deliveryProofId }`. |
| 3 | POST | `/api/orders/:id/delivery-otp/generate` | `driver` | Generate a fresh 6-digit OTP for this order. Server checks `Customer.requireDeliveryVerification === true` AND customer has a `User` row (`prisma.user.findFirst({where:{customerId, role:'customer', status:'active'}})`). If no portal login: returns `409` with `{ code: 'CUSTOMER_HAS_NO_APP', message: "Customer doesn't have the MyGasLink app installed — please use Signature or Photo instead." }`. If has login: writes `otpCode` (plaintext), `otpExpiresAt = now + 10min` to `delivery_proofs` (upserts by `orderId`) AND fires SSE-workaround → invalidates customer app's next `/orders` fetch (no `notifyCustomer` exists — see §7 R3). |
| 3 | POST | `/api/orders/:id/delivery-otp/verify` | `driver` | Driver types the OTP shown on the customer's app screen. Server compares to stored plaintext, sets `otpVerifiedAt = new Date()`. On success returns `200`. Driver's UI then enables the main "Confirm Delivery" button. |
| 1 | GET | `/api/orders/:id/delivery-proof` | `driver`, `super_admin`, `distributor_admin`, `finance` | (Optional utility) Fetch existing proof for an order — used by the driver client to check "did I already capture proof after a network drop?" before showing the capture UI again. Also used by admin surfaces later if a proof-review UI is added. Response omits `otpCode` for non-driver roles. |

**Existing endpoint touched, not new:** `POST /api/orders/:id/confirm-delivery` at [routes/orders.ts:495](../packages/api/src/routes/orders.ts:495). Only additive change is the extended Zod schema (§1.1) accepting optional proof-echo fields for backward-compat if a client sends them; the primary write path for proof metadata is the separate `/delivery-proof` endpoint above.

---

## Section 3 — Mobile changes needed (driver app)

### 3.1 Files changed

**Phase 1 (Signature only):**

| File | Change | Why |
|---|---|---|
| [packages/mobile/app/(driver)/orders.tsx](../packages/mobile/app/(driver)/orders.tsx) | Extend `DeliveryConfirmationModal` (existing, ~line 109 is the mutation call). Before showing existing qty/notes fields, fetch `order.customer.requireDeliveryVerification` (add to `driver-orders` query response) and if `true`, gate the submit button on completing one of three proof tabs (Phase 1: signature only visible; Phase 2 adds photo; Phase 3 adds OTP). On submit: (a) `getCurrentLocation({ accuracy: Location.Accuracy.High })`, (b) upload signature PNG to S3 via presigned URL, (c) POST `/delivery-proof` with `{proofType, s3Key, signingPartyPhone, capturedLat, capturedLng}`, (d) POST existing `/confirm-delivery` with existing body. | Primary UX surface |
| [packages/mobile/src/services/location.ts](../packages/mobile/src/services/location.ts) | Add `getCurrentLocationHighAccuracy()` sibling function OR add optional `accuracy` param to `getCurrentLocation()`. Currently hardcoded to `Accuracy.Balanced` (:22). | Feature spec requires `Accuracy.High` at proof capture |
| `packages/mobile/src/services/s3Upload.ts` (new) | Thin wrapper: `presignedPut(uploadUrl, blob, contentType)` — direct `fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': ct } })`. No AWS SDK on mobile. | Client-side upload to presigned URL |
| `packages/mobile/src/components/SignaturePad.tsx` (new) | Wraps a signature-pad library, exposes `onCapture(pngDataUri: string) => void`. Also captures `signingPartyPhone` in a paired text input. | Signature UI |
| [packages/mobile/src/services/deliveryQueue.ts](../packages/mobile/src/services/deliveryQueue.ts) | Extend `QueuedDelivery` type with optional `proofType`, `proofS3Key`, `proofSigningPartyPhone` (metadata only — see §7 R5). Total additions ~130-150 bytes per entry, fits comfortably in the 2KB SecureStore-per-key cap for single deliveries. NEVER put raw signature PNG bytes here — a base64 signature alone exceeds the 2KB budget. | Offline queue support (metadata only; upload can't be offline-queued) |

**Phase 2 (Photo):**

| File | Change |
|---|---|
| `packages/mobile/app.json` | Re-add `NSCameraUsageDescription` (iOS), `CAMERA` Android permission, `expo-camera` plugin entry. Re-add `NSPhotoLibraryUsageDescription` if photo library access is offered (spec is camera-only — probably not needed). |
| `packages/mobile/package.json` | Add `expo-camera`, `expo-image-manipulator` (compression). Use `npx expo install` not `pnpm add` (per feedback memory). |
| `packages/mobile/plugins/` (new custom config plugin) | Manifest merge `tools:node="remove"` on `RECORD_AUDIO` — `expo-camera` tacks it on unconditionally for the photos-only flow (per CLAUDE.md v1.1 backlog item, elevate to a hard requirement of Phase 2). |
| `packages/mobile/src/components/PhotoCapture.tsx` (new) | Wraps `CameraView` / `takePictureAsync` at max 1200px long edge, JPEG quality 0.7, then `expo-image-manipulator.resize` to enforce the cap client-side, then upload to S3 via the same presigned URL flow as signature. |

**Phase 3 (OTP):**

| File | Change |
|---|---|
| [packages/mobile/app/(driver)/orders.tsx](../packages/mobile/app/(driver)/orders.tsx) | Add OTP tab: "Send OTP to Customer" button → POST `/delivery-otp/generate`. On `409 CUSTOMER_HAS_NO_APP` → toast "Customer doesn't have the app — use Signature or Photo instead" and disable the OTP tab. On success → show input field, driver types code, POST `/delivery-otp/verify`, enable submit. |

### 3.2 New dependencies

| Package | Phase | Install command | Notes |
|---|---|---|---|
| `react-native-signature-canvas` (or equivalent) | 1 | `npx expo install react-native-signature-canvas` | Signature pad. Any equivalent Expo-compatible lib works. |
| `expo-camera` | 2 | `npx expo install expo-camera` | Was removed in 6abbb23 — re-adding |
| `expo-image-manipulator` | 2 | `npx expo install expo-image-manipulator` | New — for client-side resize/compress before S3 upload |

`expo-location` is already installed (`~19.0.8`, [package.json](../packages/mobile/package.json)) — no new install for Phase 1.

### 3.3 Permission changes

- **Phase 1:** none. `NSLocationWhenInUseUsageDescription` + Android `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` already declared in [app.json](../packages/mobile/app.json). No new App Store Connect privacy label needed. First-run permission prompt for drivers already exists (breadcrumb tracking).
- **Phase 2:** camera permission returns. Re-declare `NSCameraUsageDescription` + Android `CAMERA`. New App Store Connect privacy nutrition label declaration required. New Play Console privacy declaration required. New first-run driver permission prompt on both platforms.
- **Phase 3:** none new (server-side integration).

---

## Section 4 — Mobile changes needed (customer app)

Only Phase 3 (OTP) touches the customer app. Phases 1 and 2 have zero customer-app impact — proof capture is entirely driver-side.

### 4.1 Files changed (Phase 3 only)

| File | Change |
|---|---|
| [packages/mobile/app/(customer)/orders.tsx](../packages/mobile/app/(customer)/orders.tsx) | Add a new conditional block on the order card at ~line 588 (between the driver-name block ending at :587 and the action-buttons row starting at :589). When `order.otpCode` is present (populated only when `status='pending_delivery'` AND verification enabled AND OTP fresh — see §1.4), render a prominent "Delivery Verification Code" section with the 6-digit OTP in monospace large-font display. Copy: "Share this code with your MyGasLink driver at delivery." |

Follows the exact `{order.someField && (<View>...</View>)}` idiom already used for the driver-name block immediately above.

### 4.2 Refresh mechanism gap (§7 R3)

Customer app has **no SSE channel** (`notifyCustomer` does not exist in [sseManager.ts](../packages/api/src/lib/sseManager.ts) — only `notifyDriver` exists). Also **no `refetchInterval`** configured on `useApiQuery`, and no `focusManager`/`onlineManager` wiring for TanStack Query in React Native.

Current refresh mechanisms:
- `staleTime: 30_000` naturally expiring + component remount/refocus
- Pull-to-refresh ([(customer)/orders.tsx:517](../packages/mobile/app/(customer)/orders.tsx:517))

**Practical effect on OTP UX:** after a driver-side `/delivery-otp/generate` call, the customer's app card **won't show the OTP** until either (a) they pull to refresh, or (b) they navigate away and back (triggers remount → refetch after 30s staleTime). Options for Phase 3:
- **(a) Add a `refetchInterval: 10_000` for `pending_delivery` orders only** — polling every 10s while any order is in flight. Cheapest, no infra changes. Battery/data cost is small (small JSON response, only while flight order exists).
- **(b) Add `notifyCustomer` to sseManager + wire an EventSource in the customer app** — architecturally cleaner but net-new infrastructure. Would also require customer-side SSE `AppState` reconnect handling similar to what `deliveryQueue.ts` does for NetInfo today.
- **(c) Out-of-band: server-side sends push notification (APNs/FCM) with "your delivery OTP" copy** — best UX but blocked on the v1.1-Sprint-1 push notification infrastructure work (CLAUDE.md backlog).

Recommend **(a) polling** for Phase 3 v1 as the lowest-risk option; revisit (b) or (c) when general customer-app real-time needs justify it.

---

## Section 5 — PDF changes

### 5.1 Insertion point

`invoicePdfService.ts` main render function ([:854-890](../packages/api/src/services/pdf/invoicePdfService.ts:854)) follows a strict Y-cursor pattern: every section takes `startY`, returns height consumed, caller advances `cursorY` by height + `LAYOUT.SECTION_GAP` (when non-zero).

Add a new async function:
```ts
async function drawProofSection(
  doc: PDFKit.PDFDocument,
  proof: DeliveryProofForPdf | null,
  startY: number,
): Promise<number>
```
Returns `0` when `proof` is null OR `Customer.requireDeliveryVerification` is false (preserves the "return 0 when absent" convention already used by `drawComplianceSection`, `drawFooter`).

**Insertion point in main render:** between the `drawComplianceSection` call at :878-880 and the footer-fit-check at :882-888. The existing page-overflow check right before `drawFooter` generalizes automatically to accommodate the extra section height.

### 5.2 Content per proof type (Phase 1 scope shown; Phases 2-3 additions noted)

- **Header row:** "Delivery Verified — {method}" (small badge-style, muted color)
- **Meta row:** ISO timestamp of `capturedAt` (formatted `DD-MMM-YYYY HH:mm IST`), GPS `(lat, lng)` in small font
- **Method-specific body:**
  - **Signature** (Phase 1): embedded PNG at ~120×60px via `doc.image(pngBuffer, x, y, { fit: [120, 60] })` — reuse the QR-code embed pattern at [:673-681](../packages/api/src/services/pdf/invoicePdfService.ts:673) with the same try/catch-around-`doc.image()` graceful-degrade. Below: "Signed by: {signingPartyPhone}"
  - **Photo** (Phase 2): decision deferred to Phase 2 kickoff. Recommendation from prior investigation: embed 400×300px thumbnail (~30-60 KB) — full-res would bloat PDF 50-200×. Alternative: link-out URL rendered as short text with a QR (uses existing QRCode dep). Pick one at Phase 2 start.
  - **OTP** (Phase 3): just the text "OTP Verified" — no code display on the PDF (the code was ephemeral by design)

### 5.3 Data plumbing

Extend the `invoiceForPdf` query in `invoicePdfService.ts`'s data-fetch to include:
```ts
order: {
  include: {
    ...existing includes,
    deliveryProof: { include: { /* only the fields we render */ } }
  }
}
```
Fetch the signature PNG buffer from S3 (via the stored `s3Key` → resolve to CloudFront URL → `fetch()` the bytes → pass buffer to `doc.image()`) inside `drawProofSection`. Wrap in try/catch — a missing/unreadable S3 object should downgrade to text-only ("Signature captured — image unavailable"), not throw.

### 5.4 Size guidance

- **Section footprint:** ~80-100pt tall for signature (image + 2 text rows). Roughly comparable to the compliance section's IRN card. No page-overflow concerns for typical invoices.
- **PDF byte impact:** small signature PNG ~5-15 KB embedded. Photo (Phase 2) at 400×300 thumbnail ~30-60 KB. Baseline invoice today is tens of KB (mostly vector + QR code). Signature phase does not materially change PDF size.

---

## Section 6 — Test files to update

Confirmed by direct grep: **13 test files, 71 raw occurrences** of `confirmDelivery` / `confirm-delivery`. Complete list with change needed:

### 6.1 confirmDelivery tests (13 files)

| File | Occurrences | Change needed |
|---|---|---|
| [duplicate-notification-fix.test.ts](../packages/api/src/__tests__/duplicate-notification-fix.test.ts) | 8 | No change if new proof fields default absent. Verify no test hardcodes an exact request body without proof fields where the response would now differ. |
| [dva-timestamp-reset.test.ts](../packages/api/src/__tests__/dva-timestamp-reset.test.ts) | 11 | No change expected — DVA timestamp reset logic unaffected. |
| [float-stock/float-reconciliation.test.ts](../packages/api/src/__tests__/float-stock/float-reconciliation.test.ts) | 2 | No change — walk-in float reconciliation orthogonal to proof capture. Verify the mocked customer used in these tests has `requireDeliveryVerification=false` (default) so the proof branch is skipped. |
| [godown-pickup.test.ts](../packages/api/src/__tests__/godown-pickup.test.ts) | 11 | No change — godown pickup structurally excluded (§ORDER-TYPE-INVESTIGATION D). Add ONE new test asserting proof-fields are ignored when reached (defense-in-depth) if godown ever accidentally hits the driver path in future. |
| [gst-dispatch-trip.test.ts](../packages/api/src/__tests__/gst-dispatch-trip.test.ts) | 9 | No change if fixtures use `requireDeliveryVerification=false`. |
| [gst-invoicing.test.ts](../packages/api/src/__tests__/gst-invoicing.test.ts) | 1 | No change — GST processing unaffected. |
| [gst-reissue.test.ts](../packages/api/src/__tests__/gst-reissue.test.ts) | 6 | No change — reissue flow unaffected. |
| [inventory.test.ts](../packages/api/src/__tests__/inventory.test.ts) | 1 | No change — inventory event writes unaffected. |
| [onboarding-and-imports.test.ts](../packages/api/src/__tests__/onboarding-and-imports.test.ts) | 6 | **HIGH ATTENTION** — this file has the existing `describe('POST /api/orders/:id/confirm-delivery — idempotency', ...)` block (:458). Extend with cases: (a) retry with same qty + additional proof data → proof is upserted, delivery still returns 200 no-op (§7 R1); (b) retry with same qty + same proof → no-op both. |
| [over-delivery-guard.test.ts](../packages/api/src/__tests__/over-delivery-guard.test.ts) | 9 | No change — bounds validation runs before proof handling. |
| [services/orderService.sse.test.ts](../packages/api/src/__tests__/services/orderService.sse.test.ts) | 4 | **HIGH ATTENTION** — pinned SSE-emit contract test. Verify the new proof-write path (if bundled into `confirmDelivery` or run as separate transaction) doesn't disturb the `notifyDriver` shape/ordering. |
| [wi109-zero-qty-delivery.test.ts](../packages/api/src/__tests__/wi109-zero-qty-delivery.test.ts) | 1 | No change — WI-109 zero-qty guard runs on `items` array, independent of proof. |
| [workflow.test.ts](../packages/api/src/__tests__/workflow.test.ts) | 2 | No change — general lifecycle test. |

### 6.2 New tests to add

**Phase 1:**
- `delivery-proof-signature.test.ts` — full happy path: POST upload-URL → PUT to (mocked) S3 → POST `/delivery-proof` → verify DB row → POST `/confirm-delivery` → verify order delivered.
- `delivery-proof-tenant-isolation.test.ts` — driver from dist-1 can't submit proof for an order in dist-2. Mirrors `paymentSubmissionService.ts` isolation pattern (§7 R2).
- `delivery-proof-retry-idempotency.test.ts` — retry same proof upserts (no duplicate row); retry different proof method upserts (latest wins per §1.3.1).
- `delivery-proof-verification-flag-off.test.ts` — customer with `requireDeliveryVerification=false` → proof endpoint accepts but is inert; confirm-delivery works exactly as today.

**Phase 3:**
- `delivery-otp-no-portal-login.test.ts` — customer without a `User` row → `/delivery-otp/generate` returns 409 with `CUSTOMER_HAS_NO_APP` code and expected copy.
- `delivery-otp-generate-verify.test.ts` — full OTP round-trip.
- `delivery-otp-expiry.test.ts` — OTP after `otpExpiresAt` returns error.

### 6.3 customerService tests — new flag

Directly-touched files: [d1-address-validation.test.ts](../packages/api/src/__tests__/d1-address-validation.test.ts), [e1-multi-branch-gstin.test.ts](../packages/api/src/__tests__/e1-multi-branch-gstin.test.ts) (call `createCustomer`/`updateCustomer`).

Broader domain: `customer-import-business-name.test.ts`, `d2-csv-shipping-warnings.test.ts`, `empty-balances-g4.test.ts`, `go-live-date-g5.test.ts`, `onboarding-checklist-g6.test.ts`, `onboarding-imports-g3.test.ts`, `customers.test.ts`, `customers-list-filter.test.ts`, `customers-status-update.test.ts`, `customer-gst-rate-override.test.ts`, `customer-balance-get-b.test.ts`, `compute-customer-overdue-c.test.ts`, `customer-statement-opening-balance.test.ts`, `customer-statement-report-d.test.ts`, `phase7-mobile-customer-form.test.ts`.

**Needs verification:** which of the above do exhaustive-key-shape assertions vs. subset assertions. Only exhaustive-key checks would break on adding `requireDeliveryVerification` to the response. Not confirmed by this pass — flag for the implementation session.

**New test:** `customer-require-delivery-verification.test.ts` — CRUD round-trip, role guard behaviour if added, wire-shape guard.

### 6.4 Customer-portal orders response — `otpCode` field

Directly-touched files: [customer-portal.test.ts](../packages/api/src/__tests__/customer-portal.test.ts), [payment-commitment.test.ts](../packages/api/src/__tests__/payment-commitment.test.ts) (reference `customer-portal/orders`).

**Needs verification:** which do exhaustive-shape assertions. Same caveat as §6.3.

**New tests (Phase 3):** as listed in §6.2 — `delivery-otp-*` tests already cover the response-shape angle (assert `otpCode` presence/absence under eligibility conditions).

### 6.5 Wire-shape guards ([anti-pattern-guards.test.ts](../packages/api/src/__tests__/anti-pattern-guards.test.ts))

Add three new `describe` blocks:

1. **Extended `deliveryConfirmationSchema` round-trip guard** — assert new optional proof fields survive `validate()` unmangled; assert omitting them still passes (backward-compat).
2. **Customer-portal orders response `otpCode` guard** — present under eligibility conditions, absent for orders not owned by the caller, absent when `requireDeliveryVerification=false`, absent after `otpVerifiedAt` is set.
3. **Delivery-proof endpoint response shape** — assert `otpCode` never leaks to non-driver roles; assert internal fields (`s3Key` if desired, `capturedBy` if desired) are or aren't in the response per product decision.

---

## Section 7 — Risk table

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Driver retries `confirmDelivery` after network drop; today's idempotency branch ([orderService.ts:865-889](../packages/api/src/services/orderService.ts:865)) early-returns on exact-qty match, silently **dropping any proof fields** submitted with the retry | High (offline queue exists precisely for this scenario) | High — proof legally required but never persisted, 200 OK gives false success signal | **Separate `/delivery-proof` endpoint** (§2), called by mobile BEFORE `/confirm-delivery`. Decouples proof idempotency (upsert-by-orderId) from delivery idempotency. `/confirm-delivery`'s comparison logic never touches proof fields — zero test-file churn on the highest-blast-radius mutation. |
| R2 | Tenant leak in `delivery_proofs` — a query without `distributorId` filter returns cross-tenant rows (anti-pattern #13 shape) | Medium (13 documented anti-pattern-#13 sites historically) | High — DPDP/multi-tenant breach | Every read/write in the new `deliveryProofService.ts` MUST include `distributorId` from `req.user!.distributorId!`, never from request body. Mirror [paymentSubmissionService.ts:60-361](../packages/api/src/services/paymentSubmissionService.ts:60) pattern (10 `where` clauses all keyed on `distributorId`). File header comment stating the discipline. Guard test in `anti-pattern-guards.test.ts`. |
| R3 | Customer app doesn't show OTP after `/delivery-otp/generate` for 30-60s (no push, no SSE) | Medium (Phase 3 only) | Medium — driver waits or gives up on OTP method | Add `refetchInterval: 10_000` on `useApiQuery(['customer-orders'])` while any order is in `pending_delivery` status. Cheapest solution, no infra changes. Battery/data cost small (JSON, only in-flight). Alternative: SSE (net-new infra), push (blocked on v1.1 Sprint 1). |
| R4 | Anti-pattern #19 (WI-100 Gap A) — proof state change on customer app card requires SSE-or-polling contract. Without it, OTP stays visible after driver verifies. | Medium | Medium — customer sees stale OTP display | Same `refetchInterval` from R3 covers this — after `otpVerifiedAt` is stamped, next 10s poll returns `otpCode: null`. Additionally: `notifyDriver({type: 'order_updated', ...})` fires on the driver side per existing SSE precedent (mirror the pattern at [gst/tripAutoAdvance.test.ts](../packages/api/src/__tests__/gst/tripAutoAdvance.test.ts) test #3). |
| R5 | Signature/photo bytes can't fit in offline queue (2KB SecureStore cap per key), driver in dead zone can't retry proof upload | Medium (real-world scenario for rural routes) | Medium — proof upload blocks entire confirm-delivery flow when offline | Phase 1: document limitation clearly in driver UX ("Sync needed — upload signature when you have network"); block only the proof-required orders, allow other pending deliveries to queue normally. Phase 2 (photo): consider a separate local-file + background-sync mechanism (out of scope for v1 signature phase). |
| R6 | Anti-pattern #9 (wire-shape drift) — `Customer.requireDeliveryVerification` added to Prisma but not to `@gaslink/shared` types, or vice versa | Low | Medium — silent runtime errors on customer create/update | Update `packages/api/prisma/schema.prisma` + `packages/shared/src/schemas/index.ts` + `packages/shared/src/types/index.ts` + `mappers.ts` in same commit. Wire-shape guard test (§6.5). |
| R7 | Reintroducing `expo-camera` (Phase 2) re-tacks `RECORD_AUDIO` on Android manifest (CLAUDE.md v1.1 backlog item) | High (structural to `expo-camera`) | Medium — Play Console warning returns after being just resolved | Elevate the "config plugin with manifest merge `tools:node="remove"`" backlog item from optional-half-day to a **mandatory prerequisite** of Phase 2, in the same commit as the `expo-camera` re-add. |
| R8 | DPDP account-deletion spec doesn't cover new `delivery_proofs` table or S3 objects (per prior investigation) | Certain | Medium — compliance gap on customer deletion | Update [docs/IOS-ACCOUNT-DELETION-SPEC.md](IOS-ACCOUNT-DELETION-SPEC.md) 46-model anonymization table with a `delivery_proofs` row. Implement S3-object-deletion (net-new — no S3-delete code exists in this codebase today; the deleted `lib/s3.ts` had a `deletePaymentAttachment()` function but it was never wired). Must ship in Phase 1 alongside the first S3 write. |
| R9 | S3 config keys (`AWS_S3_BUCKET`, `AWS_CLOUDFRONT_URL`, `AWS_REGION`) may or may not still exist in `config/index.ts` — the 6abbb23 diff removed the **validation** blocks but I did not directly re-verify the config object itself | Medium | Low — env-config drift, would surface as "S3 bucket not configured" runtime error on first proof upload attempt | First step of Phase 1 impl: `grep -n "aws" packages/api/src/config/index.ts` and re-add whatever was removed. Cheap, deterministic. |
| R10 | Existing tests do exhaustive-key-shape assertions on `Customer` or customer-portal `/orders` response — adding a new field breaks them | Unknown (§6.3, §6.4 flagged as needs-verification) | Low — CI-visible, easy to fix | First step of impl: `grep -rn "toStrictEqual\|toEqual(.*key" packages/api/src/__tests__/customer` and `packages/api/src/__tests__/customer-portal*` to enumerate. Fix in same commit as the schema change. |
| R11 | `deliveryLatitude || null` at [orderService.ts:1006](../packages/api/src/services/orderService.ts:1006) coerces valid `0` to `null` (equator/prime meridian — irrelevant for India but exists) | Very low | Very low | Not worth fixing under this feature — pre-existing behaviour; flag if separately touched. New proof `capturedLat`/`capturedLng` should use `?? null` correctly. |

---

## Section 8 — Phase 1 implementation order (Signature only)

Exact sequence. Each step should be its own commit for reviewability.

**Prerequisites (before any code):**

- **P0:** Doc sweep — update [docs/IOS-PHASE0-GROUND-TRUTH.md](IOS-PHASE0-GROUND-TRUTH.md) and CLAUDE.md's WI-PENDING-PAYMENTS section to reflect the 6abbb23 removal (both currently describe deleted code as if live).
- **P0:** Add `delivery_proofs` retention row to [docs/IOS-ACCOUNT-DELETION-SPEC.md](IOS-ACCOUNT-DELETION-SPEC.md).
- **P0:** Grep-verify R9 — is `config.aws.s3Bucket` etc still in [packages/api/src/config/index.ts](../packages/api/src/config/index.ts)? If not, restore.
- **P0:** Grep-verify R10 — enumerate exhaustive-shape assertions in customer + customer-portal tests.

**Backend (in order):**

1. **DB schema** — add `Customer.requireDeliveryVerification`, `DeliveryProof` model + `ProofType` enum, migration file (auto-generated via `pnpm db:migrate dev --name add_delivery_proofs`).
2. **Shared types** — `packages/shared/src/schemas/index.ts` extend `createCustomerSchema` (and `deliveryConfirmationSchema` optionally, per §1.1). `packages/shared/src/types/index.ts` extend `Customer` and add `DeliveryProof` interface.
3. **S3 re-add** — restore `packages/api/src/lib/s3.ts` from `6abbb23^`, generalize function name to `generateDeliveryProofUploadUrl(distributorId, orderId, proofType)` returning the same `{uploadUrl, finalUrl, s3Key}` shape. New path: `delivery-proofs/${distributorId}/${orderId}/signature-${uuid}.png`. Re-add `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` deps.
4. **Delivery proof service** — new `packages/api/src/services/deliveryProofService.ts` with `upsertProof`, `getProof`, tenant isolation discipline mirroring `paymentSubmissionService.ts`. Also implement S3 object deletion for the DPDP account-deletion worker.
5. **New routes** — `POST /orders/:id/delivery-proof-upload-url`, `POST /orders/:id/delivery-proof`, `GET /orders/:id/delivery-proof` on the existing `routes/orders.ts` (or a new `routes/deliveryProofs.ts` mounted under `/api/orders`).
6. **Customer service extension** — `createCustomer` + `updateCustomer` accept `requireDeliveryVerification` per §1.2.
7. **Customer response mapper** — `mapCustomer` at [utils/mappers.ts](../packages/api/src/utils/mappers.ts) surfaces `requireDeliveryVerification`.
8. **PDF `drawProofSection`** — new function in [invoicePdfService.ts](../packages/api/src/services/pdf/invoicePdfService.ts) per §5. Data-fetch include for `deliveryProof`. Try/catch around `doc.image()` S3 fetch.
9. **Tests** — new integration tests per §6.2 (Phase 1 list), new wire-shape guards per §6.5, extend `onboarding-and-imports.test.ts` idempotency block per §6.1.

**Frontend (in order):**

10. **Web customer form** — [CustomersPage.tsx](../packages/web/src/pages/CustomersPage.tsx) `CustomerFormModal` — add `requireDeliveryVerification` checkbox at the natural slot (§1.2, after gstRateOverride block at :752). Use RHF `register` pattern.
11. **Mobile shared services** — `packages/mobile/src/services/location.ts` extend with `getCurrentLocationHighAccuracy()`. New `packages/mobile/src/services/s3Upload.ts`.
12. **Mobile SignaturePad component** — install signature-pad dep, wrap in `packages/mobile/src/components/SignaturePad.tsx`. Also renders signing-party phone text input.
13. **Mobile driver flow** — [(driver)/orders.tsx](../packages/mobile/app/(driver)/orders.tsx) `DeliveryConfirmationModal` — gate on `order.customer.requireDeliveryVerification`, render SignaturePad tab when true. On submit: (a) GPS, (b) S3 upload, (c) POST /delivery-proof, (d) POST /confirm-delivery.
14. **Offline queue extension** — [deliveryQueue.ts](../packages/mobile/src/services/deliveryQueue.ts) extend `QueuedDelivery` with proof metadata. Comment clarifying signature bytes never queued (only s3Key after upload).

**Validation gates before merging Phase 1:**

- All 1553+ existing tests still pass; new tests added per §6.
- `pnpm typecheck` exits 0; `pnpm lint` exits 0.
- Manual driver-app flow tested on physical Android + iOS (per CLAUDE.md Mobile Testing Rules #6).
- End-to-end: create test customer with flag on → place pre-order → dispatch → driver-app captures signature → S3 object exists → confirm delivery → invoice PDF renders with proof section.
- Tenant-isolation smoke: driver from dist-1 cannot submit proof for dist-2 order (verified by test, then re-verified manually).
- Migration is behaviour-preserving: all existing customers get `requireDeliveryVerification=false` by default → driver app skips proof capture → identical behaviour to today.

**Phase 1 does NOT touch:** admin web/mobile confirm-delivery modals, godown pickup, backdated flows, returns-only, customer app. Phases 2 and 3 build additive-only on the Phase 1 foundation.
