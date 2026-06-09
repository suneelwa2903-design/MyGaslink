# Date-input audit — packages/mobile

**Audit date:** 2026-06-09
**Author:** Claude (P1-3 investigation)
**Status:** Read-only audit. **No code changes in this pass.** Implementation gated on Suneel's scope approval.

---

## 1. The canonical pattern (already in the codebase)

The codebase already has a hardened date-picker component: [`src/components/ui/DateInput.tsx`](../packages/mobile/src/components/ui/DateInput.tsx). It uses `@react-native-community/datetimepicker` (already a dependency) and:

- **Android:** opens the OS dialog imperatively via `DateTimePickerAndroid.open()` on tap — feels native.
- **iOS:** renders `<DateTimePicker mode="date" display="inline">` inside a `<Modal>` with Cancel + Done — the only viable pattern on SDK 54 (no imperative API).
- Parses + emits ISO `YYYY-MM-DD` strings via *local* TZ math (the same problem class the TZ-flakiness fix at `4300e07` solved on the API test side). Avoids the UTC drift you get from `new Date('YYYY-MM-DD')`.
- Renders the chosen date as a humanised string ("31 May 2026") via `formatDate(value)` and accepts `minDate` / `maxDate` for range constraints.

Every admin screen has already adopted it: `(admin)/customer-detail.tsx`, `(admin)/dashboard.tsx`, `(admin)/finance.tsx`, `(admin)/fleet.tsx`, `(admin)/inventory.tsx`, `(admin)/more.tsx`, `(admin)/orders.tsx`, `(admin)/reports.tsx` — 8 files, no exceptions.

**The bug is that the customer + driver + shared-component surfaces never got migrated.** They still use a plain `<TextInput placeholder="YYYY-MM-DD">` which forces the customer/driver to hand-type a date string and silently accepts any junk.

---

## 2. Inventory — every screen still using the broken pattern

### 2a. Shared component (highest blast radius)

| # | File | Lines | What renders it | Why fixing this catches multiple surfaces |
|---|---|---:|---|---|
| **B-1** | [src/components/DateRangeFilter.tsx](../packages/mobile/src/components/DateRangeFilter.tsx) | 48, 60 | Customer Orders list filter; Customer Invoices list filter; Customer Payments list filter | A single fix here lights up three customer screens at once. The file's own header comment (line 10) says *"no native DateTimePicker module is installed"* — that comment is stale; `DateInput` proves the module IS installed. |

### 2b. Customer surfaces

| # | File | Lines | Use |
|---|---|---:|---|
| **C-1** | [(customer)/dashboard.tsx](../packages/mobile/app/(customer)/dashboard.tsx) | 120-128, 132-140 | "This Period" From / To filter — drives the dashboard activity counters. |
| **C-2** | [(customer)/orders.tsx](../packages/mobile/app/(customer)/orders.tsx) | 772 | Delivery-date picker inside the modify-order flow. Suspect: the same modal that the audit at P0-3 / P0-4 also touches; verify the exact context before refactor. |
| **C-3** | [(customer)/payments.tsx](../packages/mobile/app/(customer)/payments.tsx) | 186, 198 | Payment-date filter range. Distinct from the shared `DateRangeFilter` (this file has its own inline inputs). |

### 2c. Driver surfaces

| # | File | Lines | Use |
|---|---|---:|---|
| **D-1** | [(driver)/analytics.tsx](../packages/mobile/app/(driver)/analytics.tsx) | 102, 121 | Driver analytics From / To range — drives the trip-history, delivery-count, and earnings rollups. |

### 2d. Other roles already on the canonical pattern

| Role | Status |
|---|---|
| Admin | ✅ All 8 screens use `<DateInput>` (per [src/components/ui/index.ts](../packages/mobile/src/components/ui/index.ts) re-export + 8-file usage grep). |
| Super-admin | n/a — does not surface date inputs. |
| Finance (mobile) | n/a — date filtering inherits from the shared `DateRangeFilter`. Will benefit from B-1 cascade. |
| Inventory | n/a — does not surface date inputs that I found. |

---

## 3. Why this matters

Customer / driver UX. Three concrete failure modes from the current text-input pattern:

1. **Typos pass validation client-side.** `"2026-06-09 "` (trailing space) is a different string from `"2026-06-09"`. The API rejects it with a generic 400, the customer sees an opaque error toast, the cause is invisible.
2. **Locale ambiguity.** A customer typing "06/09/2026" expects "9 June 2026" (DD/MM); the API parses it as "6 September 2026" (MM/DD). Submission goes through, the wrong delivery date lands in the order, the driver shows up on the wrong day, a complaint cycle starts.
3. **No min/max enforcement.** The customer can type "1990-01-01" or "2099-12-31" into the New Order modal's delivery date. The API rejects it (the "today or tomorrow" guard from `customerPortalService.ts:254-259`) but the rejection is a server round-trip away. The canonical `DateInput` accepts `minDate` / `maxDate` and stops the bad input at the source.

The driver analytics screen has an additional mode: **the From > To inversion**. A driver typing the From date later than the To date today gets an empty result set with no signal. Native pickers prevent this at the UI layer via the same min/max props.

---

## 4. Proposed implementation scope

**Five files, one shared component reuse, no API changes.**

| Order | File | Estimated diff | Risk |
|---|---|---|---|
| 1 | `src/components/DateRangeFilter.tsx` (B-1) | ~15 lines removed, ~6 lines added. Replace the two `<TextInput>` blocks with `<DateInput>` from the same `ui/` folder. Strip the stale header comment. | Low — it's a wrapper component; props don't change for callers. |
| 2 | `(customer)/dashboard.tsx` (C-1) | ~20 lines removed (the two `<TextInput>` rows + `dateInputStyle` if unused elsewhere), ~10 lines added (two `<DateInput>` with the same labels). | Low. |
| 3 | `(customer)/payments.tsx` (C-2) | Same as C-1. | Low. |
| 4 | `(customer)/orders.tsx` (C-3, line 772) | Verify which modal — see Open Question 1. May overlap with the P0-3 / P0-4 modal refactor. | **Medium** — depends on context. |
| 5 | `(driver)/analytics.tsx` (D-1) | Same shape as C-1. Add `minDate={fromDate}` on the To picker to prevent inversion. | Low. |

Total: ~50 lines added, ~60 lines removed, +1 stale comment removed. No new dependencies. No API contract change. No native module changes (the picker module is already linked, used by every admin screen).

**Pattern for each replacement** (from `DateInput.tsx`'s declared interface):

```tsx
import { DateInput } from '../../src/components/ui';
…
<DateInput
  label="From"
  value={fromDate}
  onChange={setFromDate}
  minDate={'1990-01-01'}        // or a context-appropriate floor
  maxDate={toDate || undefined} // For "From" only — chains with "To".
/>
<DateInput
  label="To"
  value={toDate}
  onChange={setToDate}
  minDate={fromDate || undefined} // Prevents inversion.
/>
```

---

## 5. Verification plan (when implementation lands)

- `pnpm test` — no test should fail (these screens don't have component-level tests; the API tests are unaffected because the wire shape doesn't change).
- `pnpm typecheck` + `pnpm lint` — clean.
- Manual:
  - iPhone + Android Expo Go pass: open Customer dashboard, Customer payments, Customer invoices, Driver analytics → each From/To row should tap into the native date wheel/calendar, not a text keyboard.
  - Edge cases on Android: rotate device while picker open, dark mode, gesture-nav bottom inset (the picker should not be clipped by the system nav — `DateInput`'s iOS modal already handles its own safe area, Android uses the OS dialog which is system-managed).

---

## 6. Open questions for Suneel

1. **C-3 (customer orders.tsx:772) context.** The line is inside the customer Orders file but I didn't fully trace which modal — likely the Modify Order delivery-date picker. Confirm:
   - **Option A**: refactor it now in the P1-3 sweep. Clean, atomic.
   - **Option B**: leave it alone in P1-3 because the same modal will get touched again in the v1.1 modal-cleanup follow-up (the "Modify Order + Commitment Date + Reschedule modals also have the same fixed-padding pattern" callout from the P0-3 commit). Less churn but two visits to the same file.

   Recommendation: **A** — it's a tiny diff and the modal-cleanup is a different concern (safe-area, not date-picker).

2. **minDate / maxDate for customer dashboard ("This Period") + payments filters.** Defaults:
   - **From**: 1990-01-01 (effectively unbounded — the first invoice ever for any distributor is in 2025).
   - **To**: today (per current behaviour — you can't filter for activity that hasn't happened yet).
   Confirm or override.

3. **Driver analytics minDate.** Same as 2 — should drivers see analytics older than some boundary (e.g., their join date), or is "1990-01-01" floor fine?

4. **Anything else in scope?** Inventory / super-admin / finance mobile have NO date inputs that I found — confirm I'm not missing something role-specific.

---

## 7. What this audit does NOT cover

- **Web** — out of scope. The web uses HTML5 `<input type="date">` which handles the picker natively.
- **API date validation** — already consistent (uses `setHours(0,0,0,0)` in local TZ, fixed by the TZ flakiness commit at `4300e07`).
- **The customer New Order delivery date inside the New Order modal** — already uses a custom `renderDateSelector` pattern with chips ("Today" / "Tomorrow"), which is a different UX paradigm. Leave it.
- **OrderHistoryRangeFilter on the driver app** — uses a chip-based "Last 7 days / Last 30 days" picker, not a date input. Leave it.

---

## 8. Standing

Ready to implement on Suneel's go. Per the brief: investigate first, propose, wait for scope sign-off, then implement.
