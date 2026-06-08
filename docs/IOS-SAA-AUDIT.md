# iOS Safe-Area (SAA) Audit — packages/mobile

**Audit date:** 2026-06-08
**Branch:** main (post `9ae54e1` KOF commit)
**Pre-reading:** [docs/IOS-KOF-AUDIT.md](IOS-KOF-AUDIT.md), [docs/IOS-PHASE1-PARITY-MATRIX.md](IOS-PHASE1-PARITY-MATRIX.md) §3 + §4, [CLAUDE.md](../CLAUDE.md) "Mobile Development Rules".
**Scope:** read-only investigation of safe-area handling across all 62 `.tsx` files in `packages/mobile/`. No code changes. ONE deliverable: this doc.
**Confirmed installed:** `react-native-safe-area-context ~5.6.2` ([packages/mobile/package.json](../packages/mobile/package.json)). No new dependency required by the recommendation.

Legend: ✅ correct / ⚠ partial / ❌ broken / 🚩 ASK SUNEEL.

> **Foundational finding (read first):** there is **no `<SafeAreaProvider>`** anywhere in the mobile tree. A repo-wide grep returns zero matches. With `react-native-safe-area-context` v5, `SafeAreaView` from the library still functions via its native auto-provider for the *root window*, but `useSafeAreaInsets()` returns `{ top: 0, right: 0, bottom: 0, left: 0 }` until a provider is mounted. This single omission explains parts of Bugs 2 and 3 below and constrains the fix.

---

## 1. Bug-by-bug root causes

### Bug 1 — Customer-picker modal floats too high above the iOS keyboard (KOF over-correction)

**File:** [packages/mobile/app/(admin)/orders.tsx:1085-1153](../packages/mobile/app/(admin)/orders.tsx) — Create Order's nested customer picker. Same pattern at [orders.tsx:2024-2086](../packages/mobile/app/(admin)/orders.tsx) (Returns picker).

**Concrete diagnosis.** The KOF fix at commit `9ae54e1` wrapped the inner `pickerOverlay` View's child in a `KeyboardAvoidingView`, but **the actual style applied diverges from what the KOF audit recommended.** The audit recommended:

```tsx
<KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }}>
```

The committed code at [orders.tsx:1087-1090](../packages/mobile/app/(admin)/orders.tsx) instead applies:

```tsx
<KeyboardAvoidingView
  behavior={Platform.OS === 'ios' ? 'padding' : undefined}
  style={{ width: '100%' }}   // ← NOT flex:1 + justifyContent:'flex-end'
>
```

Layout tree at runtime on iOS with the keyboard up:

1. `pickerOverlay` View is `flex: 1, justifyContent: 'flex-end'` ([orders.tsx:2723-2726](../packages/mobile/app/(admin)/orders.tsx)) → it fills the screen and bottom-anchors its single child.
2. The KAV child has `width: '100%'`, no flex. Its height is intrinsic = the height of its own child (`pickerSheet`).
3. `behavior="padding"` on iOS instructs KAV to add **inner bottom padding equal to the keyboard height** when the keyboard appears.
4. So the KAV's bounding box becomes: `pickerSheet height + keyboardHeight`. Anchored to the overlay's bottom edge, the keyboard-height worth of padding occupies the strip **between the sheet's bottom and the screen's bottom edge** — which is exactly where the keyboard is rendered. The keyboard CAN reach into that padded region visually.
5. Result Suneel sees: the sheet floats above the keyboard with an awkward white gap (the padding region peeking through above the keyboard) because the `pickerSheet`'s `maxHeight: '80%'` ([orders.tsx:2728](../packages/mobile/app/(admin)/orders.tsx)) caps the sheet at 80% of the OVERLAY (whole screen), but the available space between the overlay top and the keyboard top is less than 80% — so the sheet sits at a height smaller than its cap, and the `flex-end` anchoring + `behavior='padding'` push it up above the keyboard with the gap dominant.

**One-sentence fix sketch.** Change KAV `style={{ width: '100%' }}` to `style={{ flex: 1, justifyContent: 'flex-end' }}` (as the KOF audit originally specified), and change `pickerSheet`'s `maxHeight: '80%'` constraint so the sheet fills the available KAV space — either remove `maxHeight` entirely or relax it to `maxHeight: '100%'` and let the `justifyContent: 'flex-end'` + parent flex do the bottom-anchor.

**Honest assessment.** The KOF audit's recommendation was correct in principle but the actual commit applied a *different* style. Calling this a "KOF over-correction" overstates what happened — KOF *under-corrected* (or rather, was implemented differently from what was specified). The intent was right; the style prop was wrong. Either way, today the user is worse off than before the KOF commit was applied, because pre-KOF the keyboard simply covered the bottom of the list (functional impairment) while post-KOF there is dead space + the list is shorter than it should be (also functional impairment, harder to scan).

### Bug 2 — iPhone Create Order modal top overlaps the status bar

**File:** [packages/mobile/app/(admin)/orders.tsx:1037-1295](../packages/mobile/app/(admin)/orders.tsx). Specifically the modal opens at line 1037, wraps content at line 1039 in `<SafeAreaView style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>` (no `edges` prop → defaults to all 4 edges). `modalContainer` is `{ flex: 1 }` ([orders.tsx:2670-2672](../packages/mobile/app/(admin)/orders.tsx)).

**Concrete diagnosis.** The SafeAreaView from `react-native-safe-area-context` with default edges *should* apply `paddingTop: insets.top` and `paddingBottom: insets.bottom`. It does not, because:

- React Native's `<Modal>` with `presentationStyle="fullScreen"` ([orders.tsx:1038](../packages/mobile/app/(admin)/orders.tsx)) renders in a separate iOS `UIWindow` outside the root React tree. The library's auto-provider that backs `SafeAreaView` is attached at the root window — it does NOT propagate into the modal's separate window. Inside the modal, the `SafeAreaView` falls back to zero insets.
- There is **no `<SafeAreaProvider>` at the root** ([app/_layout.tsx](../packages/mobile/app/_layout.tsx) — verified: no `SafeAreaProvider` import, no JSX usage). Even if there were, on iOS Modal presentation it would still need to be re-mounted INSIDE the modal's window for `SafeAreaView` / `useSafeAreaInsets` to receive non-zero values.

Same root cause likely affects every other "wrap in SafeAreaView" full-screen Modal in the admin orders file:
- CreateOrderModal at [orders.tsx:1039](../packages/mobile/app/(admin)/orders.tsx) (the reported case)
- CreateInvoiceModal-equivalent at [orders.tsx:1698](../packages/mobile/app/(admin)/orders.tsx)
- ReturnsOrderModal at [orders.tsx:1997](../packages/mobile/app/(admin)/orders.tsx)
- EditOrderModal at [orders.tsx:2199](../packages/mobile/app/(admin)/orders.tsx)
- AssignDriverModal at [orders.tsx:2302](../packages/mobile/app/(admin)/orders.tsx)

…and likewise the equivalent fullScreen modals in [(admin)/more.tsx](../packages/mobile/app/(admin)/more.tsx) (8 modals at lines 399, 554, 814, 970, 1158, 1410, 1675), [(admin)/finance.tsx:2408](../packages/mobile/app/(admin)/finance.tsx), [(finance)/invoices.tsx:203](../packages/mobile/app/(finance)/invoices.tsx), [src/screens/CustomerForm.tsx:528](../packages/mobile/src/screens/CustomerForm.tsx). Why Suneel reported only Create Order is most likely that this is the first surface they exercised in the iPhone test pass — the rest probably have the same defect and just haven't been observed yet.

**One-sentence fix sketch.** Either (a) add a `<SafeAreaProvider>` at the root of `app/_layout.tsx` AND wrap every fullScreen-Modal's content with a nested `<SafeAreaProvider><SafeAreaView edges={['top']}>` inside the Modal, OR (b) skip SafeAreaView inside the modal and instead apply `paddingTop: useSafeAreaInsets().top` directly to the modal container — but for (b) to work, the SafeAreaProvider MUST exist somewhere in scope; on iOS modals that means inside the Modal's own subtree.

### Bug 3 — iPhone Dispatch Results sheet bottom cutoff at the home indicator

**File:** [packages/mobile/app/(admin)/orders.tsx:1832-1924](../packages/mobile/app/(admin)/orders.tsx) — `DispatchResultModal`.

**Concrete diagnosis.** The implementation tried to do the right thing:

- Line 1850: `const insets = useSafeAreaInsets();`
- Line 1915: `paddingBottom: Math.max(20, insets.bottom + 12)` on the Close-button container.

But:

- This Modal is `transparent` ([line 1852](../packages/mobile/app/(admin)/orders.tsx)) so it renders into its own iOS presentation context (transparent modals on iOS still get their own UIWindow). Without a `<SafeAreaProvider>` mounted **inside** the modal subtree, `useSafeAreaInsets()` returns `{ bottom: 0 }` on iOS. So the runtime value of the padding becomes `Math.max(20, 0 + 12) = 20px`.
- The iPhone home indicator zone is ~34dp tall (Plus-class) or ~34dp (Pro). 20px of paddingBottom is **less than the home-indicator clearance** — the Close button sits on top of / partially behind the home indicator strip.
- Compounding: the `bottomSheet` style itself ([orders.tsx:2841-2846](../packages/mobile/app/(admin)/orders.tsx)) has `maxHeight: '80%'` and `paddingTop: 8` only — no own `paddingBottom`. The sheet container CAN extend to 80% of the parent overlay (full screen) — close to the home-indicator. The Close button is inside the sheet, near its bottom.

The fallback `Math.max(20, ...)` was the developer's defensive guard for "no insets available" — but the floor of 20 is the wrong floor (should be ~34 for iPhone home-indicator). And the real fix is to make `insets.bottom` actually return a value, which requires a SafeAreaProvider.

**One-sentence fix sketch.** Same root cause family as Bug 2 — mount a `<SafeAreaProvider>` so `useSafeAreaInsets()` returns real values, AND/OR change the floor from `Math.max(20, ...)` to `Math.max(34, ...)` as an iOS-side defensive minimum.

### Bug 4 — Android tab bar flush against system nav (pre-existing, not a today-regression)

**Files:**
- [packages/mobile/src/components/ui/ScrollableTabBar.tsx:104](../packages/mobile/src/components/ui/ScrollableTabBar.tsx) — `paddingBottom: Platform.OS === 'ios' ? 8 : 6`. Custom admin tab bar.
- [packages/mobile/src/theme.ts:113-120](../packages/mobile/src/theme.ts) — `getTabBarConfig()` returns `tabBarStyle: { paddingBottom: 8, height: 64 }`. This is used by **every default `<Tabs>` layout**: customer, driver, super-admin, finance, inventory.

**Concrete diagnosis.** Both surfaces hardcode a tiny `paddingBottom` (6-8 px) AND a fixed `height: 64`. Expo Router / React Navigation by default would otherwise add `paddingBottom: safeAreaInsets.bottom` automatically — but the `tabBarStyle` override here REPLACES (not extends) the default, dropping the safe-area handling.

On Android phones with on-screen 3-button or gesture nav:
- The system nav bar reserves ~24-48dp at the bottom of the screen.
- With `paddingBottom: 6` on the tab bar AND `height: 64`, the tab labels sit at `tabBarTop + 64 - 6 - labelHeight` — i.e. labels are at the very bottom of a 64dp strip, and the strip's lower edge sits on top of the system nav. Tap targets for the bottom row of pixels are effectively blocked by the system nav.

iOS is mostly OK on devices WITHOUT a home indicator (older iPhones) — but the same hardcode means iOS home-indicator devices also lose ~14dp (34 - 8 = ~26dp of overlap), making the tabs feel cramped. Suneel reported the Android case but the iOS impact is non-zero.

Affected layouts:
- [(admin)/_layout.tsx](../packages/mobile/app/(admin)/_layout.tsx) — uses `ScrollableTabBar` directly. Broken.
- [(customer)/_layout.tsx](../packages/mobile/app/(customer)/_layout.tsx), [(driver)/_layout.tsx](../packages/mobile/app/(driver)/_layout.tsx), [(super-admin)/_layout.tsx](../packages/mobile/app/(super-admin)/_layout.tsx), [(finance)/_layout.tsx](../packages/mobile/app/(finance)/_layout.tsx), [(inventory)/_layout.tsx](../packages/mobile/app/(inventory)/_layout.tsx) — all use `getTabBarConfig(dark)` which has the same hardcoded `paddingBottom: 8`. ALL broken on Android.

**One-sentence fix sketch.** Replace the hardcoded `paddingBottom: 8` in both surfaces with `paddingBottom: safeAreaInsets.bottom + 6` and adjust `height` to `64 + safeAreaInsets.bottom` — requires `useSafeAreaInsets()` (and therefore a `<SafeAreaProvider>` at the root, which is Bug 2's fix anyway).

**Behavioral Android change callout.** Bug 4 fix is a *positive* behavioral change on Android — it adds the missing bottom padding. This is a visible difference from current production. The implementation chunk MUST flag this in its commit summary and stop for Suneel approval before commit per the strengthened protocol. Expected magnitude on Android with gesture nav: tab bar grows from 64dp tall to ~88dp tall (64 + ~24dp gesture pill). On devices with no system nav (rare; some Android skins) the tab bar is unchanged. iOS home-indicator devices grow from 64dp to ~98dp (64 + 34dp). iOS non-home-indicator devices are unchanged.

---

## 2. Codebase-wide safe-area audit table

Methodology: grepped `SafeAreaView`, `useSafeAreaInsets`, `SafeAreaProvider` across `packages/mobile/`. Cross-checked each screen against the KOF audit's 28-file TextInput inventory. Counted every full-screen surface and every Modal that renders content.

Column legend: SAV = `<SafeAreaView>` from `react-native-safe-area-context`. SAI = `useSafeAreaInsets()` hook. HC = hardcoded numeric padding.

### 2.1 Root + global

| Surface | File:line | Wraps in SAV? | Uses SAI? | HC padding? | Top edge OK? | Bottom edge OK? | Verdict |
|---|---|---|---|---|---|---|---|
| Root layout (Stack) | [app/_layout.tsx:56-73](../packages/mobile/app/_layout.tsx) | ❌ No (View only) | ❌ No | n/a | n/a (Stack doesn't draw chrome) | n/a | ❌ **No SafeAreaProvider** — foundational defect. |
| StatusBar component | [app/_layout.tsx:59](../packages/mobile/app/_layout.tsx) | n/a | n/a | n/a | n/a | n/a | ✅ `<StatusBar>` from expo-status-bar is fine, but it sets text color, not safe area. |
| NetworkIndicator | [app/_layout.tsx:61](../packages/mobile/app/_layout.tsx) | unknown (didn't read) | ? | ? | ? | ? | ⚠ Out of audit scope. Likely benign — it overlays. |

### 2.2 (auth)

| Surface | File:line | SAV? | SAI? | HC padding? | Top edge | Bottom edge | Verdict |
|---|---|---|---|---|---|---|---|
| Login | [(auth)/login.tsx:125, 378](../packages/mobile/app/(auth)/login.tsx) | ✅ default edges | ❌ | n/a | ⚠ (no provider) | ⚠ | ⚠ Form is inside a SAV with default edges (all 4) but no provider — insets may be zero, but auth screens aren't inside a Modal so iOS native auto-provider on root window applies. Probably visually OK on iPhone. |
| Forgot password | [(auth)/forgot-password.tsx:167, 415](../packages/mobile/app/(auth)/forgot-password.tsx) | ✅ default edges | ❌ | n/a | ⚠ | ⚠ | Same as Login. |

### 2.3 (customer)

| Surface | File:line | SAV? | SAI? | HC padding? | Top edge | Bottom edge | Verdict |
|---|---|---|---|---|---|---|---|
| Dashboard | [(customer)/dashboard.tsx:57](../packages/mobile/app/(customer)/dashboard.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ (no top edge → relies on Tabs header) | ⚠ (no bottom edge → relies on Tabs bar paddingBottom: 8, see Bug 4) | ⚠ Header from Tabs covers top; bottom is the Bug 4 surface. |
| Orders | [(customer)/orders.tsx:437, 861](../packages/mobile/app/(customer)/orders.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ (Bug 4) | Same. 4 nested fullScreen Modals (KOF audit row 14) each wrap content in own SAV — Bug 2 family. |
| Invoices | [(customer)/invoices.tsx:185, 200](../packages/mobile/app/(customer)/invoices.tsx) | ✅ outer `edges={['left','right']}` + inner Modal SAV (default edges) | ❌ | n/a | ⚠ | ⚠ | Inner modal's SAV (line 200) is the Bug 2 pattern. |
| Payments | [(customer)/payments.tsx:156, 215](../packages/mobile/app/(customer)/payments.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ (Bug 4) | |
| Account | [(customer)/account.tsx:132, 302](../packages/mobile/app/(customer)/account.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ (Bug 4) | Edit-profile modal — see modal section below. |

### 2.4 (driver)

| Surface | File:line | SAV? | SAI? | HC padding? | Top edge | Bottom edge | Verdict |
|---|---|---|---|---|---|---|---|
| Layout | [(driver)/_layout.tsx](../packages/mobile/app/(driver)/_layout.tsx) | ❌ | ❌ | via theme | n/a | ⚠ Bug 4 | Tabs uses `getTabBarConfig` |
| Orders (My Deliveries) | [(driver)/orders.tsx:212, 491](../packages/mobile/app/(driver)/orders.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ Bug 4 | Delivery-proof modal lives inside this file. KOF audit row 69 — the modal was patched by the KOF commit; safe-area on its bottom edge is untested. |
| Trip | [(driver)/trip.tsx:300, 550](../packages/mobile/app/(driver)/trip.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ Bug 4 | |
| Inventory | [(driver)/inventory.tsx:54, 137](../packages/mobile/app/(driver)/inventory.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ Bug 4 | |
| Analytics | [(driver)/analytics.tsx:86, 239](../packages/mobile/app/(driver)/analytics.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ Bug 4 | |
| More | [(driver)/more.tsx:54, 178](../packages/mobile/app/(driver)/more.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ Bug 4 | |
| Profile (hidden route) | [(driver)/profile.tsx:22, 66](../packages/mobile/app/(driver)/profile.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ | Wraps ProfileScreen. |

### 2.5 (admin)

| Surface | File:line | SAV? | SAI? | HC padding? | Top edge | Bottom edge | Verdict |
|---|---|---|---|---|---|---|---|
| Layout | [(admin)/_layout.tsx](../packages/mobile/app/(admin)/_layout.tsx) | ❌ | ❌ | via ScrollableTabBar | n/a | ❌ Bug 4 | Custom tab bar has its own hardcoded padding |
| Dashboard | [(admin)/dashboard.tsx:297, 309](../packages/mobile/app/(admin)/dashboard.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Orders (screen) | [(admin)/orders.tsx:599, 953](../packages/mobile/app/(admin)/orders.tsx) | ✅ `edges={['left','right']}` | ✅ (line 1850, only inside DispatchResultModal) | n/a | ⚠ | ❌ Bug 4 | |
| CreateOrderModal | [(admin)/orders.tsx:1037-1295](../packages/mobile/app/(admin)/orders.tsx) | ✅ default edges | ❌ | n/a | ❌ Bug 2 | ❌ | **fullScreen Modal — top overlaps status bar** (no provider in modal subtree). |
| Customer picker (nested) | [(admin)/orders.tsx:1085-1153](../packages/mobile/app/(admin)/orders.tsx) | ❌ | ❌ | n/a | n/a | ❌ Bug 1 | KOF over-correction — sheet floats too high. |
| CreateInvoiceModal | [(admin)/orders.tsx:1698-1827](../packages/mobile/app/(admin)/orders.tsx) | ✅ default edges | ❌ | n/a | ❌ Bug 2 | ❌ | Same pattern as CreateOrderModal. |
| DispatchResultModal | [(admin)/orders.tsx:1832-1924](../packages/mobile/app/(admin)/orders.tsx) | ❌ (transparent View wrap) | ✅ line 1850 | `Math.max(20, insets.bottom + 12)` | n/a (bottom sheet) | ❌ Bug 3 | Floor of 20 < home-indicator 34; SAI returns 0 because no provider. |
| ReturnsOrderModal | [(admin)/orders.tsx:1997-2131](../packages/mobile/app/(admin)/orders.tsx) | ✅ default edges | ❌ | n/a | ❌ Bug 2 | ❌ | |
| Returns customer picker (nested) | [(admin)/orders.tsx:2024-2086](../packages/mobile/app/(admin)/orders.tsx) | ❌ | ❌ | n/a | n/a | ❌ Bug 1 | Same KOF over-correction. |
| EditOrderModal | [(admin)/orders.tsx:2199-2278](../packages/mobile/app/(admin)/orders.tsx) | ✅ default edges | ❌ | n/a | ❌ Bug 2 | ❌ | |
| AssignDriverModal | [(admin)/orders.tsx:2302-2350](../packages/mobile/app/(admin)/orders.tsx) | ✅ default edges | ❌ | n/a | ❌ Bug 2 | ❌ | |
| Inventory | [(admin)/inventory.tsx:267, 333](../packages/mobile/app/(admin)/inventory.tsx) | ✅ `edges={['top','left','right']}` | ❌ | n/a | ✅ (top edge declared) | ❌ Bug 4 | **The only file that includes top edge.** Worth aligning on. |
| Finance (Billing) | [(admin)/finance.tsx:378, 493, 2408, 2669](../packages/mobile/app/(admin)/finance.tsx) | ✅ default + edges variants | ❌ | n/a | ❌ Bug 2 (Modal at 2408) | ❌ | |
| Reports | [(admin)/reports.tsx:254, 448](../packages/mobile/app/(admin)/reports.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Customers | [(admin)/customers.tsx:458, 624](../packages/mobile/app/(admin)/customers.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Customer Detail | [(admin)/customer-detail.tsx:831, 878](../packages/mobile/app/(admin)/customer-detail.tsx) | ✅ (edges not visible in grep snippet) | ❌ | n/a | ⚠ | ⚠ | Read full file for edges before fix. |
| Customer Create | [(admin)/customer-create.tsx](../packages/mobile/app/(admin)/customer-create.tsx) | ✅ via CustomerForm | ❌ | n/a | ⚠ | ⚠ | Route, not Modal. |
| Collections | [(admin)/collections.tsx:540, 593](../packages/mobile/app/(admin)/collections.tsx) | ✅ (edges not visible in grep) | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Fleet | [(admin)/fleet.tsx:1217, 1230](../packages/mobile/app/(admin)/fleet.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Pending Actions | [(admin)/pending-actions.tsx:427, 554](../packages/mobile/app/(admin)/pending-actions.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| More (with 8 fullScreen Modals) | [(admin)/more.tsx:399, 554, 814, 970, 1158, 1410, 1675, 1931](../packages/mobile/app/(admin)/more.tsx) | ✅ (default + edges variants) | ❌ | n/a | ❌ Bug 2 ×8 | ❌ | Each fullScreen Modal wraps content in SAV with no provider inside → top overlap. |
| Profile (hidden) | [(admin)/profile.tsx](../packages/mobile/app/(admin)/profile.tsx) | ✅ via ProfileScreen | ❌ | n/a | ⚠ | ⚠ | |

### 2.6 (super-admin)

| Surface | File:line | SAV? | SAI? | HC padding? | Top edge | Bottom edge | Verdict |
|---|---|---|---|---|---|---|---|
| All 13 screens | every file at consistent line | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ⚠ Bug 4 | Uniform pattern — Dashboard 143, Orders 102, Customers 61, Distributors 38 (hidden), Fleet 176 (hidden), Inventory 145, Billing 69 (hidden), Users 199 (hidden), Settings 190 (hidden), Provider-catalog 68 (hidden), Health 83 (hidden), More 61. None use top edge; all rely on Tabs header. |
| Users modal | [(super-admin)/users.tsx:199](../packages/mobile/app/(super-admin)/users.tsx) | ✅ (KAV inside) | ❌ | n/a | possibly ❌ Bug 2 | ❌ | If modal is fullScreen, same Bug 2 family. Phase 1 row 8. |
| Distributors modal | [(super-admin)/distributors.tsx:222](../packages/mobile/app/(super-admin)/distributors.tsx) | ✅ | ❌ | n/a | possibly ❌ Bug 2 | ❌ | Phase 1 row 9. |

### 2.7 (finance)

| Surface | File:line | SAV? | SAI? | HC padding? | Top edge | Bottom edge | Verdict |
|---|---|---|---|---|---|---|---|
| Dashboard | [(finance)/dashboard.tsx:42, 177](../packages/mobile/app/(finance)/dashboard.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Invoices | [(finance)/invoices.tsx:105, 150, 203, 320](../packages/mobile/app/(finance)/invoices.tsx) | ✅ outer + Modal SAV (default edges at 203) | ❌ | n/a | ❌ Bug 2 (modal) | ❌ Bug 4 | |
| Payments | [(finance)/payments.tsx:69, 242](../packages/mobile/app/(finance)/payments.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | 2 nested form modals at 324, 561 with KAV; safe-area inside not confirmed. |
| Collections | [(finance)/collections.tsx:109, 119](../packages/mobile/app/(finance)/collections.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| More | [(finance)/more.tsx:52, 138](../packages/mobile/app/(finance)/more.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |

### 2.8 (inventory)

| Surface | File:line | SAV? | SAI? | HC padding? | Top edge | Bottom edge | Verdict |
|---|---|---|---|---|---|---|---|
| Analytics | [(inventory)/analytics.tsx:45, 167](../packages/mobile/app/(inventory)/analytics.tsx) | ✅ `edges={['left','right']}` | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Orders | [(inventory)/orders.tsx:137, 214](../packages/mobile/app/(inventory)/orders.tsx) | ✅ | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Inventory | [(inventory)/inventory.tsx:79, 118](../packages/mobile/app/(inventory)/inventory.tsx) | ✅ | ❌ | n/a | ⚠ | ❌ Bug 4 | Modal at 772 with KAV. |
| Fleet | [(inventory)/fleet.tsx:147, 224](../packages/mobile/app/(inventory)/fleet.tsx) | ✅ | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| More | [(inventory)/more.tsx:58, 143](../packages/mobile/app/(inventory)/more.tsx) | ✅ | ❌ | n/a | ⚠ | ❌ Bug 4 | |
| Actions (hidden) | [(inventory)/actions.tsx:36, 125](../packages/mobile/app/(inventory)/actions.tsx) | ✅ | ❌ | n/a | ⚠ | ⚠ | Modal at 190. |
| Summary (hidden) | [(inventory)/summary.tsx:64, 173](../packages/mobile/app/(inventory)/summary.tsx) | ✅ | ❌ | n/a | ⚠ | ⚠ | |
| Reconciliation (hidden) | [(inventory)/reconciliation.tsx:59, 215](../packages/mobile/app/(inventory)/reconciliation.tsx) | ✅ | ❌ | n/a | ⚠ | ⚠ | |
| Alerts (hidden) | [(inventory)/alerts.tsx:43, 183](../packages/mobile/app/(inventory)/alerts.tsx) | ✅ | ❌ | n/a | ⚠ | ⚠ | |
| Profile (hidden) | [(inventory)/profile.tsx](../packages/mobile/app/(inventory)/profile.tsx) | ✅ via ProfileScreen | ❌ | n/a | ⚠ | ⚠ | |

### Audit summary

- **62 `.tsx` files in `packages/mobile/`.** Of these, **49 wrap content in `<SafeAreaView>` from `react-native-safe-area-context`** at the top level. **2 use `useSafeAreaInsets()`** ([orders.tsx:1850](../packages/mobile/app/(admin)/orders.tsx) DispatchResultModal). **Zero files import `SafeAreaProvider`.**
- **Dominant pattern: `<SafeAreaView edges={['left', 'right']}>` — explicitly omits TOP and BOTTOM.** Used in 43 screens. The intent was "let Tabs handle top/bottom" — but Tabs doesn't actually handle bottom safely (Bug 4) and Modals lose top safe-area entirely (Bug 2).
- **Variant patterns:** `edges={['top','left','right']}` only in [(admin)/inventory.tsx:267](../packages/mobile/app/(admin)/inventory.tsx). Default `<SafeAreaView style={...}>` (no edges → all 4) used in 6 places, all of them fullScreen Modal contents — exactly the surfaces that suffer Bug 2.
- **Hardcoded paddings flagged as bandaids:** [orders.tsx:1915](../packages/mobile/app/(admin)/orders.tsx) `Math.max(20, insets.bottom + 12)` — floor too low. The `paddingBottom: Platform.OS === 'ios' ? 8 : 6` in ScrollableTabBar and the `paddingBottom: 8` in theme.ts:118 are also bandaids — they assume there's no system nav reservation worth respecting.

---

## 3. Existing pattern survey

- **`react-native-safe-area-context` version:** ~5.6.2 (verified in [packages/mobile/package.json](../packages/mobile/package.json)). v5 ships JSI-backed SafeAreaView that *can* function without an explicit `<SafeAreaProvider>` for screens mounted in the root window, but `useSafeAreaInsets()` returns zeros without one. Inside an iOS `<Modal>` (separate UIWindow) NEITHER `SafeAreaView` nor `useSafeAreaInsets` gets non-zero values without an inner provider.
- **`<SafeAreaProvider>` count in the codebase:** **0.** Foundational omission.
- **`<SafeAreaView>` from `react-native-safe-area-context` count:** ~49 files use it. The `react-native` core's `SafeAreaView` is NOT used anywhere (good — the library's is preferred).
- **`useSafeAreaInsets()` count:** 1 file ([(admin)/orders.tsx:1850](../packages/mobile/app/(admin)/orders.tsx)). It returns 0s today because no provider — so the `insets.bottom + 12` arithmetic effectively reduces to a constant 12, with a floor of 20.
- **Dominant edges convention:** `edges={['left', 'right']}` — appears in 43 screens. Indicates the team's mental model: *"Tabs and Modals supply their own top/bottom safe-area handling; the screen just guards horizontal notches."* This mental model is WRONG for Modals (Bug 2 family — Modals do not inherit safe-area) and FOR custom tab bars (Bug 4 — ScrollableTabBar and the Tabs styleconfig both override the default safe-area handling with hardcoded values).
- **Bandaids in code:**
  - `Math.max(20, insets.bottom + 12)` at [(admin)/orders.tsx:1915](../packages/mobile/app/(admin)/orders.tsx)
  - `paddingBottom: Platform.OS === 'ios' ? 8 : 6` at [ScrollableTabBar.tsx:104](../packages/mobile/src/components/ui/ScrollableTabBar.tsx)
  - `paddingBottom: 8` at [theme.ts:118](../packages/mobile/src/theme.ts)
  - `paddingBottom: Platform.OS === 'ios' ? 36 : 24` at [SelectField.tsx:109](../packages/mobile/src/components/ui/SelectField.tsx) — Phase 1 row 19; this is a different concern (form-field bottom buffer, not screen safe area) but consistent with the "iOS gets a bit more" convention.

The codebase has converged on a pattern that is *consistent and uniform* but *systematically wrong on iOS Modals and Android system-nav devices*. The fact that it has worked acceptably on Android up to now is partly luck (most Android test devices have hardware nav rather than gesture pill) and partly the `getTabBarConfig`'s `height: 64` being tall enough that 8dp padding+nav-cropping leaves *something* visible.

---

## 4. Pattern recommendation

### Option A — `<SafeAreaView edges={[...]}>` from `react-native-safe-area-context` as outer wrapper, plus mount `<SafeAreaProvider>` at root AND inside every fullScreen Modal

**Pros**
- Library already installed, dominant existing pattern (43 screens) — minimal mental-model change.
- `edges` configurable per surface — full-screen routes use `['top','bottom','left','right']`, Tabs-hosted screens use `['left','right']`, Modals use `['top','bottom','left','right']` (because Tabs won't be parent).
- Pure declarative — no per-screen imperative hook code unless a tab bar style needs the raw inset value.
- No new dependency.

**Cons**
- Needs a `<SafeAreaProvider>` mounted *inside every Modal's subtree* on iOS. That means every Modal grows a wrapper. The repo has ~17 fullScreen Modals + ~6 transparent bottom-sheet Modals — meaningful diff, ~30 lines.
- Per-edge bookkeeping is one more thing to forget on new screens.

### Option B — `useSafeAreaInsets()` hook with explicit `paddingTop: insets.top, paddingBottom: insets.bottom` on container styles

**Pros**
- Composes inside Modals fine *as long as the provider is mounted inside the Modal*.
- Single mental model: every screen reads insets and applies them itself.
- The Bug 4 fix needs `useSafeAreaInsets()` in `ScrollableTabBar.tsx` and in `getTabBarConfig` anyway — so adopting B globally aligns with what the tab-bar fix needs.

**Cons**
- More boilerplate per surface than SAV declarative form.
- Same Modal-provider requirement as Option A.

### Option C — Custom `<ScreenContainer>` wrapper

**Pros**
- Centralises the pattern, future screens stop re-declaring.
- Could also handle KOF (keyboard) uniformly.

**Cons**
- 49 existing surfaces need to migrate — big diff.
- Risk of over-abstracting; existing screens have minor variations (some use `edges={['top','left','right']}`, some have `flex: 1` on container, some embed ScrollView immediately).
- Doesn't fundamentally make the four bugs easier to fix than A or B — you still need provider + Modal wrappers.

### Smallest-diff scoring (focused on the 4 reported bugs)

| Option | Bug 1 fix | Bug 2 fix | Bug 3 fix | Bug 4 fix | New deps | Touched files | Lines changed |
|---|---|---|---|---|---|---|---|
| A | KAV style swap (no SAV needed in nested picker) | Add `<SafeAreaProvider>` at root + wrap each fullScreen Modal's content in nested `<SafeAreaProvider><SafeAreaView edges=['top','bottom','left','right']>` | Same — provider inside DispatchResultModal | Update `ScrollableTabBar.tsx` + `theme.ts` to use `useSafeAreaInsets()`; requires root provider | 0 | ~25 (provider mounts + Modal wrappers + tab bar) | ~150 |
| B | KAV style swap | Add root `<SafeAreaProvider>` + per-Modal provider + read `useSafeAreaInsets()` in each modal's outer View | Same | Same tab-bar update | 0 | ~25 | ~200 |
| C | KAV style swap (in nested picker) + new wrapper file | New `<ScreenContainer>` adopted across 49 screens | Same (DispatchResultModal needs custom variant) | Tab-bar still bespoke | 0 | ~50 | ~400+ |

### **Recommendation: Option A — `<SafeAreaView edges=[...]>` with explicit per-Modal `<SafeAreaProvider>` mounts.**

Rationale:
- **Smallest correct diff.** Option A keeps the existing 43-screen convention intact and surgically fixes the four broken surfaces by adding what's missing (root provider + per-Modal provider).
- **Mental-model continuity.** The team is already using `<SafeAreaView edges=[...]>`. The fix shifts it from "assume Tabs handles bottom" to "explicitly declare which edges each surface owns." That's a small clarification, not a refactor.
- **Future screens stay easy.** Recipe: `<SafeAreaView edges={['top','left','right']}>` for full-screen routes (top because of status bar; bottom comes from the tab bar's own padding once fixed). For fullScreen Modals: wrap in `<SafeAreaProvider><SafeAreaView edges={['top','bottom','left','right']}>` because the modal supplies its own top edge AND its own bottom edge (no Tabs underneath).
- **Bug 1 doesn't actually need SAA at all** — it's a KOF style-prop fix (`flex: 1, justifyContent: 'flex-end'` vs `width: '100%'`). Calling it out separately because bundling it into the SAA commit muddies the commit message; cleaner as a small KOF follow-up (see §5).
- **Honest interaction with KOF's `behavior="padding"`.** KAV `behavior="padding"` and a `SafeAreaView` ancestor compose correctly as long as the KAV is `flex: 1` (so it can grow into the padding region). The current Bug 1 implementation broke that composition by setting `width: '100%'` on KAV — fixing Bug 1's KAV style restores the composition AND benefits from any safe-area fixes downstream.

---

## 5. Implementation plan

### Surfaces to touch

| # | File | Change | Lines |
|---|---|---|---|
| 1 | [app/_layout.tsx](../packages/mobile/app/_layout.tsx) | Mount `<SafeAreaProvider>` around the `<Stack>` | +2 |
| 2 | [src/theme.ts](../packages/mobile/src/theme.ts) | Change `getTabBarConfig` to accept `insets: EdgeInsets` and return `paddingBottom: insets.bottom + 6, height: 64 + insets.bottom` | +5 |
| 3 | All 5 default-Tabs layouts: `(customer)`, `(driver)`, `(super-admin)`, `(finance)`, `(inventory)` | Call `useSafeAreaInsets()` and pass to `getTabBarConfig(dark, insets)` | +1 import + +1 line each = +10 |
| 4 | [src/components/ui/ScrollableTabBar.tsx](../packages/mobile/src/components/ui/ScrollableTabBar.tsx) | Add `useSafeAreaInsets()`, replace `paddingBottom: Platform.OS === 'ios' ? 8 : 6` with `paddingBottom: insets.bottom + 6`, change `height: 64` to `height: 64 + insets.bottom` | +3 |
| 5 | All 17 fullScreen `<Modal>` content wrappers (admin/orders ×5, admin/more ×8, admin/finance ×1, customer/orders ×4 nested form modals, customer/invoices ×1, customer/account ×1, finance/invoices ×1, super-admin/users ×1, super-admin/distributors ×1, finance/payments ×2, inventory/inventory ×1, inventory/actions ×1, etc.) | Wrap inner content in `<SafeAreaProvider>` immediately inside the Modal. Replace `<SafeAreaView style={...}>` with `<SafeAreaView edges={['top','bottom','left','right']} style={...}>` (explicit). | ~+2 per Modal = ~+34 |
| 6 | [(admin)/orders.tsx:1832-1924](../packages/mobile/app/(admin)/orders.tsx) DispatchResultModal | Wrap in `<SafeAreaProvider>` inside the Modal; change the inner `Math.max(20, insets.bottom + 12)` floor to `Math.max(34, insets.bottom + 12)` as defensive minimum (provider-mounted means insets.bottom should be real, but the floor handles legacy). | +2 |
| 7 | [(admin)/orders.tsx:1085-1153](../packages/mobile/app/(admin)/orders.tsx) Customer-picker KAV style | Bug 1 fix — change `style={{ width: '100%' }}` to `style={{ flex: 1, justifyContent: 'flex-end' }}` and remove `maxHeight: '80%'` from `pickerSheet` style (or change to `flex: 1`). Same change at [orders.tsx:2024-2086](../packages/mobile/app/(admin)/orders.tsx) Returns picker. | +0 (style swap); revisit `pickerSheet` style |

**Total file count to touch: ~25 files.** **Net line count: ~150-180.**

### Commit shape

**Two commits, one branch.**

- Commit 1 — `fix(mobile): mount SafeAreaProvider at root + per-Modal; fix bug 4 tab-bar safe-area on Android+iOS`.
  - Bundles items 1-6 above.
  - Single semantic change: "the safe-area pipeline is now properly mounted everywhere."
  - **Behavioral Android change** (Bug 4 fix). The summary line must call this out clearly and the implementation chunk must stop for Suneel's go-ahead before pushing.
- Commit 2 — `fix(mobile): bug 1 — restore intended KOF behavior on nested customer picker (KAV flex+justifyContent)`.
  - Just item 7.
  - This is the KOF-style follow-up. Separating it is honest: the KOF audit specified the correct style and the implementation diverged; the fix is to restore the intended style.

Note on bundling: if Suneel prefers atomic over surgical, all 7 can collapse into one commit. The two-commit form makes the Bug 4 Android-impact line cleaner to review in isolation.

### Effort estimate

- Provider mounts (items 1-3): **~30 min**.
- Tab-bar fix (item 4): **~20 min**.
- 17 Modal wrappers (item 5): **~1.5 hours** — repetitive grunt work; risk is missing one, hence the test plan.
- DispatchResultModal fix (item 6): **~15 min**.
- Bug 1 KAV fix (item 7): **~10 min**.
- Smoke test on Expo Go (iOS): **~30 min** (exercise each role, focus on the 4 reported bugs).
- Smoke test on Expo Go (Android, ensure Bug 4 fix lands and no regression): **~30 min**.
- Manual device pass on physical iPhone + physical Android phone with gesture nav: **~1 hour**.

**Total: ~5 hours end-to-end** including testing.

### Risk areas

- **Modals that nest other Modals** (the customer-picker pattern). Each `<Modal>` needs its OWN `<SafeAreaProvider>` mount because each is its own iOS UIWindow. Missing one leaves a partial fix.
- **ScrollableTabBar height change** — `height: 64 + insets.bottom` means the admin tab bar grows ~24-34dp on devices with system nav. This is the Bug 4 behavioral change. Could clip content if any screen positions content with absolute coords assuming a 64dp tab bar. Spot-check: no screens in the repo use absolute-positioning relative to tab-bar height.
- **`pickerSheet` `maxHeight: '80%'` removal** — if the FlatList becomes very long, the sheet now stretches full-height. Some users may prefer the cap. Honest tradeoff: 80% with the bug is worse than 100% with no bug. Recommend removing.
- **`getTabBarConfig` signature change** — current callers pass `(dark)`. Adding an `insets` parameter is a non-breaking additive change if `insets` is optional, but to actually apply Bug 4 fix every layout file needs to read `useSafeAreaInsets()` and pass it. Five layout edits; all line up.
- **Inside-modal-`useSafeAreaInsets`** — only one call exists today (DispatchResultModal). After the provider mount, the value becomes real. The `Math.max(20, ...)` floor was a defensive guard for the zero case; with real insets the floor of 20 is now too small on iPhone home-indicator devices (34dp). Bumping floor to 34 keeps the defensive behavior correct.

### KOF interaction — revisit `behavior="padding"` vs `"height"`?

**Recommend keeping `behavior="padding"`** for the three KOF-touched Modals (Bug 1 family). Reasoning:

- The Bug 1 layout problem is NOT `behavior="padding"` itself — it's the `width: '100%'` on the KAV (vs the recommended `flex: 1, justifyContent: 'flex-end'`).
- With `flex: 1, justifyContent: 'flex-end'`, `behavior="padding"` adds the bottom padding INSIDE the flex container, which pushes the sheet up correctly. The sheet's `maxHeight: '80%'` (relative to the KAV's available height = screen - keyboard) then naturally caps the sheet at 80% of the *visible* area, which is what you actually want.
- Switching to `behavior="height"` would resize the KAV itself when the keyboard appears — works on iOS but has a known issue where animated dismissal of the keyboard leaves the KAV in a stale-height state for one frame. `"padding"` doesn't have this.

So the KOF revisit is just the Bug 1 style swap — **NOT** a wholesale `behavior` change.

---

## 6. Cross-platform regression risk

### iOS

| Surface | Current | After fix | Risk |
|---|---|---|---|
| Root tree | No SafeAreaProvider; SafeAreaView relies on lib's native auto-provider | `<SafeAreaProvider>` mounted; SafeAreaView and useSafeAreaInsets fully functional | Low — additive |
| FullScreen Modals (17 surfaces) | Top edge overlaps status bar; bottom edge ignores home indicator | Top + bottom respected | Low — same SAV component, just gets real insets now |
| Customer picker (Bug 1) | Sheet floats with empty gap above keyboard | Sheet fills available space above keyboard | Low — fixes the regression |
| Dispatch results sheet | Close button on top of home indicator | Close button respects ~34dp clearance | Low |
| Default Tabs (customer/driver/super-admin/finance/inventory) | Tab bar 64dp tall, paddingBottom 8 | Tab bar `64 + insets.bottom` tall on iPhone home-indicator devices | **Medium** — visible behavioral change. Tabs grow ~34dp on iPhone Pro / Plus class. Visually correct; existing tests / screenshots may need refresh. |
| Admin ScrollableTabBar | Same hardcode issue | Same fix | Same medium |

### Android

| Surface | Current | After fix | Risk |
|---|---|---|---|
| Root tree | No provider | Provider mounted | Low — additive |
| FullScreen Modals | Work fine because `adjustResize` and stock SAV handles it on root window | Still works; provider just makes insets available | Low |
| Customer picker (Bug 1) | Works fine on Android — `behavior={undefined}` is a no-op and `adjustResize` does the lift | Unchanged; KAV `flex: 1` is identical to current on Android | Low |
| Dispatch results sheet | Works fine; `insets.bottom` is 0 on devices without gesture nav, ~24-48dp on gesture-nav devices — currently the floor of 20 covers most of the gesture-nav case | After fix, floor 34 is fine on gesture-nav, possibly slight extra space on no-system-nav devices | Low — at most a 14dp extra margin on niche devices |
| Default Tabs | Tab bar 64dp tall, paddingBottom 8 — labels hidden under system nav on gesture-nav phones | Tab bar `64 + insets.bottom` (gesture nav ≈ 24-48dp) — labels now visible above system nav | **High visible behavior change — POSITIVE.** Tab bar grows ~24-48dp on gesture-nav Android devices. On 3-button nav devices: smaller growth (~16-24dp typical). On Android <10 (no gesture nav): no change. |
| Admin ScrollableTabBar | Same issue | Same fix | Same |

### Bug 4 — Android impact callout

**This is the only behavioral Android-side change in the entire patch.** The implementation chunk MUST:

1. Surface the Android-impact line clearly in the commit body: *"Bug 4 fix: bottom tab bar on Android grows ~24-48dp (depending on system nav style) to clear the gesture pill / 3-button bar. Tab labels are now fully visible and tappable. iOS home-indicator devices also grow ~34dp."*
2. Stop for Suneel approval before pushing the commit per the strengthened protocol.
3. Capture a before/after screenshot pair on Android (gesture nav phone) and iOS (home-indicator iPhone) in the verification step.

Bugs 1, 2, 3 are iOS-only fixes — Android is unaffected by them.

---

## 7. Manual test plan

### Devices needed

- One iPhone with home indicator (any from iPhone X onward). Pro-class preferred for status-bar/notch testing.
- One Android phone with gesture-pill on-screen nav (typical Pixel / OnePlus / Samsung One UI 5+).
- One short-screen iPhone (SE 2nd gen or 13 mini) for keyboard cramping verification.
- Optionally: one older Android with 3-button nav for system-nav-style comparison.

### Per-platform per-bug test cases

#### Bug 1 — Customer picker gap on iPhone

1. Sign in as `bhargava@gasagency.com` / `Distadmin@123` on an iPhone.
2. Tab to Orders → Create FAB → tap "Select customer".
3. **Verify:** sheet slides up; keyboard appears; sheet's bottom edge sits **directly on the keyboard top with no gap**. At least 4 customer rows are tappable.
4. **Verify:** typing in the search filters the list; close (X) reachable.
5. Repeat on Returns Order modal.
6. Regression: Android — same flow should still work as before, no visible change.

#### Bug 2 — Modal top overlap on iPhone

For each of these 17 fullScreen Modals, open it and verify the top edge respects the iPhone status bar (time/WiFi/battery icons should be ABOVE the modal's first row):

1. Admin → Orders → Create Order
2. Admin → Orders → Create Invoice (the modal at 1698)
3. Admin → Orders → Returns Order
4. Admin → Orders → swipe an order → Edit
5. Admin → Orders → swipe an order → Assign Driver
6. Admin → More → various ×8 (cylinder types, distributor settings, etc.)
7. Admin → Billing → Create Invoice / CN / DN / etc.
8. Customer → Orders → New order modal
9. Customer → Account → Edit profile
10. Customer → Invoices → tap an invoice → details modal
11. Finance → Invoices → tap an invoice
12. Finance → Payments → Record payment
13. Super-admin → Users → Create user
14. Super-admin → Distributors → Create distributor
15. Inventory → Inventory → adjust stock
16. Inventory → Actions

(Yes, this is a lot — that's why the fix is centralized. Spot-check 4-5 of these per role; the fix is uniform.)

7. Regression: Android — same modals; should look identical to before.

#### Bug 3 — Dispatch results bottom cutoff on iPhone

1. As admin, get to a dispatchable order (with vehicle + driver + GST-enabled distributor).
2. Tap Dispatch → wait for IRN/EWB generation.
3. **Verify:** the Dispatch Results sheet appears; **Close button is fully tappable with clear space above the iOS home indicator** (~34dp minimum); list of order outcomes scrolls without the last row being clipped.
4. Regression: Android — same flow; should look identical.

#### Bug 4 — Android tab bar safe-area

1. Sign in on Android (gesture-nav phone) as any role.
2. **Verify:** bottom tab bar sits above the gesture pill with comfortable spacing. **Tap each tab label** — all tabs are reachable; nothing is hidden under the system nav.
3. Cycle through ALL 6 layouts: (customer), (driver), (admin), (super-admin), (finance), (inventory). Each must work.
4. iOS verification: on iPhone home-indicator device, verify tab bar sits cleanly above the home indicator. On older iPhone without home indicator, verify tab bar is unchanged.
5. **Before/after screenshot** for each platform — attach to the commit summary.

### Regression spot-checks on existing-working surfaces

KOF-style discipline — don't break what already works. Quick verify:

1. As admin, Create Invoice (billing/finance modal) — keyboard up on invoice number field; submit button reachable.
2. As super-admin, Users → Create user — same.
3. As driver, More → Profile → Edit profile name — same.
4. As customer, Account → Edit profile — same.
5. Login screen — KAV still lifts the password field correctly.

### Automated assertion (optional, low cost)

Add a render assertion:

```ts
// packages/mobile/__tests__/safe-area-coverage.test.tsx
import { render } from '@testing-library/react-native';
import RootLayout from '../app/_layout';
import { SafeAreaProvider } from 'react-native-safe-area-context';
test('root layout mounts SafeAreaProvider', () => {
  const tree = render(<RootLayout />);
  expect(tree.UNSAFE_getAllByType(SafeAreaProvider).length).toBeGreaterThanOrEqual(1);
});
```

Catches the most common future regression (someone removes the provider). Defer if test infra not already running for `packages/mobile/`.

---

## 8. Open questions for Suneel

1. **Two-commit split vs one commit?** §5 recommends splitting (Bug 4 / safe-area pipeline) from (Bug 1 / KOF style). One commit is atomic; two commits make the Bug 4 Android-impact line cleaner. Your call.
2. **Tab bar height growth on Android — is the ~24-48dp visible change acceptable?** Bug 4 is the bug; the fix size is what it is. But this is a meaningful visual change to every Android user. Suggest a side-by-side screenshot in the commit body so reviewers can see the magnitude.
3. **`pickerSheet maxHeight: '80%'` removal — keep cap or remove?** Bug 1 fix per §5 item 7 recommends removing it. If you'd rather keep the cap (so the sheet never extends to full screen on a very long customer list), the alternative is `maxHeight: '100%'` + `flex: 1` on KAV — same visual result for short lists, different for long lists.
4. **Should the 7 "list-with-search" screens flagged ⚠ in §2 of the KOF audit (customer dashboard, customer payments, admin customers, super-admin customers, super-admin provider-catalog, inventory orders, inventory fleet) also pick up explicit top safe-area edges in this same commit?** They're not in the 4 reported bugs but the `edges={['left','right']}` pattern hides Bug 2 from them too — top edge happens to be covered by the Tabs header. If you ever switch a screen from Tabs-hosted to standalone, the missing top edge becomes a Bug 2 in disguise. Cheap to defensively add `'top'` everywhere. Not strictly required by today's bug list.
5. **Snapshot/render test for SafeAreaProvider presence — add or defer?** §7 sketches one. Defer if `packages/mobile/__tests__/` isn't already wired for RN Testing Library.

---

*End of iOS Safe-Area Audit.*
