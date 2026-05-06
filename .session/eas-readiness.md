# EAS Build Readiness — Mobile

**Generated:** 2026-05-06
**Scope:** packages/mobile
**Mode:** Read-only audit. No builds run.

## Verdict
**Will-build: yes for `development` and `preview`. `production` has 4 must-fix items + 2 should-fix items before submission.**

---

## 1. eas.json — profile completeness

| Profile | Status | Notes |
|---|---|---|
| `development` | ✅ Complete | dev-client + iOS simulator + Android APK + localhost API URL. Will build. |
| `preview` | ✅ Complete | Internal distribution, real-device iOS, Android APK. Production API URL, Sentry DSN wired. Will build. |
| `production` | 🟡 Mostly OK | autoIncrement on, Android `app-bundle` (correct for Play Store), Sentry DSN wired. **`submit.production: {}` is empty — see §5.** |

`appVersionSource: "remote"` is fine — version comes from EAS dashboard, autoIncrement bumps build number.

---

## 2. app.json — required fields

| Field | Value | Status |
|---|---|---|
| name | `MyGasLink` | ✅ |
| slug | `mygaslink` | ✅ |
| version | `1.0.0` | 🟡 First production build — confirm with founder before submit |
| iOS bundleIdentifier | `com.mygaslink.app` | ✅ matches spec |
| Android package | `com.mygaslink.app` | ✅ matches spec |
| Deep linking scheme | `mygaslink` | ✅ |
| EAS projectId | `f6e20f06-1ee0-48da-be19-e4426997c0ff` | ✅ |
| owner | `poultryproplus` | 🟡 **CHECK:** owner is `poultryproplus` not `mygaslink`. Confirm this is the intended Expo organisation. |
| runtimeVersion policy | `appVersion` | ✅ |

### Permissions
**iOS** (via `infoPlist`):
- ✅ `NSLocationWhenInUseUsageDescription` — "We need your location for delivery tracking"
- ✅ `NSCameraUsageDescription` — "We need camera access for delivery proof photos"
- ✅ `NSPhotoLibraryUsageDescription` — "Allow MyGasLink to save delivery proof photos"
- ⚠️ Missing: `NSMicrophoneUsageDescription`. The Android side declares `RECORD_AUDIO`. If the app actually uses the mic, iOS submit will fail review. If it doesn't, drop `RECORD_AUDIO` from Android.

**Android** (`permissions`):
- ✅ ACCESS_FINE_LOCATION + ACCESS_COARSE_LOCATION (declared twice — harmless, see anti-pattern below)
- ✅ CAMERA
- ✅ RECEIVE_BOOT_COMPLETED, VIBRATE — both required for `expo-notifications`
- ⚠️ `RECORD_AUDIO` declared but no iOS counterpart. Either add `NSMicrophoneUsageDescription` or remove `RECORD_AUDIO`.
- 🧹 `ACCESS_FINE_LOCATION` is listed twice (bare and `android.permission.` form). Functional duplicate; clean up at next maintenance pass.

### Plugins
- `expo-router` ✅
- `expo-secure-store` ✅
- `expo-location` ✅ (with `locationAlwaysAndWhenInUsePermission` + `isAndroidBackgroundLocationEnabled: false`)
- `expo-camera` ✅
- `expo-notifications` ✅ (icon + color set)

### Assets
All required asset files exist in `packages/mobile/assets/`:
- `icon.png` ✅
- `adaptive-icon.png` ✅ (Android adaptive icon foreground)
- `splash.png` ✅
- `notification-icon.png` ✅
- `favicon.png` ✅ (web fallback)
- `logo.png` ✅
**No verification of resolution / safe-area / mask compliance** — recommend a manual eye-pass before submit.

---

## 3. EXPO_PUBLIC_API_URL

| Profile | Value | Status |
|---|---|---|
| development | `http://localhost:5000/api` | ✅ matches local API |
| preview | `https://api.mygaslink.com/api` | 🟡 **MUST CONFIRM:** is `api.mygaslink.com` deployed and serving traffic? `eas-monitor.yml` runs against the ephemeral test DB; production hosting per ARCHITECTURE.md §12 is EC2 + pm2 in ap-south-1 — DNS to that EC2 must be live before preview/production builds will work end-to-end. |
| production | same as preview | same |

## 4. Expo SDK 54 — known issues

Expo SDK 54 (released Sep 2025) is stable. Active concerns to verify:
- **React 19.1 vs react-dom 19.2 peer warning** seen during `pnpm install` is workspace-level — does NOT affect mobile builds (mobile has no react-dom). Safe to ignore for EAS.
- **expo-camera 17 + Android 14:** if any test devices run Android 14, run a manual photo-capture flow once before launching to a wider audience — there were intermittent permission re-prompt issues in 2025-Q4 that may or may not be resolved.
- **expo-secure-store 15** on iOS 17+ requires no extra entitlements but uses Keychain — confirm the JWT round-trips on a real device, not simulator (simulator Keychain behaves differently).

## 5. EAS secrets needed before `eas build --profile production`

Set these via `eas secret:create` or in the EAS dashboard:

### Required for build to succeed
- **Apple Developer:** `EXPO_APPLE_ID`, `EXPO_APPLE_TEAM_ID`, `EXPO_APPLE_APP_SPECIFIC_PASSWORD` (or use `eas credentials` to upload provisioning profile + cert)
- **iOS provisioning:** distribution cert + provisioning profile registered in EAS (one-time setup via `eas credentials`)
- **Android keystore:** managed by EAS (one-time setup via `eas credentials`); confirms the keystore EAS holds matches your signed build expectations

### Required for `eas submit` to succeed (once builds are ready)
- **App Store Connect:** `app-store-connect-api-key.json` uploaded as a generic file secret, plus key ID + issuer ID
- **Google Play Console:** service-account JSON uploaded as a generic file secret

`eas.json:48` has `submit.production: {}` — empty. **Add explicit submit config** before running `eas submit`:
```jsonc
"submit": {
  "production": {
    "ios": {
      "appleId": "<APPLE_ID>",
      "ascAppId": "<NUMERIC_ASC_ID>",
      "appleTeamId": "<TEAM_ID>"
    },
    "android": {
      "serviceAccountKeyPath": "./google-service-account.json",
      "track": "internal"  // start with internal, promote to production
    }
  }
}
```

### Optional but recommended
- **Sentry source-map upload:** if you want production stack traces to map to source, set `SENTRY_AUTH_TOKEN` and add `@sentry/react-native` `withSentryConfig` to metro / set up `sentry-expo`. Currently the DSN is wired but no source-map upload step is configured in EAS.

## 6. Specific items that will block a production build

### Hard blockers
1. **First production build needs `eas credentials` run interactively** to register iOS distribution cert + Android keystore with EAS. CI alone can't bootstrap this.
2. **`api.mygaslink.com` DNS must resolve** to the production EC2 instance, with TLS, before the production build is useful (the bundle hardcodes that URL).
3. **App Store + Play Store accounts must exist** with the bundle IDs `com.mygaslink.app` reserved. Filing this with Apple takes 24-48h on first submit.
4. **Privacy policy URL** required for app submission (both stores). Not present in `app.json`. Need a public privacy policy page before submit.

### Soft blockers (will build but may be rejected during review)
5. **`RECORD_AUDIO` mismatch** between Android (declared) and iOS (no NSMicrophoneUsageDescription). Apple review will flag if mic is requested without justification; Google Play will flag undeclared sensitive permissions.
6. **App icon, splash, and adaptive-icon need a visual review** for safe-area compliance, especially on Android adaptive icons (foreground must fit within the safe zone).

## 7. Action items for the founder before launch

1. Confirm `owner: poultryproplus` is correct (Expo org name).
2. Confirm version `1.0.0` is the desired first build version.
3. Set up Apple Developer + Google Play accounts with bundle ID `com.mygaslink.app` (24-48h lead time).
4. Provision DNS + TLS for `api.mygaslink.com`.
5. Author privacy policy + terms of service, host them publicly.
6. Decide: keep `RECORD_AUDIO` (and add iOS mic description) or drop it.
7. One human eye-pass on icon / splash / adaptive icons.
8. Run `eas credentials` interactively once to register production cert + keystore with EAS.
9. Update `eas.json` `submit.production` block with Apple ID + ASC App ID + Google service-account path.
10. (Optional) Wire up Sentry source-map upload via `@sentry/react-native`.

No build runs were attempted — this is read-only audit only.
