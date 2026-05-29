# MyGasLink — Pending Items

## 🔴 Strong Priority (v1.1)

### SSL Certificate Pinning
- Implement react-native-ssl-pinning for
  api.mygaslink.com
- Requires migration from Expo managed →
  bare workflow
- Pin to SPKI hash of Let's Encrypt
  intermediate (not leaf cert)
- Must implement dual-pin rotation strategy
- Estimated effort: 2 days
- Blocked on: prebuild migration decision
- Added: 2026-05-29

## 🟡 Infrastructure (v1.1)

### Auth Middleware DB Caching
- Every API request fires 2 uncached DB reads
  for JWT verification
- At polling scale this dominates DB load
- Fix: Redis/in-memory cache for verified
  tokens (TTL = token expiry)
- Added: 2026-05-29

### Float-to-Decimal Migration
- All monetary fields are Float in Prisma schema
- Should be Decimal to avoid precision issues
- Deferred: low transaction volume at launch
- Target: week 2 post-launch
- Added: 2026-05-29

## 🟢 Post-Build Tasks (do immediately after
   EAS build completes)

### assetlinks.json — Android App Links
- After EAS build: get SHA-256 signing
  fingerprint from Play Console
- Publish to:
  https://mygaslink.com/.well-known/assetlinks.json
  https://www.mygaslink.com/.well-known/assetlinks.json
- Without this file Android App Links fall
  back to disambiguation dialog
- Added: 2026-05-29

### WhiteBooks Production Activation
- Currently on sandbox
- Must activate production before go-live
- Contact WhiteBooks support for activation
- Added: 2026-05-29

## 🔵 Post-Launch Features

### Push Notifications (replaced SSE for now)
- SSE implemented for driver order updates
- True push (FCM) needed for background
  notifications when app is closed
- Requires: Firebase project, FCM setup,
  eas credentials configuration,
  server-side push token storage
- Mobile: ~0.5 days | Server: ~1 day
- Added: 2026-05-29

### Sentry Mobile Crash Reporting
- Currently Sentry is backend + web only
- Add @sentry/react-native to mobile
- When added: update Play Store Data Safety
  form to add Crash logs + Device IDs
- Added: 2026-05-29

### GST API Log Cleanup
- GST API logs accumulate in DB
- Add retention policy + cleanup job
- Added: 2026-05-29
