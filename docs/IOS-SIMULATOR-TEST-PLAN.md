# iOS Simulator — Codex-on-Mac Test Plan

Run this end-to-end after every `git pull` from origin/main on the Mac, before pushing a TestFlight or App Store build. The goal: catch iOS-specific breakage — native-toolchain versions, safe-area, keyboard, sheet presentation — that Android testing can't.

**Sim targets:**
- iPhone 15 Pro (iOS 17.x) — big screen + notch
- iPhone SE 3rd gen (iOS 17.x) — small screen + home button

iPad is intentionally excluded. `expo.ios.supportsTablet: false` in `app.json`. v1.0 ships iPhone-only.

**App stack pins (as of 2026-07-29):**
- `expo`: `~54.0.35`
- `expo-router`: `~6.0.24`
- `react-native`: `~0.81.5`
- Node: 20.x (`.nvmrc` if present; Expo 54 requires >=18.18)
- Xcode: 15.4+ (Expo 54 min)
- Ruby: 3.2+ for CocoaPods (system Ruby on macOS 14 works)

---

## Section 0 — Toolchain sanity BEFORE running the app (5 min)

If any of these are off, the build fails with cryptic messages. Check first.

### 0.1 Node
```bash
node -v          # want v20.x (Expo 54 requires >=18.18)
which node       # should be in ~/.nvm or /opt/homebrew — NOT /usr/local from a stale install
```
**Failure mode we've seen:** node 21+ breaks `metro` bundling with `RangeError: Too many message fragments` (same class as the Windows Metro crash you hit on 2026-07-29 emulator). If you see that on iOS launch, downgrade to node 20.

### 0.2 Xcode + Command Line Tools
```bash
xcode-select -p  # want /Applications/Xcode.app/Contents/Developer
xcodebuild -version
```
Xcode 15.0 or 15.1 has a known Metal linker bug that breaks `hermes-engine`. Xcode 15.3+ is safe. If you're on 15.0/15.1: upgrade Xcode via App Store or Apple Developer Downloads.

### 0.3 CocoaPods + Ruby
```bash
ruby -v          # want 3.2.x (macOS 14 default). If 2.6.x (macOS 12 default) → CocoaPods 1.15+ won't install.
pod --version    # want 1.15+
gem list cocoapods
```
**Failure mode we've seen:** `pod install` errors out with `Could not find rubygems.org` on stale gem sources — clear with `gem sources --remove ... && gem sources --add https://rubygems.org`.

### 0.4 Simulator inventory
```bash
xcrun simctl list devices available | grep -E "iPhone 15 Pro|iPhone SE"
```
If missing: Xcode → Settings → Platforms → download iOS 17.x runtime.

### 0.5 Watchman (Metro's file watcher)
```bash
brew list watchman   # want installed; corrupt state → RN can't hot-reload
watchman shutdown-server && watchman version
```

### 0.6 EAS / Expo CLI
```bash
npx expo --version   # want 0.24+
npx eas --version    # optional but nice for cloud builds
```

**Ship-blocker if any of §0.1–§0.4 fail. Fix before continuing.**

---

## Section 1 — First-boot build (10 min)

```bash
git pull
pnpm install
pnpm --filter @gaslink/shared run build   # rebuild shared once
pnpm --filter @gaslink/mobile exec npx expo prebuild --platform ios --no-install
cd packages/mobile/ios
pod install                                # ~2-3 min first time
cd -
pnpm --filter @gaslink/mobile exec npx expo run:ios
```

**Failure modes we've seen and their fixes:**

| Symptom | Root cause | Fix |
|---|---|---|
| `pod install` fails on `PromisesObjC` or `FBReactNativeSpec` | Xcode version mismatch or stale pod cache | `rm -rf packages/mobile/ios/Pods packages/mobile/ios/build && pod install` |
| `Command 'metro' not found` | Node version < 18.18 or `expo-cli` legacy install | Uninstall legacy: `npm rm -g expo-cli`; use `npx expo` |
| RN `RangeError: Too many message fragments` on launch | Node 21+ bug in `ws` used by Metro | Downgrade to Node 20 via `nvm install 20 && nvm use 20` |
| `Signing for gaslink requires a development team` | Not signed into Xcode | Open `packages/mobile/ios/gaslink.xcworkspace` → target → Signing & Capabilities → pick your team |
| App boots, immediately white-screens with no error | Metro not reachable OR `EXPO_PUBLIC_API_URL` unset | Check `packages/mobile/.env`; localhost DOES work in iOS Simulator (unlike Android where you'd need `10.0.2.2`) |
| Fonts render as squares | `expo-font` didn't bundle assets during prebuild | Re-run `npx expo prebuild --clean` |
| `expo-camera` build fails with `RECORD_AUDIO` privacy string missing | Native config plugin didn't inject the Info.plist string | `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` must be in `app.json > expo.ios.infoPlist`; re-run prebuild |

Once you see the login screen, move on to §2.

---

## Section 2 — Safe-area, keyboard, and sheet presentation (25 min)

**This is the largest source of iOS-only bugs.** Run every step on BOTH iPhone 15 Pro (notch) AND iPhone SE (no notch). The bugs in this section usually only surface on one form factor.

### 2.1 Status bar and notch (all screens)

For each of these, the top nav bar or content must sit BELOW the notch, and NOT under the status bar:

- (auth) Login screen
- (admin) Dashboard, Orders, Billing, Inventory, Customers, Fleet, Purchases, Expenses, Quotations, Reports, Collections, More, Settings, Pending Actions, Pending Payments
- (finance) Invoices, Payments, Orders
- (super-admin) Distributors, Users
- (customer) Dashboard, Orders, Invoices, Payments, Account
- (driver) Orders, My Submissions, More
- (hq) Dashboard, Orders, Invoices, Ledger, Payments, Aging, Profile

Log in as each role. Take one representative screenshot per group. Any content clipped by the notch → capture and report.

### 2.2 Bottom tab bar + home indicator

Bottom tab icons must NOT overlap the home indicator swipe area. Screens with a tab bar:
- Every admin tab, every finance tab, every customer tab, every driver tab, every super-admin tab, every HQ tab.

**Known-good pattern**: `SafeAreaView edges={['top','bottom','left','right']}` on the layout root plus `tabBarStyle` with `paddingBottom: insets.bottom` in the tabs config.

### 2.3 Keyboard doesn't cover inputs (KAV coverage matrix)

Anti-pattern #25 in CLAUDE.md — RN `<Modal>` on Android doesn't propagate the outer SafeAreaView bottom inset. Same story on iOS for the keyboard: without `KeyboardAvoidingView` (`behavior='padding'` on iOS), the keyboard sits over the Save button.

For **each modal below**, open it, tap the LAST input field before the Save button, and confirm the keyboard doesn't cover the Save button.

- **(admin) Orders → +** Create Order modal → Special Instructions
- **(admin) Orders → +** → nested Customer picker → Search input ← **watch this one**
- **(admin) Orders** → any delivered order → Cancel Order → Reason textarea
- **(admin) Orders** → edit an order → Special Instructions
- **(admin) Inventory → Stock → Adjust Stock** → Reason
- **(admin) Inventory → Stock → Empties Return** (new sheet) → Quantity / Notes
- **(admin) Inventory → Stock → Empties Return** → nested Customer picker → Search
- **(admin) Purchases → +** → Add Purchase → Amount / Notes
- **(admin) Purchases → +** → Record Purchase Payment → Amount / Reference
- **(admin) Purchases** → nested Supplier picker → Search
- **(admin) Expenses → +** → New expense → Amount / Description / Notes
- **(admin) Expenses** main screen → Search input at top
- **(admin) Expenses** → Category dropdown → in-picker Search input
- **(admin) Quotations → +** New Quotation → every field (Subject / Email / CC / Rate)
- **(admin) Quotations → +** → freeform recipient → Address / Phone
- **(admin) Quotations → +** → nested Customer picker → Search ← **watch this one**
- **(admin) Customers → +** New Customer → every field
- **(admin) Fleet → Add Vehicle** → every field
- **(admin) Settings → Change Password** → all three password fields
- **(driver) confirm-delivery modal** → Notes textarea + Signature pad appears above keyboard
- **(finance) Payments → +** Record Payment → Amount / Reference
- **(finance) Invoices** → filters modal → Search
- **(super-admin) Users → +** New User → every field
- **(super-admin) Distributors → +** New Distributor → every field
- **(customer) Orders → +** Place Order → quantity + notes
- **(hq) any** → filters modal

If keyboard covers the Save button anywhere → **ship-blocker**. Note the screen + iPhone model.

### 2.4 Bottom-sheet home-indicator clearance

For each bottom-sheet modal, the last row of the scrollable body must not sit under the home indicator.

- (admin) Create Order → Customer picker FlatList last row
- (admin) Empties Return → Customer picker FlatList last row
- (admin) Quotations → Customer picker FlatList last row
- (admin) Expenses → Category picker last row
- (driver) Confirm Delivery → notes textarea bottom edge

Known-good pattern: `paddingBottom: Math.max(insets.bottom + 8, 24)` on the sheet container.

### 2.5 Landscape / rotation

`app.json > expo.orientation: 'portrait'` locks all screens to portrait. Rotate the sim to landscape (`⌘→`). App should NOT rotate. If it does → `orientation` isn't being honored (usually caused by a Fabric/rn-new-arch flag).

---

## Section 3 — Auth + session persistence (5 min)

Focus: Keychain via `expo-secure-store`, biometrics not enabled, no `AsyncStorage` for tokens.

1. Cold launch → login as `bhargava@gasagency.com` / `Distadmin@123`.
2. Kill app (swipe up on app switcher). Relaunch.
   - Expect: lands on Orders (mini-op) without re-login.
3. Logout → login as `suneel@mygaslink.com` / super admin.
4. Switch distributor via header → confirm switch persists across kill/relaunch.
5. Login rate limit: 6 rapid wrong passwords → the 6th returns 429.
6. Change password (Settings → Change Password) → logout → login with new pwd → change back.

---

## Section 4 — Mini-op flows (20 min)

Login: `bhargava@gasagency.com` / `Distadmin@123`. (Mannava Bhargava tenant, `accountType='mini_operator'`.)

### 4.1 Create Order — same-day
- New order → Ramani → today → **Driver Name: Raju** (new mini-op-only input) → 1× 19KG → Save.
- Land as Delivered. Order card shows "Raju" as driver.

### 4.2 Create Order — backdated with inline pricing + empties
- New order → Ramani → past date (today − 2) → 3× 19KG.
- **Rate ₹ per line: 5000** (per-line override).
- **Empties Collected: 3** (new per-item input, only visible when backdated).
- Confirm blue "Backdated delivery" banner appeared before Save.
- Save → land as Delivered on the past date.
- Download invoice PDF → **₹15,000 total** (3 × 5,000), `issueDate` = past date.
- Statement PDF → new row on that past date, running Pend E stays flat (delivered − collected = 0 net).

### 4.3 Cancel a delivered order
- Delivered order → ⋯ → Cancel.
- Chip picker appears with 5 options (Wrong customer / Damaged returned / Customer refused / Duplicate entry / Other) — **cancellationType required for delivered orders on mini-op**.
- Pick "Wrong customer" + reason → Cancel Order.
- Order tag shows Cancelled.
- Statement PDF → mini-op HIDES the cancelled `invoice_entry` row AND the `Cancelled:` reversal row atomically. Running balance still reconciles.

### 4.4 Empties Return (standalone)
- Stock tab → **Empties Return button** (new, top-right area) → pick customer → 19KG → qty 4 → today → Record.
- Statement PDF → row `Empties: 4× 19KG` on today's date, running Pend E decreases by 4.
- Customer balance (Customers → Ramani → Empties): `withCustomerQty` down 4 for 19KG.

### 4.5 Expenses — filters + search + filtered total
- Expenses → search "Diesel" → filtered-total strip drops.
- Category dropdown → open picker → **in-picker search "Fuel"** → pick Fuel → strip narrows further.
- Payment dropdown → pick Bank → strip narrows again.
- Clear each → total returns to full window.
- Category chip colours match the group (Vehicle Costs, Staff Costs, etc.) — small dot + left border on each card.

### 4.6 Purchases + Purchase Ledger PDF
- Purchases → + → Add Purchase → supplier → 19KG × 100 fulls, 28 empties, ₹2,950 rate, cash → Save.
- Purchase Ledger PDF → payment rows read `- Rs. 1,40,000.00` (plain ASCII hyphen — **no double-quote artefact**).

---

## Section 5 — Regular distributor + Quotations (20 min)

Login: `sharma@gasdist.com` / `Gstadmin@123`.

### 5.1 Quotations — end-to-end mobile
- More → **Quotations** (new — was gated to mini-op-only in earlier build; now distributor+finance only).
- Filter chip row: All / Draft / Sent / Accepted / Rejected / Expired — **horizontal strip, no tall bars**.
- Card left border colored by status (Draft grey, Sent blue, Accepted green, Rejected red, Expired amber).

- **+ FAB** → New Quotation modal.

  **Recipient toggle:** Existing customer / Enter new.
  - Existing: pick Ramani → email auto-fills. If she has no email → red banner "Add one below to send via email".
  - Freeform: fill Name, Contact, Phone, GSTIN, Address, City, State, Pincode. All optional except Name.

  **Email + CC:**
  - Email override (blank ← customer's email fills automatically if picked).
  - CC emails (comma / semicolon / space separated). Count shows below.

  **Line item mode:** Per cylinder / Per kg.
  - Per cylinder: cylinder type chip + Rate ₹ (incl GST) + Discount ₹.
  - Per kg: cylinder type + **Capacity (kg)** (auto-fills from picked type) + Rate ₹/kg + Discount ₹/kg.

  **GST rate:** 5% / 18% chip.

- Save → lands as Draft.
- Open Draft → **Duplicate** → new Draft created.
- Open Draft → **Send email** → SMTP-configured server sends; unconfigured → "SMTP not configured" alert.

### 5.2 Quotation PDF — per-kg card cross-check
Download a per-kg Draft's PDF (top-right icon in detail modal). Confirm the per-kg card shows:
- `Rate per KG (incl. GST @ 5%)  (excl GST ₹142.86)  :  ₹150.00`
- `Discount per KG  (excl GST - ₹1.90)  :  - ₹2.00`
- `Final rate per KG (incl. GST)  :  ₹148.00`
- `Final rate per KG (excl. GST)  :  ₹140.95`

Item name reads `19 KG — per kg` (no duplicated `(19KG)`).

### 5.3 Regular GST flows (regression)
- Create a same-day order for a B2B customer → confirm delivery → verify IRN + EWB fire (GST live tenant).
- Cancel a delivered order → **credit note flow** triggers (regular distributor, NOT the mini-op reversal).

### 5.4 Statement PDF — regular tenant
- Download any B2B customer statement.
- Cancelled invoice + its `Cancelled:` reversal both VISIBLE (regular distributors keep the audit trail).
- Total row: `Pend E` and `Emp Cost` reconcile (`Emp Cost = Pend E × per-type deposit`).
- Empties-return row: `Emp C` shows the returned qty; running `Pend E` decrements.

---

## Section 6 — Driver + Customer (15 min)

### 6.1 Driver
Login: `raju@gasagency.com` / `Driver@123`.
1. Dashboard → active-trip card shows if there's a live DVA.
2. Take a photo → **camera permission prompt on first use** — accept. Confirm the prompt text is human-readable (not the default placeholder).
3. Confirm delivery → signature pad works with finger; save.
4. Kill app.
5. **Offline queue:** Simulator → Settings → Developer → Network Link Conditioner → 100% loss.
6. Confirm another delivery → should be queued locally.
7. Restore network → queue drains.

### 6.2 Customer
Login: `royal@kitchen.com` / `Customer@123`.
1. Dashboard shows recent orders + payments.
2. Place a new order → confirm it lands in `pending_delivery`.
3. Open an invoice → View PDF → renders.
4. OTP tab appears on the current order card when portal-access is enabled.

---

## Section 7 — Reports + PDFs on iOS (5 min)

Regular admin.

1. Reports → Outstanding & Aging → table header has subtle indigo tint; body rows plain.
2. Reports → CSV export → Numbers / Files opens.
3. Reports → Vehicle Ledger PDF → renders, no missing-glyph `"` characters.
4. Empties PDF → renders, no missing-glyph artefacts.
5. Statement PDF (customer) → renders (already covered in §5.4).

---

## Section 8 — iOS-specific gotchas checklist

- [ ] No `AsyncStorage` used for auth tokens. Kill+relaunch test proves SecureStore is doing its job (§3.2).
- [ ] Camera permission prompt has readable copy (`NSCameraUsageDescription` in Info.plist).
- [ ] Location permission (Driver confirm) has readable copy (`NSLocationWhenInUseUsageDescription`).
- [ ] No `console.error` red-box overlay during any normal flow.
- [ ] No RN yellow-box warnings during any normal flow.
- [ ] Dark-mode toggle (More → Appearance) applies to every screen without reload.
- [ ] Portrait lock honored (§2.5).
- [ ] `app.json > expo.ios.supportsTablet: false` — sim doesn't offer iPad targets.
- [ ] `expo.ios.buildNumber` bumped for every TestFlight (never reuse).
- [ ] `expo.ios.usesNonExemptEncryption: false` present (avoids the ATS export-compliance prompt each App Store upload).

---

## Section 9 — Report a failure

Per failing scenario capture:
- Section + step number in this doc.
- iPhone model + iOS version.
- Expected vs actual (one line each).
- Screenshot (`⌘S` in Simulator → Desktop).
- If a native crash: `~/Library/Logs/DiagnosticReports/` — attach the latest `.ips` file.

Post to the shared thread with subject `iOS-sim: §<n>.<step> <one-line-summary>`. Suneel triages before scheduling the fix.

---

## Section 10 — Ship criteria

Push to TestFlight when **ALL** of these pass on **BOTH** iPhone 15 Pro AND iPhone SE:

- §0 — toolchain — no red.
- §1 — first-boot build — clean.
- §2.1 — no clipped notch content.
- §2.2 — no home-indicator overlap.
- §2.3 — no keyboard-covers-Save in any listed modal.
- §2.4 — no home-indicator overlap on any sheet.
- §2.5 — portrait lock honored.
- §3 — auth persists across kill+relaunch.
- §4 — mini-op flows: no crashes.
- §5 — regular distributor + Quotations: no crashes.
- §6 — driver + customer: no crashes.
- §8 — gotchas all green.

Anything else is a "known issue" note in the TestFlight release notes. Only crashes and §2.3 / §2.4 failures are hard ship-blockers for v1.0.
