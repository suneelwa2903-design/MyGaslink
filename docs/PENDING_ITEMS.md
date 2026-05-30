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

### Collections Excel Export (broken)
- /api/analytics/export/collections returns JSON not xlsx
- Web button calls non-existent path AND bypasses shared axios client
  (anti-pattern #5)
- Mobile correctly omitted the button
- Fix: proper server-side xlsx generation OR client-side CSV from reduce data
- Added: 2026-05-31

### Collections Metrics — No Server Endpoint
- Total Due / Overdue / Missing Cylinders computed client-side via reduce()
- No dedicated /analytics/collections/summary
- Works but not scalable for large datasets
- Fix: add server-side aggregation endpoint
- Added: 2026-05-31

### Customer interface too narrow in more.tsx
- Local Customer interface declares status: 'active' | 'suspended' only
- Shared CustomerStatus enum also has 'inactive'
- Fix: delete local interface, import shared Customer type
- Small follow-up commit
- Added: 2026-05-31

### EditCustomerModal duplicated
- EditCustomerInlineModal (more.tsx) and EditCustomerModal (customer-detail.tsx) are duplicates calling same endpoint
- Fix: extract to packages/mobile/src/components/EditCustomerModal.tsx
- Added: 2026-05-31

### hsnCode not in mobile Cylinder Types
- Web exposes hsnCode field in create/edit
- Mobile omits it — affects GST invoicing accuracy if HSN needs to change
- Fix: add hsnCode field to CylinderTypesModal create/edit form
- Priority: medium (GST-relevant)
- Added: 2026-05-31

### Cylinder Types delete copy mismatch
- Mobile toast says "deleted"
- Server actually soft-deactivates
- Fix: change toast to "deactivated"
- Priority: low
- Added: 2026-05-31

### pull-to-refresh spinner broken on 2 modals
- CylinderPricesModal + InventoryThresholdsModal pass refreshing={false} to RefreshControl
- Spinner never shows during pull-down
- Fix: wire refreshing state correctly (CylinderTypesModal does this correctly)
- Priority: low
- Added: 2026-05-31

### emptyDepositPrice unused on mobile
- Mapper exposes field but mobile never displays it
- Low priority, no user impact
- Added: 2026-05-31

### Analytics dashboard date filter is server-side no-op
- /analytics/dashboard and /analytics/header-metrics accept dateFrom/dateTo in route params but service functions only take distributorId — params silently dropped
- Web date picker on dashboard is currently decorative
- Mobile params wired correctly and will become live once server is fixed
- Fix: update getDashboardStats() and getHeaderMetrics() signatures to accept + use date range
- Added: 2026-05-31
