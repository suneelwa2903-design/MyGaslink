# MyGasLink State — 07 Aug 2026

Read-only product snapshot generated from the repo (code, config, migrations, git history, working tree). No production DB was queried. Facts only; anything not verifiable in the repo is marked **NOT IN REPO — ask Suneel**.

**Headline for a non-technical reader:** MyGasLink is a live, multi-tenant LPG distribution platform (web + Android app, production at mygaslink.com since May 2026) covering the full distributor workflow — orders, inventory, GST e-invoicing, billing, collections, fleet, expenses, purchases, and reports — for 8 user roles. There is a very large batch of finished-but-uncommitted work sitting on the local machine (~9,250 lines: a reports overhaul, defective-cylinder returns, and a full supplier/corporation purchase ledger), plus SSL certificate pinning implemented yesterday. The iOS App Store submission is the single active track.

---

## 0. UNCOMMITTED LOCAL WORK (working tree vs HEAD)

**Plain language:** roughly two weeks of finished feature work is on this laptop but not yet committed to git — it is tested (new test files exist for all of it) but at risk until committed.

Scale: **~9,251 insertions / 891 deletions across 55 modified files + ~60 new (untracked) files**, including 4 new DB migrations. All 4 schema-change groups have matching migration folders on disk (`20260806000000_saved_reports`, `20260806120000_f1_defective_returns`, `20260806140000_f8_supplier_ledger`, `20260806160000_f8v2_corp_ledger`) — no orphan schema edits.

| Uncommitted feature | What it is (plain language) | Completeness | Safe to commit? |
|---|---|---|---|
| **Reports revamp (F2/F7 + saved reports + report builder)** | A full reports suite: Daily Sales, Day-Close Summary, Driver Daily Log, Vehicle Ledger (computed), report catalog, custom Report Builder with saved reports. `reportsService.ts` +3,636 lines; `ReportsPage.tsx` +1,207 lines; web route `/app/report-builder`. | Migration ✅, ~14 new test files ✅, web UI ✅, mobile reports screen updated ✅ | Yes |
| **F1 — Defective cylinder returns** | Track damaged/leaking cylinders returned to the supplier and the credit claimed for them. New web page `/app/defective-returns`, API route `/api/defective-returns`. | Design doc ✅ (`docs/F1-DEFECTIVE-RETURNS-DESIGN.md`), migration ✅, `defective-returns.test.ts` ✅, web UI ✅ (`InventoryPage.tsx` +1,110) | Yes |
| **F8 — Supplier Ledger (purchase book)** | A proper account book per supplier (source distributor): purchase entries with charges, purchase payments, purchase credit/debit notes, opening balances. New models `PurchasePayment`, `PurchaseEntryCharge`, `PurchaseCreditNote` + more. | Migration ✅, `f8-supplier-ledger.test.ts` ✅, `PurchasesPage.tsx` +246 ✅, seed + verify scripts ✅ | Yes |
| **F8v2 — Corporation Ledger** | One ledger per oil company (HPCL/IOCL/BPCL-style): money owed, cylinders moved, landed cost, deposits. New web pages `/app/corporations`, `/app/corporations/:corpId`. | Migration ✅, scenario tests ✅, PDF dump/verify scripts ✅ | Yes |
| **SSL certificate pinning (mobile)** | App refuses to talk to an impostor server (protection on hostile Wi-Fi). OS-native pinning via config plugin `packages/mobile/plugins/withSslPinning.js`, env-gated `SSL_PINNING=true` on preview/production EAS profiles only; runbook at `docs/RUNBOOK-CERT-ROTATION.md`. | Plugin ✅, runbook ✅, JS detection layer `src/lib/pinning.ts` ✅. Residual: EAS cloud build + real-device MITM test | Yes (ships with next store release) |
| **Backdated-events backfill + attribution fixes (DDL-1)** | Fixes so that backdated orders/trips generate the same inventory events and driver/vehicle attribution as normal orders — keeps every report honest. `backfill-backdated-events.ts` + edits to all 3 backdated services. | Tests updated ✅, backfill script ✅ | Yes |
| **Housekeeping** | CI memory bump, CLAUDE.md updates, launch.json, master pending items doc, 3 new release-brief docs, Phase-2 testing guide, ~15 one-off verify/seed scripts under `packages/api/scripts/_*` | — | Scripts violate anti-pattern #1 (ad-hoc scripts at root) — commit or prune deliberately |

⚠️ **Risk flag:** a laptop failure today loses all of this. Committing to a branch (even unpushed) should precede everything else.

⚠️ **Stray file:** an `app.json` exists at the **repo root** (untracked) — likely accidental; the real one is `packages/mobile/app.json`. Verify before committing.

---

## 1. SHIPPED & LIVE (committed features)

**Plain language:** this is everything a user can touch today. Note: local git is ~100 commits ahead of the last verified EC2 deploy (`58404de`, 2026-05-29) — features committed recently (deposit ledger, GST filing export, price history, SaaS billing polish) are committed locally but **deployment state unverified from this machine** (NOT IN REPO — ask Suneel / check EC2 HEAD).

### Web app features (by sidebar/route)

| Feature (UI label) | What it does | Roles | Route |
|---|---|---|---|
| Analytics | Main dashboard — sales, deliveries, stock and money trends, plus Reports tab | all staff roles | `/app/analytics` |
| Orders | Take, track, dispatch and close customer cylinder orders | all staff roles | `/app/orders` |
| Inventory / Stock | Daily count of full and empty cylinders in godown and on vehicles | admin, finance, inventory, mini-op | `/app/inventory` |
| Defective Returns *(uncommitted)* | Log damaged cylinders sent back to supplier, claim credit | admin, finance, inventory, mini-op | `/app/defective-returns` |
| Customers | Directory — balances, history, settings, cylinder balances | admin, finance, inventory, mini-op | `/app/customers` |
| Quotations | Price quotes to prospects before they become orders | admin, finance, mini-op | `/app/quotations` |
| Billing & Payments | Invoices + money received; badge for payments awaiting approval; Deposits tab | admin, finance, inventory, mini-op | `/app/billing-payments` |
| Collections | "Who owes us money" call list for overdue customers | admin, finance, inventory | `/app/collections` |
| Fleet | Drivers, vehicles, trip assignments | admin, finance, inventory | `/app/fleet` |
| Expenses | Day-to-day business spending against categories | admin, finance, mini-op | `/app/expenses` |
| Corporations *(uncommitted)* | Per-oil-company ledger: dues, cylinder movement, landed cost, deposits | admin, finance | `/app/corporations` |
| Purchases | Supplier accounts and purchase entries | mini-op, admin, finance | `/app/purchases` |
| Pending Actions | Exception to-do list — GST failures, disputes, stock mismatches | admin, finance, inventory | `/app/pending-actions` |
| Report Builder *(uncommitted)* | Build and save custom reports | all staff roles | `/app/report-builder` |
| Settings | Company profile, users, pricing, GST, Tally, subscription | all staff roles | `/app/settings` |
| Distributors / GST Activation / Provider Catalog / Health / Account Deletions / API Docs | Platform administration | super_admin only | various |
| Customer portal (5 pages) | Dashboard, Orders, Invoices, Payments (online pay), Account (incl. deletion) | customer | `/app/customer/*` |
| HQ portal (7 pages) | Multi-branch corporate customer: rolled-up orders, invoices, ledger, payments, aging | customer_hq | `/hq/*` |
| Public site | Landing, login, password flows, privacy/terms/support pages | public | `/` etc. |

### Mobile app (Android live on Play Store; iOS in submission track)

| Role group | Screens | Count |
|---|---|---|
| Distributor admin | dashboard, orders, customers (+create/detail), inventory, finance, fleet, collections, expenses, purchases, quotations, pending-actions, pending-payments, reports, more, profile | 17 |
| Driver | trip, orders, inventory, analytics, submit-payment, my-submissions, more, profile (+ offline queue + live SSE updates) | 8 |
| Customer | dashboard, orders, invoices, payments, account | 5 |
| Finance | 13 screens mirroring web finance surface | 13 |
| Inventory | 13 screens | 13 |
| Super-admin | 12 screens incl. distributors, billing, health, provider catalog | 12 |
| HQ (corporate customer) | aging, invoices, ledger, orders, payments, profile | 7 |
| Shared | login/password flows, account-deletion flow (4 screens) | 7 |

Note: mini_operator_admin has **no dedicated mobile route group** — mini-operators are web-first today.

### API surface

~45 route modules, all tenant-scoped through `authenticate → resolveDistributor → requireDistributor` except documented platform-level exceptions (`/api/users`, `/api/billing`, `/api/pricing`, `/api/settings`, `/api/pending-actions`, `/api/distributors`, `/api/provider-catalog`) whose tenant safety lives in per-handler guards. Two Razorpay webhooks (HMAC-gated). Swagger docs at `/api/docs` (super-admin).

**Audit flag surfaced by this sweep:** `/api/admin/login-history` is mounted **without `authenticate` at the mount point** in `app.ts` (unlike every sibling) — auth must exist inside the router; verify before the next security pass.

### Feature flags / env toggles (production-relevant)

| Flag | Gates | Production default |
|---|---|---|
| `INVENTORY_DISPATCH_DEBIT` | Debit full cylinders at dispatch (vs at delivery) | `true` in prod |
| `INVENTORY_STOCK_GATE_BYPASS` | Skip stock-sufficiency check before dispatch | unset (gate active) |
| `GASLINK_GST_SANDBOX` | GST e-invoicing sandbox vs live NIC | per-tenant `gstMode` + this | 
| `RAZORPAY_KEY_*` | Real charges vs mock mode (mock when key contains "mock"/secret unset) | NOT IN REPO — ask Suneel |
| `SSL_PINNING` (mobile build) | Native cert pinning | `true` on preview/production EAS profiles only |
| `SMTP_HOST/USER` | Email sending (disabled → logged only) | NOT IN REPO — ask Suneel |
| `SENTRY_DSN` | API crash reporting (prod only) | NOT IN REPO — ask Suneel |

---

## 2. BUILT BUT NOT LIVE

**Plain language:** finished code that isn't earning yet — each blocked by one specific switch, credential, or external step.

| Feature | State in code | What blocks it going live |
|---|---|---|
| **GST e-invoicing on production NIC** | Fully live-capable client (token cache, retry, forensic logging); `live` mode hard-fails without prod creds | WhiteBooks **production activation** + per-tenant `gstMode: live` flip. Sharma runs sandbox today |
| **SaaS subscription billing via Razorpay (Phase E)** | Real SDK + HMAC verification, but key falls back to `rzp_test_mock` → mock mode | Real `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET` in prod env + the 5 ship-blocker fixes (brief says "effectively DONE") |
| **Customer "Pay Now" online payment (Phase F)** | Per-distributor Razorpay creds in DB, gated by `razorpayEnabled` (default `false`) | A distributor supplying their Razorpay keys + flag flip. Zero tenants enabled |
| **Push notifications** | `expo-notifications` installed; 6 functions are deliberate no-ops; plugin removed from app.json | v1.1 rebuild: APNs+FCM wiring + re-add plugin (deferred to avoid Apple rejection) |
| **SSL certificate pinning** | Implemented (uncommitted) — native config plugin, `SSL_PINNING=true` on preview/production | Commit + next EAS store build + real-device MITM test |
| **iOS apps (all three)** | Feature parity work done per iOS track; ASC app exists (ascAppId 6783034856), submit config in eas.json | Apple review submission — the current active track |
| **Universal Links (iOS half)** | Android App Links verified green in Play Console; iOS `associatedDomains` absent | Apple Team ID + AASA file deployment (v1.1, ~half day) |
| **Sentry source maps (mobile)** | Crashes ARE captured (Hermes bytecode stacks); upload pipeline documented 4-step | `SENTRY_AUTH_TOKEN` EAS secret + org/project env + plugin re-add |
| **Web Sentry** | Code gated on `VITE_SENTRY_DSN` | DSN not set in any committed config — NOT IN REPO — ask Suneel whether prod build has it |
| **WhatsApp Business API** | Env vars reserved in `.env.example`, explicitly marked "no current code path reads these" | Everything — integration not built. Only a `wa.me` share link exists |
| **Delivery-proof OTP by SMS** | OTP generated + persisted "for a future SMS/WhatsApp channel" | No SMS gateway integration exists at all (no Twilio/MSG91/Gupshup anywhere) |
| **Production monitor** | Old E2E monitor workflow disabled 2026-06-08 (it never monitored prod); Telegram monitor template unread by any code | Real monitor build (~1-2 days, scoped in docs) |

---

## 3. HALF-BUILT / IN PROGRESS

| Item | Evidence | Status |
|---|---|---|
| The entire §0 uncommitted batch | working tree | Built + tested, **not committed** |
| `notifications.ts` stub service | `packages/mobile/src/services/notifications.ts` — 6 no-ops + 2 skipped tests waiting | Deliberate stub for v1.1 |
| Mini-operator on mobile | No `(mini-operator)` route group exists — role is web-only | Gap by design or omission — ask Suneel |
| Seed fixtures for newest roles | No seeded `customer_hq` or `mini_operator_admin` user, no `mini_operator` tenant | Test-infra gap |
| One Swagger endpoint documented as `501 Not implemented` | `packages/api/src/swagger.ts:808` | Doc/impl mismatch |
| i18n (EN+TE translations) | Branch `claude/sharp-grothendieck`, never merged | Parked |
| `CustomerInventoryBalance.pendingReturns` | Column + plumbing exist, hidden from all UI, consumed by nothing | Scheduled for removal pass |
| FLAG_SECURE removal | Zero occurrences left in code (N15 brief: "APK rebuild — 5 min") | Code done; ships with next build |

---

## 4. KNOWN GAPS & DEBT (from code evidence)

**Plain language:** the codebase is unusually clean on classic debt markers (only 7 TODO/FIXME in all four packages — real debt is tracked in docs instead). The items below are the concrete gaps the sweep verified.

1. **Timezone-safe dates: 95% adopted, one live bug found.** `localTodayISO()` has 184 call sites and the CI guard blocks the banned pattern. BUT the sweep found one genuine instance the guard can't see because it's split across two lines: [customerService.ts:1647-1648](packages/api/src/services/customerService.ts:1647) (`importOpeningBalances`) — computes **yesterday's date between midnight and 5:30 AM IST**. Four sibling sites worth re-checking: `customerService.ts:1720`, `backdatedAdjustmentService.ts:116`, `routes/reports.ts:187`, `billingService.ts:627`. ~49 other "derived-date" sites are mostly benign formatting of stored dates.
2. **Contact form has no dedicated rate limiter.** `POST /api/contact` (public, writes DB + sends email) is covered only by the global 1000-req/15-min limiter — usable as an email spammer against `CONTACT_FORM_EMAIL`. Every other sensitive route has its own limiter; this one imports none. No CAPTCHA/honeypot. **~30-minute fix.**
3. **Polling intervals.** 12 `refetchInterval` sites. The outlier: [OrdersPage.tsx:2257](packages/web/src/pages/OrdersPage.tsx:2257) polls every **5 seconds** on a heavy page. Sidebar + DashboardLayout each poll at 60s on every authenticated page (2 background requests/min floor for every logged-in user). Driver mobile polling was replaced by SSE (good).
4. **IRN 24h cancel-window pre-check:** present, shared, and unit-tested on web (`gstWindows.ts`, gates Cancel button on both invoice pages). Gaps: no mobile equivalent, and no separate EWB-window helper (both share the IRN-derived check).
5. **`/api/admin/login-history` mounted without `authenticate` at the mount point** — unlike every sibling route. Auth may exist inside the router; verify before next security pass.
6. **Stale compiled Hermes bundles (`.hbc`) committed** under `packages/mobile/dist/` — old code baked into the repo; should be gitignored. Same for the untracked `.aab`/`.apk` binaries in the mobile package root.
7. **Known accepted risks (documented, unchanged):** plaintext credential columns (`gst_credentials`, Razorpay secrets) pending a single coordinated encryption pass; `login_history` retention is a manual endpoint with no cron; GA4 measurement ID hardcoded in `index.html` with no consent gate; `pnpm -r typecheck` may mask per-package failures (lint already fixed).

---

## 5. INTEGRATIONS MATRIX

| Integration | Status in code | Env vars needed | Evidence |
|---|---|---|---|
| **WhiteBooks / NIC GST** (e-invoice + e-way bill) | Live-capable, per-tenant gated (`disabled`/`sandbox`/`live`); prod mode hard-fails without prod creds | 12× `WHITEBOOKS_{EINVOICE,EWAYBILL}_{SANDBOX,PROD}_*`, `EC2_PUBLIC_IP` (NIC IP allowlist) | `services/gst/whitebooksClient.ts` (722 lines) |
| **Razorpay — SaaS billing** (Phase E) | Sandbox/mock-defaulted (mock when key unset/contains "mock") | `RAZORPAY_KEY_ID/SECRET`, `RAZORPAY_WEBHOOK_SECRET` | `services/razorpayService.ts`, `routes/billing.ts:286` |
| **Razorpay — customer Pay Now** (Phase F) | Live-capable, per-tenant, default OFF | DB columns per distributor, not env | `routes/customerPortal.ts:543`, schema:516 |
| **SMTP email** (Google Workspace) | **Live** — welcome/password/contact/invoice mails | `SMTP_HOST/PORT/USER/PASS/FROM`, `CONTACT_FORM_EMAIL` | `utils/email.ts` (718 lines) |
| **Tally export** | **Live** — offline XML voucher files for manual import (not a network sync) | none (settings-driven) | `services/tallyExportService.ts` (630 lines) |
| **AWS S3 + CloudFront** (uploads) | Live-capable, gated; local-disk fallback in dev | `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_CLOUDFRONT_URL` | `lib/s3.ts` |
| **Google Analytics 4** | **Live**, hardcoded ID `G-15XZNWJ79K`, pageview-only, no consent gate | none | `packages/web/index.html:4` |
| **Sentry — API** | Gated: prod + DSN only | `SENTRY_DSN` | `lib/sentry.ts` |
| **Sentry — web** | Gated: `VITE_SENTRY_DSN` (unset in repo) | `VITE_SENTRY_DSN` | `web/src/lib/sentry.ts` |
| **Sentry — mobile** | **Live** in preview/prod builds; source maps deferred | DSN in eas.json; missing `SENTRY_AUTH_TOKEN` | `src/services/crashReporting.ts` |
| **Push (expo-notifications)** | **Stubbed** — 6 no-ops, plugin removed | none yet | `src/services/notifications.ts` |
| **SSE real-time** (in-house) | **Live** — replaced driver 30s polling | none | `lib/sseManager.ts` |
| **GPS** (expo-location) | **Live**, device-native. **No maps API anywhere** (no Google Maps/Mapbox) | none | `src/services/location.ts` |
| **SMS gateway** | **Absent** — zero references; OTP persisted with no send path | — | `deliveryProofService.ts:266` |
| **AiSensy / WhatsApp API** | **Absent** — env vars reserved, unread; only a `wa.me` share link | reserved: `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | `.env.example` |
| **CI/CD** (GitHub Actions → EC2) | **Live** — build, test, SSH deploy staging + prod | AWS + EC2 + SSH secrets | `.github/workflows/ci.yml` |
| **E2E monitor cron** | **Disabled** (2026-06-08; never monitored prod) | legacy | `.github/workflows/e2e-monitor.yml` |
| **Telegram infra monitor** | **Absent** — template file only, no reader | `TELEGRAM_BOT_TOKEN` etc. | `.env.monitor.example` |

---

## 6. MOBILE RELEASE STATE

**Plain language:** the Android app is v1.2.0, built through Expo's cloud (EAS); build numbers are auto-incremented remotely so they aren't visible in the repo. Security hardening (SSL pinning) is wired in and ships with the next store build. A few iOS-vs-Android inconsistencies exist, all known/accepted.

| Item | Value |
|---|---|
| App version (`app.json`) | **1.2.0** (package.json says 1.0.0 — cosmetic drift) |
| Expo SDK | 54 (RN 0.81.5, React 19.1.4) |
| versionCode / buildNumber | Not in repo — EAS remote `appVersionSource` with `autoIncrement: true` on production |
| Android package / iOS bundle | `com.mygaslink.app` |
| Android permissions | Location (fine+coarse), Camera. `RECORD_AUDIO` stripped by local plugin `withoutRecordAudio` |
| iOS config | `supportsTablet: false`, `usesNonExemptEncryption: false`, location + camera usage strings |
| Plugins | 12 total, incl. 4 local: `withResizeableActivity`, `withoutRecordAudio`, `withDedupIntentFilters`, `withSslPinning` |
| EAS profiles | dev (localhost, no pinning) / preview (prod API, `SSL_PINNING=true`, Sentry) / production (same + app-bundle + autoIncrement) |
| Store submit config | iOS `submit.production` present (ascAppId 6783034856); **no Android submit block** — Play releases are manual |

**iOS vs Android mismatches (all worth one line in the next release checklist):**
- Android has verified App Links (`mygaslink.com`); iOS has **no `associatedDomains`** yet (deferred to v1.1 — needs Apple Team ID).
- Android pinning fails **open** on 2027-11-01 (dead-man switch); iOS `NSPinnedDomains` has no expiration — accepted risk in the runbook.
- iOS pinning is unit-test-verified only (prebuild can't generate the iOS project on Windows); real verification happens at EAS cloud build.
- Camera permission string is duplicated in two places (infoPlist + plugin config) — two sources of truth.
- Untracked built binaries (`mygaslink-1.2.0.aab`, an .apk) sit in the mobile package root — should be gitignored.

---

## 7. TENANT & DATA SNAPSHOT (from code/seed only — production DB not queried)

**Plain language:** the platform knows 8 kinds of user and 2 kinds of business account. Dev/test data ships with 3 companies.

**Roles (verbatim):** `super_admin`, `distributor_admin`, `finance`, `inventory`, `driver`, `customer`, `customer_hq`, `mini_operator_admin`

**Account types:** `distributor`, `mini_operator` · **Subscription plans:** starter, growth, business, enterprise, ultra · **GST modes:** disabled, sandbox, live

**Schema scale:** 83 Prisma models, 56 Prisma enums (3,479 lines). Shared TS package mirrors 41 of the 56 enums — 15 have no TS mirror.

**Seeded tenants:** `dist-001` Bhargava Gas Agency (Telangana, GST disabled, IOCL), `dist-002` Sharma Gas Distributors (Karnataka, GST sandbox, HPCL), `dist-demo` Demo Gas Agency (sandbox).

**Seed coverage gaps found by this sweep:**
- No seeded `customer_hq` or `mini_operator_admin` user, and no `mini_operator` account-type tenant — the two newest roles have **zero seed fixtures**.
- Seed prints plaintext default passwords to stdout at the end of `seed.ts` (dev convenience; worth removing before any shared-environment use).
- WhiteBooks sandbox credentials seed onto dist-002 keyed to a personal email.

---

## 8. WHAT COULD SHIP IN <1 WEEK

Engineering judgment from the repo only, least remaining effort first:

| # | Item | What remains | Effort |
|---|---|---|---|
| 1 | **Contact-form rate limiter** | Add a dedicated limiter (pattern already exists 5× in the codebase) + optional honeypot field | ~30 min |
| 2 | **Timezone bug in `importOpeningBalances`** + sibling sites | Swap 5 sites to `localTodayISO()`, extend the CI guard to catch the two-line variant | ~2 hrs |
| 3 | **Android submission — final 3 steps** | Ads declaration → "No ads"; confirm content rating; `eas build --profile production` (which also picks up SSL pinning + FLAG_SECURE removal) | ~half day incl. build wait |
| 4 | **Commit + deploy the §0 batch** (reports revamp, defective returns, supplier + corporation ledgers) | Commit, run 4 migrations on RDS, `pnpm test` (test files already exist), deploy, smoke-test | 1–2 days, mostly verification |
| 5 | **Super Admin SaaS billing go-live** | Release brief marks the 5 ship-blockers "effectively DONE"; remaining: real Razorpay keys in prod env + a live payment test | 1 day — and time-critical for the July-billing… now August-billing cycle |

---

## 9. FUTURE ROADMAP CANDIDATES — GOOD-TO-HAVES, NOT COMMITMENTS

Each item lists the code seam that makes it feasible today. Tiered by how naturally it follows from the existing data model.

### Tier 1 — natural next steps (data model already supports them)

| Idea | What makes it easy today |
|---|---|
| **Route optimisation** (sequence a driver's stops to cut km/day) | Orders + addresses + vehicles + trips + `tripNumber` attribution all exist; start with nearest-neighbour, no maps API needed initially |
| **Live trip tracking + customer ETA** ("your cylinder is 3 stops away") | `expo-location` GPS service + SSE pipe already live; just needs a position-publish loop + customer subscribe |
| **Refill-cycle prediction** (nudge customers before they run out) | Complete per-customer order history with delivery dates; a rolling-average interval is a single query |
| **WhatsApp ordering + status updates** | Env vars already reserved; customer identity + order API complete; needs the WhatsApp Business/AiSensy integration itself |
| **Collections intelligence** (auto-ranked daily call list) | Ledger, overdue computation (`computeCustomerOverdue`), and payment history all exist; Collections page is the natural home |
| **UPI autopay / payment links on every invoice** | Phase F per-tenant Razorpay is fully built — this is activation + UX, not new code |
| **Delivery-proof OTP by SMS** | OTP already generated and persisted; only the SMS gateway send path is missing |

### Tier 2 — strong differentiators (moderate build)

| Idea | What makes it easy today |
|---|---|
| **Cylinder QR tracking** (scan at dispatch/delivery/return) | `expo-camera` already integrated; InventoryEvent stream (15 event types incl. defective) is the ledger to hang scans on |
| **Demand forecasting + auto purchase suggestion** | New F8 supplier ledger + purchase entries give the procurement side; sales history gives demand |
| **Driver incentives / payroll-lite** | Deliveries, collections, empties per driver per trip are all attributed (DDL-1 work made this reliable) |
| **Customer credit scoring → auto credit limits** | Payment punctuality derivable from ledger + allocations; credit gate already exists to enforce it |
| **P&L per vehicle / per route** | Expenses module + Vehicle Ledger report (uncommitted) are the two halves |
| **Recurring/scheduled orders + delivery-slot choice** | Customer portal ordering is complete; needs a schedule table + cron |
| **GSTR-1/3B one-click filing** | GST Filing Export already ships the data; filing via GSP is the last mile |
| **Anomaly alerts** (empties mismatch, cash collected but unrecorded) | Pure queries over the InventoryEvent + payment streams; Pending Actions page is the natural surface |

### Tier 3 — startup-scale platform plays

| Idea | Seam |
|---|---|
| **Self-serve distributor onboarding + subscription checkout** | Onboarding progress tracker + billing plans (5 tiers incl. `ultra`) + Razorpay Phase E all exist — the missing piece is a public signup flow |
| **Multi-depot/godown per distributor** | Schema is single-godown today — real migration work |
| **Mini-operator mobile app** | Role + web surface exist; mobile route group is the gap |
| **Distributor-to-distributor stock exchange** | Multi-tenant DB makes clearing-house mechanics feasible; corp ledger (F8v2) is a template |
| **Embedded finance** (working-capital credit against receivables) | The ledger IS the underwriting data; partner play, not a build |
| **White-label customer app per distributor** | Expo config-driven builds make skinning feasible |
| **Safety & compliance module** (leak-complaint SLA, PESO doc vault, inspection reminders) | Pending Actions + camera + S3 uploads are the building blocks |

### Tier 4 — moonshots (talk about, don't build)

- **IoT smart regulators / weight sensors** — auto-detect low gas, auto-order
- **Franchise/HQ mode** — corporate entity overseeing many distributor tenants (F8v2 corp ledger + customer_hq role are the first seeds)
- **ONDC / marketplace presence** for commercial LPG discovery
- **Carbon/subsidy reporting** as regulation evolves

**Honest revenue ranking:** refill prediction → WhatsApp ordering → collections list → route optimisation. The first three deepen retention with existing distributors; route optimisation demos best but saves less than it looks in dense delivery areas where drivers already know their beats.
