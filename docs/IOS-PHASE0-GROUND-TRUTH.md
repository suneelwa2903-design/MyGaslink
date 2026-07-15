# iOS Phase 0 — Ground-Truth Audit

**Audit date:** 2026-06-08
**Branch:** main
**HEAD commit:** `4b7e83f` — `chore(web): add Google Analytics (gtag.js) — measurement ID G-15XZNWJ79K` (2026-06-02)
**Last doc update referenced in CLAUDE.md / TESTING_PROGRESS.md:** 2026-05-21 (18 days stale at audit time)
**Working directory dirty:** Yes — `packages/mobile/app.json` has uncommitted local edits (see §3); three uncommitted `.aab` build artifacts; one stray `_tmp_*` file at repo root.

This report is built from `git log`, file inspection, and live `pnpm` runs. Where CLAUDE.md disagrees with what is on disk, this file follows the code.

> ⚠️ **STALE (2026-07-15):** `expo-camera`, `packages/mobile/src/components/DeliveryProofCamera.tsx`, and `packages/api/src/lib/s3.ts` were removed in commit `6abbb23` (2026-06-19). References to these three in this document are historical — they were live at audit time but no longer exist on `main`. `lib/s3.ts` is being restored as part of the proof-of-collection feature (Phase 1); `expo-camera` will be restored in Phase 2. Trust this note over the body when planning current work.

---

## 1. What shipped since the last doc update

Total commits across `2026-05-21..HEAD` on the audited branch: **202**.

By touched area (one commit can touch multiple areas, so totals exceed 202):

| Area | Commits touched |
|------|-----------------|
| `packages/api/` | 103 |
| `packages/mobile/` | 69 |
| `packages/web/` | 40 |
| `docs/` | 29 |
| `packages/shared/` | 17 |

No commits in the window have `WIP`, `broken`, or `fixme` in the subject. Three commits are explicit test-only or wipe-script work and not feature reverts (`c8af6c9`, `bc7f8c7`, `68f074f`).

### Mobile-relevant highlights (chronological, oldest first)

The mobile package has effectively been rebuilt since 2026-05-21. The cluster headed `[STEP-*]`, `[STAGE-*]`, `[GROUP-*]` is a deliberate web→mobile parity drive for the four ops roles (distributor_admin, finance, inventory, super_admin — driver and customer were not in scope, see §3).

- `8b0f9ba feat(mobile+api): SSE driver notifications, super-admin logout, DPDP consent, account deletion, Android App Links, demo seed data, SSE tests, flaky test fixes` — adds three of the four CLAUDE.md "MUST DO" items in one shot (DPDP consent, account deletion, App Links). SSE replaces polling for driver notifications (the actual implementation lives in [packages/mobile/src/services/sseService.ts](../packages/mobile/src/services/sseService.ts), see §6).
- `caad937 [STEP-2A] feat(shared): canonical status labels + variants — single source of truth` — adds shared label/variant lookup so web and mobile cannot diverge on order/note status copy.
- `[STEP-1A]` / `[STEP-1B]` (`bae6fe7`, `a63aad7`) — API role-gate tightening + web button-visibility alignment with API.
- `[STEP-3A]` … `[STEP-3I]` and `[STAGE-A]` … `[STAGE-H]` — the bulk of (admin) screen parity work: orders, pending actions, collections, vehicle mapping, customers, settings, dashboard, inventory parity, billing & payments parity, scrollable 9-tab bar + Reports/Customers/Fleet/Collections promoted to tabs.
- `[GROUP-1]` … `[GROUP-9D]` — finer-grained admin polish (dashboard redesign, payment detail modal, fleet edit, bulk assign, customer balances filters, vehicle return per-cylinder breakdown, orders payload corrections, GST settings Test-Connection, cylinder prices/thresholds CRUD, users add/edit role + deactivate, IRN/EWB cancel-button removal).
- `c4eeba2 chore(mobile): SDK 54 dep alignment — unblock EAS dev build (expo-dev-client + 8 version fixes + 2 missing peers)` — landed before the parity drive; this is the most recent SDK bump.
- `de4627a chore(mobile): hoist pnpm node_modules to unblock EAS Gradle (fixes react-native-reanimated build)` and `1e73974 chore(workspace): promote node-linker=hoisted to root .npmrc — EAS install honours it` — pnpm hoisting fixes for EAS Android builds. **Note:** these commits' subject lines reference `react-native-reanimated`, but `react-native-reanimated` is NOT in [packages/mobile/package.json](../packages/mobile/package.json) anymore — it appears to have been removed (or the dep was pulled in transitively at the time and is no longer needed). Verify before relying.
- `609164b fix(shared): add prepare script to build dist before EAS bundling` — EAS bundler couldn't resolve `@gaslink/shared/dist` without a build step; now `prepare` builds before pack.
- Three mobile bugfixes on `2026-06-01`: `16fa843` (cylinder-types URL), `e31af91` (mark-as-returned + safe area + vehicle return payload + validation error expansion), `f61afc5` (assign driver date + dashboard alerts + collections), `1fc475e` (partial-delivery fulls + reconciled empties + daily summary date — most recent commit touching `packages/mobile/`).

### What did NOT ship since 2026-05-21

- No iOS-specific commits (no `ios:` prefix, no `Info.plist` edits beyond what was already in `app.json`, no native Xcode project).
- No `@sentry/react-native` install (DSN is plumbed in eas.json but the SDK is uninstalled, see §5).
- No real `expo-notifications` registration code path (the service file is a no-op stub even though the plugin is in `app.json`, see §5).
- No SSL cert pinning library.
- No biometric / `expo-local-authentication` work.

### Suspect commits

None matching `WIP|broken|fixme|revert` in subject. Two commits warrant a closer look for hidden risk:

- `c4eeba2` — SDK 54 dep alignment. SDK 54 is current (Expo 54.x is the line we're on per `packages/mobile/package.json`'s `expo ~54.0.35`). No concerns flagged.
- `0dabbfa fix(gst): NIC error surfacing, trip auto-advance after EWB retry, B2C/B2B dispatch consistency, seed UUID IDs, vehicle plate validation` — large multi-fix; unrelated to iOS readiness but landed inside the window.

---

## 2. Real test status

Three commands run from the repo root or the package directory. Mobile typecheck was run via `pnpm typecheck` inside `packages/mobile`. Lint via `pnpm run lint` at the root. Tests run per-package because the root `pnpm -r run test` output never flushed to file but completed successfully (exit 0).

### `pnpm test` (per-package, exit 0 on all)

| Package | Result | Tests | Files | Duration |
|---------|--------|-------|-------|----------|
| `@gaslink/api` (vitest) | ✅ exit 0 | **895 passed**, 0 failed, 0 skipped | 86 | 85s |
| `@gaslink/mobile` (jest) | ✅ exit 0 | **41 passed**, 2 skipped, 0 failed | 6 | 4s |
| `@gaslink/web` (vitest) | ✅ exit 0 | **6 passed**, 0 failed | 2 | 1s |
| `@gaslink/shared` | n/a — no `test` script | — | — | — |

**Grand total: 942 passed / 2 skipped / 0 failed.**

The two skipped tests are in [packages/mobile/src/__tests__/notifications.test.ts](../packages/mobile/src/__tests__/notifications.test.ts):

```
it.skip('returns push token when permission granted (stub: not built in Expo Go)', ...)
it.skip('requests permission when not already granted (stub: not built in Expo Go)', ...)
```

The skips are intentional and the in-file comment is honest: `src/services/notifications.ts` is a **no-op stub** because push notifications don't work in Expo Go. The stub's `registerForPushNotifications()` hard-returns `null` and never calls `expo-notifications`, so the granted-path assertions can never pass. The third test (`returns null when permission denied`) does pass because the stub always returns `null`. **See §6 — this means push notifications are not actually implemented; only the permission-denied stub is "tested".**

### `pnpm typecheck` (mobile, exit 0)

```
> @gaslink/mobile@1.0.0 typecheck C:\Projects\Re-New_Gaslink\packages\mobile
> tsc --noEmit
```

Clean — zero TypeScript errors in `packages/mobile`.

### `pnpm run lint` (root, exit 0)

`pnpm -r run lint` ran across api / web / mobile / shared. **0 errors** across all packages. Warning counts:

| Package | Errors | Warnings |
|---------|--------|----------|
| api | 0 | (not surfaced in tail) |
| web | 0 | 5 (`react-hooks/incompatible-library` on `useForm().watch`, `react-hooks/exhaustive-deps`) |
| mobile | 0 | 10 (`react-hooks/exhaustive-deps` on screens) |

CLAUDE.md describes ESLint as "blocking" with `@typescript-eslint/no-explicit-any` promoted to `error`. That is still true: lint exits 0 on `main`. The warnings are pre-existing hooks-rule advice; none are ship-blockers.

### Ground-truth delta vs CLAUDE.md

CLAUDE.md "PRODUCTION STATE" claims **"TESTS: 716 passing"**. Reality: **942 passing + 2 skipped**. That's a +226 test delta since 2026-05-21, consistent with the API suite growing from ~700 to 895 across the parity-drive window plus the new SSE/mobile services and anti-pattern guards.

---

## 3. Mobile app inventory

### Route groups (Expo Router file-based)

Seven role-based route groups exist under [packages/mobile/app/](../packages/mobile/app/). Counting `(auth)` (login/forgot-password), there are **6 in-app role surfaces** plus the auth flow — not 3 apps. The "three apps" framing from the task brief maps to:

- **Customer app** → `(customer)` route group. **EXISTS.** Tabs: dashboard, orders, invoices, payments, account.
- **Driver app** → `(driver)` route group. Tabs: orders, trip, inventory, analytics, more, profile.
- **Distributor (admin) app** → split across FOUR role groups, not one:
  - `(admin)` for `distributor_admin` (and currently the most-built-out)
  - `(super-admin)` for `super_admin`
  - `(finance)` for `finance`
  - `(inventory)` for `inventory`

### Root navigation router

[packages/mobile/app/index.tsx](../packages/mobile/app/index.tsx) routes by `user.role` after auth-store hydration:

```
customer        → /(customer)/dashboard
driver          → /(driver)/orders
super_admin     → /(super-admin)/dashboard
distributor_admin → /(admin)/dashboard
inventory       → /(inventory)/analytics  (summary is href:null; STEP-2B)
finance         → /(finance)/dashboard
```

### Screen counts per group

```
(auth)        3 files (_layout, login, forgot-password)
(customer)    6 files (_layout, dashboard, orders, invoices, payments, account)
(driver)      7 files (_layout, orders, trip, inventory, analytics, more, profile)
(admin)      15 files (_layout, dashboard, orders, inventory, fleet, customers, customer-create, customer-detail, collections, finance, reports, pending-actions, more, profile)
(super-admin) 13 files (_layout, dashboard, orders, customers, distributors, fleet, inventory, billing, users, settings, provider-catalog, health, more)
(finance)     7 files (_layout, dashboard, collections, payments, invoices, more, profile)
(inventory)  11 files (_layout, analytics, orders, fleet, inventory, reconciliation, summary, actions, alerts, more, profile)
```

Total screens: **62** including layouts.

### Version metadata — single source

[packages/mobile/package.json](../packages/mobile/package.json):

```json
"name": "@gaslink/mobile",
"version": "1.0.0"
```

[packages/mobile/app.json](../packages/mobile/app.json):

```json
"name": "MyGasLink",
"slug": "mygaslink",
"version": "1.0.0",
"runtimeVersion": { "policy": "appVersion" },
"ios.bundleIdentifier": "com.mygaslink.app",
"android.package": "com.mygaslink.app",
"scheme": "mygaslink",
"owner": "mygaslinks-organization",
"extra.eas.projectId": "43a84457-0603-4883-8247-c351f159f575"
```

**Critical gaps:**

- `expo.ios.buildNumber` — **NOT SET.** App Store Connect requires this; without it, `eas build` may default to "1" on every build which will collide on every upload to ASC after the first.
- `expo.android.versionCode` — **NOT SET.** Same risk on Google Play.
- `expo.version` — set to `1.0.0`, hard-coded. Combined with `runtimeVersion.policy: "appVersion"`, every build will share runtime `"1.0.0"` until `version` is bumped — that means EAS Update will deliver any new JS bundle to every installed copy. Acceptable for launch; revisit before the second iOS submission.

### Local edits not yet committed

`git status --short` shows `M packages/mobile/app.json`. The diff:

```
android.permissions: + "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION", "android.permission.CAMERA", "android.permission.RECORD_AUDIO"
extra.eas.projectId: f6e20f06-1ee0-48da-be19-e4426997c0ff → 43a84457-0603-4883-8247-c351f159f575
owner: poultryproplus → mygaslinks-organization
```

Two concerns:

1. **`android.permission.RECORD_AUDIO`** is added to Android. There is no matching `NSMicrophoneUsageDescription` in `ios.infoPlist`. If the iOS build ever pulls a native module that touches the microphone (it should not given current deps — see §5 — but the Android permission suggests intent), iOS will crash on first use. Either remove RECORD_AUDIO (no library in the deps list needs it) or add `NSMicrophoneUsageDescription` defensively.
2. The `extra.eas.projectId` and `owner` switch suggests the EAS project has been migrated to a new org; this is the active config but is uncommitted. Commit before any build to avoid losing it.

### Latest commit touching mobile

`1fc475e` — 2026-06-01 — *fix(driver+admin): vehicle stock shows remaining fulls after partial delivery + empties zero on both confirm and mismatch + daily summary date display*. So the mobile package has not been touched since the 2026-06-01 driver/admin bugfix.

---

## 4. iOS build readiness

### Native iOS project

```
ls packages/mobile/ios/ → No such file or directory (exit 2)
```

**No native `ios/` directory exists.** This is the managed Expo workflow. EAS cloud build is the only way to produce an iOS binary from this repo without first running `npx expo prebuild --platform ios`. That is a *good* default — we get to skip Xcode signing dances — but the trade-off is that every native dep is locked to what the EAS image supports, and any iOS-only Info.plist tweak has to ride in `app.json > expo.ios.infoPlist` or via a config plugin.

No `app.config.js` / `app.config.ts` either — `app.json` is the only source of truth.

### `eas.json` profiles

[packages/mobile/eas.json](../packages/mobile/eas.json):

```json
{
  "cli": { "version": ">= 12.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "simulator": true },
      "android": { "buildType": "apk" },
      "env": { "EXPO_PUBLIC_API_URL": "http://localhost:5000/api" }
    },
    "preview": {
      "distribution": "internal",
      "ios": { "simulator": false },
      "android": { "buildType": "apk" },
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.mygaslink.com/api",
        "EXPO_PUBLIC_SENTRY_DSN": "https://b78dc94670acb...@...sentry.io/4511100732506112"
      }
    },
    "production": {
      "autoIncrement": true,
      "ios": { "image": "latest" },
      "android": { "buildType": "app-bundle" },
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.mygaslink.com/api",
        "EXPO_PUBLIC_SENTRY_DSN": "https://b78dc94670acb...@...sentry.io/4511100732506112"
      }
    }
  },
  "submit": { "production": {} }
}
```

**Build-config gaps blocking iOS App Store submission:**

| Item | Status | Notes |
|------|--------|-------|
| `build.production.ios.image` | `"latest"` set | OK. Pins to the current EAS macOS image. |
| `build.production.ios.resourceClass` | NOT SET | Falls back to EAS default (m-medium for production). Fine for first build; may need bumping for cold-cache builds. |
| `build.production.ios.simulator` | NOT SET | Defaults to `false` (device-archive). Correct for App Store. |
| `build.production.autoIncrement` | `true` | iOS build number will auto-increment. Combined with `appVersionSource: "remote"` (cli config), EAS owns the build number, not the local `app.json`. Good. |
| `cli.appVersionSource` | `"remote"` | EAS owns build numbers on the server. So the missing `expo.ios.buildNumber` in `app.json` is not a blocker — EAS will manage it. But the first build still needs an initial number set in the EAS project; check before kicking off. |
| `submit.production.ios.appleId` | **NOT SET** | Required for `eas submit` to TestFlight / App Store. Ship-blocker. |
| `submit.production.ios.ascAppId` | **NOT SET** | Required. Ship-blocker. |
| `submit.production.ios.appleTeamId` | **NOT SET** | Required. Ship-blocker. |
| Apple Developer Program membership | UNKNOWN locally | Cannot be inspected from disk. Treat as pending until the user confirms enrollment is complete. |

`submit.production` is an empty object — every Apple/ASC identifier needs to be added before `eas submit --platform ios` can run.

### `app.json > expo.ios` — what's there vs what's needed

What's set today:

```json
"ios": {
  "supportsTablet": true,
  "bundleIdentifier": "com.mygaslink.app",
  "infoPlist": {
    "NSLocationWhenInUseUsageDescription": "We need your location for delivery tracking",
    "NSCameraUsageDescription": "We need camera access for delivery proof photos",
    "NSPhotoLibraryUsageDescription": "Allow MyGasLink to save delivery proof photos"
  }
}
```

What's MISSING (and at least one is a likely ship-blocker — see §5 for the audit table):

- `expo.ios.buildNumber` — not in `app.json`. EAS handles via `appVersionSource: remote`, so this is OK but be aware.
- `expo.ios.entitlements` — not present; nothing in the codebase requires entitlements today (no Push capability declared, no Sign In With Apple, no Associated Domains).
- `expo.ios.associatedDomains` — **NOT SET.** Android has `intentFilters` for `mygaslink.com` and `www.mygaslink.com` (App Links via `autoVerify: true`); the iOS equivalent (Universal Links) needs `associatedDomains: ["applinks:mygaslink.com", "applinks:www.mygaslink.com"]` here AND an `apple-app-site-association` file at `https://mygaslink.com/.well-known/apple-app-site-association`. Today only the custom URL scheme `mygaslink://` works on iOS; HTTPS deep links from email/SMS will open Safari, not the app. Not a hard reject from Apple, but breaks user expectation.
- `NSFaceIDUsageDescription` — n/a, no biometric library installed (see §5).
- `NSMicrophoneUsageDescription` — required IFF iOS ends up linking a native module that touches the mic. Today none of the listed `expo-*` deps include the mic, so this is currently OK; but `android.permission.RECORD_AUDIO` was just added to the Android side (uncommitted) — if a future feature actually uses it, iOS will need a string here.
- `NSUserTrackingUsageDescription` — only required if any analytics SDK uses ATT. Not present today (no AppsFlyer, no Branch, no Facebook SDK).
- `ITSAppUsesNonExemptEncryption` (or equivalent in `app.json > expo.ios.config.usesNonExemptEncryption: false`) — **NOT SET.** Apple asks this question on every TestFlight upload. Setting it to `false` (the app only uses HTTPS, which is exempt) skips a per-build prompt. Strongly recommended.

---

## 5. Native modules audit

From [packages/mobile/package.json](../packages/mobile/package.json) `dependencies` (16 native-relevant packages):

| Module | Version | iOS support | Info.plist key required | In `app.json`? |
|--------|---------|-------------|-------------------------|----------------|
| `expo` | ~54.0.35 | ✅ (host SDK) | n/a | n/a |
| `expo-router` | ~6.0.24 | ✅ | n/a (plugin only) | plugin listed ✅ |
| `expo-secure-store` | ~15.0.8 | ✅ Keychain | n/a | plugin listed ✅ |
| `expo-location` | ~19.0.8 | ✅ CoreLocation | `NSLocationWhenInUseUsageDescription` | present ✅; plugin string in plugins[] ✅ |
| `expo-camera` | ~17.0.10 | ✅ AVFoundation | `NSCameraUsageDescription`, optionally `NSMicrophoneUsageDescription` if used for video w/ audio | `NSCameraUsageDescription` present ✅; **`NSMicrophoneUsageDescription` ABSENT** — only an issue if camera is used for audio-on video; today the camera service is photos-only per [DeliveryProofCamera.tsx](../packages/mobile/src/components/DeliveryProofCamera.tsx). OK as long as we never enable video. |
| `expo-notifications` | ~0.32.17 | ✅ APNs | none for permission text (Apple handles); needs Push Capability entitlement IF actually used | plugin listed ✅; but **service file is a NO-OP stub** ([packages/mobile/src/services/notifications.ts](../packages/mobile/src/services/notifications.ts) — every function returns `null` or no-ops with a header comment "replace this with the real implementation"). EAS production build will silently produce an APNs-capable binary that never registers a token. See §6. |
| `expo-file-system` | ^19.0.23 | ✅ | n/a | n/a |
| `expo-font` | ~14.0.12 | ✅ | n/a | plugin listed ✅ |
| `expo-linking` | ^8.0.12 | ✅ | n/a (scheme via expo.scheme) | scheme `mygaslink` set ✅ |
| `expo-sharing` | ^14.0.8 | ✅ UIActivityViewController | n/a | n/a |
| `expo-constants` | ~18.0.13 | ✅ | n/a | n/a |
| `expo-dev-client` | ~6.0.21 | ✅ | n/a | dev builds only |
| `expo-status-bar` | ~3.0.9 | ✅ | n/a | n/a |
| `@expo/vector-icons` | ^15.1.1 | ✅ (font subset) | n/a | n/a |
| `@expo/metro-runtime` | ^6.1.2 | ✅ (runtime) | n/a | n/a |
| `@react-native-community/datetimepicker` | ^8.4.4 | ✅ | n/a | plugin listed ✅ |
| `@react-native-community/netinfo` | ^11.4.1 | ✅ | n/a | n/a |
| `react-native-safe-area-context` | ~5.6.2 | ✅ | n/a | n/a |
| `react-native-screens` | ~4.16.0 | ✅ | n/a | n/a |
| `nativewind` | ^4.1.0 | ✅ (babel-only) | n/a | n/a |
| `react-native` | ~0.81.5 | ✅ | n/a | n/a |
| `react` | ^19.1.0 | ✅ | n/a | n/a |
| `axios` | ^1.15.0 | JS only | n/a | n/a |
| `@tanstack/react-query` | ^5.80.0 | JS only | n/a | n/a |
| `zustand` | ^5.0.0 | JS only | n/a | n/a |
| `zod` | ^3.25.0 | JS only | n/a | n/a |

### Cross-checks against CLAUDE.md anti-patterns

- **AsyncStorage for tokens**: ABSENT. `@react-native-async-storage/async-storage` is NOT a dependency. Token storage goes through `expo-secure-store` in [packages/mobile/src/lib/api.ts](../packages/mobile/src/lib/api.ts) (lines 13-41). The only string match for "AsyncStorage" in the mobile package is a comment in `deliveryQueue.ts` saying it explicitly avoids AsyncStorage. ✅ Compliant with CLAUDE.md mobile rule #1.
- **SSL cert pinning**: ABSENT. No `react-native-ssl-pinning`, no custom interceptor. CLAUDE.md flags this as "NON-NEGOTIABLE" before launch. **Still TODO.** See §6.
- **`react-native-reanimated`**: NOT in dependencies despite `de4627a chore(mobile): hoist pnpm node_modules to unblock EAS Gradle (fixes react-native-reanimated build)` referencing it. Either it was removed afterwards or it was transitively pulled by a now-removed dep. Worth confirming on a clean install before EAS; if it ever was needed, it isn't now.
- **`@sentry/react-native`**: NOT in dependencies. But `EXPO_PUBLIC_SENTRY_DSN` is set on both preview and production EAS profiles, and the file [packages/mobile/src/services/crashReporting.ts](../packages/mobile/src/services/crashReporting.ts) has the entire Sentry init code COMMENTED OUT with a header saying "To fully activate, ensure @sentry/react-native is installed". So crash reporting is a stub: prod builds will report nothing to Sentry, ever. Inline note: `[CrashReporting]` console.error fallback only fires in `__DEV__`.

### Android-only libs

None. Every dep that has any native code supports both platforms.

---

## 6. App Store submission gating items (re-check of CLAUDE.md "MUST DO BEFORE FIRST DISTRIBUTOR")

| Item | CLAUDE.md as of 2026-05-21 | Reality on `4b7e83f` | Notes |
|------|----------------------------|----------------------|-------|
| WhiteBooks prod creds on EC2 | TODO | Cannot inspect locally — assume TODO unless user confirms. | Not iOS-relevant. |
| **DPDP consent checkbox in mobile app** | TODO | **DONE.** [(auth)/login.tsx](../packages/mobile/app/(auth)/login.tsx) lines 16-29, 47-98, 230-282 implement an explicit DPDP consent checkbox with `dpdp_consent_v1` key persisted to SecureStore. Login is blocked until ticked. | Landed in `8b0f9ba` on 2026-05-?? (after the doc snapshot). |
| **Account deletion UI in mobile app** | TODO | **DONE.** [packages/mobile/src/components/DeleteAccountButton.tsx](../packages/mobile/src/components/DeleteAccountButton.tsx) — mailto-based deletion request with 30-day promise, mounted in (admin)/more.tsx, (finance)/profile.tsx, (inventory)/profile.tsx, (super-admin)/settings.tsx, (customer)/account.tsx, (driver)/profile.tsx. | ⚠️ Apple-specific concern: App Store guideline **5.1.1(v)** requires account deletion **in-app**, not via email. A mailto link MAY be rejected by reviewers; the guideline language is "your app must let users initiate account deletion from within the app and the action must complete with no further interaction required from the user other than a confirmation". A mailto opens a separate app (Mail) and asks the user to send. **This is a likely review-team rejection vector.** Either build a real `DELETE /api/users/me` flow (preferred) or ensure the mailto pre-fills sufficient info that reviewers will accept it as a single-tap initiate. The web admin already has the user CRUD scaffolding; an API endpoint is the smaller lift. |
| **SSL cert pinning** | TODO ("NON-NEGOTIABLE") | **STILL TODO.** No pinning library in deps; no custom interceptor in `src/lib/api.ts`; no `https-pinning` directive. | Apple does NOT require pinning to ship to App Store. But CLAUDE.md flags it as non-negotiable for the launch posture. Decide: ship without pinning to hit the 2-week budget (acceptable risk for v1.0, the API is HTTPS-only and the mobile app talks to one well-known host), then add it as v1.1. |
| **Push notifications** | "super-critical — drivers won't get delivery alerts otherwise" | **PARTIALLY DONE.** [packages/mobile/src/services/notifications.ts](../packages/mobile/src/services/notifications.ts) is a **no-op stub**. The header comment says "Push notifications are NOT supported in Expo Go (SDK 53+). This file exports no-op stubs so the app doesn't crash. When building a dev APK (eas build --profile development), replace this with the real implementation". The replacement HAS NOT happened. **However**, driver-side real-time updates are handled by SSE (`8b0f9ba`'s "SSE driver notifications") via [packages/mobile/src/services/sseService.ts](../packages/mobile/src/services/sseService.ts) — XHR-based EventSource client that connects to `/api/drivers/me/events` whenever the driver app is in foreground. **What this means for iOS launch:** drivers get foreground updates via SSE, but: (a) no background push, so the driver MUST have the app open to see new orders, (b) `expo-notifications` is in `app.json > expo.plugins` and will produce an APNs-capable binary on iOS — Apple may flag the unused capability if it's wrong, but it won't be a reject. **Recommendation:** either remove the `expo-notifications` plugin entirely until the real implementation lands, or implement registration + a real `device_tokens` API endpoint as part of the iOS push. The mobile-app side is straightforward; the API needs a token table + a fan-out path. |
| **Privacy Policy** | implied | privacy URL `https://mygaslink.com/privacy` referenced from the consent checkbox. The site is live (per CLAUDE.md "LIVE AT: mygaslink.com"). Apple wants this URL submitted in App Store Connect. | Confirm the page actually loads + includes the disclosures the data-collection nutrition label will declare (location, camera, photos, contact info). |
| **Privacy nutrition labels** | not addressed in CLAUDE.md | Must be declared in App Store Connect, not in code. Based on §5: Location, Camera, Photos, Contact Info (email/phone via login), Identifiers (device token if push lands). | Not a code task; flag for ASC prep. |

### Other Apple-review gotchas observed in code

- The DPDP consent checkbox UI is mandatory before login but the underlying privacy disclosure is a `Linking.openURL` to the privacy policy webpage. Apple historically accepts this if (a) the link is reachable from a pre-account-creation screen (it is — the login screen), and (b) the policy actually exists. Confirm the page is up before submission.
- The audit cannot confirm the actual content of `mygaslink.com/privacy`; do a manual fetch before submission.

---

## 7. Ground-truth deltas vs CLAUDE.md

| CLAUDE.md claim | Reality on `4b7e83f` |
|-----------------|----------------------|
| `EC2 HEAD: 58404de` | Local HEAD is `4b7e83f`. `58404de` is 96 commits behind. EC2 deployment state cannot be inspected from this machine. |
| `TESTS: 716 passing` | **942 passing + 2 skipped** (api 895, mobile 41+2-skip, web 6). |
| `MUST DO: WhiteBooks production credentials` | Cannot inspect EC2 locally. Treat as still TODO. |
| `MUST DO: DPDP consent checkbox in mobile app` | **DONE** in `8b0f9ba`. |
| `MUST DO: Account deletion UI in mobile app` | **DONE** in `8b0f9ba` (mailto-based; see §6 for Apple-review caveat). |
| `MUST DO: SSL cert pinning in mobile (NON-NEGOTIABLE)` | **STILL ABSENT.** No pinning library or custom interceptor. |
| `MUST DO: Push notifications` | **STUB STILL IN PLACE.** Driver foreground updates use SSE instead (`sseService.ts`). Real `expo-notifications` registration is not wired. |
| `ANDROID SUBMISSION — 3 steps remaining: ads decl / content rating / production aab` | Cannot confirm from code alone. Three local `.aab` files exist under `packages/mobile/build-*.aab` (~73 MB each) from 2026-06-02 — these are EAS Android production builds that have already been produced but apparently not uploaded yet. |
| App `expo.version: 1.0.0`, `package.json version: 1.0.0` | ✅ Match. No mismatch. |
| `expo-secure-store` for tokens | ✅ Confirmed in [src/lib/api.ts](../packages/mobile/src/lib/api.ts). |
| No `console.log` in prod code | Not enforced via babel — `babel-plugin-transform-remove-console` is not in deps. CLAUDE.md mentions it as a rule but it isn't actually installed. Console statements DO ship today. |
| `@sentry/react-native` for crash reporting | **NOT installed.** Service is a stub with Sentry code commented out. DSN is in eas.json env but unused. |
| ESLint runs clean and blocking | ✅ Confirmed — 0 errors, 0 explicit-any, 15 hooks-warnings. |
| Mobile dev rule #5 "EXPO_PUBLIC_API_URL must use LAN IP for phone testing" | `eas.json` `development.env.EXPO_PUBLIC_API_URL` is `http://localhost:5000/api`. This is fine for simulator but will not work for a physical-device dev build — must be overridden per-developer. Pre-existing condition, not new. |

---

## 8. Recommended next moves

Ordered by hard dependency. "Today" = "do before any other Phase 1 work starts."

1. **Today — Apple Developer Program enrollment** *(parallel, user-side)*. Cannot proceed to step 8 without the team ID + an ASC App Record. Allow 24-48h for individual; up to 2 weeks for organization (D-U-N-S). This is the critical-path risk for the 2-week budget — if it's not started, start today.

2. **Today — Decide the account-deletion path.** App Store guideline 5.1.1(v) requires in-app account deletion that completes "with no further interaction other than a confirmation." The current mailto implementation is at high risk of reviewer rejection. Two options:
   - **Cheap fix:** keep mailto BUT also add an in-app "Confirm deletion" button that calls a real `DELETE /api/users/me` (soft-delete server-side, hard-delete in the 30-day batch job). Two-day API task.
   - **Riskier:** ship as-is and respond to the rejection if it comes. Adds 7-10 days to the timeline if it comes back.
   Recommend option A.

3. **Today — Commit the working-copy `app.json` changes** so the EAS project ID isn't lost. Five-minute task; do this before kicking off any EAS build.

4. **This week — Add the missing iOS submission identifiers to `eas.json > submit.production.ios`**: `appleId`, `ascAppId`, `appleTeamId`. Cannot run `eas submit` without them. Five-minute task after the user has the ASC app record from step 1.

5. **This week — Decide on push notifications.** Two paths:
   - **Path A (cheap):** remove the `expo-notifications` plugin from `app.json` for v1.0. SSE already covers driver foreground updates. Document explicitly that v1.0 has no background push. Six-line code change.
   - **Path B (real):** install `@sentry/react-native` style — i.e. replace `notifications.ts` stub with the real implementation that requests permission, fetches Expo push token, posts it to a new `POST /api/devices/register-push-token` endpoint, server fan-out integrated into the existing SSE notifier. Roughly 3-5 days of work, including iOS APNs config + server-side device-token table + Sentry-grade tests.
   Choose A for the 2-week iOS budget; revisit for v1.1.

6. **This week — Add iOS Universal Links** to match Android App Links. `app.json > expo.ios.associatedDomains: ["applinks:mygaslink.com", "applinks:www.mygaslink.com"]` + `apple-app-site-association` file deployed at `https://mygaslink.com/.well-known/apple-app-site-association`. One-day task split between mobile config and web deploy. Optional but recommended.

7. **This week — Set `app.json > expo.ios.config.usesNonExemptEncryption: false`** to avoid the per-upload TestFlight prompt. Five-minute change. We use HTTPS only; the exemption applies.

8. **Week 2 — First EAS iOS build.** `eas build --platform ios --profile production`. This is the first time the iOS toolchain runs against this codebase. Likely surprises: native-module version mismatches even though `c4eeba2` cleaned up SDK 54 alignment (verify against current Expo SDK 54 native version map), Apple-asset assertions (icon sizes, splash sizes — `assets/icon.png` and `assets/splash.png` exist but iOS may want a separate adaptive icon). Budget a full day of iteration on this even if everything else is in place.

9. **Week 2 — TestFlight internal track.** Run the same screens the Android build was tested against, on a physical iPhone — driver flow, customer order placement, admin dashboard. Catch any iOS-specific touch-target / SafeAreaView / KeyboardAvoidingView regressions before public submission.

10. **Week 2 — App Store review submission.** Submit with one of: (a) updated in-app account deletion (recommended), (b) detailed reviewer notes explaining the mailto-then-30-day flow. Expect 24-72h initial review.

### Can we EAS-cloud-build iOS today without code changes?

**No.** The blockers in order:

1. `submit.production.ios.{appleId, ascAppId, appleTeamId}` are unset → can't submit, but CAN build.
2. **Account deletion mailto** is a known App-Store-rejection risk → can build, can submit, will likely get bounced.
3. `app.json > expo.ios.config.usesNonExemptEncryption` missing → can build, but every upload prompts (annoying, not blocking).
4. Working-copy `app.json` changes uncommitted → if a fresh checkout is used to build, the EAS projectId reverts to the old one.

So **CAN run `eas build --platform ios --profile production`** today (after committing app.json), but cannot ship to the App Store without fixing items 1 + 2.

### Single most likely blower of the 2-week iOS budget

**The account-deletion mailto is the biggest risk to the schedule.** Apple's review team is aggressive about 5.1.1(v) — a reject costs 5-10 days minimum. Either ship the real `DELETE /api/users/me` endpoint and an in-app confirmation modal alongside the mailto, or be ready to redo the submission with reviewer notes explaining the policy of an off-app deletion request.

The second most likely budget-blower is the first EAS iOS build itself — first contact with the iOS toolchain after a long managed-Expo run; budget a full debug day.

---

*End of Phase 0 audit. Reach the user before starting Phase 1.*
