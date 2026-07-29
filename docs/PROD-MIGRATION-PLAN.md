# Production Migration Plan — commit `89f3c43` and beyond

## 1 · Prisma schema changes

**Zero.** Verified with:
```bash
git diff HEAD~1..HEAD --name-only | grep -E "prisma|migrations|\.sql$"
# (no output)
```

Every column my changes touch already exists on prod:
| Column read/written | Table | Already present on prod? |
|---|---|---|
| `unitPriceOverride` on backdated create | `order_items` | ✅ (Mini-op #2 migration, live since 2026-07-23) |
| `driverNameFreeText` on backdated create | `orders` | ✅ (Mini-op #S3 migration, live since 2026-07-16) |
| `emptiesCollected` on backdated create | `order_items` | ✅ (schema field since Brief-3 init migration) |
| `status: 'cancelled'` read for hide-cancelled | `invoices` | ✅ (existing enum member) |
| `accountType: 'mini_operator'` read | `distributors` | ✅ (Mini-op onboarding migration) |
| `orderLevelPricingEnabled` read | `customers` | ✅ (Mini-op #2 migration) |
| `description` search (`contains` ILIKE) | `expenses` | ✅ (existing text column) |
| `paymentMethod` filter | `expenses` | ✅ (existing enum) |

**Deployment:**
```bash
# On EC2, after `git pull` on the API:
cd packages/api
pnpm install
pnpm db:generate           # regenerate Prisma client
# No `pnpm db:migrate` needed — no new migration.
pm2 restart gaslink-api
```

If `db:migrate` is run out of habit, it's a no-op (migrations 1–17 are already applied per CLAUDE.md; there is no migration 18).

## 2 · One-time data operations

### 2.1 — Ready to run (spec'd, on standby)

**Op A: Backfill Mannava Bhargava's 28 ledger-date-drifted orders**
- **Why:** Bhargava entered 28 orders through the regular Create Order form for past delivery dates BEFORE the mini-op backdated shortcut landed. Their `invoice.issueDate` and `customer_ledger_entries.entryDate` landed on the create-day (2026-07-28) instead of the intended `deliveryDate`. Statement PDFs read 28-Jul across the board.
- **Script:** `packages/api/scripts/backfill-backdated-adjustment-dates.ts` (exists) — needs a scoped `--distributor=mannava_bhargava_id --dry-run` first.
- **Safety rails:** dry-run default; skip any invoice with `irnStatus='success'` (won't touch GST-filed docs); skip any invoice already in a prior month; per-order transaction; write an `audit_log` row for each mutation.
- **Prerequisite:** the mini-op backdated flow (in commit `89f3c43`) so users can create backdated orders correctly going forward — done.
- **Status:** ON STANDBY per user 2026-07-28. Runs after v1.0 mobile push once smoke-tests green.
- **Reversibility:** the audit log lets us script an inverse; not automated but doable.

**Op B: Ramani cancelled-invoice cleanup (Quick Gas Supply / mini-op)**
- **Why:** Two invoices for Ramani were cancelled during scenario testing but their reversal ledger entries pushed the statement PDF's running balance higher than reality. My commit's PDF-render-only filter (mini-op) hides them from the customer view — but the DB rows remain and the audit tab still shows them.
- **Script:** none needed. The commit's `hideCancelledInvoices` render-time filter is sufficient. DB stays as-is (audit trail preserved).
- **Status:** No action needed — the fix is the code, not a data op.

### 2.2 — Diagnostic / already-run (informational)

**Full-fleet audit of ledger-date drift** — `packages/api/scripts/audit-ledger-date-drift.ts` ran 2026-07-28 → 31 total drifted orders (28 Bhargava, 3 Vanasthali). The 3 Vanasthali cases were already regularised via the backdated modal on web that same day; only Bhargava's 28 remain.

### 2.3 — Nothing else

No account-purge, no seed-reset, no encryption pass, no analytics-recompute, no cron re-schedule. The commit is behaviour-additive: new mobile CRUD, better ledger math, PDF label fixes, filter extensions.

## 3 · Deploy order (production)

Assuming Codex-on-Mac clears the iOS test plan and Suneel signs off:

1. **Web + API** first.
   - `git pull` on EC2 → `pnpm install` → `pnpm --filter @gaslink/shared build` → `pnpm db:generate` → `pm2 restart gaslink-api` → `pm2 restart gaslink-web` (or however the SPA is served).
   - Smoke: `/health` returns 200; log in as `sharma@gasdist.com` on `mygaslink.com`; land on Analytics.
   - **Rollback:** `git checkout <previous-tag>` on EC2 → `pnpm install` → `pnpm db:generate` → `pm2 restart`. No schema rollback needed (no schema changes).

2. **Android mobile** — EAS Update channel `production`:
   - `eas update --branch production --message "mini-op v1.0 polish + mobile Quotations CRUD"`
   - Verifies: existing installed users get the JS bundle on next open; native binaries unchanged.
   - **Rollback:** `eas update --branch production --republish` an older update. Users pick it up on next open.

3. **iOS mobile** — TestFlight (after §Ship-criteria clears):
   - `eas build --platform ios --profile production`
   - Upload to App Store Connect → TestFlight internal → confirm on Suneel's iPhone → external tester lane → App Store review.
   - **Rollback:** Apple doesn't allow rolling back a submitted build. Next submission fixes forward.

4. **Op A backfill** (only if Suneel green-lights): scoped run with `--distributor=mannava_bhargava_id --dry-run` → diff review → repeat without `--dry-run`.

## 4 · What to watch post-deploy

- **API `/health` 200 across 15 min windows** — check `pm2 logs gaslink-api` for any 500s on the extended `/expenses` endpoint (new `search` + `paymentMethod` filter branches — most likely regression surface).
- **Statement PDFs** — spot-check one B2B (regular) and one mini-op statement to confirm cancelled-row behaviour matches expectations (regular keeps the audit trail; mini-op hides it).
- **Quotation PDF per-kg** — download one to confirm the excl-GST rows appear.
- **User creation / driver-linking** — still working on live (§CLAUDE.md — those tests were pre-existing flakes; the runtime is fine).

## 5 · What we're NOT deploying in this batch

Explicitly out of scope until later chunks:

- Super Admin billing 5 ship-blockers — parked (CLAUDE.md target: restart by 2026-06-25 for July 1 first billing).
- Push notifications (APNs + FCM) — v1.1 Sprint 1.
- Universal Links / AASA file — v1.1.
- SSL cert pinning — v1.1 or DPDP-driven.
- Sentry Expo plugin re-activation — v1.1 (procedure documented in CLAUDE.md; 4 steps).
- GSTR-1 export — parked.
- Float-to-Decimal WI-006 — parked.
- Customer ledger view WI-075 — parked.
- Test suite pollution cleanup (users.test.ts, empties-return T4c) — parked (see CLAUDE.md "PARKED: Test flakiness").

## 6 · TL;DR

- **Prisma migrations to run: none.**
- **One-time data ops to run: none required by this commit.** (Op A is a separate customer-service ask, on standby.)
- **Deploy is a plain `git pull → pnpm install → pnpm db:generate → pm2 restart` on EC2 for the API, then EAS Update for Android, then TestFlight for iOS.**
- **No schema rollback path needed.** Rolling back the code is the whole rollback.
