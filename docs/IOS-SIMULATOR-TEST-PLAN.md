# iOS Simulator — Smoke + Regression Test Plan

Cadence: run after every `codex sync` on Mac when a new build lands in the iOS simulator, before we push a TestFlight or App Store build.

Goal: catch iOS-specific issues Android testing wouldn't (safe-area, keyboard, secure-store, native-picker, sheet presentation) without re-running the full Android matrix.

Simulators to use (Xcode 15+):
- iPhone 15 Pro (iOS 17, "big screen + notch")
- iPhone SE 3rd gen (iOS 17, "small screen + home button")
- Optional: iPad Air (if `expo.ios.supportsTablet` is ever flipped — v1.0 is phone-only)

Note: v1.0 iOS supports iPhone only. `supportsTablet: false` in `app.json > expo.ios`.

---

## 0 · Setup

```bash
# Fetch latest, install, prebuild ios
git pull
pnpm install
pnpm --filter @gaslink/mobile exec npx expo prebuild --platform ios --no-install
cd packages/mobile/ios && pod install && cd -

# Run in simulator (opens first available)
pnpm --filter @gaslink/mobile exec npx expo run:ios
```

If you hit a native-module signing issue, open `packages/mobile/ios/gaslink.xcworkspace` in Xcode and select your team.

Sanity check before every session:
- Simulator has network (open Safari, load a page).
- API_URL in `packages/mobile/.env` (or launch config) points at a reachable backend. For staging: `https://api.mygaslink.com`. For laptop dev: your laptop's LAN IP (localhost from the simulator maps to the Mac itself — but 10.0.2.2 doesn't apply on iOS Simulator; `localhost` DOES resolve).

---

## 1 · Auth + Session Persistence (5 min)

Focus: Keychain via `expo-secure-store`; auto-relaunch behaviour.

1. Cold launch → login as `bhargava@gasagency.com` / `Distadmin@123`.
2. Kill app (swipe up on app switcher). Relaunch.
   - Expect: lands on Orders (mini-op) / Dashboard (regular admin) without asking for login again.
3. Logout → login as `suneel@mygaslink.com` (super admin).
4. Switch distributor via header → confirm switch persists across kill/relaunch.
5. Login rate limit: 6 rapid wrong passwords → expect 429 on the 6th attempt.

---

## 2 · Safe-Area + Keyboard (10 min)

Focus: iPhone notch, home indicator, on-screen keyboard.

Run on **both** iPhone 15 Pro (notch) and iPhone SE (no notch).

### 2a · Notch / status-bar
- Every top nav bar should sit below the notch, not under it. Screens: Orders / Customers / Billing / Purchases / Expenses / Quotations / Reports / More.
- Bottom tab bar: home indicator should NOT overlap tab icons.

### 2b · Keyboard doesn't cover inputs
For each modal, tap a bottom-most input field. The keyboard should NOT cover the Save button:

- **Create Order** modal (Admin → Orders → +) — pick a customer, scroll to Special Instructions, tap it.
- **Customer picker** inside Create Order — tap the search input.
- **Cancel Order** modal — tap Reason textarea.
- **New Expense** modal — tap Amount / Description / Notes.
- **Empties Return** modal (Stock tab) — tap Quantity / Notes.
- **New Quotation** modal — tap Subject / Email / CC / Rate.
- **New Quotation → customer picker** — tap the search input.
- **New Purchase** modal (mini-op Purchases) — tap Amount / Notes.
- **Record Purchase Payment** modal — tap Amount / Reference.

Fail mode: keyboard covers Save button → note the screen + iPhone model.

### 2c · Home-indicator overlap (bottom sheets)
For each bottom-sheet modal, the last row of the scrollable body should NOT sit under the home indicator:

- Create Order → customer picker FlatList last row.
- Empties Return sheet.
- New Quotation → customer picker.
- Category picker on Expenses.

---

## 3 · Mini-op flows (15 min)

Login: `bhargava@gasagency.com` / `Distadmin@123`.

### 3a · Create Order (same-day)
1. New order → Ramani → today's date → Driver Name "Raju" → 1× 19KG.
2. Save → lands as Delivered.
3. Open the order → confirm the driver name shows on the card.

### 3b · Backdated order + empties + inline pricing
1. New order → Ramani → past date (e.g. today-2) → Rate ₹5,000/cyl → 3× 19KG → 3 empties.
2. Save → check the "Backdated delivery" banner appeared before save.
3. Download the invoice PDF → confirm ₹15,000 total (3 × 5,000), issueDate matches past date.
4. Open Ramani statement → confirm ledger entry on that past date, running Pend E decreases by (3 empties − 3 delivered) = 0 net.

### 3c · Cancel a delivered order
1. On a delivered order → tap the ⋯ menu → Cancel.
2. Modal opens → pick "Wrong customer" → enter reason → Cancel Order.
3. Confirm the order shows Cancelled tag, PDF stops (invoice cancelled), statement PDF for that customer HIDES both the invoice row and the reversal (mini-op only).

### 3d · Empties Return
1. Stock tab → Empties Return → pick customer → 19KG → qty 4 → today → Record.
2. Customer statement PDF → new row on today's date "Empties: 4× 19KG", running Pend E decreases by 4.

### 3e · Expenses filters + search
1. Expenses → search "Diesel" → confirm the top filtered-total strip drops to just the diesel entries.
2. Category dropdown → pick "Fuel" → filtered total narrows further.
3. Payment dropdown → pick "Bank" → confirm both filters apply. Clear each in turn.

### 3f · Purchases
1. Purchases → + Add Purchase → pick supplier → 19KG × 100 fulls, 28 empties, ₹2,950 rate, cash.
2. Save → Purchase Ledger PDF → confirm entry, no double-quote artefacts on payment rows (should read `- Rs. 1,40,000.00`).

---

## 4 · Regular distributor + Quotations (10 min)

Login: `sharma@gasdist.com` / `Gstadmin@123`.

### 4a · Quotations (new v1.0 mobile feature)
1. More → Quotations → confirm chip row (All/Draft/Sent/Accepted/Rejected/Expired) renders as a proper horizontal strip.
2. + FAB → New Quotation:
   - Existing customer: pick Ramani → auto-fill recipient email.
   - Freeform toggle: switch → fill name / phone / address / GSTIN.
   - Email override + CC: add 1 CC email.
   - GST: 5% chip → active.
   - Line item mode: **Per kg** → cylinder type 19KG → capacity auto-fills to 19 → rate ₹150/kg → discount ₹2/kg.
   - Save → lands as Draft.
3. Open the Draft → Duplicate → confirm a new Draft is created.
4. Open the original Draft → Send email → SMTP-configured server should send; otherwise "SMTP not configured" Alert.
5. Download the PDF (top-right icon) → confirm per-kg card shows:
   - Rate per KG (incl GST @ 5%)  (excl GST ₹142.86)  : ₹150.00
   - Discount per KG (excl GST - ₹1.90)  : - ₹2.00
   - Final rate per KG (incl GST) : ₹148.00
   - Final rate per KG (excl GST) : ₹140.95
6. Confirm the item name reads `19 KG — per kg` (no duplicated capacity).

### 4b · Existing Orders / GST flows (regression)
1. Create a same-day order for a B2B customer → confirm delivery → confirm IRN + EWB (if GST live).
2. Cancel a delivered order → confirm the credit note flow triggers (regular distributor, NOT mini-op).

---

## 5 · Driver + Customer (10 min)

### 5a · Driver
Login: `raju@gasagency.com` / `Driver@123`.
1. Confirm active-trip card shows on dashboard.
2. Take a photo (camera permission prompt on first use — accept).
3. Confirm delivery → signature pad works with Apple Pencil / finger.
4. Kill app → offline queue: turn off Wi-Fi → confirm another delivery → toggle Wi-Fi on → queue drains.

### 5b · Customer
Login: `royal@kitchen.com` / `Customer@123`.
1. Dashboard shows recent orders + payments.
2. Place a new order → picks a pending_delivery order.
3. Open an invoice → View PDF → confirm renders.

---

## 6 · Reports + PDFs (5 min)

Regular admin only.

1. Reports → Outstanding & Aging → confirm the table header has the subtle indigo tint, body rows are plain.
2. Reports → CSV export → tap → confirm the file opens in Numbers / Files.
3. Reports → PDF report (Vehicle Ledger) → confirm renders + no missing-glyph `"` characters.

---

## 7 · iOS-specific gotchas checklist

- [ ] No `AsyncStorage` used for auth tokens (SecureStore only). Grep-guard already in place; visually: token survives kill+relaunch.
- [ ] Camera permission prompt on Driver's first photo capture — the Info.plist string should read something human-readable, not the default placeholder.
- [ ] Location permission (Driver confirm-delivery) — same as above.
- [ ] No console.error / red-box banners visible during a normal flow. Any RN warning is a hit.
- [ ] Dark mode toggle (Appearance in More) applied to every screen without a reload.
- [ ] Portrait only — rotate the simulator to landscape and confirm layout stays sane OR is locked (per `expo.ios.orientation`).

---

## 8 · Report a failure

For each failing scenario, capture:
- Screen name + step number in this doc.
- iPhone model + iOS version.
- 1-line description of expected vs actual.
- Screenshot (⌘S in Simulator → saved to Desktop).

Post to the shared thread — Suneel triages before we schedule the fix.

---

## 9 · Ship criteria

Push to TestFlight when ALL of these pass on both iPhone 15 Pro AND iPhone SE:
- Section 1 (Auth) — all 5 steps.
- Section 2 (Safe-area / keyboard) — no keyboard-cover on any listed modal.
- Section 3 (Mini-op flows) — a–f, no crashes.
- Section 4 (Regular + Quotations) — a–b, no crashes.
- Section 5 (Driver + Customer) — 5a–5b, camera permission accepted cleanly.
- Section 7 (gotchas) — every check green.

Anything else is a "known issue" note in the TestFlight release notes; only crashes and safe-area/keyboard covers are ship-blockers for v1.0.
