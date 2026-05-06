# [item-id]: Release v[X.X.X] — [iOS | Android | Both]
Type: deployment
Platform: [ios | android | both]
Priority: high
Created: [YYYY-MM-DD]
Dependencies: [all feature/bug items in this release]

---

## Release Scope
[What features and fixes are in this release]

## Version Numbers
| Field | Previous | New |
|---|---|---|
| version (semantic) | X.X.X | X.X.X |
| iOS buildNumber | NNN | NNN+1 |
| Android versionCode | NNN | NNN+1 |
| Git tag | vX.X.X | vX.X.X |

## Pre-Release Checklist

### Code Quality
- [ ] All work items in this release have status = `completed`
- [ ] All tests passing (unit + integration + E2E)
- [ ] Security scan clean
- [ ] No `console.log` in production code
- [ ] Bundle size checked — no unexpected increase >5%
- [ ] No debug/development code left in

### Device Testing
- [ ] iOS physical device — all release features tested
- [ ] Android physical device — all release features tested
- [ ] Oldest supported iOS version tested
- [ ] Mid-range Android device tested
- [ ] Slow network (3G) tested for key flows
- [ ] Offline mode tested for key flows

### App Store / Play Store
- [ ] Screenshots updated if UI changed
- [ ] App description updated if needed
- [ ] What's New text written
- [ ] Privacy policy URL valid
- [ ] Age rating still correct
- [ ] App permissions list still accurate

### Backend Compatibility
- [ ] New API version deployed before app release
- [ ] Old app versions still work with new API (backward compat)
- [ ] Feature flags set correctly (if using flags)

## Build Steps

```bash
# 1. Bump version in app.json / package.json
# 2. Commit version bump
git commit -m "chore: bump version to vX.X.X"
git tag vX.X.X

# 3. Build with EAS
eas build --platform all --profile production

# 4. Test production build on device before submitting
# 5. Submit
eas submit --platform ios
eas submit --platform android
```

## Rollout Strategy
- [ ] Staged rollout: [0%→10%→50%→100% or full rollout]
- [ ] Monitor crash rate for 24h before increasing rollout percentage
- [ ] Crash rate threshold for halt: >1% new crashes

## Rollback Plan
- OTA rollback (minor issues): `eas update --rollback-to-embedded`
- Store rollback (major issues): halt staged rollout, submit hotfix build
- Server rollback: [if API changes must be reverted]

## Post-Release Monitoring (48h)
- [ ] Sentry crash rate < baseline
- [ ] API error rate < baseline
- [ ] App Store / Play Store reviews monitored
- [ ] Telegram alert configured for new crash spikes

## What's New Copy
*(for App Store / Play Store release notes)*
```
[Write release notes here — user-facing language, no technical jargon]
```
