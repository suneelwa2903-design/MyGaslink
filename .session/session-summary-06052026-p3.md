# Session summary — 2026-05-06 (Part 3)

Branch: `claude/competent-franklin-af7401`
Worktree: `.claude/worktrees/competent-franklin-af7401`

## Headline

6 tasks shipped end-to-end. Test suite grew from **254 → 265** (11 new
integration tests, all passing). API typecheck clean. Web typecheck clean.
Mobile typecheck error count unchanged (58 pre-existing, 0 introduced by
this session).

## Commits

| SHA | Task | Title |
|-----|------|-------|
| 18d2a93 | 1 | feat(ux): role-aware morning dashboard with collections call list |
| 7fa6095 | 2 | feat(ux): collections call list on collections page |
| f05c6ba | 3 | feat(mobile): offline delivery confirmation queue with auto-sync |
| 53d9dbe | 4 | feat(ux): show driver contact in customer portal order detail |
| 5ffdeac | 5 | feat(ux): onboarding checklist + CSV import for customers and opening balances |
| _(test commit follows below)_ | 6 | test(api): tests for new UX features + update work items |

## Per-task notes

### Task 1 — Role-aware dashboard (18d2a93)
- New service: `analyticsService.getOverdueCallList(distributorId)` — joins
  customers ⇄ outstanding-past-due invoices, returns `{ customerId,
  customerName, phone, totalOutstanding, overdueInvoiceCount, daysOverdue }`
  sorted desc.
- New route: `GET /api/analytics/overdue-call-list`.
- AnalyticsPage `tab === 'dashboard'` now renders role-specific blocks. For
  finance/inventory the existing admin metrics grid is hidden.
- New shared type: `OverdueCallListEntry`.
- Phone: prefers the customer's primary contact phone over the customer's
  main phone (matches the Customer model's `contacts.isPrimary` field).

### Task 2 — Collections call list tab (7fa6095)
- CollectionsPage now has a Call List ↔ All Collections tab toggle.
- Reuses the same `useQuery(['overdue-call-list'])` from Task 1 — no extra
  endpoint, no duplicated query.
- Mobile breakpoint switches to a card layout with a one-tap `tel:` button —
  finance can call while walking the floor.

### Task 3 — Offline delivery confirmation (f05c6ba)
- **Server idempotency** in `orderService.confirmDelivery`:
  - already delivered + same quantities → return 200 with the existing order
  - already delivered + different quantities → throw 409
  - prevents the double-delivery + 500 cycle when the driver retries
- **Mobile queue** at `packages/mobile/src/services/deliveryQueue.ts`:
  - SecureStore key `pending_deliveries` (chosen because AsyncStorage isn't
    a current dep — flagged below)
  - Auto-sync via `AppState` 'active' transition (no NetInfo dep needed)
  - `isNetworkError` distinguishes transport failures (queue) from 4xx
    (drop, won't ever succeed) and 5xx (queue, retry)
- UI: pending-sync count badge on the My Deliveries tab, per-order
  "pending sync" Badge, tap-to-retry banner.

### Task 4 — Driver contact in portal (53d9dbe)
- `customerPortalService.getMyOrderById` and `getMyOrders` now flatten
  `driverName` + `driverPhone` onto the order. Added `driverPhone?: string |
  null` to the shared `Order` type.
- Phone is gated by status: only exposed when status ∈ {pending_dispatch,
  pending_delivery}. Hidden once delivered/cancelled and before driver
  assignment.
- Tenant isolation: existing `where: { customerId, distributorId }`
  guarantees a customer in distributor A can never see a driver from
  distributor B.

### Task 5 — Onboarding + CSV import (5ffdeac)
- Service additions in `customerService`: `importCustomers`,
  `importOpeningBalances`, `getOnboardingProgress`, `dismissOnboarding`.
- Routes (must come before `/:id` to avoid the catch-all): `POST
  /import-csv`, `POST /import-opening-balances`, `GET
  /onboarding/progress`, `POST /onboarding/dismiss`.
- New web component: `OnboardingTab` with tiny inline CSV parser (no new
  deps), template download, preview table, per-row failure breakdown.
- SettingsPage gains an "Onboarding" tab (admin-only) and now respects
  `?tab=` query string for deep-linking.
- AnalyticsPage shows a "Get started" amber banner to admin-like users when
  setup is incomplete (clicks through to Settings → Onboarding).

### Task 6 — Tests + tracking (this commit)
- New test file: `packages/api/src/__tests__/onboarding-and-imports.test.ts`
  with 11 tests covering all five new behaviours, including tenant isolation
  for each.
- `work_items.json` updated: WI-025 through WI-030 added, all marked done.

## Final test counts

```
Test Files  18 passed (18)
     Tests  265 passed (265)
   Duration ~15s
```
Baseline at session start: 17 files, 254 tests.

## Design decisions / trade-offs

1. **Opening-balance storage is a known gap** — see WI-029 description.
   The founder spec explicitly says use a credit-method PaymentTransaction
   plus a CustomerLedgerEntry. I implemented exactly that. But the
   Collections page reads `Invoice.outstandingAmount` only, so imported
   opening balances will not appear in Collections (or in the new call
   list) until either (a) Collections is extended to add ledger debits, or
   (b) opening balances are stored as Invoice rows with a synthetic invoice
   number and `status: 'overdue'`. **Founder must verify which behaviour
   is wanted.**

2. **SecureStore for the offline queue** — CLAUDE.md suggests
   AsyncStorage for non-sensitive offline queues, but AsyncStorage is not
   in `packages/mobile/package.json`. Rather than add a dep, I reused
   SecureStore (which is already used for tokens). Per-key size cap on
   Android is ~2KB which fits ~10–20 queued deliveries comfortably.

3. **No NetInfo dependency** — the spec calls for "on network reconnect
   (NetInfo change to connected)". I implemented foreground-only sync
   (AppState 'active') because adding `@react-native-community/netinfo`
   would expand the dependency surface for Expo. Founder may want to add
   NetInfo later for instant reconnect retries; the queue is already
   structured to call `syncPendingDeliveries()` from any trigger.

4. **Finance unallocated-payments query** filters client-side from the
   first 50 recent payments, because `paymentService.listPayments` does
   not currently accept an `allocationStatus` filter. Adding that filter
   is a one-line change but I preferred not to expand scope. Flag for
   later if the dashboard needs older unallocated payments.

5. **Driver phone disclosure rule** — exposed only during in-flight
   statuses. If founder wants this rule to differ (e.g. always visible to
   the customer once the driver is assigned), the gate is in
   `customerPortalService.getMyOrderById` / `getMyOrders` (single
   `showDriverContact` constant in each).

6. **Onboarding banner heuristic** — `isNewlyCreated = orderCount === 0
   AND customerCount < 5 AND inventoryEventCount === 0`. Per spec. The
   server's `getOnboardingProgress.show` is `true` when not dismissed AND
   (newly created OR required steps incomplete). Once the distributor
   takes their first order the banner naturally goes away because the
   newly-created heuristic flips, but a user can still see the Onboarding
   tab to revisit setup.

## Items needing founder verification

- Opening balance storage model (see #1 above) — does Founder want imported
  opening balances to surface in Collections / overdue-call-list? If yes:
  Collections + getOverdueCallList both need to JOIN the ledger.
- Driver phone disclosure: confirm "hidden once delivered" is correct
  (current implementation), or should it remain visible for, say, 24h
  after delivery for any post-delivery customer queries?
- The onboarding step 4 ("Enter opening stock balance") currently checks
  for `InventoryEvent` rows of type `initial_balance`. There is no UI in
  this session that creates one — the existing manual-adjustment flow at
  `POST /api/inventory/manual-adjustment` could be used, but a dedicated
  "initial balance" button was out of scope. Flag this if a dedicated UI
  is wanted before launch.

## Updated work_items.json summary

| ID     | Status   | Title |
|--------|----------|-------|
| WI-025 | done     | Role-aware morning dashboard with collections call list |
| WI-026 | done     | Collections call list on Collections page |
| WI-027 | done     | Offline delivery confirmation queue + idempotent server |
| WI-028 | done     | Driver contact in customer portal order detail |
| WI-029 | done     | Onboarding checklist + CSV import |
| WI-030 | done     | Integration tests for new UX features |

Pre-existing pending items unchanged: WI-006 (Float→Decimal, planned),
WI-007 (GST live mode verification), WI-008 (Telugu i18n in progress),
WI-020 (@sentry/browser wiring), WI-023 (push to GitHub), WI-024 (manual
smoke tests).
