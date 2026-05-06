# Pre-Launch Checklist — Re-New GasLink

**Generated:** 2026-05-06
**Sources:** `tracking/work_items.json`, `session-summary-06052026.md`, `gap-report.md`, `eas-readiness.md`, `float-to-decimal-plan.md`, `tenant-audit-results.md`

This checklist is the honest go/no-go view, not aspirational. Each row says what's actually true today.

---

## A. Code & infra (engineering side)

| ID | Item | Status | Verified by |
|---|---|---|---|
| WI-001 | Tenant-isolation audit (services) | 🟢 done | 254/254 tests pass; commits `b6f8c58/a0f855c/8c758b2` |
| WI-002 | `requireDistributor` exemptions cleaned up | 🟢 done | commit `aec783d` |
| WI-003 | Ad-hoc test scripts removed | 🟢 done | commit `21c8fee` |
| WI-004 | CN/DN buttons hidden when GST disabled | 🟢 done | commit `d1bb216` |
| WI-005 | Vehicle field removed from assign-driver modal | 🟢 done | commit `d1bb216` |
| WI-009 | Graceful shutdown + process error handlers | 🟢 done | commit `1add950` |
| WI-010 | Web ErrorBoundary | 🟢 done | commit `6d7afd9` |
| WI-011 | Source maps off in production vite build | 🟢 done | commit `6d7afd9` |
| WI-012 | axios upgraded to ^1.15.0 (CVE fixes) | 🟢 done | commit `8c59594` |
| WI-013 | Distributor verified in `resolveDistributor` middleware | 🟢 done | commit `aec783d` |
| WI-014 | Audit log for super_admin tenant switches | 🟢 done | commit `aec783d` |
| WI-015 | PORT discrepancy fixed (5000 everywhere) | 🟢 done | commit `7a89001` |
| WI-019 | Pre-existing typecheck bugs fixed | 🟢 done | commit `6d7afd9` |
| WI-016 | Integration tests Batch A (customers, payments, billing) | 🟢 done | commit `6c7527a`, 34 new tests |
| WI-017 | Integration tests Batch B (settings, drivers/vehicles, assignments, analytics) | 🟢 done | commits `be29a17/2c2544a/c505aae/c4e3f29`, 75 new tests |
| WI-018 | Integration tests Batch C (cylinderTypes, pricing, users, pendingActions) | 🟢 done | commits `0aedee4/4b104e0/518aedc/5b04ea1`, 51 new tests |
| WI-008 | Telugu i18n — full coverage | 🟡 in-progress | foundation done (commit `a2dd97c`); 22 web pages + all of mobile remain |
| WI-006 | Float → Decimal migration (35 monetary fields) | ⚪ planned, deferred | plan in `.session/float-to-decimal-plan.md`; classified `blocksLaunch: false` |
| WI-007 | GST live mode tested against WhiteBooks production | 🔴 not done | needs founder action — first IRN ever to be issued |
| WI-020 | `@sentry/browser` wired up for web ErrorBoundary | ⚪ deferred | post-launch hardening |

**Test suite:** 254/254 passing. **Typecheck:** zero errors in api/web/shared.

## B. Manual testing

| Item | Status | Notes |
|---|---|---|
| Phase 1 — Navigation smoke (55 cases × 7 roles) | 🔴 0/55 | per `docs/TESTING_PROGRESS.md` |
| Phase 2 — E2E by module (≈200 cases) | 🔴 0 | not started |
| Phase 3 — Mobile via Expo Go | 🔴 0 | not started |
| Phase 4 — API integration tests | 🟢 254/254 | `pnpm test` |

## C. Founder action items (blocking)

| Item | Source | Status |
|---|---|---|
| Issue first real IRN against WhiteBooks production credentials | WI-007 | 🔴 pending |
| Telugu translation review by native speaker | session-summary-06052026 | 🔴 pending |
| Apple Developer account + bundle ID `com.mygaslink.app` reservation | eas-readiness §7.3 | 🔴 pending |
| Google Play Console + bundle ID reservation | eas-readiness §7.3 | 🔴 pending |
| DNS for `api.mygaslink.com` → production EC2 with TLS | eas-readiness §3 | 🔴 pending |
| Privacy policy + ToS hosted publicly | eas-readiness §6.4 | 🔴 pending |
| `eas credentials` interactive setup (one-time, registers cert + keystore with EAS) | eas-readiness §6.1 | 🔴 pending |
| Confirm Expo `owner: poultryproplus` is the right org | eas-readiness §2 | 🔴 pending |
| Confirm app version `1.0.0` for first build | eas-readiness §2 | 🔴 pending |
| Production GST credentials provisioned (WhiteBooks) | TESTING_PROGRESS / WI-007 | 🔴 pending |
| Run Phase 1 navigation smoke (≈30 min once API+web are running) | TESTING_PROGRESS | 🔴 pending |
| Run Phase 2 critical workflows (Order → Payment, Inventory cycle, Customer portal) | TESTING_PROGRESS | 🔴 pending |
| Run Phase 3 mobile via Expo Go on real devices | TESTING_PROGRESS | 🔴 pending |

## D. Founder action items (advisable but not blocking)

| Item | Source | Status |
|---|---|---|
| Resolve `RECORD_AUDIO` mismatch (drop it from Android OR add `NSMicrophoneUsageDescription`) | eas-readiness §6.5 | 🟡 |
| Visual eye-pass on icon, splash, adaptive-icon for safe-area compliance | eas-readiness §6.6 | 🟡 |
| Fill in `eas.json` `submit.production` block with Apple ID + ASC App ID + Google service-account path | eas-readiness §5 | 🟡 |
| Wire up Sentry source-map upload (`@sentry/react-native`, `@sentry/vite-plugin`) | eas-readiness §5 / WI-020 | 🟡 |
| Telugu i18n full extraction across remaining web pages + mobile | WI-008 | 🟡 |

## E. Deferred to post-launch

| Item | Reason |
|---|---|
| WI-006 — Float → Decimal migration | High blast-radius surgery (4-8h). Float still works; rounding drift is bounded for current order values (< ₹100k). Plan ready in `.session/float-to-decimal-plan.md` for a dedicated session. |
| WI-008 — Telugu i18n full coverage (22 web pages + 11 components + 55 mobile route files + 7 mobile components) | Foundation in place. Extraction is mechanical; the bottleneck is native-speaker translation review. Recommended cadence: per-page namespace, one PR per page. |
| WI-020 — `@sentry/browser` web wiring | ErrorBoundary uses `globalThis.Sentry` for now. Wire up after Sentry web account is provisioned. |
| Web component-level integration tests | Manual smoke covers it pre-launch per founder direction. |
| Mobile unit tests (Jest configured but unused) | Manual via Expo Go pre-launch. |

---

## Go / No-Go Summary

| Category | Status |
|---|---|
| Engineering — code quality, tests, security | 🟢 **GO** |
| Engineering — Float→Decimal precision | 🟡 **CONDITIONAL** — currently within tolerance for typical order values; revisit if any tenant exceeds ₹100k single-invoice GST math |
| Engineering — Telugu i18n full coverage | 🟡 **NOT GO** if Telugu is launch-required; foundation only |
| Manual QA — Phases 1, 2, 3 | 🔴 **NOT GO** — manual passes have not started |
| External — accounts, DNS, store reservations, privacy policy | 🔴 **NOT GO** — none provisioned yet |
| External — GST live mode | 🔴 **NOT GO** — never issued a real IRN |

**Net:** ENGINEERING-side is GO. Launch is currently blocked on (a) external/founder action items in §C, (b) manual testing in §B, and (c) the Telugu coverage call in §A WI-008.

If WI-008 full coverage is hard-required for launch (founder previously said yes), expect 16–48 additional hours of i18n extraction + native-speaker review before the launch window opens. If the launch can ship in English-only with Telugu rolling in as a fast-follow, the engineering side is ready as soon as §B and §C are unblocked.
