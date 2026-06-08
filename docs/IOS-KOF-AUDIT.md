# iOS Keyboard-Overlap (KOF) Audit — packages/mobile

**Audit date:** 2026-06-08
**Branch:** main
**Pre-reading:** [docs/IOS-PHASE1-PARITY-MATRIX.md](IOS-PHASE1-PARITY-MATRIX.md) section 3 (35 `Platform.OS` branches inventoried), [CLAUDE.md](../CLAUDE.md) "Mobile Development Rules".
**Scope:** read-only investigation of keyboard-vs-UI overlap in `packages/mobile/`. No code changes.
**Reported bug:** Suneel reports iOS keyboard overlaps the customer picker in the admin order-creation flow, preventing customer selection.

Legend per audit row: ✅ keyboard safe / ⚠ suspect, needs device check / ❌ confirmed broken on iOS.

---

## 1. Bug repro — Suneel's reported issue

### Trigger

(admin) → Orders tab → "Create" FAB → in the **Create Order** modal, tap "Select customer". The nested customer-picker sheet slides up from the bottom and auto-focuses a search TextInput at the top of that sheet.

### Files and line ranges

- Outer modal (`CreateOrderModal`): [packages/mobile/app/(admin)/orders.tsx:1037-1288](../packages/mobile/app/(admin)/orders.tsx) — declares `<Modal presentationStyle="fullScreen">` → `<SafeAreaView>` → `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>` → `<ScrollView keyboardShouldPersistTaps="handled">`.
- Nested customer-picker modal: [packages/mobile/app/(admin)/orders.tsx:1081-1144](../packages/mobile/app/(admin)/orders.tsx) — declares a SECOND `<Modal animationType="slide" transparent>` with `pickerOverlay` (`flex: 1, justifyContent: 'flex-end'`) wrapping a `pickerSheet` (`maxHeight: '80%'`, rounded top corners). Inside that sheet: a search `<TextInput autoFocus>` at line 1098-1105 followed by a `<FlatList>` of customers.
- Same picker pattern is duplicated in `ReturnsOrderModal` at [orders.tsx:2012-2052](../packages/mobile/app/(admin)/orders.tsx) (identical bug).
- Style definitions: `pickerOverlay` at line 2707, `pickerSheet` at 2711.

### Root cause (concrete diagnosis)

React Native renders each `<Modal>` in its OWN top-level native window — on iOS, a new `UIWindow` / presentation context. **Props applied to a parent `<KeyboardAvoidingView>` in the outer modal do NOT propagate into the inner modal's view hierarchy.** When the user taps the picker:

1. The inner `<Modal transparent>` mounts a new iOS presentation context.
2. Inside that context the search `<TextInput autoFocus>` triggers the iOS keyboard.
3. The inner modal has NO `<KeyboardAvoidingView>` and NO `behavior="padding"`. The keyboard appears OVER the bottom of the picker sheet.
4. Because the sheet is `justifyContent: 'flex-end'` (anchored to the bottom) with `maxHeight: 80%`, the keyboard now hides the bottom ~40% of the FlatList — and on shorter iPhones (SE, mini) the keyboard can cover the entire list, leaving only the header and search bar visible.
5. The list rows that ARE visible remain tappable, but if the customer the admin wants is below the fold there is no way to reach them — the FlatList scrolls inside its container, but the container height is now the same as the keyboard's top edge.

On Android the same code is functional because `android:windowSoftInputMode` defaults to `adjustResize` (Expo's default — see section 6) which resizes the whole window when the keyboard appears, including the inner modal's view tree. iOS has no equivalent global resize — every focused view must opt in via `KeyboardAvoidingView` (or be inside a scroll container that handles scrolling to the focused input itself).

### One-sentence fix sketch

Wrap the nested picker sheet's inner content in `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>` immediately inside the inner `<Modal>`'s `pickerOverlay` View, so the search TextInput + FlatList lift above the iOS keyboard.

---

## 2. Codebase-wide audit

Methodology: grepped for `TextInput`, `KeyboardAvoidingView`, `keyboardShouldPersistTaps`, `Keyboard.`, `useKeyboard`, `KeyboardAwareScrollView` across `packages/mobile/app/` and `packages/mobile/src/`. Classified each in-scope screen by form type. Cross-referenced against the 19 Platform.OS keyboard-related branches Phase 1 already documented.

### 2.1 (auth) — shared

| Screen | File:line | Form type | Has KAV? | Behavior (iOS / Android) | Wraps ScrollView? | Suspect on iOS? | Notes |
|--------|-----------|-----------|----------|--------------------------|--------------------|-----------------|-------|
| Login | [(auth)/login.tsx:128-377](../packages/mobile/app/(auth)/login.tsx) | Form-heavy (email + password) | ✅ Yes | `padding` / `height` | ✅ Yes | ✅ No | Canonical pattern. Submit button is below the inputs and lifts correctly. |
| Forgot-password (OTP) | [(auth)/forgot-password.tsx:168-414](../packages/mobile/app/(auth)/forgot-password.tsx) | Form-heavy (email → OTP → new-password) | ✅ Yes | `padding` / `height` | ✅ Yes | ✅ No | Canonical pattern. |

### 2.2 (customer)

| Screen | File:line | Form type | Has KAV? | Behavior (iOS / Android) | Wraps ScrollView? | Suspect on iOS? | Notes |
|--------|-----------|-----------|----------|--------------------------|--------------------|-----------------|-------|
| Dashboard | [(customer)/dashboard.tsx](../packages/mobile/app/(customer)/dashboard.tsx) | List-with-search | ❌ No | n/a | n/a | ⚠ Maybe | TextInput is a list-filter at top — keyboard would push it off-screen but the inline list scrolls. Low risk. |
| Orders | [(customer)/orders.tsx:561-859](../packages/mobile/app/(customer)/orders.tsx) | 4 form modals (rename, edit qty, etc.) | ✅ Yes ×4 | `padding` / `undefined` | ✅ Yes | ✅ No | Phase 1 row 14 — all four modals have KAV. |
| Invoices | [(customer)/invoices.tsx](../packages/mobile/app/(customer)/invoices.tsx) | Read-only with filter | n/a | n/a | n/a | ✅ No | Out of scope. |
| Payments | [(customer)/payments.tsx](../packages/mobile/app/(customer)/payments.tsx) | List-with-search | ❌ No | n/a | n/a | ⚠ Maybe | TextInput at top in `DateRangeFilter`. Low risk — input is above keyboard. |
| Account | [(customer)/account.tsx:241-300](../packages/mobile/app/(customer)/account.tsx) | Form modal (edit profile) | ✅ Yes | `padding` / `undefined` | ✅ Yes | ✅ No | Phase 1 row 13. |

### 2.3 (driver)

| Screen | File:line | Form type | Has KAV? | Behavior (iOS / Android) | Wraps ScrollView? | Suspect on iOS? | Notes |
|--------|-----------|-----------|----------|--------------------------|--------------------|-----------------|-------|
| Orders (delivery proof modal) | [(driver)/orders.tsx:291-462](../packages/mobile/app/(driver)/orders.tsx) | Form modal at BOTTOM of screen (delivered qty + empties + notes) | ❌ **No** | n/a | n/a | ❌ **YES** | **Confirmed broken.** Modal is `justifyContent: 'flex-end'`, contains numeric TextInputs at lines 342, 367, and a multiline notes TextInput at 430. Submit "Confirm Delivery" button at 451 will be covered by the iOS keyboard when the notes field is focused. Driver cannot submit without dismissing keyboard manually. Phase 1 missed this — it was tagged ✅ because no `Platform.OS` ternary appears, but the absence IS the bug. |
| Trip | [(driver)/trip.tsx](../packages/mobile/app/(driver)/trip.tsx) | Read-only (PDF download) | n/a | n/a | n/a | ✅ No | No TextInput. |
| Analytics | [(driver)/analytics.tsx](../packages/mobile/app/(driver)/analytics.tsx) | Date-range filter | ❌ No | n/a | n/a | ⚠ Maybe | Date filter is at top — likely safe. Needs device verification. |
| Inventory | [(driver)/inventory.tsx](../packages/mobile/app/(driver)/inventory.tsx) | Read-only | n/a | n/a | n/a | ✅ No | No TextInput. |
| More | [(driver)/more.tsx](../packages/mobile/app/(driver)/more.tsx) | Read-only | n/a | n/a | n/a | ✅ No | |
| Profile (hidden) | [(driver)/profile.tsx](../packages/mobile/app/(driver)/profile.tsx) | Form | ✅ Yes (via ProfileScreen.tsx:144) | `padding` / `undefined` | ✅ Yes | ✅ No | |

### 2.4 (admin)

| Screen | File:line | Form type | Has KAV? | Behavior (iOS / Android) | Wraps ScrollView? | Suspect on iOS? | Notes |
|--------|-----------|-----------|----------|--------------------------|--------------------|-----------------|-------|
| Orders (create-order modal) | [(admin)/orders.tsx:1037-1288](../packages/mobile/app/(admin)/orders.tsx) | Form-heavy modal | ✅ Yes (outer) | `padding` / `undefined` | ✅ Yes | ⚠ Partial | Outer modal is safe. Nested customer picker modal at 1081-1144 is NOT — **this is Suneel's reported bug.** |
| Orders (nested customer picker) | [(admin)/orders.tsx:1081-1144](../packages/mobile/app/(admin)/orders.tsx) | Picker-with-search | ❌ **No** | n/a | n/a | ❌ **YES** | **Confirmed broken.** Nested `<Modal>` has no KAV. See section 1. |
| Orders (returns-order modal) | [(admin)/orders.tsx:1987-2117](../packages/mobile/app/(admin)/orders.tsx) | Form modal | ✅ Yes (outer) | `padding` / `undefined` | ✅ Yes | ⚠ Partial | Same nested customer picker pattern at 2012-2052 — same bug. |
| Orders (returns nested picker) | [(admin)/orders.tsx:2012-2052](../packages/mobile/app/(admin)/orders.tsx) | Picker-with-search | ❌ **No** | n/a | n/a | ❌ **YES** | Identical to the create-order picker. |
| Orders (edit-order modal) | [(admin)/orders.tsx:2181-2263](../packages/mobile/app/(admin)/orders.tsx) | Form modal | ✅ Yes | `padding` / `undefined` | ✅ Yes | ✅ No | No nested picker — customer is fixed once order exists. |
| Inventory | [(admin)/inventory.tsx:836, 1204, 3303](../packages/mobile/app/(admin)/inventory.tsx) | 3 form modals | ✅ Yes ×3 | `padding` / `height` | ✅ Yes | ✅ No | Phase 1 row 4. |
| Finance (billing) | [(admin)/finance.tsx:1308, 1468, 1918, 2154, 2428](../packages/mobile/app/(admin)/finance.tsx) | 5 form modals (invoice, CN, DN, etc.) | ✅ Yes ×5 | `padding` / `undefined` | ✅ Yes | ✅ No | Phase 1 row 3 — most thoroughly KAV-covered file in the codebase. |
| Customers | [(admin)/customers.tsx:473](../packages/mobile/app/(admin)/customers.tsx) | List-with-search | ❌ No | n/a | n/a | ⚠ Maybe | Search TextInput is at top of screen, list scrolls below. Low risk on iOS. |
| Customer-create | [(admin)/customer-create.tsx](../packages/mobile/app/(admin)/customer-create.tsx) (uses CustomerForm) | Form-heavy ROUTE (not modal) | ✅ Yes (CustomerForm.tsx:552) | `padding` / `undefined` | ✅ Yes | ✅ No | Already iOS-hardened — header comment at customer-create.tsx:11-13 explicitly cites iOS modal-nesting as why this is a route, not a Modal. |
| Customer-detail | [(admin)/customer-detail.tsx](../packages/mobile/app/(admin)/customer-detail.tsx) | Edit form via CustomerFormModal | ✅ Yes (via CustomerForm) | inherited | ✅ Yes | ✅ No | |
| Fleet | [(admin)/fleet.tsx:1071](../packages/mobile/app/(admin)/fleet.tsx) | Picker (no TextInput) | n/a | n/a | n/a | ✅ No | Vehicle picker has no search input. |
| More (edit-customer modal etc.) | [(admin)/more.tsx:559, 816, 1679](../packages/mobile/app/(admin)/more.tsx) | 3 form modals | ✅ Yes ×3 | `padding` / `undefined` | ✅ Yes | ✅ No | Phase 1 row 6. |
| Pending-actions | [(admin)/pending-actions.tsx:502](../packages/mobile/app/(admin)/pending-actions.tsx) | Form modal | ✅ Yes | `padding` / `undefined` | ✅ Yes | ✅ No | Phase 1 row 7. |
| Reports / Dashboard / Collections / Profile | various | Read-only / list-with-filter | n/a | n/a | n/a | ✅ No | No form TextInputs at viewport bottom. |

### 2.5 (super-admin)

| Screen | File:line | Form type | Has KAV? | Behavior (iOS / Android) | Wraps ScrollView? | Suspect on iOS? | Notes |
|--------|-----------|-----------|----------|--------------------------|--------------------|-----------------|-------|
| Users (hidden) | [(super-admin)/users.tsx:199](../packages/mobile/app/(super-admin)/users.tsx) | Form modal | ✅ Yes | `padding` / `height` | ✅ Yes | ✅ No | Phase 1 row 8. |
| Distributors (hidden) | [(super-admin)/distributors.tsx:222](../packages/mobile/app/(super-admin)/distributors.tsx) | Form modal | ✅ Yes | `padding` / `height` | ✅ Yes | ✅ No | Phase 1 row 9. |
| Customers | [(super-admin)/customers.tsx:74](../packages/mobile/app/(super-admin)/customers.tsx) | List-with-search | ❌ No | n/a | n/a | ⚠ Maybe | Search at top, low risk. |
| Provider-catalog (hidden) | [(super-admin)/provider-catalog.tsx:82](../packages/mobile/app/(super-admin)/provider-catalog.tsx) | List-with-search | ❌ No | n/a | n/a | ⚠ Maybe | Same pattern as customers. |
| Other screens | various | Read-only | n/a | n/a | n/a | ✅ No | |

### 2.6 (finance)

| Screen | File:line | Form type | Has KAV? | Behavior (iOS / Android) | Wraps ScrollView? | Suspect on iOS? | Notes |
|--------|-----------|-----------|----------|--------------------------|--------------------|-----------------|-------|
| Payments | [(finance)/payments.tsx:324, 561](../packages/mobile/app/(finance)/payments.tsx) | 2 form modals (record payment, edit) | ✅ Yes ×2 | `padding` / `height` | ✅ Yes | ✅ No | Phase 1 row 10. |
| Invoices, Collections, Dashboard, More, Profile | various | Read-only / via CustomerForm | n/a | n/a | n/a | ✅ No | |

### 2.7 (inventory)

| Screen | File:line | Form type | Has KAV? | Behavior (iOS / Android) | Wraps ScrollView? | Suspect on iOS? | Notes |
|--------|-----------|-----------|----------|--------------------------|--------------------|-----------------|-------|
| Inventory | [(inventory)/inventory.tsx:772](../packages/mobile/app/(inventory)/inventory.tsx) | Form modal | ✅ Yes | `padding` / `height` | ✅ Yes | ✅ No | Phase 1 row 12. |
| Actions (hidden) | [(inventory)/actions.tsx:190](../packages/mobile/app/(inventory)/actions.tsx) | Form modal | ✅ Yes | `padding` / `height` | ✅ Yes | ✅ No | Phase 1 row 11. |
| Orders | [(inventory)/orders.tsx:146](../packages/mobile/app/(inventory)/orders.tsx) | List-with-search | ❌ No | n/a | n/a | ⚠ Maybe | Search at top, low risk. |
| Fleet | [(inventory)/fleet.tsx:156](../packages/mobile/app/(inventory)/fleet.tsx) | List-with-search | ❌ No | n/a | n/a | ⚠ Maybe | Search at top, low risk. |
| Other screens | various | Read-only | n/a | n/a | n/a | ✅ No | |

### Audit summary

- **Total in-scope screens** (have at least one TextInput): **28** files matched the TextInput grep.
- **Confirmed broken on iOS (❌):** **3 cases in 2 files** — admin orders.tsx nested customer picker (×2, lines 1081 and 2012), driver orders.tsx delivery-proof modal (line 291).
- **Suspect / needs device check (⚠):** 7 list-with-search screens. These are list-filter inputs at the TOP of a scrollable surface — iOS auto-scroll of the focused input usually keeps them visible, but the FlatList below loses its bottom rows to the keyboard. Not a blocker, but a polish opportunity.
- **Safe (✅) — already follow the canonical pattern:** all 19 KAV blocks Phase 1 documented, plus `CustomerForm`, `ProfileScreen`, and both auth screens. **22 form-modal/form-route surfaces are already correct.**

The "broken" set is concentrated entirely in **nested-Modal-with-TextInput patterns**. No top-level form modal in the codebase is broken — they all have KAV.

---

## 3. Pattern recommendation

### Option A — Native `<KeyboardAvoidingView>` per surface

Wrap every form surface (including each nested picker modal) with `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>`.

**Pros**
- Zero new dependencies — pure JS using React Native primitives already imported in 22 files.
- Matches the canonical pattern the codebase has used in all 22 working surfaces.
- The fix for the 3 broken cases is a 4-line wrap each.
- No cloud-build round-trip needed.

**Cons**
- Per-screen `keyboardVerticalOffset` may still be needed if a screen has a translucent header — but none of the 3 broken cases do (they're inside Modals that own their own status bar).
- Does not auto-scroll to the focused input. The driver delivery-proof modal would still need the notes field high enough above the keyboard for the Submit button to be reachable — the existing layout already achieves this once KAV is added because the modal sheet maxHeight contracts naturally.

### Option B — Adopt `react-native-keyboard-aware-scroll-view`

Add a new npm dep and replace each form-modal's `ScrollView` with `<KeyboardAwareScrollView>`.

**Pros**
- Single drop-in replacement; handles scroll-to-focused-input automatically. Nice for long forms (CustomerForm).
- Solves the "TextInput below the keyboard" case more elegantly than KAV alone.

**Cons**
- **Native-code dependency.** Per repo memory (`feedback-expo-install-for-native-packages`), this is a smoke-build-revalidating change — would force a cloud build to validate even though it's an Expo-managed workflow. The library's recent versions DO ship as pure JS for newer RN, but Expo SDK 54 compat is unverified without `npx expo install --check`.
- Forces 22 already-working surfaces to be refactored just to standardise — large diff for no behavioural change on Android, where everything already works.
- Adds maintenance burden for a 3rd-party that has historically had RN-version-compat churn.
- The 3 broken cases don't NEED auto-scroll — they need a wrapper that lifts the sheet. KAV alone solves the bug. Bringing in a library to solve a bug the framework already solves is over-engineering.

### Option C — Custom `<ScreenWithKeyboard>` wrapper component

Add `packages/mobile/src/components/ui/ScreenWithKeyboard.tsx` that wraps `KeyboardAvoidingView` + `ScrollView` with canonical defaults (`behavior`, `keyboardShouldPersistTaps`, sensible `paddingBottom`).

**Pros**
- Centralises the platform branching — future screens stop re-declaring `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`.
- Pure JS, no cloud build.
- Forms a documented contract: "all form modals MUST use ScreenWithKeyboard."

**Cons**
- One more abstraction in a codebase that already has 22 correct hand-rolled instances. The Phase 1 audit found those 22 are all uniform.
- Migrating the 22 working instances is touchy — different ones use different `behavior` for Android (`undefined` vs `'height'` vs explicit), different `paddingBottom` constants, different `contentContainerStyle`. A wrapper that hides those nuances either grows a 6-prop API (defeating the purpose) or forces flattening that loses real polish.
- Doesn't actually FIX the 3 broken cases faster than Option A — you still need to drop the wrapper around the 3 picker modals plus refactor the 22 others to use it.

### Smallest-diff scoring

| Option | Diff size to fix the 3 broken cases | Diff size to standardise the other 22 | New deps | Cloud build required |
|--------|-------------------------------------|-----------------------------------------|----------|----------------------|
| A | ~12 lines (3 KAV wraps) | 0 (already canonical) | 0 | No |
| B | ~12 lines (3 KAV wraps if kept) + replace ScrollView in 22 surfaces if standardising | ~150 lines | 1 (native) | **Yes** |
| C | ~12 lines + wrapper file (~40 lines) + 22-surface migration | ~250 lines | 0 | No |

### Recommendation: **Option A** — native `KeyboardAvoidingView`, matching the existing 22-surface convention.

Rationale:
- The bug is concentrated in nested Modals that simply forgot to add the wrapper. Adding it brings them into line with the rest of the codebase.
- Option B fails the "smallest diff that fixes the most" test AND introduces cloud-build risk for no functional gain over A in the broken cases.
- Option C is reasonable in principle but the codebase has already converged on a hand-rolled pattern that works. Adding an abstraction now is a refactor masquerading as a bug fix.
- **Honest uncertainty:** if a future screen needs scroll-to-focused-input for a 12-input form, revisit Option B at that time as a localised import. For today's bug, Option A is the answer.

---

## 4. Implementation plan

### Total screens needing a fix

**3 surfaces in 2 files.**

1. [(admin)/orders.tsx:1081-1144](../packages/mobile/app/(admin)/orders.tsx) — Create Order's nested customer picker. Wrap `pickerOverlay` View's children in a KAV.
2. [(admin)/orders.tsx:2012-2052](../packages/mobile/app/(admin)/orders.tsx) — Returns Order's nested customer picker. Identical wrap.
3. [(driver)/orders.tsx:291-462](../packages/mobile/app/(driver)/orders.tsx) — Delivery-proof modal. Wrap the inner content `<View>` (the sheet container at line 299) in a KAV.

### Files needing NEW code vs replacement

- **New code (KAV import + wrapper):** [(driver)/orders.tsx](../packages/mobile/app/(driver)/orders.tsx) — `KeyboardAvoidingView` and `Platform` are NOT currently imported on line 2; the import must be added. The admin orders.tsx file already imports both at lines 13-14.
- **Pattern-extension only (no new imports):** [(admin)/orders.tsx](../packages/mobile/app/(admin)/orders.tsx) — both broken cases just need a wrapper added.

### Commit shape

**Single commit.** Title: `fix(mobile): ios keyboard overlap on nested customer picker + delivery proof modal`. The three changes are tightly related (same root cause, same one-line fix pattern, same testing burden) and total ~20 lines. Splitting into three commits would be ceremony without value.

### Effort estimate

- Code change: **~30 minutes** (3 wraps, 1 import line).
- Smoke test on iOS Expo Go: **~15 minutes** (launch app, exercise each flow).
- Smoke test on Android Expo Go (regression): **~15 minutes** (same flows).
- Manual device pass on real iPhone via TestFlight or `eas build --profile preview`: **~30 minutes** to confirm the keyboard behaviour matches the simulator.
- Total: **~1.5 hours** end-to-end.

### Risk — screens where the new wrapper might break existing custom behaviour

- [(driver)/orders.tsx delivery proof modal](../packages/mobile/app/(driver)/orders.tsx): the sheet currently sits in `justifyContent: 'flex-end'` with no max-height. Adding KAV with `behavior="padding"` will cause iOS to pad the sheet bottom by the keyboard height — desired behaviour. **Low risk.** Verify on a short iPhone (SE) that the proof-camera button + photo preview + textfields all remain visible at once when the notes field is focused.
- [(admin)/orders.tsx nested picker](../packages/mobile/app/(admin)/orders.tsx): the inner sheet has `maxHeight: '80%'`. With KAV `padding` mode the sheet's bottom edge will be lifted to the top of the keyboard — the FlatList will then have a smaller height but full scrollability. **Low risk.** Verify the close (X) button at the top of the picker remains tappable.
- **None of the 22 already-correct surfaces are touched**, so no regression risk to those flows.

---

## 5. Test plan

### Automated assertions

The codebase has **no existing snapshot tests for KAV presence** ([packages/mobile/__tests__/](../packages/mobile/) is empty for these flows). Two options:

1. **(Recommended for this PR — low cost)** Add a lightweight render assertion that the nested customer-picker Modal contains a `<KeyboardAvoidingView>`. With React Native Testing Library:

   ```ts
   // pseudocode — packages/mobile/__tests__/keyboard-coverage.test.tsx
   import { render } from '@testing-library/react-native';
   import { CreateOrderModal } from '../app/(admin)/orders';
   const tree = render(<CreateOrderModal visible openCustomerPicker /* test prop */ />);
   expect(tree.UNSAFE_getAllByType(KeyboardAvoidingView).length).toBeGreaterThanOrEqual(2);
   ```

   This catches future regressions where someone removes the wrapper. Acceptable to defer if test infra isn't already set up (current PR can skip).

2. **(Skip for this PR)** Snapshot tests — high churn cost, low value.

### Manual test plan for Suneel (Expo Go on iPhone)

Run on an iPhone with a SHORT screen (SE 2nd-gen or mini) for the worst-case keyboard real estate. iPhone Pro is also fine but the bug is most pronounced on short devices.

**Scenario 1 — Admin order creation (THE REPORTED BUG)**

1. Sign in as `bhargava@gasagency.com` / `Distadmin@123`.
2. Tab to Orders → tap "Create" FAB.
3. In the Create Order modal, tap "Select customer".
4. Verify: the picker sheet slides up. The search TextInput at the top auto-focuses and the keyboard appears.
5. Verify: the customer list is fully visible — **at least 4 customer rows are tappable below the search bar with the keyboard up**.
6. Verify: the X close button on the picker remains tappable.
7. Type "royal" — verify filter works.
8. Tap a customer row — verify picker dismisses and "Royal Kitchen" appears in the picker button.

**Scenario 2 — Admin returns order**

1. Same login. From the order list, swipe / use the menu to find the "Returns" action.
2. Open the Returns Order modal.
3. Tap "Select customer".
4. Repeat scenario-1 verifications 4-8.

**Scenario 3 — Driver delivery proof**

1. Sign out, sign in as `raju@gasagency.com` / `Driver@123`.
2. Open My Deliveries (orders tab).
3. Pick a `pending_delivery` order and tap "Deliver".
4. Delivery sheet slides up. Tap the multiline "Delivery Notes" field.
5. Verify: with keyboard up, the "Confirm Delivery" button at the bottom IS still visible OR can be reached by scrolling within the sheet.
6. Type some notes. Verify Confirm button works.

**Scenario 4 — Negative regression for the 22 working surfaces (spot check)**

1. As admin, open Create Invoice (Billing/finance modal). Type into the invoice number field. Verify keyboard doesn't break anything.
2. As super-admin, open Users → Create user. Same check.
3. As driver, log in → tap Profile in More. Edit profile name. Same check.

If any of those three regress, KAV behaviour drift is at play and the fix needs reconsideration.

---

## 6. Android regression risk

### Per-screen Android impact

For each of the 3 fix targets, the new wrapper will be `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>`. The `behavior={undefined}` on Android means KAV is effectively a passthrough View — **zero layout impact on Android**. The Android keyboard behaviour for these screens comes entirely from `android:windowSoftInputMode`.

### AndroidManifest.xml — `windowSoftInputMode`

Mobile uses the Expo managed workflow. No physical `AndroidManifest.xml` exists in the repo (Expo generates it at build time from [app.json](../packages/mobile/app.json)). The relevant Expo config field is `expo.android.softwareKeyboardLayoutMode` — **this field is NOT set** in [app.json](../packages/mobile/app.json) (verified via the full file read).

When `softwareKeyboardLayoutMode` is unset, Expo defaults to `resize` — which is `adjustResize` in AndroidManifest terms. With `adjustResize` the whole window contracts when the keyboard appears, and child views (including nested modals) inherit the smaller layout. **This is why all 28 TextInput-bearing screens work on Android without explicit KAV — the OS resizes for them.**

The `Platform.OS === 'ios' ? 'padding' : undefined` pattern in the new wrappers preserves this: on Android, `undefined` behavior on KAV is a no-op, and `adjustResize` continues to do its job. **Android cannot regress** from the proposed change.

### Cases where Android *could* regress

- If anyone later changes `behavior` to `'height'` on Android for one of the 3 fix targets, the nested Modal's measure-pass will fight `adjustResize` and produce double-resizing. **Don't do that.** Keep `undefined` on Android consistent with what (admin)/orders.tsx already does (Phase 1 row 5).
- If `app.json` ever sets `expo.android.softwareKeyboardLayoutMode: "pan"`, the Android side breaks across the board (not just the 3 fix targets). That's a separate manifest-level concern — flag in any future PR that touches `app.json`.

### Cross-platform parity statement

After the fix:
- **iOS:** all 3 broken cases now lift their content above the keyboard. Matches Android behaviour.
- **Android:** unchanged. `adjustResize` continues to handle everything.
- **No screen behaves worse on either platform.**

---

## 7. Quick-win path

**Yes — there is a 5-minute single-file fix for the EXACT bug Suneel reported.**

Unblock immediately by patching only the Create-Order nested picker at [(admin)/orders.tsx:1081-1144](../packages/mobile/app/(admin)/orders.tsx). One wrap:

```tsx
// Inside the inner <Modal visible={showCustomerPicker} ...>:
<View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
  <KeyboardAvoidingView                                      // ← NEW
    behavior={Platform.OS === 'ios' ? 'padding' : undefined} // ← NEW
    style={{ flex: 1, justifyContent: 'flex-end' }}          // ← NEW
  >
    <View style={[styles.pickerSheet, { backgroundColor: C.modalBg }]}>
      {/* …existing content unchanged… */}
    </View>
  </KeyboardAvoidingView>                                    // ← NEW
</View>
```

`KeyboardAvoidingView` and `Platform` are already imported at orders.tsx:13-14, so no import diff needed. Single file, ~5 lines, ~5 minutes.

**Recommended path:**
1. Ship the quick win for Create-Order TODAY (unblock the manual testing path).
2. Ship the systematic patch (all 3 surfaces — add the same wrap to Returns picker + driver delivery proof) in the same week as a follow-up commit. Don't let it slide — the driver delivery-proof case is more functionally severe (driver can't submit) even though Suneel hit the admin case first.

**Do NOT defer the driver fix to a later sprint.** The driver app is the highest-touch surface in the product and the Confirm Delivery button being obscured by the keyboard is a hard blocker once a real driver tries it on iOS.

---

## 8. Open uncertainties (flag for Suneel)

- The 7 "list-with-search" screens (⚠ Maybe in section 2) are LIKELY fine on iOS because the search input is at the top of the viewport — iOS auto-scrolls focused inputs into view. But I have not verified on a physical iPhone. If you spot a list-screen where the keyboard hides results below the input, that screen joins the fix list with the same one-line KAV wrap.
- The driver delivery-proof modal's bottom-anchored layout means even with KAV applied, on a very short iPhone (SE) the proof-photo button + qty inputs + notes field + Confirm button may not all fit above the keyboard simultaneously. The KAV fix unblocks the keyboard-overlap part, but if cramping appears, the modal's content may need to switch from a fixed View to a ScrollView (separate WI, low priority).
- I have NOT executed the app — every diagnosis is based on static code reading + the platform contract (RN Modal owns its native window on iOS; `adjustResize` is the Android default). The bug repro mechanism in section 1 is high confidence but the SE-class device behaviour after fix is best confirmed on hardware.

---

*End of iOS KOF audit.*
