# iOS / Android UX Bug-Batch (UBB) Audit — packages/mobile

**Audit date:** 2026-06-08
**Branch:** main (HEAD `013d923`, post SAA C1 `4d0b35b` + SAA C2 `4c2cee2`)
**Pre-reading:** [docs/IOS-PHASE1-PARITY-MATRIX.md](IOS-PHASE1-PARITY-MATRIX.md), [docs/IOS-KOF-AUDIT.md](IOS-KOF-AUDIT.md), [docs/IOS-SAA-AUDIT.md](IOS-SAA-AUDIT.md), [CLAUDE.md](../CLAUDE.md) "Mobile Development Rules".
**Scope:** read-only investigation of 7 bugs surfaced during Suneel's iPhone + Android Expo Go pass. **No code changes.** ONE deliverable: this doc.
**Memory rules honoured:** `feedback-audit-style-props-verbatim` (every style prop value below is verbatim — copy exactly), `feedback-android-impact-protocol` (every fix has an Android impact prediction).

Legend: ✅ correct / ⚠ partial / ❌ broken / 🚩 needs Suneel device confirmation.

---

## 1. Bug-by-bug root causes

### Bug U1 — iPhone bottom tab bar over-padding (SAA C1 over-correction)

**Surfaces:**
- [packages/mobile/src/theme.ts:114-125](../packages/mobile/src/theme.ts) — `getTabBarConfig(dark, insets)` returns `tabBarStyle: { paddingTop: 6, paddingBottom: insets.bottom + 6, height: 64 + insets.bottom }`. Used by 5 layouts: (customer), (driver), (super-admin), (finance), (inventory).
- [packages/mobile/src/components/ui/ScrollableTabBar.tsx:98-110](../packages/mobile/src/components/ui/ScrollableTabBar.tsx) — admin layout's custom bar with identical math: `paddingTop: 6, paddingBottom: insets.bottom + 6, height: 64 + insets.bottom`.

**Concrete diagnosis.** SAA C1 added BOTH `+ 6` to `paddingBottom` AND grew `height` by `insets.bottom`. With iPhone home-indicator `insets.bottom ≈ 34`:

| Component | Before SAA C1 | After SAA C1 | Delta |
|---|---|---|---|
| Bar height | 64 | 98 | +34 |
| paddingTop | 6 (theme) / 8 (Scrollable) | 6 | -0/-2 |
| paddingBottom | 8 | 40 | +32 |
| Inner content area | ~50dp | ~52dp | +2 |
| Empty zone above home-indicator | 0 (overlapped indicator) | 40 (6 breath + 34 inset) | +40 |

So icons occupy the upper **58dp** of a **98dp** tall bar, and the lower **40dp is empty space** painted in `colors.bg` (solid white / dark). The icons hug the top.

**Is this a double-count?** Investigated against `@react-navigation/bottom-tabs`. Looking at [node_modules/@react-navigation/bottom-tabs/lib/module/views/BottomTabBar.js:249-254](../packages/mobile/../../node_modules/@react-navigation/bottom-tabs/lib/module/views/BottomTabBar.js):

```js
{
  height: tabBarHeight,
  paddingBottom: tabBarPosition === 'bottom' ? insets.bottom : 0,
  paddingTop: tabBarPosition === 'top' ? insets.top : 0,
  paddingHorizontal: Math.max(insets.left, insets.right)
}], tabBarStyle]  // tabBarStyle is spread LAST — overrides
```

User's `tabBarStyle` is spread **last** — it OVERRIDES the framework's `paddingBottom: insets.bottom` baseline. So there is **no double-count of the inset**. The framework would have added `insets.bottom` paddingBottom anyway; SAA's `insets.bottom + 6` replaces it (+ 6dp breath).

**However**: `getTabBarHeight` in the same file at lines 88-91 says "if user-supplied `tabBarStyle` has `height: <number>`, that's the FINAL height — no inset added." So `height: 64 + insets.bottom` works as intended (no double).

**So what's Suneel seeing?** It's a **visual perception issue, not a math bug.** Native iOS tab bars on UIKit are ~49dp tall with the home-indicator zone drawn UNDER a TRANSLUCENT bar (system blur). Our bar is `64dp + insets.bottom = 98dp` with a SOLID `colors.bg` background that paints over the home-indicator zone, with icons clustered at the top. The 40dp empty solid-color strip below the icons reads to the user as "a gap below the tab bar."

**Honest assessment: SAA C1 over-corrected in spirit, not in math.** The `+ 6` on paddingBottom + the full `insets.bottom` growth on height combine to produce a TALL bar with content top-anchored. Geometrically correct (icons clear of home-indicator); visually awkward (40dp solid colour band at bar's bottom).

**One-sentence fix sketch.** Drop the `+ 6` on `paddingBottom` — let the inset itself be the safe-area zone, and keep `paddingTop: 6` for header breath. New math: `paddingTop: 6, paddingBottom: insets.bottom, height: 64 + insets.bottom`. On iPhone: paddingBottom 34, inner 58dp, bar 98dp — icons sit slightly lower in their visible region, empty home-indicator zone is the natural 34dp safe-area. On Android no-inset: paddingBottom 0, height 64 — slight regression on Android-with-physical-nav phones (was 6, now 0). **Mitigation: pick `paddingBottom: Math.max(6, insets.bottom)`** to keep 6dp floor when there's no system nav.

**Severity:** medium (cosmetic; not blocking).
**Blast radius:** 2 files, 4 lines of code changed (theme.ts:123-124, ScrollableTabBar.tsx:108-109).
**Android impact:** behavioral (cosmetic). On 3-button-nav and gesture phones where `insets.bottom > 6`, no visible change (the `+ 6` was already swamped by the inset). On Android with NO system nav (rare; some custom skins, Android 9-), bar shrinks from 70dp (`64 + 6` padding) to 64dp — 6dp loss. **Mitigated** by the `Math.max(6, insets.bottom)` floor recommendation.
**Mechanical or structural:** mechanical (one line each in 2 files).

🚩 **Needs Suneel device confirmation**: is the "gap below the tab bar" actually the 40dp inner-padding empty zone (Hypothesis A), or is there a DIFFERENT gap below the bar's outer edge (Hypothesis B/C — not found in code)? If a screenshot shows a solid-colour strip between icons and the home indicator, fix as proposed. If the screenshot shows empty space BELOW the bar's outer bottom edge, the bug is elsewhere and this audit is wrong on U1.

---

### Bug U2 — Dispatch Results modal red bar at the bottom

**File:** [packages/mobile/app/(admin)/orders.tsx:1838-1930](../packages/mobile/app/(admin)/orders.tsx) — `DispatchResultModal`. Pre-existing, NOT a SAA C1 regression.

**Concrete diagnosis.** Carefully traced every red element in the modal:

| Red element | File:line | Use |
|---|---|---|
| `ACCENT = '#dc2626'` | [orders.tsx:153](../packages/mobile/app/(admin)/orders.tsx) | Module-level red accent |
| `styles.primaryBtn { backgroundColor: ACCENT, flex: 1, paddingVertical: 14, borderRadius: 12 }` | [orders.tsx:2899-2906](../packages/mobile/app/(admin)/orders.tsx) | Close button |
| `<TouchableOpacity style={styles.primaryBtn} onPress={onClose}>` | [orders.tsx:1921-1923](../packages/mobile/app/(admin)/orders.tsx) | The Close button INSIDE the modal |
| `borderColor: r.success ? '#22c55e' : '#ef4444'` | [orders.tsx:1885](../packages/mobile/app/(admin)/orders.tsx) | Result row left border on FAILED rows |
| `color={r.success ? '...' : '#ef4444'}` | [orders.tsx:1893](../packages/mobile/app/(admin)/orders.tsx) | Failed result-row checkmark icon |
| `color: '#ef4444'` | [orders.tsx:1910](../packages/mobile/app/(admin)/orders.tsx) | Failed result-row error message text |

**The "red bar" is the full-width Close button at the bottom of the modal.** Layout chain:

```
<Modal transparent>
  <SafeAreaProvider>
    <View pickerOverlay backgroundColor={overlay} flex:1, justifyContent:flex-end>
      <View bottomSheet backgroundColor={modalBg}, maxHeight:'85%'>
        <View bottomSheetHandle />
        <View modalHeader>
          <Text>Dispatch Results</Text>
          <Ionicons name="close" />        // ← FIRST close affordance (X icon)
        </View>
        <ScrollView>{result rows}</ScrollView>
        <View paddingHorizontal:16, paddingBottom: Math.max(34, insets.bottom+12)>
          <TouchableOpacity style={primaryBtn /* RED, flex:1 */}>
            <Text>Close</Text>                // ← SECOND close affordance (red bar)
          </TouchableOpacity>
        </View>
      </View>
    </View>
  </SafeAreaProvider>
</Modal>
```

The modal has **TWO close affordances**:
1. The X icon at the top right of the header (line 1870-1872) — small, standard
2. A full-width red Close button at the bottom (lines 1920-1924) with `styles.primaryBtn { backgroundColor: '#dc2626', flex: 1, paddingVertical: 14 }`

Suneel's "red bar at the bottom" IS the redundant red Close button. `flex: 1` stretches it to full container width (minus the `paddingHorizontal: 16` on the wrapper), `paddingVertical: 14` makes it ~50dp tall. Looks like a red strip because the text "Close" is the only content.

**One-sentence fix sketch.** Either (a) remove the bottom Close button entirely — the header X is sufficient and standard; (b) restyle it as a secondary action (outlined, not solid red) since it's a redundant close, not a primary destructive action.

**Severity:** medium (cosmetic / UX confusion; not blocking).
**Blast radius:** 1 file, 5-7 lines removed OR style swap.
**Android impact:** none (cosmetic, identical render on both platforms).
**Mechanical or structural:** mechanical (delete a `<TouchableOpacity>` block).

**Recommendation:** delete the bottom Close button. The header X is sufficient and matches every other modal in the app.

---

### Bug U3 — Android Fleet "Mark Returned" / "DISPATCHED" pills disconnected from vehicle row, vehicle number not visible

**File:** [packages/mobile/app/(admin)/fleet.tsx:782-857](../packages/mobile/app/(admin)/fleet.tsx) — the vehicles `FlatList` `renderItem`.

**Concrete diagnosis.** The row layout:

```tsx
<View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
               paddingVertical: 14, gap: 12 }}>
  <View 40×40 icon-circle />                                   // ~40dp
  <View flex:1>                                                // claims remaining
    <Text fontSize:15 fontWeight:600>{item.vehicleNumber}</Text>     // NO numberOfLines
    <Text fontSize:12 textMuted>{item.vehicleType}{capacity}</Text>
  </View>
  <StatusBadge label={item.status} ... />                      // pill, auto-width
  {item.status === 'dispatched' && (                           // CONDITIONAL
    <TouchableOpacity marginLeft:6 paddingHorizontal:10 paddingVertical:6 ...>
      <Text fontSize:11 fontWeight:700>Mark Returned</Text>
    </TouchableOpacity>
  )}
  <TouchableOpacity marginLeft:8 padding:4>
    <Ionicons name="create-outline" />                         // ~28dp
  </TouchableOpacity>
</View>
```

When `item.status === 'dispatched'`, the right cluster contains:
- StatusBadge "DISPATCHED" — `paddingHorizontal: 8, paddingVertical: 3`, label `fontSize: 11, textTransform: 'uppercase'` → ~85-90dp wide
- gap 12dp
- Mark Returned button — `paddingHorizontal: 10`, label "Mark Returned" `fontSize: 11 fontWeight: 700` → ~100-110dp wide
- marginLeft 8dp
- Edit icon button — `padding: 4` around 20dp icon → ~28dp

Right-cluster total: ~90 + 12 + 110 + 8 + 28 = **~248dp** (plus the 6dp `marginLeft` on Mark Returned).

On a typical 360dp Android screen:
- `paddingHorizontal: 16 × 2 = 32` → inner 328dp
- 40 (icon-circle) + 12 (gap) + 248 (right cluster) = **300dp**
- Remaining for vehicle-number text: 328 - 300 = **28dp**

A 28dp-wide text container forces the vehicle-number string ("KA01-AB-1234" — ~110dp at 15pt) to wrap aggressively. Since there's NO `numberOfLines={1}` on the `<Text>`, RN wraps to 2, 3, or 4 lines depending on text length. The vehicle-number renders as a vertical stack of 2-3 character chunks.

Compounding: `alignItems: 'center'` on the row vertically centres the right cluster with the now-3-line text. The DISPATCHED pill + Mark Returned button + Edit icon end up sitting at the **vertical midpoint of the tall text stack**, looking "floating" or "disconnected" from any specific text line.

The vehicle-type sub-text on line 2 (`fontSize: 12`) ALSO has no `numberOfLines`, so it may also wrap. Net effect: a 4-line text column with a centered right cluster that looks orphaned.

"Vehicle number not visible" — because the wrapped chunks look like noise. The user can't parse which line is the vehicle number.

**One-sentence fix sketch.** Two changes: (a) add `numberOfLines={1}` and `ellipsizeMode="tail"` to both `<Text>` elements in the text block — vehicle number truncates with `...` instead of wrapping; (b) reduce the right cluster width by removing redundant elements: the StatusBadge "DISPATCHED" is implied by the presence of the Mark Returned button (only dispatched vehicles get it). Drop the StatusBadge when `status === 'dispatched'` AND Mark Returned is rendered, OR drop the Mark Returned button entirely and rely on row-tap to surface actions.

**Severity:** **high** (vehicle number is the primary content; if it's wrapped illegibly, the screen is broken on Android).
**Blast radius:** 1 file, ~5 lines changed.
**Android impact:** behavioral (positive — fixes the bug). iOS impact: depends on screen width. iPhone Pro (430dp) has more room; the row may not currently wrap on iPhone — but `numberOfLines={1}` defensively prevents it.
**Mechanical or structural:** mechanical.

---

### Bug U4 — Vehicle registration number wrapping awkwardly when paired with status pills + Mark Returned button

**File:** Same as U3 — [packages/mobile/app/(admin)/fleet.tsx:782-857](../packages/mobile/app/(admin)/fleet.tsx).

**This is the same bug as U3.** U3 describes the visual symptom (pills disconnected, number not visible); U4 describes the cause (wrap). Treat as a single fix.

**Concrete diagnosis.** See U3 — `<Text>` elements lack `numberOfLines={1}`; flex:1 column gets squeezed to ~28dp when right cluster is full.

**One-sentence fix sketch.** Same as U3.

**Severity:** **high** (same finding).
**Blast radius:** same (1 file, ~5 lines, deduped with U3).
**Android impact:** same as U3.
**Mechanical or structural:** mechanical.

**Group with U3 — one fix covers both.**

---

### Bug U5 — FAB (red + button) overlapping content on multiple screens

**Surfaces — FAB is duplicated, NOT a shared component:**

| File | FAB definition | Style |
|---|---|---|
| [packages/mobile/app/(admin)/fleet.tsx:86-111](../packages/mobile/app/(admin)/fleet.tsx) | `function FAB({onPress})` | `position:'absolute', bottom:24, right:24, width:56, height:56, borderRadius:28, backgroundColor:ACCENT` |
| [packages/mobile/app/(admin)/customers.tsx:105](../packages/mobile/app/(admin)/customers.tsx) | `function FAB({onPress})` | (assumed similar; not re-read) |
| [packages/mobile/app/(admin)/more.tsx:304](../packages/mobile/app/(admin)/more.tsx) | `function FAB({onPress})` | (assumed similar) |
| [packages/mobile/app/(admin)/orders.tsx:2662-2677](../packages/mobile/app/(admin)/orders.tsx) | `styles.fab` (inline) | `position:'absolute', bottom:24, right:20, width:56, height:56, borderRadius:28, backgroundColor:ACCENT` |

**Concrete diagnosis — iPhone Orders FAB overlapping bottom card.**

- `styles.listContent { padding: 16, paddingBottom: 100 }` ([orders.tsx:2519-2522](../packages/mobile/app/(admin)/orders.tsx)) — 100dp clearance at end of scroll content.
- FAB at `bottom: 24, height: 56` — occupies `bottom: 24` to `bottom: 80` of its parent (the screen content area above the tab bar).
- When the user is at the end of the scroll, the LAST card's bottom is `100 - paddingBottom(visible) = ...` Actually the 100dp paddingBottom is BELOW the last card, so the last card's bottom sits 100dp above the scroll container's bottom. The FAB top sits 80dp above the same bottom. → 20dp clearance between last card bottom and FAB top. **OK at end-of-scroll.**

- BUT: when the user is NOT at end-of-scroll (just scrolling through), the "card near the bottom of the visible viewport" IS partially covered by the FAB. This is **inherent to absolute-positioned FABs** without OS-level scroll-edge inset and is the standard tradeoff. Adding more paddingBottom doesn't help because mid-scroll cards are always going to be near the FAB.

So Suneel's iPhone Orders complaint is partly **expected FAB-overlap behavior** and partly **the 20dp end-of-scroll clearance is too tight** — visually the last card almost touches the FAB.

**Concrete diagnosis — Android Fleet FAB overlapping Mark Returned button.**

- [packages/mobile/app/(admin)/fleet.tsx:783-867](../packages/mobile/app/(admin)/fleet.tsx) — vehicles `FlatList` then `<FAB />` rendered as a SIBLING inside the `<View style={{ flex: 1 }}>` parent. No `contentContainerStyle` with paddingBottom on the FlatList (confirmed: grep returned no `paddingBottom:` in fleet.tsx renderItem context).
- FAB at `position:'absolute', bottom:24, right:24, width:56, height:56`.
- The rightmost item on a vehicle row at the bottom of the viewport IS the Edit icon button (at the row's right edge), and to its left is the Mark Returned button (when dispatched). With NO bottom padding on the list, the FAB's 56-wide circle at right:24 overlaps the rightmost ~80dp of the visible viewport's bottom band — directly on top of the Edit icon and Mark Returned button.

**One-sentence fix sketch.** Two-part:
- Add `contentContainerStyle={{ paddingBottom: 96 }}` to the fleet.tsx vehicles FlatList (and drivers, and any other FlatList that has a FAB sibling). 96 = FAB bottom + height + clearance = 24 + 56 + 16. This pushes the last row above the FAB at end-of-scroll.
- Optionally bump orders.tsx `listContent.paddingBottom` from 100 → 120 for more end-of-scroll clearance.
- Long-term: factor a shared `<FAB />` component into [packages/mobile/src/components/ui/](../packages/mobile/src/components/ui/) and add a `useScreenPadding()` helper that returns the FAB-clearance value, so screens don't hardcode 96/100/120.

**Severity:** **high** on Android Fleet (Mark Returned literally unreachable when row is at bottom of viewport — that's U5's intersection with U3). Medium on iPhone Orders (cosmetic clipping; user can scroll to dodge).
**Blast radius:** 4 files (fleet.tsx, customers.tsx, more.tsx, orders.tsx), 4 lines (one paddingBottom per FlatList). Optional refactor: +1 new file (`src/components/ui/FAB.tsx`) ~25 lines.
**Android impact:** behavioral (positive — clears the Mark Returned button). iPhone impact: cosmetic (more end-of-scroll breathing room).
**Mechanical or structural:** mechanical fix (add paddingBottom). Structural fix (shared FAB) is optional.

---

### Bug U6 — iPhone tab bar horizontal truncation (admin's 9-tab scroll bar)

**File:** [packages/mobile/src/components/ui/ScrollableTabBar.tsx:112-119](../packages/mobile/src/components/ui/ScrollableTabBar.tsx).

**Concrete diagnosis.**

```tsx
<ScrollView
  horizontal
  showsHorizontalScrollIndicator={false}   // ← scrollbar hidden
  contentContainerStyle={{
    alignItems: 'stretch',
    paddingHorizontal: 4,
  }}
>
```

Each tab has `minWidth: 76, paddingHorizontal: 10` ([line 173-174](../packages/mobile/src/components/ui/ScrollableTabBar.tsx)) → ~96dp wide. Nine visible tabs × 96 = **864dp** of content in a horizontal ScrollView on a 390dp iPhone screen. **The bar IS scrollable** — that part works. But:

1. **No scrollbar indicator** (`showsHorizontalScrollIndicator={false}`).
2. **No edge gradient / fade** to hint at off-screen content.
3. **No arrow icon** at either edge.
4. **No initial scroll-into-focused-tab behavior** — when a non-leftmost tab becomes focused (e.g., "Fleet" or "Collections"), the bar doesn't auto-scroll to centre the focused tab. The user has to discover horizontal scroll by accident.

Suneel sees the last visible tab cut off at the screen's right edge with no visual cue.

**One-sentence fix sketch.** Two minimal changes:
- Set `showsHorizontalScrollIndicator={true}` so iOS shows the standard horizontal scrollbar on touch (auto-hides shortly after).
- Add an `onLayout` + `scrollToFocused` `useEffect` that scrolls the focused tab into view when the state index changes — uses a `ScrollView` ref.
- Optional: add a right-edge fade/gradient overlay (`LinearGradient` from `expo-linear-gradient`) as an affordance.

**Severity:** **medium** (discoverability issue; bar IS functional, just not obvious).
**Blast radius:** 1 file, ~10-15 lines (ref + useEffect + indicator toggle).
**Android impact:** behavioral (positive — same scroll affordance arrives on Android too). The Android tab bar is the same component, identical 9-tab visible cluster. Confirmed neutral-or-positive on Android.
**Mechanical or structural:** mechanical (one flag flip + one effect).

---

### Bug U7 — Android 3-button-nav tab bar verification

**Files:** Same surfaces as U1 (theme.ts:114-125, ScrollableTabBar.tsx:98-110).

**Concrete diagnosis — code-level reasoning.**

Expo SDK 54 (the installed version per [packages/mobile/package.json](../packages/mobile/package.json) — confirmed earlier) **enables Android edge-to-edge by default**. This means the app window includes the area under the system nav bar, and `useSafeAreaInsets().bottom` returns the actual system-nav height:
- **3-button nav (Suneel's test device):** typically 48dp.
- **Gesture pill:** 16-24dp.
- **No nav (some custom skins / older Android):** 0dp.

The SAA C1 doc said "Android phones with hardware nav (insets.bottom === 0) see a 2 dp reduction." That statement assumes pre-edge-to-edge or hardware physical buttons. With edge-to-edge on Android, the original `paddingBottom: 8` was sufficient because the app DID NOT extend under the nav (system nav was OS chrome). But with edge-to-edge ON, the app DOES extend under the nav, so `insets.bottom > 0` and SAA C1's `paddingBottom: insets.bottom + 6 = 54dp` (3-button) IS WHAT'S NEEDED for tab labels to clear the nav.

**On Suneel's 3-button-nav Android device, what should the tab bar look like?**
- Height: `64 + 48 = 112dp`
- paddingTop: 6, paddingBottom: 54
- Inner content: 52dp (icons + labels)
- Below icons: 54dp empty zone, painted in `colors.bg` (solid white/dark), covers system nav area

**Will the system nav be visible THROUGH the tab bar?** With edge-to-edge, the system nav is rendered by Android OS on top of the app window. The tab bar's solid `colors.bg` background fills the area underneath the nav. **The 3-button nav appears as black/icons against a white/dark backdrop (whatever `colors.bg` is).** That's visually fine — the nav buttons are still tappable (OS handles them), and the tab labels are above them.

**But there's a subtle interaction:** the bar's INNER icon zone is 52dp at the top. So if the user can SEE the system nav with their finger, they instinctively know the bar's tappable zone is above the OS nav. The 54dp solid-colour empty band BETWEEN icons and nav IS visible but interpretable.

**Same hypothesis A from U1 applies:** to Suneel this 54dp empty band might LOOK like "the tab bar is too tall." But it's not a regression on Android — it's the SAA C1 fix doing what it was supposed to (clear the system nav). Pre-SAA, on edge-to-edge Android, labels would have been HIDDEN UNDER the system nav (`paddingBottom: 8` meant tap targets bottom-edge was at `bar_top + 56dp`, and if nav reservation was 48dp, the bottom 48dp of the bar overlapped with nav touch area).

**Code-only verdict:** SAA C1 is **correct on Android 3-button-nav**. The bar grows to clear the nav. Labels are visible and tappable.

🚩 **Needs Suneel device confirmation:**
1. Is the tab bar VISUALLY too tall on Suneel's 3-button-nav Android phone? (If yes — same fix as U1.)
2. Are labels tappable above the 3-button row? (Should be — SAA fix grew the bar specifically to ensure this.)
3. Are labels CLIPPED by the 3-button row? (Should NOT be after SAA — if they are, edge-to-edge isn't behaving as documented.)

**Severity:** unknown without device confirmation. Code-level: low (likely a no-op verification).
**Blast radius:** if U1's fix lands, U7 is auto-fixed (same files).
**Android impact:** behavioral (cosmetic — same direction as U1).
**Mechanical or structural:** N/A (verification only).

**Recommendation: verify Suneel's 3-button-nav Android phone AFTER U1's fix lands. If U1 is fixed properly, U7 verifies clean.**

---

## 2. Grouping — which bugs share fix patterns

| Group | Bugs | Files touched | Shared root cause |
|---|---|---|---|
| **A — Tab-bar safe-area arithmetic** | U1, U7 | theme.ts (1 file), ScrollableTabBar.tsx (1 file) | SAA C1's `paddingBottom: insets.bottom + 6` + `height: 64 + insets.bottom` over-corrected on tall-inset devices. Fix: drop the `+ 6` from paddingBottom (or use `Math.max(6, insets.bottom)`). Both U1 and U7 are the same code path. |
| **B — Fleet vehicle-row layout** | U3, U4 | fleet.tsx (1 file) | Vehicle-row `<Text>` lacks `numberOfLines={1}`; right cluster squeezes the flex:1 text column on dispatched rows. Fix: add `numberOfLines={1}` + optionally drop redundant DISPATCHED StatusBadge when Mark Returned is rendered. |
| **C — FAB overlap** | U5 (multiple sub-surfaces) | fleet.tsx, orders.tsx, customers.tsx, more.tsx (4 files) | FAB at `position:absolute bottom:24` is duplicated across files, and several FlatLists lack `paddingBottom` to clear FAB. Fix: add `paddingBottom: 96` to each FAB-bearing FlatList. |
| **D — Dispatch Results redundant Close button** | U2 | orders.tsx (1 file) | Bottom red Close button is redundant with header X. Fix: delete it. |
| **E — Tab bar horizontal-scroll affordance** | U6 | ScrollableTabBar.tsx (1 file) | `showsHorizontalScrollIndicator={false}` hides the scroll cue. Fix: flip to `true`; add `scrollToFocused` effect. |

**Overlap notes:**
- Group A (U1+U7) and Group E (U6) both touch `ScrollableTabBar.tsx` — could share a commit.
- Group B (U3+U4) and Group C (U5 — Fleet sub-surface) both touch `fleet.tsx` — could share a commit OR explicitly separate so the Android-positive impact line in C is isolated.

---

## 3. Recommended commit shape

**Three commits, in order:**

### Commit 1 — `fix(mobile): tab-bar safe-area + horizontal-scroll affordance (UBB C1)`
**Bundles groups A + E (U1, U6, U7).**
**Files:** `src/theme.ts`, `src/components/ui/ScrollableTabBar.tsx` (2 files).
**Lines:** ~12-15.
**Android impact:** behavioral (cosmetic). Tab bar on Android `insets.bottom > 0` devices: paddingBottom shrinks from `insets.bottom + 6` to `Math.max(6, insets.bottom)`. On 3-button nav (48dp): from 54dp → 48dp — 6dp reduction, visually invisible. On gesture nav (24dp): from 30dp → 24dp — 6dp reduction. On hardware-nav (0dp): unchanged 6dp. **iPhone:** same logic; paddingBottom 40 → 34. ScrollView indicator: appears on touch (auto-hides) on both platforms.
**Verification:** on-device iPhone screenshot of tab bar; on-device 3-button-nav Android screenshot. Verify U7 simultaneously.
**Rationale for bundling A + E:** same file (ScrollableTabBar.tsx) plus theme.ts. Atomic for "tab-bar UX polish."

### Commit 2 — `fix(mobile): Fleet vehicle-row layout + FAB clearance (UBB C2)`
**Bundles groups B + C (U3, U4, U5 across all surfaces).**
**Files:** `app/(admin)/fleet.tsx`, `app/(admin)/orders.tsx`, `app/(admin)/customers.tsx`, `app/(admin)/more.tsx` (4 files).
**Lines:** ~15-20.
**Android impact:** behavioral (positive — fixes U3/U4 vehicle-number visibility and U5 Mark Returned reachability on Fleet). iPhone impact: cosmetic (more end-of-scroll clearance; ellipsized vehicle numbers if they would have wrapped).
**Verification:** before/after Android screenshot of dispatched vehicle row; iPhone screenshot of last order card.
**Rationale for bundling B + C:** the dispatched-vehicle-row bug and the FAB-covers-Mark-Returned bug are user-perceived as the SAME bug ("I can't see / can't tap on the Fleet screen"). Splitting them creates an artificial commit boundary that doesn't match the user's mental model.

### Commit 3 — `fix(mobile): remove redundant Close button in Dispatch Results modal (UBB C3)`
**Bundles group D (U2).**
**Files:** `app/(admin)/orders.tsx` (1 file).
**Lines:** ~5 (delete a TouchableOpacity block + its wrapper View if empty).
**Android impact:** none (cosmetic, identical on both platforms).
**Verification:** open dispatch flow, screenshot modal — verify only header X remains.
**Rationale for separation:** D is purely cosmetic and on a different screen than C2's work. Keeping it standalone lets reviewers spot-check the diff is just a deletion.

**Total: 3 commits, 6 unique files (with overlap: orders.tsx appears in C2 AND C3 — could trigger a rebase, mitigate by sequencing C2 → C3 with `git rebase --continue` strategy or merge into one commit if conflict risk is high).**

---

## 4. Per-commit Android impact prediction (per `feedback-android-impact-protocol`)

| Commit | Bug coverage | Android impact (cosmetic / behavioral / none) | Magnitude | Direction |
|---|---|---|---|---|
| C1 (tab bar) | U1, U6, U7 | **Cosmetic** | ~6dp paddingBottom reduction on insets-bearing Android phones; scrollbar appears briefly on touch | Neutral (paddingBottom unchanged on visible-icon position; scrollbar is a discovery cue) |
| C2 (Fleet + FAB) | U3, U4, U5 | **Behavioral (positive)** | Vehicle rows render single-line ellipsized number; Fleet FlatList grows 96dp at bottom so FAB no longer overlaps Mark Returned | Positive — fixes blocker on Fleet |
| C3 (red close button) | U2 | **None** | No behavior change; pure cosmetic on a modal that renders identically on both platforms | N/A |

**Per the strengthened protocol, C2's Android-positive impact MUST be called out in the commit body with magnitude + before/after screenshot.** C1's cosmetic change is also worth a callout (the 6dp shift is visually invisible but a real number change).

---

## 5. Cross-platform regression risk

### iPhone (potential regressions from each commit)

| Commit | iPhone risk |
|---|---|
| C1 | **Low.** Tab bar paddingBottom drops from `insets.bottom + 6` to `Math.max(6, insets.bottom)`. On iPhone home-indicator (34): 40 → 34 — 6dp tighter against home indicator. Still respects safe-area floor. Icons drop ~3dp visually (toward centre of the bar's visible region). Visually correct, matches Apple HIG. ScrollView indicator: appears on touch — standard iOS pattern. |
| C2 | **Low.** `numberOfLines={1}` on Fleet vehicle row: if the iPhone wasn't wrapping the vehicle number (wider screen than Android, likely no wrap), the change is invisible. If it WAS wrapping, now it ellipsizes — slight info loss but matches typical mobile list patterns. FlatList paddingBottom increase: gives more end-of-scroll clearance, no negative effect. |
| C3 | **None.** Pure deletion of redundant Close button. The header X remains. |

### Android (potential regressions from each commit)

| Commit | Android risk |
|---|---|
| C1 | **Low-to-medium.** Tab bar paddingBottom on no-system-nav phones (rare, custom skins) was 6dp pre-SAA, became 6dp after SAA (`0 + 6`), becomes `Math.max(6, 0) = 6dp` after C1 — unchanged. On 3-button nav (48dp): 54 → 48 — slightly tighter against nav buttons. Still respects safe-area. On gesture pill (24dp): 30 → 24 — same. **Verify on Suneel's 3-button-nav device that tap targets above the nav row are still comfortable.** |
| C2 | **Low.** `numberOfLines={1}` fixes the bug. FlatList paddingBottom adds clearance — no negative effect on Android. |
| C3 | **None.** Same as iPhone. |

### Risk summary

- C3 is risk-free (pure UX simplification).
- C2 is the **largest positive** change (fixes Android Fleet blocker) and **lowest risk** of regression (additive padding + ellipsize).
- C1 is the **trickiest** because it modifies SAA C1's recent math. The `+ 6` removal might cause Suneel to perceive a "different" tab bar on iPhone (in fact, the icon region SHIFTS DOWN by 3dp toward visual centre — should look BETTER). Honest disclosure: this audit recommends reversing part of SAA C1 within 24 hours of it landing. That's not a "regression" in the bug sense; it's iterative polish on an unanticipated visual perception.

---

## 6. Open questions for Suneel

1. **U1 hypothesis confirmation.** Can you share a screenshot (or close describe) what "gap below the tab bar" looks like on iPhone? The audit's hypothesis is: the 40dp empty band BETWEEN icons and the home indicator (inside the tab bar's solid `colors.bg` fill) is what reads as a "gap." If instead the gap is OUTSIDE the bar (between bar's bottom edge and the screen's bottom edge), the bug is elsewhere and the audit's U1 root-cause is wrong. **Cheap to resolve: one screenshot, two minutes.**

2. **U2 — keep or remove the bottom Close button?** Audit recommends remove. If you have a reason to keep it (e.g., accessibility — bottom-of-screen for thumb reach), restyle as secondary outlined instead. Your call.

3. **U3/U4 — keep the DISPATCHED StatusBadge when Mark Returned is shown?** They're somewhat redundant (presence of Mark Returned button implies vehicle is dispatched). Removing the badge gives the vehicle-number text another ~90dp of breathing room. Or keep both for explicitness.

4. **U6 — also add a right-edge fade gradient as a scroll affordance?** Audit recommends just `showsHorizontalScrollIndicator={true}` + `scrollToFocused`. A gradient is nicer UX but adds `expo-linear-gradient` import and ~15 more lines. Punt to v1.1 polish?

5. **U7 — is your test Android device showing tab bar correctly post-SAA?** If yes, no fix needed for U7 beyond C1's general tightening. If you see clipped labels or unreachable tabs, that's a different (worse) bug and we need to investigate edge-to-edge state, the `expo-system-ui` v1.1 backlog item, and `android.edgeToEdgeEnabled` in app.json.

6. **C1's reduction of SAA C1's `+ 6`.** This is honest re-correction within 24 hours of SAA C1 landing. Do you want to instead **augment** SAA C1 with a different mechanism (e.g., justify-content shift on the icon row) to preserve the SAA C1 math intact and just centre the icons visually? Audit recommends the cleaner approach (drop the `+ 6`) but the alternative is reasonable if you want to minimize SAA C1's regression-surface.

7. **Shared FAB component as a follow-up?** Currently 4 copies of `function FAB(...)`. Not in scope for these fixes — just flagging. Could be a v1.1 cleanup.

---

## 7. Implementation order — gating dependencies

**Recommended order: C1 → C2 → C3.**

| Step | Commit | Reason for sequencing |
|---|---|---|
| 1 | **C1 (tab bar)** | Must land BEFORE U7 verification, because U7 IS verifying C1's effect on 3-button-nav Android. If C1 changes the tab bar math, U7's test runs against the new math. Bonus: C1 is the highest-uncertainty commit (depends on U1 hypothesis confirmation) — landing it first lets Suneel verify and approve / reject before deeper changes. |
| 2 | **C2 (Fleet + FAB)** | After C1 because C1 might subtly shift screen geometry (3-6dp). Fleet's FAB clearance computation `paddingBottom: 96` is conservative enough to absorb C1's shift, but landing C1 first ensures the actual tab-bar height is known when sizing C2's clearance. |
| 3 | **C3 (red close button)** | Pure cosmetic in a separate modal — no gating. Can land anytime; placing last because it's the smallest and most independent commit. |

**Hard gating:** C1 → U7 verification (same device test pass). Recommend Suneel runs the 3-button-nav Android verification immediately after C1 lands. If U7 verifies clean, no further action needed.

**Soft gating:** C2 / C3 can swap order freely. Both can land same session as C1 after Suneel green-lights C1's screenshot.

### Effort estimate per group

| Group / commit | Code time | Verification time | Total |
|---|---|---|---|
| C1 (U1 + U6 + U7 verification) | 20 min | 30 min (iPhone + 3-button-nav Android screenshots) | **~50 min** |
| C2 (U3 + U4 + U5) | 40 min (4 files, dedupe + verify each FAB paddingBottom math) | 30 min (Android dispatched-vehicle row + iPhone Orders bottom card) | **~70 min** |
| C3 (U2) | 5 min (delete + verify diff is clean) | 5 min (modal screenshot) | **~10 min** |
| **Total** | ~65 min | ~65 min | **~2 hours 10 min** |

### What needs Suneel before starting?

- **U1 hypothesis confirmation** (per open question 1) — answer before starting C1.
- **U2 keep/remove decision** (per open question 2) — answer before starting C3.
- **U3/U4 keep DISPATCHED badge?** (per open question 3) — answer before starting C2.

If Suneel can answer 1, 2, 3 in one round-trip, the implementation chunk has full clarity and can land all three commits in ~2 hours.

---

## 8. Summary of file:line citations

| Surface | File:line | Bug |
|---|---|---|
| Tab bar math (default) | [packages/mobile/src/theme.ts:114-125](../packages/mobile/src/theme.ts) | U1, U7 |
| Tab bar math (admin scrollable) | [packages/mobile/src/components/ui/ScrollableTabBar.tsx:98-110](../packages/mobile/src/components/ui/ScrollableTabBar.tsx) | U1, U7 |
| Tab bar scroll affordance | [packages/mobile/src/components/ui/ScrollableTabBar.tsx:112-119](../packages/mobile/src/components/ui/ScrollableTabBar.tsx) | U6 |
| Dispatch Results modal Close button | [packages/mobile/app/(admin)/orders.tsx:1920-1924](../packages/mobile/app/(admin)/orders.tsx) | U2 |
| Dispatch Results modal `primaryBtn` style | [packages/mobile/app/(admin)/orders.tsx:2899-2906](../packages/mobile/app/(admin)/orders.tsx) | U2 |
| Fleet vehicle row | [packages/mobile/app/(admin)/fleet.tsx:782-857](../packages/mobile/app/(admin)/fleet.tsx) | U3, U4 |
| Fleet StatusBadge | [packages/mobile/app/(admin)/fleet.tsx:69-84](../packages/mobile/app/(admin)/fleet.tsx) | U3 |
| Fleet FAB | [packages/mobile/app/(admin)/fleet.tsx:86-111](../packages/mobile/app/(admin)/fleet.tsx) | U5 |
| Fleet vehicles FlatList (no paddingBottom) | [packages/mobile/app/(admin)/fleet.tsx:783-867](../packages/mobile/app/(admin)/fleet.tsx) | U5 |
| Orders FAB | [packages/mobile/app/(admin)/orders.tsx:849-855, 2662-2677](../packages/mobile/app/(admin)/orders.tsx) | U5 |
| Orders listContent paddingBottom | [packages/mobile/app/(admin)/orders.tsx:2519-2522](../packages/mobile/app/(admin)/orders.tsx) | U5 |
| Customers FAB | [packages/mobile/app/(admin)/customers.tsx:105](../packages/mobile/app/(admin)/customers.tsx) | U5 |
| More FAB | [packages/mobile/app/(admin)/more.tsx:304](../packages/mobile/app/(admin)/more.tsx) | U5 |
| React Navigation BottomTabBar (reference) | [node_modules/@react-navigation/bottom-tabs/lib/module/views/BottomTabBar.js:200-254](../packages/mobile/../../node_modules/@react-navigation/bottom-tabs/lib/module/views/BottomTabBar.js) | U1 (confirms no double-count) |
| React Navigation BottomTabView (reference) | [node_modules/@react-navigation/bottom-tabs/lib/module/views/BottomTabView.js:135-163](../packages/mobile/../../node_modules/@react-navigation/bottom-tabs/lib/module/views/BottomTabView.js) | U1 (confirms custom tabBar receives insets prop; SafeAreaProviderCompat passthrough) |

---

*End of iOS / Android UX Bug-Batch Audit.*
