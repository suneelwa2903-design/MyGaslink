# iOS Phase 1 — Per-App Parity Matrix

**Audit date:** 2026-06-08
**Branch:** main
**HEAD commit:** `6df8856` — `chore(mobile): remove expo-notifications plugin for v1.0`
**Inputs:** Phase 0 audit ([docs/IOS-PHASE0-GROUND-TRUTH.md](IOS-PHASE0-GROUND-TRUTH.md)), live grep of `packages/mobile/`, `expo prebuild --platform ios --no-install --clean` dry-run.
**Authoritative reference:** Android is the source of truth. Every "iOS missing / wrong" call below is "make iOS match Android." Where Android itself is unclear or inconsistent across the three apps, the row is tagged 🚩 ASK SUNEEL.
**Pre-existing context honoured:**
- `expo-notifications` plugin is OUT of `app.json` as of `6df8856`. Not flagged as a bug below.
- `ios.buildNumber`, `usesNonExemptEncryption`, and an `eas.json submit.production.ios` block landed in `500d6d2` and are present (values empty pending Apple Developer enrollment).
- iOS toolchain not available locally (Windows). `expo prebuild --platform ios` is a Windows-side dry-run only; section 6 documents the exact behaviour.

Legend: ✅ working / ⚠ caveat / ❌ missing or broken / 🚩 ASK SUNEEL.

---

## 1. App inventory

The five role-based route groups under [packages/mobile/app/](../packages/mobile/app/) decompose into the three logical "apps" called for in the brief. Counts come from the `.tsx` file inventory in section 2.

### Customer app — `(customer)`

5 visible screens + 1 layout. Entry is `(customer)/dashboard.tsx`; on JWT-decoded `role === 'customer'` the root router at [packages/mobile/app/index.tsx](../packages/mobile/app/index.tsx) lands the user here. Tabs: Dashboard, Orders, Invoices, Payments, Account. Primary user is a household / commercial LPG consumer who places refill orders, views the running balance, and downloads invoice PDFs. Android status from Phase 0: parity drive complete, no open bugs as of 2026-06-01 (`1fc475e`). Files: [(customer)/_layout.tsx](../packages/mobile/app/(customer)/_layout.tsx), [dashboard.tsx](../packages/mobile/app/(customer)/dashboard.tsx), [orders.tsx](../packages/mobile/app/(customer)/orders.tsx), [invoices.tsx](../packages/mobile/app/(customer)/invoices.tsx), [payments.tsx](../packages/mobile/app/(customer)/payments.tsx), [account.tsx](../packages/mobile/app/(customer)/account.tsx).

### Driver app — `(driver)`

6 visible screens + 1 layout. Entry is `(driver)/orders.tsx` for `role === 'driver'`. Tabs: Analytics, My Deliveries (orders), Trip, Vehicle Stock (inventory), More; Profile is hidden behind More. Primary user is the delivery driver. The layout at [(driver)/_layout.tsx](../packages/mobile/app/(driver)/_layout.tsx) wires three cross-cutting concerns on mount: (a) offline-queue auto-sync via `attachAutoSync` / `startNetworkListener`, (b) SSE event stream via `sseConnect` (`order_assigned`/`order_updated`/`trip_updated` invalidate TanStack keys), (c) a pending-deliveries badge over the orders tab. Android status: working, with PDF trip-sheet download via `expo-file-system` v55 + `expo-sharing` in [trip.tsx](../packages/mobile/app/(driver)/trip.tsx). Files: [(driver)/_layout.tsx](../packages/mobile/app/(driver)/_layout.tsx), [orders.tsx](../packages/mobile/app/(driver)/orders.tsx), [trip.tsx](../packages/mobile/app/(driver)/trip.tsx), [inventory.tsx](../packages/mobile/app/(driver)/inventory.tsx), [analytics.tsx](../packages/mobile/app/(driver)/analytics.tsx), [more.tsx](../packages/mobile/app/(driver)/more.tsx), [profile.tsx](../packages/mobile/app/(driver)/profile.tsx).

### Ops / Distributor cluster — `(admin)` + `(super-admin)` + `(finance)` + `(inventory)`

The "distributor app" is actually four role-scoped route groups, each its own Tabs layout.

- **`(admin)` — distributor_admin role.** 13 screens + 1 layout, including the largest single file in the repo ([(admin)/inventory.tsx](../packages/mobile/app/(admin)/inventory.tsx) at 4130 lines and [(admin)/orders.tsx](../packages/mobile/app/(admin)/orders.tsx) at 3080 lines). Custom scrollable 9-tab bar via [ScrollableTabBar.tsx](../packages/mobile/src/components/ui/ScrollableTabBar.tsx) (STAGE-H). Tabs: Dashboard, Orders, Billing (file `finance`), Inventory, Reports, Customers, Fleet, Collections, More. Hidden routable screens: `pending-actions`, `customer-detail`, `customer-create`, `profile`. Primary user: distributor head — orders, billing, GST, fleet, customers, collections. Android status: parity drive complete (STEP/STAGE/GROUP commits); the largest mobile surface.
- **`(super-admin)` — super_admin role.** 12 screens + 1 layout. Default 5-tab `<Tabs>` layout (no ScrollableTabBar). Visible tabs: Analytics, Orders, Inventory, Customers, More. Hidden but routable: `distributors`, `billing`, `users`, `fleet`, `settings`, `provider-catalog`, `health`. Primary user: MyGasLink platform operator with cross-distributor visibility.
- **`(finance)` — finance role.** 5 visible screens + Profile hidden. Tabs: Analytics (file `dashboard`), Invoices, Payments, Collections, More.
- **`(inventory)` — inventory role.** 5 visible screens + 5 hidden (summary, actions, reconciliation, alerts, profile). Tabs: Analytics, Orders, Inventory, Fleet, More.

Total screens across all groups (including layouts and `(auth)`): **62** `.tsx` files. Android status across the cluster: working post-parity drive; root index router at [packages/mobile/app/index.tsx](../packages/mobile/app/index.tsx) handles role gating.

---

## 2. Per-screen parity matrix

A `.tsx` is judged "iOS working: ✅" UNLESS it imports an Android-only module, uses a `Platform.OS` branch that leaves iOS missing, depends on Android intent-filter or Android-permission machinery without an iOS equivalent, or touches native APIs whose iOS support is conditional. The platform-OS scans below (sections 3–5) confirm that every existing `Platform.OS` ternary covers both branches and the only Android-specific code path is `DateTimePickerAndroid.open()` in [DateInput.tsx:77-89](../packages/mobile/src/components/ui/DateInput.tsx) which is gated behind `Platform.OS === 'android'` and the iOS branch is fully implemented at [DateInput.tsx:135-178](../packages/mobile/src/components/ui/DateInput.tsx).

So the question reduces to: "do any screens depend on Android-side configuration that is missing on iOS?" The answer for the file-by-file matrix is — `app.json > expo.android.intentFilters` registers the HTTPS deep-link route for `mygaslink.com`. The iOS equivalent (`expo.ios.associatedDomains`) is not set. So any screen that is the target of an HTTPS deep link is functionally degraded on iOS to scheme-only (`mygaslink://…`). Section 5 explains in detail. In the per-screen tables this surfaces as ⚠ on the screens that are likely deep-link targets (today: the password-reset flow at `(auth)/forgot-password.tsx`, and any email-link to an invoice or order — but neither side currently emits HTTPS app-link URLs from the server, so the gap is structural rather than functional today).

### 2.1 Customer app

| Screen | File path | Android working | iOS working | Gap notes |
|--------|-----------|-----------------|-------------|-----------|
| Layout (tabs) | [app/(customer)/_layout.tsx](../packages/mobile/app/(customer)/_layout.tsx) | ✅ | ✅ | Standard 5-tab `<Tabs>`. No platform-specific code. |
| Dashboard | [app/(customer)/dashboard.tsx](../packages/mobile/app/(customer)/dashboard.tsx) | ✅ | ✅ | No native API usage beyond TanStack queries. |
| Orders | [app/(customer)/orders.tsx](../packages/mobile/app/(customer)/orders.tsx) | ✅ | ⚠ | Uses `Linking.openURL('tel:...')` at lines [246, 509](../packages/mobile/app/(customer)/orders.tsx). iOS handles `tel:` natively. Four `KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}` blocks at [563, 652, 714, 804](../packages/mobile/app/(customer)/orders.tsx) — correct iOS path. `presentationStyle="overFullScreen"` + `statusBarTranslucent` set on all sheet modals, both iOS- and Android-correct. |
| Invoices | [app/(customer)/invoices.tsx](../packages/mobile/app/(customer)/invoices.tsx) | ✅ | ✅ | PDF download → `expo-file-system` v55 + `expo-sharing`. Identical pattern works on both platforms; iOS share sheet is UIActivityViewController. |
| Payments | [app/(customer)/payments.tsx](../packages/mobile/app/(customer)/payments.tsx) | ✅ | ✅ | Same PDF/share pattern as invoices.tsx (line 4-5). |
| Account | [app/(customer)/account.tsx](../packages/mobile/app/(customer)/account.tsx) | ✅ | ✅ | KeyboardAvoidingView at [line 243](../packages/mobile/app/(customer)/account.tsx); modal uses `presentationStyle="overFullScreen" statusBarTranslucent` at line 240 — iOS-correct. `DeleteAccountButton` mounted here. |

### 2.2 Driver app

| Screen | File path | Android working | iOS working | Gap notes |
|--------|-----------|-----------------|-------------|-----------|
| Layout (tabs + SSE + offline-queue) | [app/(driver)/_layout.tsx](../packages/mobile/app/(driver)/_layout.tsx) | ✅ | ✅ | SSE uses XHR (no native module), works on both platforms per [sseService.ts:13-18](../packages/mobile/src/services/sseService.ts). `attachAutoSync`/`startNetworkListener` use `@react-native-community/netinfo` which supports both. |
| Analytics | [app/(driver)/analytics.tsx](../packages/mobile/app/(driver)/analytics.tsx) | ✅ | ✅ | Read-only charts. |
| My Deliveries (orders) | [app/(driver)/orders.tsx](../packages/mobile/app/(driver)/orders.tsx) | ✅ | ✅ | Comment block at [284-290](../packages/mobile/app/(driver)/orders.tsx) explicitly documents iOS `presentationStyle="overFullScreen"` and Android `statusBarTranslucent` together — both branches set. Uses `DeliveryProofCamera` ([components/DeliveryProofCamera.tsx](../packages/mobile/src/components/DeliveryProofCamera.tsx)) which works on iOS via `expo-camera`. `NSCameraUsageDescription` IS in `app.json`. |
| Trip | [app/(driver)/trip.tsx](../packages/mobile/app/(driver)/trip.tsx) | ✅ | ✅ | Trip-sheet PDF download via `new File(Paths.cache, ...)` + `Sharing.shareAsync` with explicit `UTI: 'com.adobe.pdf'` at [trip.tsx:160](../packages/mobile/app/(driver)/trip.tsx) — the UTI is iOS-specific and correctly provided. Location tracking via `expo-location` foreground-only (`NSLocationWhenInUseUsageDescription` set in `app.json`). |
| Vehicle Stock (inventory) | [app/(driver)/inventory.tsx](../packages/mobile/app/(driver)/inventory.tsx) | ✅ | ✅ | Read mostly. |
| More | [app/(driver)/more.tsx](../packages/mobile/app/(driver)/more.tsx) | ✅ | ✅ | Includes DeleteAccountButton; uses mailto Linking (see section 7 — mailto is iOS-compatible but Apple 5.1.1(v) policy is a separate concern, flagged as blocker). |
| Profile (hidden) | [app/(driver)/profile.tsx](../packages/mobile/app/(driver)/profile.tsx) | ✅ | ✅ | Thin wrapper around `src/screens/ProfileScreen.tsx`. |

### 2.3 Ops cluster — (admin)

| Screen | File path | Android working | iOS working | Gap notes |
|--------|-----------|-----------------|-------------|-----------|
| Layout (9-tab scrollable bar) | [app/(admin)/_layout.tsx](../packages/mobile/app/(admin)/_layout.tsx) | ✅ | ✅ | `ScrollableTabBar` includes iOS-aware `paddingBottom: Platform.OS === 'ios' ? 8 : 6` at [ScrollableTabBar.tsx:104](../packages/mobile/src/components/ui/ScrollableTabBar.tsx). Home-indicator safe area is handled via the parent SafeAreaView in each screen. |
| Dashboard | [app/(admin)/dashboard.tsx](../packages/mobile/app/(admin)/dashboard.tsx) | ✅ | ✅ | |
| Orders | [app/(admin)/orders.tsx](../packages/mobile/app/(admin)/orders.tsx) | ✅ | ✅ | 3080-line screen with multiple Modal sheets — each declares `presentationStyle="fullScreen"` or `"pageSheet"` (line 2285); `pageSheet` is iOS-only (Android falls back). KeyboardAvoidingView at lines 1041/1691/1989/2184. PDF export via expo-file-system+sharing. |
| Billing (file `finance`) | [app/(admin)/finance.tsx](../packages/mobile/app/(admin)/finance.tsx) | ✅ | ✅ | 8 `KeyboardAvoidingView`/`paddingBottom` Platform.OS branches, all correct (lines 1308, 1316, 1468, 1476, 1918, 1926, 2155, 2164, 2430, 2709). PDF/share pattern identical. |
| Inventory | [app/(admin)/inventory.tsx](../packages/mobile/app/(admin)/inventory.tsx) | ✅ | ✅ | Three `behavior={Platform.OS === 'ios' ? 'padding' : 'height'}` (837, 1205, 3304) — the `'height'` Android fallback is the recommended pattern, OK. |
| Reports | [app/(admin)/reports.tsx](../packages/mobile/app/(admin)/reports.tsx) | ✅ | ✅ | CSV export via same expo-file-system + sharing path. |
| Customers | [app/(admin)/customers.tsx](../packages/mobile/app/(admin)/customers.tsx) | ✅ | ✅ | |
| Customer Detail (hidden) | [app/(admin)/customer-detail.tsx](../packages/mobile/app/(admin)/customer-detail.tsx) | ✅ | ✅ | PDF/share for invoice download. |
| Customer Create (hidden) | [app/(admin)/customer-create.tsx](../packages/mobile/app/(admin)/customer-create.tsx) | ✅ | ✅ | The header comment at [customer-create.tsx:11-13](../packages/mobile/app/(admin)/customer-create.tsx) explicitly cites iOS-specific Modal nesting fragility as the *reason* this was promoted from a Modal-in-Modal to a real route. Already iOS-hardened. |
| Collections | [app/(admin)/collections.tsx](../packages/mobile/app/(admin)/collections.tsx) | ✅ | ✅ | `tel:` Linking at line 240. iOS-native. |
| Fleet | [app/(admin)/fleet.tsx](../packages/mobile/app/(admin)/fleet.tsx) | ✅ | ✅ | |
| Pending Actions (hidden) | [app/(admin)/pending-actions.tsx](../packages/mobile/app/(admin)/pending-actions.tsx) | ✅ | ✅ | |
| More | [app/(admin)/more.tsx](../packages/mobile/app/(admin)/more.tsx) | ✅ | ✅ | Many Modal sheets, all with `presentationStyle="fullScreen"` or `"formSheet"` (`formSheet` is iOS-only, falls back gracefully on Android). KeyboardAvoidingView branches at 560, 817, 1680. |
| Profile (hidden) | [app/(admin)/profile.tsx](../packages/mobile/app/(admin)/profile.tsx) | ✅ | ✅ | 14-line wrapper. |

### 2.4 Ops cluster — (super-admin)

| Screen | File path | Android working | iOS working | Gap notes |
|--------|-----------|-----------------|-------------|-----------|
| Layout (5 tabs) | [app/(super-admin)/_layout.tsx](../packages/mobile/app/(super-admin)/_layout.tsx) | ✅ | ✅ | Default `<Tabs>` — 7 screens hidden via `href: null`. |
| Dashboard (Analytics) | [app/(super-admin)/dashboard.tsx](../packages/mobile/app/(super-admin)/dashboard.tsx) | ✅ | ✅ | |
| Orders | [app/(super-admin)/orders.tsx](../packages/mobile/app/(super-admin)/orders.tsx) | ✅ | ✅ | |
| Customers | [app/(super-admin)/customers.tsx](../packages/mobile/app/(super-admin)/customers.tsx) | ✅ | ✅ | |
| Distributors (hidden) | [app/(super-admin)/distributors.tsx](../packages/mobile/app/(super-admin)/distributors.tsx) | ✅ | ✅ | KeyboardAvoidingView at line 222. |
| Fleet (hidden) | [app/(super-admin)/fleet.tsx](../packages/mobile/app/(super-admin)/fleet.tsx) | ✅ | ✅ | |
| Inventory | [app/(super-admin)/inventory.tsx](../packages/mobile/app/(super-admin)/inventory.tsx) | ✅ | ✅ | |
| Billing (hidden) | [app/(super-admin)/billing.tsx](../packages/mobile/app/(super-admin)/billing.tsx) | 🚩 | 🚩 | Phase 0 noted an unrelated SUPERADMIN-BILLING-AUDIT.md exists in working dir — possibly indicates Android-side ambiguity here. 🚩 ASK SUNEEL: is super-admin Billing considered "working" on Android? Phase 1 should not invent an answer. |
| Users (hidden) | [app/(super-admin)/users.tsx](../packages/mobile/app/(super-admin)/users.tsx) | ✅ | ✅ | KeyboardAvoidingView at line 199. |
| Settings (hidden) | [app/(super-admin)/settings.tsx](../packages/mobile/app/(super-admin)/settings.tsx) | ✅ | ✅ | DeleteAccountButton mounted. |
| Provider Catalog (hidden) | [app/(super-admin)/provider-catalog.tsx](../packages/mobile/app/(super-admin)/provider-catalog.tsx) | ✅ | ✅ | |
| Health (hidden) | [app/(super-admin)/health.tsx](../packages/mobile/app/(super-admin)/health.tsx) | ✅ | ✅ | |
| More | [app/(super-admin)/more.tsx](../packages/mobile/app/(super-admin)/more.tsx) | ✅ | ✅ | |

### 2.5 Ops cluster — (finance)

| Screen | File path | Android working | iOS working | Gap notes |
|--------|-----------|-----------------|-------------|-----------|
| Layout (5 tabs) | [app/(finance)/_layout.tsx](../packages/mobile/app/(finance)/_layout.tsx) | ✅ | ✅ | |
| Dashboard (Analytics) | [app/(finance)/dashboard.tsx](../packages/mobile/app/(finance)/dashboard.tsx) | ✅ | ✅ | |
| Invoices | [app/(finance)/invoices.tsx](../packages/mobile/app/(finance)/invoices.tsx) | ✅ | ✅ | Modal at line 202 with `presentationStyle="fullScreen"`. |
| Payments | [app/(finance)/payments.tsx](../packages/mobile/app/(finance)/payments.tsx) | ✅ | ✅ | KeyboardAvoidingView at 324, 561. |
| Collections | [app/(finance)/collections.tsx](../packages/mobile/app/(finance)/collections.tsx) | ✅ | ✅ | |
| More | [app/(finance)/more.tsx](../packages/mobile/app/(finance)/more.tsx) | ✅ | ✅ | |
| Profile (hidden) | [app/(finance)/profile.tsx](../packages/mobile/app/(finance)/profile.tsx) | ✅ | ✅ | DeleteAccountButton mounted. |

### 2.6 Ops cluster — (inventory)

| Screen | File path | Android working | iOS working | Gap notes |
|--------|-----------|-----------------|-------------|-----------|
| Layout (5 tabs) | [app/(inventory)/_layout.tsx](../packages/mobile/app/(inventory)/_layout.tsx) | ✅ | ✅ | |
| Analytics | [app/(inventory)/analytics.tsx](../packages/mobile/app/(inventory)/analytics.tsx) | ✅ | ✅ | |
| Orders | [app/(inventory)/orders.tsx](../packages/mobile/app/(inventory)/orders.tsx) | ✅ | ✅ | |
| Inventory | [app/(inventory)/inventory.tsx](../packages/mobile/app/(inventory)/inventory.tsx) | ✅ | ✅ | KeyboardAvoidingView at line 772. |
| Fleet | [app/(inventory)/fleet.tsx](../packages/mobile/app/(inventory)/fleet.tsx) | ✅ | ✅ | |
| More | [app/(inventory)/more.tsx](../packages/mobile/app/(inventory)/more.tsx) | ✅ | ✅ | |
| Summary (hidden) | [app/(inventory)/summary.tsx](../packages/mobile/app/(inventory)/summary.tsx) | ✅ | ✅ | |
| Actions (hidden) | [app/(inventory)/actions.tsx](../packages/mobile/app/(inventory)/actions.tsx) | ✅ | ✅ | KeyboardAvoidingView at 190. |
| Reconciliation (hidden) | [app/(inventory)/reconciliation.tsx](../packages/mobile/app/(inventory)/reconciliation.tsx) | ✅ | ✅ | |
| Alerts (hidden) | [app/(inventory)/alerts.tsx](../packages/mobile/app/(inventory)/alerts.tsx) | ✅ | ✅ | |
| Profile (hidden) | [app/(inventory)/profile.tsx](../packages/mobile/app/(inventory)/profile.tsx) | ✅ | ✅ | DeleteAccountButton mounted. |

### 2.7 Auth (shared)

| Screen | File path | Android working | iOS working | Gap notes |
|--------|-----------|-----------------|-------------|-----------|
| Layout | [app/(auth)/_layout.tsx](../packages/mobile/app/(auth)/_layout.tsx) | ✅ | ✅ | |
| Login (with DPDP consent) | [app/(auth)/login.tsx](../packages/mobile/app/(auth)/login.tsx) | ✅ | ✅ | KeyboardAvoidingView at line 129 (`'padding'` iOS / `'height'` Android). DPDP consent persists in SecureStore. Privacy policy `Linking.openURL` at line 66 — iOS handles HTTPS Linking via Safari. |
| Forgot password (OTP) | [app/(auth)/forgot-password.tsx](../packages/mobile/app/(auth)/forgot-password.tsx) | ✅ | ⚠ | KeyboardAvoidingView at line 169 correct. ⚠ If the reset link is ever sent as an HTTPS app-link (vs an in-app OTP entry), iOS lacks `associatedDomains` and would open Safari instead of the app. Today the flow is OTP-entry inside the app, so the gap is structural rather than functional — see section 5. |

---

## 3. `Platform.OS` branches inventory

Total `Platform.OS` occurrences in the mobile package (excluding `node_modules`): **35**, distributed across 22 files (full list captured during the audit). The audit found **zero** instances where the iOS branch is missing or returns a different *behavioural* result from the Android branch — the patterns are uniformly styling deltas (KeyboardAvoidingView mode, paddingBottom for the iOS home-indicator) and one Android-specific imperative-vs-modal API split for the date picker. Below are the unique families.

| # | File:line(s) | Android branch does | iOS branch does | Severity | Recommended fix |
|---|--------------|---------------------|-----------------|----------|-----------------|
| 1 | [(auth)/login.tsx:129](../packages/mobile/app/(auth)/login.tsx) | KeyboardAvoidingView `behavior='height'` | KeyboardAvoidingView `behavior='padding'` | cosmetic | None — this is the React Native official cross-platform recipe. |
| 2 | [(auth)/forgot-password.tsx:169](../packages/mobile/app/(auth)/forgot-password.tsx) | `behavior='height'` | `behavior='padding'` | cosmetic | None. |
| 3 | [(admin)/finance.tsx](../packages/mobile/app/(admin)/finance.tsx) lines 1308, 1316, 1468, 1476, 1918, 1926, 2155, 2164, 2430, 2709 | `behavior=undefined` and `paddingBottom: 24` | `behavior='padding'` and `paddingBottom: 36` (extra space for iOS home-indicator) | cosmetic | None. |
| 4 | [(admin)/inventory.tsx:837, 1205, 3304](../packages/mobile/app/(admin)/inventory.tsx) | `behavior='height'` | `behavior='padding'` | cosmetic | None. |
| 5 | [(admin)/orders.tsx:1041, 1691, 1989, 2184](../packages/mobile/app/(admin)/orders.tsx) | `behavior=undefined` | `behavior='padding'` | cosmetic | None. |
| 6 | [(admin)/more.tsx:560, 817, 1680](../packages/mobile/app/(admin)/more.tsx) | `behavior=undefined` | `behavior='padding'` | cosmetic | None. |
| 7 | [(admin)/pending-actions.tsx:503](../packages/mobile/app/(admin)/pending-actions.tsx) | `behavior=undefined` | `behavior='padding'` | cosmetic | None. |
| 8 | [(super-admin)/users.tsx:199](../packages/mobile/app/(super-admin)/users.tsx) | `behavior='height'` | `behavior='padding'` | cosmetic | None. |
| 9 | [(super-admin)/distributors.tsx:222](../packages/mobile/app/(super-admin)/distributors.tsx) | `behavior='height'` | `behavior='padding'` | cosmetic | None. |
| 10 | [(finance)/payments.tsx:324, 561](../packages/mobile/app/(finance)/payments.tsx) | `behavior='height'` | `behavior='padding'` | cosmetic | None. |
| 11 | [(inventory)/actions.tsx:190](../packages/mobile/app/(inventory)/actions.tsx) | `behavior='height'` | `behavior='padding'` | cosmetic | None. |
| 12 | [(inventory)/inventory.tsx:772](../packages/mobile/app/(inventory)/inventory.tsx) | `behavior='height'` | `behavior='padding'` | cosmetic | None. |
| 13 | [(customer)/account.tsx:243](../packages/mobile/app/(customer)/account.tsx) | `behavior=undefined` | `behavior='padding'` | cosmetic | None. |
| 14 | [(customer)/orders.tsx:563, 652, 714, 804](../packages/mobile/app/(customer)/orders.tsx) | `behavior=undefined` | `behavior='padding'` | cosmetic | None. |
| 15 | [src/screens/ProfileScreen.tsx:145](../packages/mobile/src/screens/ProfileScreen.tsx) | `behavior=undefined` | `behavior='padding'` | cosmetic | None. |
| 16 | [src/screens/CustomerForm.tsx:553](../packages/mobile/src/screens/CustomerForm.tsx) | `behavior=undefined` | `behavior='padding'` | cosmetic | None. |
| 17 | [src/components/ui/DateInput.tsx:93-99, 134-178](../packages/mobile/src/components/ui/DateInput.tsx) | Imperative `DateTimePickerAndroid.open()` | Inline `<Modal>` + `<DateTimePicker display="inline">` with explicit Done/Cancel | acceptable-asymmetry | None — required by SDK 54; the iOS branch is the official Expo recipe. |
| 18 | [src/components/ui/ScrollableTabBar.tsx:104](../packages/mobile/src/components/ui/ScrollableTabBar.tsx) | `paddingBottom: 6` | `paddingBottom: 8` (home-indicator) | cosmetic | None. |
| 19 | [src/components/ui/SelectField.tsx:109](../packages/mobile/src/components/ui/SelectField.tsx) | `paddingBottom: 24` | `paddingBottom: 36` | cosmetic | None. |

Search for `Platform.OS === 'ios'` and `Platform.OS === 'android'` returned **only** the above families — no asymmetric "feature on Android, missing on iOS" branches.

There is **one** Android-only string match in services code worth noting (not Platform.OS but Android-aware): [deliveryQueue.ts:9](../packages/mobile/src/services/deliveryQueue.ts) comment "SecureStore on Android caps each key at ~2KB." iOS Keychain has effectively no per-key cap, so the constraint is the binding one; behaviour is fine on both.

---

## 4. Native module iOS gaps

The Phase 0 table is reproduced below with only the iOS-config columns.

| Module | iOS Info.plist key required | Present in `app.json > expo.ios.infoPlist`? | iOS entitlement needed | Other iOS config |
|--------|------------------------------|------------------------------------------------|------------------------|------------------|
| `expo-secure-store` (Keychain) | none | n/a | none (Keychain access is implicit) | none |
| `expo-location` | `NSLocationWhenInUseUsageDescription` | ✅ ([app.json:25](../packages/mobile/app.json)) | none (foreground-only) | Plugin also embeds `locationAlwaysAndWhenInUsePermission` string at [app.json:75](../packages/mobile/app.json) — defensive; only NSLocationWhenInUseUsageDescription is actually consumed because `isAndroidBackgroundLocationEnabled: false` and no iOS-always permission is requested by code. |
| `expo-camera` | `NSCameraUsageDescription` | ✅ ([app.json:26](../packages/mobile/app.json)) | none | `NSMicrophoneUsageDescription` would be needed for video w/ audio. ❌ Not set. Currently camera is photos-only ([DeliveryProofCamera.tsx](../packages/mobile/src/components/DeliveryProofCamera.tsx) uses `takePictureAsync`, never `recordAsync`) — OK. **Do not enable video without first adding `NSMicrophoneUsageDescription`.** |
| `expo-camera` (Photos save) | `NSPhotoLibraryUsageDescription` | ✅ ([app.json:27](../packages/mobile/app.json)) | none | OK. |
| `expo-notifications` | (none for permission text; APNs is Apple-managed) | n/a (plugin removed in `6df8856`) | Push capability (`aps-environment`) IF re-enabled | Plugin is out of `app.json` for v1.0 — push is intentionally deferred. Phase 0 noted this. |
| `expo-file-system` | none | n/a | none | Cache writes go to `Paths.cache` (iOS NSCachesDirectory) — automatic. |
| `expo-sharing` | none | n/a | none | Maps to UIActivityViewController — automatic. Trip-sheet at [trip.tsx:160](../packages/mobile/app/(driver)/trip.tsx) supplies `UTI: 'com.adobe.pdf'` which iOS uses for app-suggestion filtering — correct. |
| `expo-linking` | none for in-app handling; `LSApplicationQueriesSchemes` IF code calls `Linking.canOpenURL('tel:')` or similar | ❌ Not set | none | iOS 9+ requires `LSApplicationQueriesSchemes` to be populated for any URL scheme passed to `canOpenURL`. [DeleteAccountButton.tsx:40](../packages/mobile/src/components/DeleteAccountButton.tsx) calls `Linking.canOpenURL('mailto:...')`. Without `LSApplicationQueriesSchemes: ["mailto", "tel"]`, `canOpenURL` always returns `false` on iOS 9+, so the mailto fallback triggers instead of opening Mail. **This is a real bug** — section 7 lists it. |
| `@react-native-community/datetimepicker` | none | n/a | none | iOS-specific `display="inline"` used at [DateInput.tsx:146](../packages/mobile/src/components/ui/DateInput.tsx). Plugin listed in `app.json > plugins`. |
| `@react-native-community/netinfo` | none (reachability is a public API) | n/a | none | OK. |
| `react-native-safe-area-context` | none | n/a | none | OK. |
| `react-native-screens` | none | n/a | none | OK. |
| `@sentry/react-native` | n/a — **not in deps** (per Phase 0 §5) | — | (would be needed: ITSAppUsesNonExemptEncryption already `false` ✅, dSYM upload) | Not installed. Crash-reporting service is a stub. Not iOS-specific. |

**Bottom line for iOS Info.plist:** the only ❌ in this section is missing `LSApplicationQueriesSchemes`. Section 7 carries it as a blocker because the account-deletion flow is the existing Apple-rejection vector, and silently-broken `canOpenURL` makes the fallback path the only path on iOS, which means the user gets an Alert instead of Mail.app — making Apple's 5.1.1(v) concern strictly worse.

---

## 5. Deep linking / Universal Links gap

[app.json:48-66](../packages/mobile/app.json) declares an Android intent filter for `https://mygaslink.com` and `https://www.mygaslink.com` with `autoVerify: true`. This is Android App Links — taps on those HTTPS URLs from email/SMS/browser route into the installed app. There is **no iOS equivalent declared.**

### What's missing on iOS

1. **`expo.ios.associatedDomains` in `app.json`.** The minimal addition:
   ```json
   "ios": {
     "associatedDomains": [
       "applinks:mygaslink.com",
       "applinks:www.mygaslink.com"
     ]
   }
   ```
   The `applinks:` prefix scopes the entitlement to Universal Links (vs `webcredentials:` for Sign In With Apple, etc.). Both the apex and `www` host need to be listed — they are separate origins to iOS.

2. **The Associated Domains entitlement** on the iOS app. EAS adds this automatically when `associatedDomains` is set in `app.json` (Expo's prebuild step writes it into the generated `.entitlements`). No extra config in `eas.json` needed.

3. **The `apple-app-site-association` file** hosted at `https://mygaslink.com/.well-known/apple-app-site-association` (note: no `.json` extension, served as `application/json`, no redirects, accessible without authentication, valid TLS, ≤ 128 KB). Minimal content:
   ```json
   {
     "applinks": {
       "apps": [],
       "details": [
         {
           "appID": "<APPLE_TEAM_ID>.com.mygaslink.app",
           "paths": ["*"]
         }
       ]
     }
   }
   ```
   `appID` is `<TeamID>.<bundleIdentifier>`. The team ID is the 10-character string from Apple Developer; the bundle identifier is `com.mygaslink.app` (already set in [app.json:19](../packages/mobile/app.json)). The same file must also be reachable at `https://www.mygaslink.com/.well-known/apple-app-site-association` because Apple fetches per host.

4. **iOS fetches the AASA file** at first install and again periodically. If the file is unreachable or malformed when iOS first tries to fetch it, Universal Links silently fall back to opening Safari — and iOS won't retry for hours. Validate using `https://app-site-association.cdn-apple.com/a/v1/mygaslink.com` after deploy.

### Why this matters today

The server does not currently emit HTTPS deep-link URLs (no email reset link → app, no SMS order link → app). So the iOS gap is **structural, not functional**, until the API begins generating those URLs. Two flows that *should* eventually be deep-linkable:
- Customer order-status SMS / email → tap → open order detail in the app.
- Driver delivery alert → tap notification → open delivery detail. (Push isn't wired for v1.0 per Phase 0, so this is moot until v1.1.)

### Recommended Phase 2 work

- One-line addition to `app.json` (5 minutes).
- Web team deploys AASA file at `https://mygaslink.com/.well-known/apple-app-site-association` (1 hour including DNS/CDN cache invalidation).
- Validate via the Apple CDN URL after deploy.

Total effort: half a day. Not a v1.0 blocker, but trivial to land in the iOS 2-week window.

---

## 6. `expo prebuild --platform ios --no-install --clean` dry-run

Run from `packages/mobile/`:

```
> npx expo prebuild --platform ios --no-install --clean
```

### Exit code

**0** (success) — but iOS file generation was **skipped** by Expo on Windows.

### Full stderr / stdout

```
env: load .env
env: export EXPO_PUBLIC_API_URL
! Git branch has uncommitted file changes
› It's recommended to commit all changes before proceeding in case you want to revert generated changes.
Git status is dirty but the command will continue because the terminal is not interactive.
- Clearing ios
✔ Cleared ios code
⚠️  Skipping generating the iOS native project files. Run npx expo prebuild again from macOS or Linux to generate the iOS project.

CommandError: At least one platform must be enabled when syncing
```

### What this means

`expo prebuild --platform ios` on Windows is a no-op for iOS file generation. Expo refuses to materialise the Xcode project / Podfile / Info.plist on a non-Mac host because:
- It cannot `pod install` (no CocoaPods on Windows by default — and `--no-install` does not change that).
- Several plugin steps shell out to `xcodebuild` / `xcrun` for asset validation.
- The deterministic CRLF/LF differences would write a project that wouldn't build on a Mac anyway.

So `ls packages/mobile/ios/` returns "No such file or directory" after the run — **no `ios/` folder was created.** No cleanup needed (and confirmed below).

### Generated `ios/MyGasLink/Info.plist`

**Not captured.** Cannot be captured on this host. To be done in Phase 2 from a macOS environment (or by inspecting an EAS cloud build's job log, which surfaces the merged Info.plist).

What the Info.plist *will* contain, based on `app.json > expo.ios.infoPlist` + plugin contributions:

| Key | Source | Expected value |
|-----|--------|----------------|
| `CFBundleDisplayName` | `expo.name` | `MyGasLink` |
| `CFBundleIdentifier` | `expo.ios.bundleIdentifier` | `com.mygaslink.app` |
| `CFBundleShortVersionString` | `expo.version` | `1.0.0` |
| `CFBundleVersion` | `expo.ios.buildNumber` | `1` (overridden by EAS remote autoIncrement) |
| `ITSAppUsesNonExemptEncryption` | `expo.ios.infoPlist.ITSAppUsesNonExemptEncryption` + `expo.ios.config.usesNonExemptEncryption` | `false` ✅ (both keys set) |
| `NSCameraUsageDescription` | `expo.ios.infoPlist` + `expo-camera` plugin | "Allow MyGasLink to access your camera for delivery proof." (plugin string wins) |
| `NSLocationWhenInUseUsageDescription` | `expo.ios.infoPlist` + `expo-location` plugin | "Allow MyGasLink to use your location for delivery tracking." |
| `NSPhotoLibraryUsageDescription` | `expo.ios.infoPlist` | "Allow MyGasLink to save delivery proof photos" |
| `NSMicrophoneUsageDescription` | — | **❌ NOT SET.** Acceptable as long as camera stays photos-only (see section 4). |
| `LSApplicationQueriesSchemes` | — | **❌ NOT SET.** Required for `Linking.canOpenURL('mailto:...')` / `'tel:...'` to return true on iOS 9+. See section 7. |
| `CFBundleURLTypes` (for `mygaslink://`) | `expo.scheme` | `mygaslink` |
| `com.apple.developer.associated-domains` (entitlement) | — | **❌ NOT SET** in `app.json > expo.ios.associatedDomains`. See section 5. |
| `UISupportedInterfaceOrientations` | `expo.orientation` | `portrait` |

### Generated `ios/Podfile`

**Not captured** (same reason). Expected CocoaPods deps (one pod per native module in section 4):
- `Expo`, `ExpoModulesCore`
- `EXSecureStore` (expo-secure-store)
- `EXLocation` (expo-location)
- `ExpoCamera` (expo-camera)
- `ExpoFileSystem` (expo-file-system)
- `ExpoFont` (expo-font)
- `ExpoLinking` (expo-linking)
- `ExpoSharing` (expo-sharing)
- `ExpoConstants` (expo-constants)
- `ExpoStatusBar` (expo-status-bar)
- `EXUpdates` (expo-updates is implicit when `updates.url` is set in app.json at [line 97-100](../packages/mobile/app.json))
- `RNCDateTimePicker` (@react-native-community/datetimepicker)
- `RNCNetInfo` (@react-native-community/netinfo)
- `RNScreens` (react-native-screens)
- `RNCSafeAreaContext` (react-native-safe-area-context)
- Plus React Native core pods: `React`, `React-Core`, `RCT-Folly`, `boost`, `glog`, `RCTRequired`, `RCTTypeSafety`, `ReactCommon`, `Yoga`, `hermes-engine`.

No third-party native modules outside the Expo ecosystem — so no manual Podfile patches expected.

### Errors / warnings about missing config

Only one warning surfaced in the dry-run: `Git branch has uncommitted file changes`. None about missing Apple config. Real Apple-side validation (icon sizes, bundleID match between `app.json` and the ASC app record, push capability vs entitlement consistency) does not run until EAS build time.

### Cleanup

`ls packages/mobile/ios` returned "No such file or directory" — Expo never created the folder on this Windows host. **No cleanup needed.** Confirmed `git status` post-run shows only the pre-existing untracked files (the `_tmp_*` and the docs/web `.docx`) — no `ios/` directory leaked. The two temporary scratch files created during the audit (`_tmp_prebuild_out.txt` and a stray `_tmp_4674_...` from a prior session) were also removed.

---

## 7. Severity-ranked gap list

Effort is calendar effort assuming one engineer, including PR + review.

### Blockers (must fix before iOS App Store submission)

| # | File:line | Description | Effort |
|---|-----------|-------------|--------|
| B1 | [eas.json:51-53](../packages/mobile/eas.json) | `submit.production.ios.appleId` / `ascAppId` / `appleTeamId` are empty strings. Cannot run `eas submit --platform ios` without them. Blocked on Apple Developer enrollment completing. | 5 min once enrollment lands (Phase 0 §8 step 1) |
| B2 | [src/components/DeleteAccountButton.tsx:38-55](../packages/mobile/src/components/DeleteAccountButton.tsx) | App Store guideline 5.1.1(v): account deletion must be **in-app** and complete with "no further interaction other than a confirmation." Current mailto + 30-day off-app processing is the highest-likelihood reject vector per Phase 0 §6. Needs a real `DELETE /api/users/me` (soft-delete; hard purge in 30-day batch) + in-app confirm modal that calls it. | 1-2 days (mobile UI + API endpoint + tests) |
| B3 | [app.json:24-29](../packages/mobile/app.json) | `LSApplicationQueriesSchemes` is missing. iOS 9+ requires this for `Linking.canOpenURL('mailto:...')` / `'tel:...'` to return `true`. Without it, [DeleteAccountButton.tsx:40](../packages/mobile/src/components/DeleteAccountButton.tsx) `canOpenURL` returns false → user sees the "No mail app" Alert instead of Mail.app — making Apple's 5.1.1(v) concern strictly worse than the Android equivalent. Also affects `tel:` Linking in [(customer)/orders.tsx:246, 509](../packages/mobile/app/(customer)/orders.tsx) and [(admin)/collections.tsx:240](../packages/mobile/app/(admin)/collections.tsx) — though `tel:` URLs technically open without the entitlement, defensive code paths that call `canOpenURL` first will short-circuit. Add `"LSApplicationQueriesSchemes": ["mailto", "tel"]` to `expo.ios.infoPlist`. | 15 min |
| B4 | Apple Developer Program — user-side | Phase 0 §8 step 1. Without enrollment, nothing else in this list can ship. | external; 24-48h (individual) up to 2 weeks (org / D-U-N-S) |

### High (functional but visibly wrong on iOS — should fix before submission)

| # | File:line | Description | Effort |
|---|-----------|-------------|--------|
| H1 | [app.json](../packages/mobile/app.json) (missing `expo.ios.associatedDomains`) | iOS Universal Links not configured; Android App Links are. Section 5. Requires app.json change + AASA file deploy at `https://mygaslink.com/.well-known/apple-app-site-association`. Apple silently caches "no AASA" for hours after first install, so deploy AASA **before** the first TestFlight invite. | half-day (mobile config + web deploy + cache validation) |
| H2 | [src/services/notifications.ts:1-44](../packages/mobile/src/services/notifications.ts) and [app/_layout.tsx:44-69](../packages/mobile/app/_layout.tsx) | `expo-notifications` plugin was removed in `6df8856` for v1.0, but `app/_layout.tsx` still lazy-imports `registerForPushNotifications` and `addNotificationResponseListener` from a stub that returns nulls. The lazy-import is wrapped in `.catch()` so it doesn't crash, but: (a) the stub file is dead code, (b) the layout effects fire on every auth change for nothing, (c) any reviewer reading the code will assume push is implemented. Either delete the stub + the two `useEffect` blocks, or keep them as a documented placeholder with a TODO commenting back to a v1.1 spec. SSE already covers driver foreground updates ([sseService.ts](../packages/mobile/src/services/sseService.ts)) — v1.0 has no background push by design. | 30 min |
| H3 | [src/services/crashReporting.ts](../packages/mobile/src/services/crashReporting.ts) (per Phase 0 §5) | `@sentry/react-native` is not installed but DSN is plumbed into `eas.json`. Prod iOS builds will silently report nothing. Not iOS-specific (same on Android) but iOS first-launch crash visibility is critical for App Store launch — review will surface crash-rate metrics quickly. | 1 day (install + initialize + dSYM upload config) |
| H4 | 🚩 ASK SUNEEL — [docs/SUPERADMIN-BILLING-AUDIT.md](SUPERADMIN-BILLING-AUDIT.md) exists in working dir but is uncommitted. Implies Android super-admin Billing has open issues. Cannot determine iOS-impact without that doc. | 🚩 ASK SUNEEL |

### Low (cosmetic, defer to v1.1)

| # | File:line | Description | Effort |
|---|-----------|-------------|--------|
| L1 | [app.json:46](../packages/mobile/app.json) | Android `android.permission.RECORD_AUDIO` is declared but no code uses the microphone (camera is photos-only). If iOS ever gains video-w/-audio support, `NSMicrophoneUsageDescription` will be needed defensively. Right now neither side uses the mic. Recommend removing `RECORD_AUDIO` from Android permissions to align surfaces (Phase 0 §3 already flagged). | 5 min |
| L2 | [app/_layout.tsx:44-49](../packages/mobile/app/_layout.tsx) | Dead `registerForPushNotifications()` call inside a `useEffect`. See H2. Merging H2 covers this. | covered by H2 |
| L3 | SSL certificate pinning | CLAUDE.md flags as "NON-NEGOTIABLE" but Apple does not require it for App Store. Phase 0 recommended deferring to v1.1. Not iOS-specific. | 1-2 days when implemented |
| L4 | App icon / splash / iPad-specific assets | `expo.ios.supportsTablet: true` is set in [app.json:18](../packages/mobile/app.json). Apple may require iPad-specific screenshots in ASC even though the app is intended for phones. Either flip to `false` (iPhone-only) to skip that work, or supply iPad screenshots. 🚩 ASK SUNEEL: should v1.0 be iPhone-only? | 15 min config change, OR half-day for iPad assets |
| L5 | `expo.runtimeVersion.policy: "appVersion"` | Means every new JS bundle goes to every installed copy until `version` is bumped. Acceptable for v1.0 launch; flag for revisit on v1.1. | none for v1.0 |

---

## 8. Realistic budget call

### Effort sum

- **Blockers:** B1 (5 min) + B2 (1-2 days) + B3 (15 min) + B4 (external, 24-48h to 2 weeks). Sum of *work* (excluding B4 wait): **≈ 1.5-2 days.**
- **High:** H1 (0.5 day) + H2 (0.5 hr) + H3 (1 day). H4 unknown pending Suneel input. Sum: **≈ 1.5-2 days.**
- **Plus** the first EAS iOS build itself: Phase 0 §8 step 8 budgets a full day of iteration on first contact with the iOS toolchain (asset assertions, native-version mismatches, splash sizing). **1 day.**
- **Plus** TestFlight pass on a physical iPhone: section 7 doesn't list it as a gap because there are no known iOS regressions in the code, but a real-device pass is still ~1 day to surface anything the static audit missed.

**Code work total: ≈ 4.5-6 days of engineering.**

### Can this ship in 2 weeks with a parallel 3-4 day account-deletion mini-track?

**Marginal yes, with one assumption.** The 3-4 day account-deletion mini-track *is* B2 (the largest blocker), so the parallel track is not really parallel — it's the long pole. Calendar laid out:

- Day 0-1: Apple Developer enrollment + `app.json` / Info.plist quick fixes (B1, B3, H1 config side, L1).
- Day 1-4: Account deletion API + UI (B2 in parallel-named track).
- Day 4-5: H2 stub cleanup + H3 Sentry install.
- Day 5-6: AASA web deploy + iOS prebuild validation (H1 web side).
- Day 6-7: First EAS iOS build (expect iteration).
- Day 7-8: TestFlight physical-device pass; bug fixes.
- Day 8-9: ASC metadata + privacy nutrition labels + screenshots.
- Day 9-12: Submit + initial review (Apple turnaround 24-72h).
- Day 12-14: Reject-and-resubmit buffer (5.1.1(v) is the highest-likelihood reject vector even with B2 done; reviewers occasionally still raise it).

**Constraint:** if Apple Developer enrollment is at the *organization* tier (D-U-N-S verification), the enrollment alone can eat 1-2 weeks, eating the entire budget. This is Phase 0's §8 step 1 and the brief calls out today is 2026-06-08 — if enrollment is not already in flight, the 2-week budget is at material risk regardless of code work.

### If it does not fit, recommended cuts

In priority order (cut the latest first):

1. **Defer SSL cert pinning to v1.1** (L3 — already recommended in Phase 0 §6).
2. **Defer iPad support to v1.1** (L4 — flip `supportsTablet: false`, market as iPhone-only at launch). Avoids iPad screenshot work and any iPad-specific layout bugs surfacing in review.
3. **Defer Universal Links to v1.1** (H1). Custom scheme (`mygaslink://`) still works on iOS; the gap only matters once the API begins emitting HTTPS deep links — which it doesn't today. Drops half a day.
4. **Defer Sentry install to v1.1** (H3). Crash visibility loss is real but not a launch blocker; Apple's own crash dashboard in App Store Connect catches the top issues. Drops a day.

After those four cuts the iOS work is **≈ 2-3 days of code + 1 day first-build + 1 day TestFlight + Apple review wait** — comfortably inside 2 weeks **iff** Apple enrollment is already done.

The single most realistic risk to the 2-week budget is **not the code** — it's Apple Developer enrollment timing (B4) and the chance of an Apple reviewer rejecting 5.1.1(v) despite a real in-app delete endpoint (B2). Both are out of code-author hands.

---

*End of Phase 1 parity matrix.*
