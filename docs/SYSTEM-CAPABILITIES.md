# SYSTEM CAPABILITIES — Re-New GasLink

A plain-English walkthrough of everything the platform can do, written for the founder.

Generated 2026-05-06 — end-of-day pass. Reflects: 27 work items (24 done, 3 founder-blocked external, 0 in-flight code work outstanding), 18 backend test files, 265 passing integration tests, 0 typecheck errors across api/web/mobile. Today added: role-aware morning dashboards, collections call list, offline delivery confirmation with NetInfo + idempotent server, driver contact in customer portal, onboarding checklist with CSV import, opening balances stored as synthetic invoices, Sentry web wired (WI-020 done), Float → Decimal migration on all 35 monetary fields (WI-006 done), all mobile typecheck errors resolved.

---

## PART 1 — What Is This System?

**Re-New GasLink** is the operating software for an LPG (cooking-gas) distribution business. The kind of business that buys cylinders by the truckload from IOCL / HPCL / BPCL bottling plants, stores them in a godown, and delivers them every day to thousands of homes, restaurants, factories, and shops. Today, most of these distributors run on paper, WhatsApp messages, and Excel sheets — which means lost cylinders, missed deliveries, late GST filings, slow collections, and no visibility into what's actually happening on the ground.

The platform replaces all of that with one connected system: a web app for the office, a phone app for drivers and inventory staff, a customer self-service portal, and a back office for the platform owner who runs this as a SaaS for many distributors. It handles the daily workflow (orders, deliveries, inventory, returns), the money side (invoices, GST e-invoicing with WhiteBooks, payments, credit/debit notes, customer ledgers), the people side (drivers, vehicles, customers, staff, roles), and the platform side (per-distributor billing, seat limits, suspension when bills go unpaid).

Audience: mid-sized LPG distributors in India running 200 to 2,000 deliveries a day, plus the agencies that operate them.

---

## PART 2 — The People Who Use It

Six roles. Same web app, same mobile app — different morning view because each one has a different job.

### Super Admin (platform operator)
Sees all tenants. Switches into any tenant via the X-Distributor-Id header (the header is regex-validated and the chosen distributor is verified-active before any data is served — every switch emits an audit event). Manages distributor onboarding, plan/seat assignment, GST mode, billing cycles, suspension, the provider catalog (IOCL/HPCL/BPCL cylinder types), and platform health.

### Distributor Admin (office)
Their morning view in the web app — top of the dashboard, in this exact order:
1. **Stock Position** — every active cylinder type with `closingFulls` + `closingEmpties`, color-coded `OK / WARNING / CRITICAL` against the configured thresholds. Click → Inventory page.
2. **Today's Dispatch** — three counts: orders pending driver assignment, orders today, delivered today. Click → Orders page filtered to the right status.
3. **Call these customers today** — overdue call list (top 8). One row per customer past their credit period: name, primary contact phone (tappable `tel:`), total outstanding, days overdue. Sorted by days overdue desc. "View all →" → Collections page.
4. **Pending Actions** — the existing approve/resolve queue, now displayed below the morning briefing instead of above it.

### Finance
Stripped-down view focused on collections + reconciliation. Sees: the call list, unallocated/partially-allocated payments (server-side filter, sorted by amount desc, top 20), failed IRNs needing retry, and the pending-actions items relevant to them. Stock and dispatch sections are hidden — not their job.

### Inventory
Sees: stock position with thresholds, vehicles pending end-of-day reconciliation, threshold alerts for cylinder types under warning/critical levels, and inventory-related pending actions. Financial data hidden.

### Driver (mobile only)
Web shows "please use the mobile app" if a driver somehow logs into the web. On the phone they see: trip, my deliveries, vehicle stock, and a more menu. **Delivery confirmation works offline.** If the API is unreachable when they tap Confirm Delivery, the order is saved to a SecureStore queue with a "pending sync" badge. The queue auto-syncs the moment connectivity returns (NetInfo listener fires on the false→true transition) and also when the app comes to the foreground (AppState listener). The badge count appears on the My Deliveries tab icon. The server is idempotent — a duplicate confirm with matching quantities returns 200 (no-op), mismatching quantities returns 409.

### Customer (portal — web)
Their dashboard shows orders pending, invoices outstanding, amount outstanding, and per-cylinder-type balance summary. They can place orders, view orders, view + download invoice PDFs, view payments, and update their shipping profile. **Once an order has a driver assigned and is in flight (status `pending_dispatch` or `pending_delivery`)**, the order detail view shows a "Your delivery driver" callout with the driver's name and phone as a tappable `tel:` link. The phone is hidden once the order is delivered or cancelled, and before driver assignment.

---

## PART 3 — The Core Workflows

### Order journey

1. **Create** — distributor admin (or customer via portal) creates an order. If the customer has a `preferredDriverId` and that driver has a dispatch-ready assignment for the delivery date, the order skips the assignment step and lands at `pending_dispatch`. Otherwise: `pending_driver_assignment`.
2. **Assign driver** — admin picks a driver from the available pool. Vehicle is auto-resolved server-side from the day's driver-vehicle assignment (no vehicle dropdown — that anti-pattern was removed in WI-005).
3. **Dispatch** — vehicle is loaded against the driver assignment, status moves through `loaded_and_dispatched`. EWB is generated server-side if the tenant is `gstMode != disabled`.
4. **Deliver** — driver opens the order on the mobile app, taps Confirm Delivery, enters delivered quantities + empties collected, optionally takes a proof photo. **If offline:** the confirmation is queued (see PART 5 — offline queue). Otherwise the API records the delivery, creates inventory events (delivery + collection), recalculates daily summaries, and (if a pricing rule exists) auto-generates the invoice.
5. **Reconcile** — at end-of-day the vehicle returns to depot. Inventory user reconciles loaded vs returned vs delivered. Discrepancies → `AccountabilityLog` entries with a cost-amount field.

### Collections workflow

1. **Call list generation** — `analyticsService.getOverdueCallList(distributorId)` runs a single query: customers with at least one outstanding invoice whose `dueDate < today`. For each customer it computes total outstanding across overdue invoices, count of overdue invoices, and days-overdue from the **oldest** overdue invoice. Sorted by daysOverdue desc.
2. **What finance sees** — the list at the top of their dashboard (top 8) and as a tab on the Collections page (full list, table on desktop, card layout on mobile with a one-tap call button).
3. **Recording payment** — finance opens Billing & Payments → Record Payment, picks the customer and amount, chooses method (cash / cheque / online / UPI / bank transfer / credit). Allocation is either auto (FIFO across outstanding invoices) or manual (pick which invoices to apply the payment to). Each allocation reduces `Invoice.outstandingAmount` and writes a `CustomerLedgerEntry`. When `outstandingAmount` hits zero the invoice flips to `status='paid'`.
4. **Opening balances** — for distributors moving from paper, the onboarding CSV import creates a synthetic overdue Invoice per customer (`isOpeningBalance=true`, due today, `status='overdue'`, no items, no GST). These automatically appear in Collections, in the call list, and in the customer portal — same code path as any normal invoice.

### Onboarding workflow (new distributor's first hour)

Settings → Onboarding tab. 6-step checklist with progress bar:
1. Add cylinder types and prices
2. Add drivers and vehicles
3. Add customers (CSV import available — template download, preview, per-row failure breakdown)
4. Enter opening stock balance (dedicated modal listing each active cylinder type with two number inputs; saves through `POST /api/inventory/initial-balance`)
5. Import customer opening balances (CSV — same preview/confirm flow)
6. Configure GST (optional — distributor can launch GST-disabled and turn it on later)

Until steps 1-5 are complete, the distributor admin's dashboard shows a "Get started" amber banner deep-linking to the Onboarding tab. The whole banner can be dismissed permanently (stored in `distributor_settings` JSONB as `dismissedOnboarding: true`).

---

## PART 4 — The Business Rules

### Multi-tenant
Single Postgres database. Every tenant-scoped table has `distributor_id` + an index. Every Prisma query in services includes `where: { distributorId }` — there is no row-level security; isolation is by convention enforced in tests. Two-distributor tenant-isolation tests live in `customers.test.ts`, `payments.test.ts`, `analytics.test.ts`, `onboarding-and-imports.test.ts` — every new feature added today has a tenant-isolation test.

### GST behavior is per-tenant
`Distributor.gstMode` is one of `disabled / sandbox / live`. The web hides GST columns / buttons (CN/DN, IRN status, GSTIN field) when `gstMode === 'disabled'`. The API hard-gates WhiteBooks calls on the same flag — a `disabled` tenant can never accidentally hit the WhiteBooks API.

### Credit period
Per-customer in days (`Customer.creditPeriodDays`, default 30). An invoice's `dueDate = issueDate + creditPeriodDays`. Past due → `status='overdue'` (and shows up in collections / call list).

### Idempotency
Delivery confirmation: duplicate same-quantities returns the existing order (200). Different quantities returns 409 conflict. Driver retries after uncertain network never create double-delivered records.

### Cylinder accounting
Event-sourced. Every cylinder movement writes an `InventoryEvent` row (event types: `incoming_fulls`, `outgoing_empties`, `delivery`, `collection`, `manual_adjustment`, `cancellation`, `cancellation_return`, `initial_balance`, `write_off`, `returns_collection`). Daily `InventorySummary` rows are computed from the event log and can be recalculated from any past date. Days can be locked once finalized.

### Money is exact (Decimal)
All 35 monetary fields are stored as Postgres `NUMERIC(18,4)` and computed as Prisma `Decimal` server-side. No floating-point drift on aggregates. Serialized to numbers at the API boundary (`utils/decimal.toNum`) so the web client doesn't need to change.

---

## PART 5 — The Technical Backbone

### Stack
- **API** — Express + TypeScript ESM, Prisma client over Postgres 17, Vitest for integration tests
- **Web** — React 19 + Vite + Tailwind + Zustand + TanStack Query
- **Mobile** — React Native + Expo 54 (managed) + NativeWind, Expo Router file-based routing, expo-secure-store for tokens + offline queue
- **Shared** — `@gaslink/shared` workspace package — Zod schemas, TypeScript types, enums

### Authentication
JWT access (15m) + refresh (7d). Tokens in Zustand+localStorage on web, expo-secure-store on mobile. Forgot password via email OTP. First-login force-password-reset flag on every seeded staff user. Rate limits on `/login` and `/forgot-password`.

### Authorization
6 roles, gated per-route via `requireRole(...)`. Super-admin tenant switching only via the validated `X-Distributor-Id` header — every successful switch emits a `super_admin_tenant_switch` business event with userId, distributorId, requestId, ip.

### Offline queue (mobile delivery)
- Storage: `expo-secure-store` key `pending_deliveries` (JSON array). SecureStore is used because AsyncStorage isn't currently a dependency; per-key Android cap is ~2KB which fits ~10-20 queued deliveries.
- Triggers: `AppState` 'active' transition + NetInfo `isConnected: false → true` transition. Both call `syncPendingDeliveries()`.
- Error policy: network errors → keep in queue, increment attemptCount. 4xx (validation, cancelled order) → drop. 5xx → keep + retry. 409 (idempotency conflict) → drop (server has it, just with different quantities — UI can investigate).
- UI surface: orange badge on the My Deliveries tab icon with the count, per-order "pending sync" Badge, tap-to-retry banner showing `${count} pending sync · tap to retry`.

### Idempotent delivery confirmation
`orderService.confirmDelivery` first checks if the order is already in a `delivered` / `modified_delivered` state. If yes: compare submitted line-quantities against stored quantities. Match → return current order with 200 (no side effects, no second InventoryEvent, no second invoice). Mismatch → throw 409. This is what makes the offline queue safe — the queue can retry as many times as it wants.

### Sentry (errors + monitoring)
- **API** — `@sentry/node` initialized in `packages/api/src/lib/sentry.ts` from app boot. The global error handler captures every unhandled exception. unhandledRejection / uncaughtException handlers also send to Sentry before exit.
- **Web** — `@sentry/browser` initialized in `packages/web/src/main.tsx` *before* React mounts via `initSentry()` in `packages/web/src/lib/sentry.ts`. ErrorBoundary's `componentDidCatch` calls `Sentry.captureException`. DSN read from `VITE_SENTRY_DSN`. `tracesSampleRate: 0.2`. In dev mode, `beforeSend` returns null so Sentry stays quiet locally.
- **Mobile** — not yet wired (would use `@sentry/react-native`). Tracked separately.

### Reliability
Graceful shutdown on SIGTERM/SIGINT (server.close → prisma.$disconnect → exit, 30s hard timeout). Source maps off in production builds (Sentry uploads will re-enable as `hidden` once the upload pipeline exists). Web ErrorBoundary wraps the entire app inside StrictMode with a recoverable Tailwind-styled fallback UI.

### Health
`GET /api/health` returns liveness + DB readiness. The web app surfaces it on Health Monitoring (super admin only). `scripts/monitor/health-check.{ps1,sh}` polls from cron / Task Scheduler with Telegram alerts via `scripts/alerts/`.

---

## PART 6 — What Is Built vs What Is Coming

27 work items. 24 done, 3 founder-blocked external, 0 code-side outstanding.

### Fully built and tested
- Multi-tenant foundation, JWT auth, RBAC, customer / cylinder / order / invoice / payment / inventory / fleet / reconciliation / GST sandbox / customer portal / super admin / GasLink billing / pending-actions / accountability / analytics / settings (all WI-001 through WI-018, WI-022).
- Reliability: graceful shutdown, error handlers, web ErrorBoundary, source maps off (WI-009/010/011).
- Security: axios CVE upgrade, distributor-active verification middleware, audit logging, query-param tenant anti-pattern removed (WI-002, WI-012, WI-013, WI-014).
- API integration tests: **265 passing** in 18 test files.
- **Today:** role-aware morning dashboard for all 4 office roles (WI-025), collections call list on its own page (WI-026), offline delivery confirmation with NetInfo + idempotent server (WI-027), driver contact in customer portal (WI-028), onboarding checklist + CSV import for customers and opening balances (WI-029), tests for all the above (WI-030).
- **Today end-of-day:** Sentry complete wiring in web (WI-020 done), Float → Decimal migration on all 35 monetary fields (WI-006 done), all mobile typecheck errors resolved (was 58, now 0).

### In progress
- **Telugu i18n** — 5 of 28 web pages + 4 enum namespaces extracted. Foundation stable. Per-page protocol at `.session/i18n-extraction-protocol.md`. Remaining 23 web pages + 5 components + all of mobile is incremental work that can ship post-launch (WI-008, `blocksLaunch: false` as of today).

### Pending founder action (external)
- **GST live mode test against WhiteBooks production** (WI-007) — needs production credentials.
- **GitHub repo + push** (WI-023) — see PART 12 for exact commands.
- **Manual smoke testing** (WI-024) — guide at `docs/MANUAL-TESTING-GUIDE.md`.
- **Apple Developer + Google Play accounts** + **DNS for `api.mygaslink.com`** + **Privacy policy page** — required before EAS submit. Not a work-item yet; tracked in `.session/eas-readiness.md`.

---

## PART 7 — Data Model (high level)

45 Prisma models, 38+ enums. Headline shapes:

- `Distributor` — tenant root. Owns everything. `gstMode`, `subscriptionPlan`, `billingTier`, godown + office addresses.
- `User` — staff or customer-portal user. `role`, `distributorId`, optional `customerId` (for portal users), `requiresPasswordReset`.
- `Customer` — billed entity. `customerName`, optional `businessName`, `gstin`, `customerType` (B2B/B2C), `creditPeriodDays`, `stopSupply`, `preferredDriverId`. Has `contacts[]` (phone book) and `cylinderDiscounts[]` (per-customer per-type negotiated discount).
- `Order` — one delivery. `status` enum, `driverId`, `vehicleId`, `deliveryDate`. `items[]` carry `quantity` + `deliveredQuantity` + `emptiesCollected` + Decimal `unitPrice` + `discountPerUnit` + `totalPrice`.
- `Invoice` — one bill. Decimal `totalAmount` / `amountPaid` / `outstandingAmount`. `status` enum (`draft / issued / partially_paid / paid / overdue`). `irnStatus` / `ewbStatus` for GST. `isOpeningBalance` flag for back-filled migration invoices, `notes` text.
- `PaymentTransaction` + `PaymentAllocation` — payment records and what invoices they were applied to. Decimal `amount` / `allocatedAmount`. `allocationStatus` (`unallocated / partially_allocated / fully_allocated`).
- `InventoryEvent` + `InventorySummary` — event log + computed daily snapshot per cylinder type. Lockable per day.
- `CustomerLedgerEntry` — append-only ledger per customer, one row per Invoice / CreditNote / DebitNote / Payment / adjustment.
- `Driver` + `Vehicle` + `DriverVehicleAssignment` — fleet. Day-level driver↔vehicle assignment carries the dispatch state machine.
- `PendingAction` — generic approve/resolve queue with severity, SLA deadline, `requiresApproval` flag.
- `AccountabilityLog` — discrepancies discovered at reconciliation, with cost amount + resolution workflow.
- `BillingCycle` + `BillingItem` — GasLink-billing (i.e. SaaS billing of distributors).
- `GstCredential` per `(distributorId, scope)` for WhiteBooks. `GstDocument` carries IRN/EWB blobs.

Schema lives at `packages/api/prisma/schema.prisma` — 1,400+ lines, kept incremental via migrations under `packages/api/prisma/migrations/`.

---

## PART 8 — Multi-tenancy & Security

- **No row-level security.** Tenant isolation is enforced by always including `distributorId` in service-layer Prisma queries. The audit at WI-001 verified all 28 service files. Today's new endpoints (overdue-call-list, import-csv, import-opening-balances, initial-balance, onboarding/progress, onboarding/dismiss) all have explicit tenant-isolation tests.
- **Super-admin tenant switching** is the only mechanism for crossing tenant boundaries, and it goes through `middleware/auth.ts:resolveDistributor` which: (1) regex-validates the X-Distributor-Id header format, (2) looks up the distributor and checks `status !== 'suspended'`, (3) emits a business audit event, (4) caches the verified distributor on `req.distributor`.
- **Customer portal isolation** — every customer-portal endpoint queries by `where: { customerId, distributorId }`, so a portal user cannot see anyone else's data even by URL guessing. The order detail's new `driverPhone` field is doubly-scoped — only included when the order matches both customerId + distributorId, only exposed during in-flight statuses.
- **Secrets** — JWT secrets fall back to dev defaults in dev (with warning), hard-fail in production via `validateEnv()`. CORS origins must be set in production. SecureStore on mobile holds tokens (not AsyncStorage).

---

## PART 9 — Integrations

### WhiteBooks (GST e-invoicing)
- Sandbox covered end-to-end and tested in `gst-invoicing.test.ts` + `gst-toggle.test.ts`. Production credentials never exercised — WI-007 founder action.
- Endpoints: IRN issue, IRN cancel (24h window), EWB generate, EWB cancel (24h window), GSTIN validate, GSTIN lookup (used during distributor onboarding to autofill legal name + address).
- Per-distributor credentials in `GstCredential` table, scoped by `einvoice` / `ewaybill`.

### Provider catalog
Cross-tenant table holding cylinder type records published by IOCL / HPCL / BPCL. Distributors import the ones they sell. Super admin manages.

### Sentry
API + web wired (see PART 5). Mobile not yet wired.

### Email (SMTP)
For OTP delivery on forgot-password + contact-form submissions. SMTP credentials in env. No-op (logs only) if `SMTP_HOST` is empty.

---

## PART 10 — Mobile App

### Platform
- React Native via Expo 54 (managed workflow). Targets iOS 15+ and Android 10+ (API 29).
- Expo Router file-based routing under `app/` with role-grouped folders: `(admin) (auth) (customer) (driver) (finance) (inventory) (super-admin)`.
- State: Zustand + expo-secure-store for tokens. TanStack Query for server state.
- Icons: `@expo/vector-icons` (Ionicons). NativeWind for styling.

### Driver experience (the most-exercised role)
Trip → My Deliveries → Vehicle Stock → More tabs. Delivery confirmation is now offline-tolerant (SecureStore queue + AppState + NetInfo triggers + idempotent server). Pending sync shows as an orange badge on the tab icon and a per-order Badge.

### Build / release
- `version` in app.json/package.json semantic; `buildNumber` (iOS) / `versionCode` (Android) increment every build.
- EAS production build readiness audit at `.session/eas-readiness.md` — Apple Dev / Play Console / DNS / privacy policy / `eas credentials` / `eas.json submit.production` block all flagged for founder.

### Typecheck
**0 errors today.** Was 58 (mostly missing `@expo/vector-icons` types + `(super-admin)/users.tsx` UserRole literal-string mismatch + `(super-admin)/billing.tsx` BillingStatus enum-value mismatch + `(super-admin)/customers.tsx` references to non-existent `contactPerson` / `address` fields + `(super-admin)/inventory.tsx` references to non-existent `fullCylinders` / `emptyCylinders`). All resolved in commit `57f14d2`.

---

## PART 11 — Operations & Monitoring

- **Health**: `GET /api/health` → liveness + DB-readiness. Web Health Monitoring page (super admin) surfaces it.
- **Cron / monitoring scripts** under `scripts/monitor/`, `scripts/alerts/`, `scripts/security/`. Runnable but not yet wired to CI or to the production EC2.
- **Logging**: Winston via `utils/logger.ts`. Structured JSON, request-correlation via `requestId` middleware.
- **Sentry**: see PART 5.
- **Backups / restore**: Postgres on Docker locally; production strategy not yet documented (deferred to post-launch ops doc).
- **CI/CD**: `.github/workflows/ci.yml` exists but won't run until WI-023 (GitHub repo + push) is done by founder.

---

## PART 12 — Roadmap & Known Gaps

### What lets us launch tomorrow
The codebase is launchable today. The four launch-blocking items are all founder external actions:
1. **WI-023** — push to GitHub. Exact commands:
   ```bash
   git remote add origin https://github.com/<your-username>/Re-New_Gaslink.git
   git branch -M master
   git push -u origin master
   ```
2. **WI-024** — work through `docs/MANUAL-TESTING-GUIDE.md` (7 sessions, ~3 hours total).
3. **WI-007** — exercise GST live mode against WhiteBooks production with real credentials.
4. **EAS readiness** — Apple Developer + Google Play accounts, DNS for `api.mygaslink.com`, privacy policy page hosted publicly.

### What's deferred (won't block launch)
- **WI-008 Telugu** — 23 of 28 web pages + all of mobile remain. Foundation stable; pages can be extracted incrementally and translation pass done by a native speaker.
- **Mobile Sentry** — `@sentry/react-native` to be wired once a DSN is provisioned.
- **Source-map upload to Sentry** — `@sentry/vite-plugin` for web, `@sentry/react-native` for mobile, both post-DSN.
- **Coverage in CI** — ADLC config defines coverage thresholds (auth 100%, business 80%, overall 70%) but `vitest --coverage` not yet wired into CI.
- **Detox E2E mobile tests** — manual via Expo Go today.

### Risks to watch in production
1. **GST live mode** — WhiteBooks rate limits and sandbox-vs-prod schema drift. WI-007 first.
2. **Postgres advisory locks during migrations** — multiple worktrees on the shared local DB hold connections that block `prisma migrate deploy`. The `LOCAL-DEV-STARTUP.md` troubleshooting section documents the kill-stale-connections workaround. Production won't share a DB but watch for this in CI.
3. **Telugu UI mid-launch** — until extraction is complete, switching language to Telugu shows English fallback strings on the un-extracted pages. The user-facing impact is limited but should be communicated.
4. **Offline queue size cap** — SecureStore on Android caps each key at ~2KB. ~10-20 deliveries fit. If a driver is offline for a full day with 30+ deliveries, the oldest entries may overflow. Migrate to AsyncStorage for non-sensitive offline data when the use case demands it.
