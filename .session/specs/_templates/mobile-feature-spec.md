# [item-id]: [Mobile Feature Title]
Type: feature
Platform: [ios | android | both]
Priority: [critical|high|medium|low]
Created: [YYYY-MM-DD]
Dependencies: [item-ids or none]

---

## Overview
[What this feature does, why, user impact]

## User Story
As a [role], I want [goal] so that [benefit].

## Acceptance Criteria
- [ ] [Specific, measurable criterion 1]
- [ ] [Specific, measurable criterion 2]
- [ ] [Specific, measurable criterion 3]
- [ ] [Specific, measurable criterion 4]
- [ ] [Specific, measurable criterion 5]

## Platform Behaviour
- **iOS:** [any iOS-specific behaviour or differences]
- **Android:** [any Android-specific behaviour or differences]
- **Offline:** [what happens when device is offline — show cached? block? queue?]
- **Background:** [any behaviour when app is backgrounded]

## Screen / Navigation
- **Entry point:** [screen name, tab, deeplink or push notification]
- **Exit:** [back behaviour, swipe dismiss, modal close]
- **Deeplink (if any):** `myapp://[path]`

## API Requirements
<!-- List API endpoints this feature calls -->
| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| GET | /api/v1/[resource] | required | [notes] |

## Data & State
- **Server state:** [React Query hook name — e.g. `useInvoices`]
- **Local state:** [what's held in component state]
- **Persisted state:** [anything stored in AsyncStorage/SecureStore]
- **Cache:** [should response be cached? for how long?]

## Offline Behaviour
- Read: [show cached / show error / block]
- Write: [queue for sync / block / show error]
- Sync conflict strategy: [server-wins / manual / N/A]

## Permissions Required
- [ ] Camera — reason: [why]
- [ ] Location — reason: [why]
- [ ] Notifications — reason: [why]
*(remove permissions not needed)*

## UI / UX
- **Screen type:** [stack screen | modal | tab | bottom sheet]
- **Loading state:** [skeleton | spinner | nothing]
- **Empty state:** [what to show when no data]
- **Error state:** [what to show on API error]
- **Pull to refresh:** [yes | no]

## Performance Requirements
- Screen load: < 300ms
- List scroll: 60fps sustained
- API calls > 200ms: show loading indicator

## Testing Strategy

### Unit Tests
- [What to test]

### Component Tests (RNTL)
- [Component interaction tests]

### E2E Tests (Detox)
1. [Full flow 1 — happy path]
2. [Error/offline flow]

### Device Testing
- [ ] iOS physical device
- [ ] Android physical device (mid-range)
- [ ] Slow network (3G throttle)
- [ ] Offline mode

## Security Checklist
- [ ] Auth token from SecureStore — not AsyncStorage
- [ ] API calls over HTTPS only
- [ ] No sensitive data in console.log
- [ ] Input validated before API call
- [ ] Deeplink parameters validated before use
- [ ] tenant_id from JWT — not from client state
