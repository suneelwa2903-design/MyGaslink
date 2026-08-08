# Date-format consistency audit (2026-08-08)

**Trigger:** On Analytics → Reports → Inventory Movement, the filter shows `08-07-2026` while the table rows show `2026-07-12` — two different date formats on one screen. Ask: pick **one** consistent format app-wide; customer-facing ledgers should be **dd/mm/yy**. This is a read-only assessment — **no code changed yet**.

---

## TL;DR

- There is **no single date formatter** anywhere. `@gaslink/shared` only exposes `localTodayISO()` / `localDateISO()` which produce `YYYY-MM-DD` for **input values / storage**, never for display.
- Every user-facing date is formatted **ad-hoc at the call site**. Total distinct on-screen formats: **~13 in web, 7 in mobile, 6 in API/PDF.**
- The exact confusion in the screenshot = a **browser-native `<input type="date">`** (renders in OS locale → `08-07-2026`) sitting next to a **report table that prints raw `YYYY-MM-DD`** from the backend. Neither goes through a formatter.
- One important constraint: **native `<input type="date">` cannot be format-forced** via HTML/CSS — it always renders in the viewer's OS locale. Controlling *its* display needs a custom date-picker component (bigger lift). Everything else (all read-only display) can be standardised cleanly.

---

## Proposed standard

| Context | Format | Example |
|---|---|---|
| **All display dates** (tables, cards, ledgers, PDFs, mobile) | `dd/MM/yyyy` | `12/08/2026` |
| Date **+ time** where needed | `dd/MM/yyyy, hh:mm a` | `12/08/2026, 10:30 am` |
| Compact chart axes only | `MMM yy` | `Aug 26` |

Notes:
- You asked for **dd/mm/yy** on customer-facing ledgers. I recommend **4-digit year (`dd/MM/yyyy`)** everywhere for zero ambiguity, but this is a one-word switch — if you want literal `dd/mm/yy` (2-digit year) on ledgers to save column width, say so and it's trivial.
- `dd/MM/yyyy` (numeric, zero-padded) matches Indian convention and your dd/mm preference, and is unambiguous once zero-padded + 4-digit year. (Today's dominant web format `7/8/2026` is the *same order* but non-padded and locale-dependent — the fix is to pin it.)

**Enforcement:** add `formatDisplayDate(d)` + `formatDisplayDateTime(d)` to `@gaslink/shared` (mirroring the existing `localDateISO` pattern), route every surface through it, then add a CI guard banning raw `toLocaleDateString` / `toLocaleString` for display (same style as the existing anti-pattern #21 TZ guard).

---

## Current state — inventory

### Web (`packages/web`) — ~13 distinct formats, no shared formatter
- **Dominant:** `7/8/2026` — bare `toLocaleDateString('en-IN')`, ~90 sites (all ledger/invoice/payment/order tables).
- **6 near-duplicate local `formatDate` helpers** with overlapping-but-different output: `07 Aug 2026` (CollectionsPage, SettingsPage), `07-Aug-2026` (SendBillingInvoiceModal), `07 Aug 2026, 10:30 am` (ProfilePage, DeletionRequests), `7/8/2026` (hq/DashboardPage), etc.
- **Raw ISO shown to users:** report tables (ReportsPage) and `InventoryPage.tsx:3012` print backend `YYYY-MM-DD` directly — **this is the `2026-07-12` in the screenshot.**
- **Native `<input type="date">`** on ~40 screens (all filter ranges + form date fields) — OS-locale, ambiguous — **this is the `08-07-2026` in the screenshot.**
- One stray `en-US` locale (CustomersPage:138).

### Mobile (`packages/mobile`) — 7 distinct formats
- Canonical `formatDate` in `src/theme.ts` → `16 May 2026`, used by the shared `DateInput` picker + customer invoices/orders.
- **But bypassed** ad-hoc (~12 sites) with bare `toLocaleDateString('en-IN')` → `16/5/2026`, incl. admin customer-detail ledger and even *within* `(customer)/payments.tsx` (line 130 `formatDate` vs line 211 bare). 4 screens re-declare a copy of `formatDate`; 2 more use variants; dashboard headers use long-form.
- Not in `@gaslink/shared` — lives only in the mobile app.

### API / PDF (`packages/api`) — 6 formats; customer ledger is the odd one out
- **Dominant PDF format:** `DD-MMM-YYYY` (`24-Jan-2025`) via `pdfLayoutUtils.formatDate` — invoices, supplier/purchase ledgers, vouchers, trip sheets, credit notes, registers, quotations.
- **Customer ledger PDF uses a *different* format** — `D/M/YY` (`16/7/26`) via `formatDateCompact` (deliberate, to save column width). So a customer gets an **invoice dated `24-Jan-2025` and a ledger dated `24/1/25`** — two styles from the same distributor. This is the highest-visibility inconsistency.
- Reports layer: `reportsService.dayKey` → `YYYY-MM-DD` **computed in UTC** (feeds report JSON, report CSV, invoices CSV). PDFs use **local-time** getters → the same date can render as a different calendar day between a report and its PDF near IST midnight (anti-pattern #21 mechanism drift).
- Exports split three ways: GST filing `YYYY-MM-DD` (local), report/invoice CSV `YYYY-MM-DD` (UTC), Tally `YYYYMMDD` (UTC). *(Export formats are machine-target and should stay as-is — Tally/GST require them.)*

---

## What fixes the screenshot specifically
1. **Report table date cells** → route through the shared formatter so they show `12/08/2026` not `2026-07-12`.
2. **The filter input** (`08-07-2026`) is browser-native — see the caveat below.

---

## The native-date-input caveat (decision needed)
`<input type="date">` renders in the viewer's OS locale and **cannot** be forced to `dd/MM/yyyy` via code. Options:
- **(a) Leave inputs as-is** — on an Indian-locale device they already show dd-mm; the value we store is always correct ISO. Lowest effort. Inputs stay slightly different from display text.
- **(b) Build one shared custom date-picker** component (web) that displays `dd/MM/yyyy` and emits ISO — full control, consistent everywhere, but it's a real component to build + swap into ~40 sites.

Recommendation: **(a) for now**, revisit (b) only if the input/display mismatch still bothers users after display is standardised.

---

## Proposed phased plan (once you approve the standard)

| Phase | Scope | Effort |
|---|---|---|
| 1 | Add `formatDisplayDate` / `formatDisplayDateTime` to `@gaslink/shared` | 30 min |
| 2 | **Customer-facing first** (your priority): customer ledger PDF, invoice PDF, customer web pages, customer + finance mobile screens → `dd/MM/yyyy` | ~half day |
| 3 | Web app-wide sweep: replace ~90 inline `toLocaleDateString` + 6 local helpers + report-table cells | ~1 day |
| 4 | Mobile sweep: consolidate to shared formatter, kill the 6 local variants | ~half day |
| 5 | Align `reportsService.dayKey` to local-TZ (fix #21 drift) so reports match PDFs | ~2 hrs |
| 6 | CI guard: ban raw `toLocaleDateString`/`toLocaleString` for display | ~1 hr |
| — | (Optional) custom web date-picker for input consistency | separate, ~1 day |

Exports (Tally `YYYYMMDD`, GST `YYYY-MM-DD`) are intentionally **out of scope** — those formats are mandated by the target systems.

---

## Open decisions for you
1. **`dd/MM/yyyy` (4-digit year) or literal `dd/mm/yy` (2-digit)?** Recommend 4-digit for all except maybe the space-tight ledger.
2. **Native inputs:** accept OS-locale (option a) or build a custom picker (option b)?
3. **Build order:** customer-facing only first (Phase 1–2, ship, review), then the rest? Or all at once?

---

# Implementation design & impact (2026-08-08)

**Decision locked:** standard = **`dd/MM/yyyy`** (4-digit year), for both viewing and input display, everywhere, with no data breakage. Governing principle: **standardise the DISPLAY layer only; the DATA/wire format (ISO to API, GST/Tally payloads) never changes.**

## Safety verification — done, result: ZERO risk

Two read-only safety sweeps ran across all three packages:

**A. Does anything parse a displayed date string back into a date?** → **No, 0 findings.**
- Every `new Date(x)` consumes an ISO/Date from the API/DB, or is regex-guarded to `^\d{4}-\d{2}-\d{2}$`.
- Every `.split`/`.slice(0,10)` operates on ISO, never a display format.
- The only date-bearing import (`as_of_date` on opening-balance CSV) is doubly regex-guarded to `YYYY-MM-DD`; there is no Excel/CSV date *import* elsewhere.
- Every `<input type="date">` (web) and `DateTimePicker` (mobile) stores `e.target.value` / `toIsoLocal()` = **ISO**, regardless of what the box displays. Formatted output is one-way render only; nothing is written back to DB/API as a display string.
- **Conclusion:** display formatting is fully decoupled from data. Changing display cannot break any parse/consume/import/submit path.

**B. Are GST / Tally / regulatory exports isolated from display code?** → **Yes, fully isolated.**
| Path | Function | Format | Isolated |
|---|---|---|---|
| IRN/EWB (NIC) | `payloadBuilders.ts:179` private `formatDate` (date-fns) | `dd/MM/yyyy` | YES |
| Tally XML | `tallyExportService.ts:75` `tallyDate` | `YYYYMMDD` (UTC) | YES |
| GST filing xlsx | `gstFilingExportService.ts:59` `d()` | `YYYY-MM-DD` | YES |
| Invoices CSV | `invoices.ts:134` inline | `YYYY-MM-DD` | YES |
- **Zero** shared code between any regulatory path and the display/PDF formatters. A display change provably cannot reach them.
- Bonus: NIC already mandates `dd/MM/yyyy`, so our target matches what GST invoices already show — but the paths stay independent regardless.
- **One guardrail:** never standardise by globally wrapping `date-fns` — the IRN builder calls `date-fns` `format` directly. Standardise at the app-helper/component level only (the normal approach). A CI guard + the existing `gst-payload-shape` tests enforce this.

## Architecture — one shared formatter, display-only

Add to `@gaslink/shared` (alongside the existing `localTodayISO`/`localDateISO`, which stay for input VALUES):
- `formatDisplayDate(input: string | Date | null | undefined): string` → `dd/MM/yyyy` (local TZ; returns `—` for null/invalid). Accepts an ISO string or a Date; **never** re-parses a display string.
- `formatDisplayDateTime(input): string` → `dd/MM/yyyy, hh:mm a`.

Everything routes through these. Input values keep using `localDateISO`/native `.value` (ISO) — untouched.

## Impact — how many places, upstream/downstream

| Area | Change | Sites | Risk |
|---|---|---|---|
| `@gaslink/shared` | add 2 formatters | 1 file | none (additive) |
| **Web display** | replace ~90 inline `toLocaleDateString` + 6 local helpers → `formatDisplayDate` | ~96 | low (render-only) |
| **Web report tables** | tag date columns `date:true` in report column defs (backend) + format `date` columns in the web table renderer (like existing `money:true`) — **this fixes the `2026-07-12` screenshot** | ~40 column defs + 1 renderer | low |
| **Mobile display** | point `theme.formatDate` → shared; kill 6 local variants + ~12 bare `toLocale*` calls | ~20 | low |
| **PDF (customer-facing)** | `pdfLayoutUtils.formatDate` `DD-MMM-YYYY` → `dd/MM/yyyy`; drop customer-ledger `formatDateCompact` `D/M/YY` → `dd/MM/yyyy`; fold in the quotation duplicate | 3 fns → all PDFs | **medium — customer-visible; snapshot-test + re-run GST tests to prove isolation** |
| `reportsService.dayKey` | (recommended) UTC → local-TZ (`localDateISO`) to fix anti-pattern #21 day-drift so reports match PDFs | 1 fn | medium — changes grouping near IST midnight (a correctness fix); needs test review |
| **Native date inputs** | (optional Phase 7) custom picker to show `dd/MM/yyyy` in the box — **pure UI, value stays ISO, zero data risk** | ~40 | low but larger effort |
| GST / Tally / exports | **OUT OF SCOPE — do not touch** | 0 | — |

## Testing strategy (can't-afford-mistakes)

1. **Unit** — `formatDisplayDate`/`formatDisplayDateTime`: null/undefined/invalid, ISO string, Date, zero-pad single-digit d/m, year-boundary, IST vs UTC midnight, leap day.
2. **GST regression (critical)** — run `gst-payload-shape.test.ts` + the full `gst-*` suite unchanged; assert IRN/EWB dates still `dd/MM/yyyy` from the NIC builder — proves we never touched regulatory formatting.
3. **Report wire-shape guard** — date columns still emit `YYYY-MM-DD` in JSON/CSV (data contract unchanged); only the rendered table shows `dd/MM/yyyy`.
4. **PDF checks** — assert invoice PDF + customer ledger PDF render `dd/MM/yyyy` (add/extend PDF tests).
5. **CI guard** — ban raw `toLocaleDateString`/`toLocaleString` for display + ban wrapping `date-fns` globally (same style as the anti-pattern #21 TZ guard).
6. **Green gates** — full suite (1553), typecheck, lint green after each phase.
7. **Manual** — browser-verify 3–4 screens + open an invoice PDF and a customer ledger PDF.

## Recommended rollout (phased, gate between each)
1. Shared formatters + unit tests.
2. Reports (date:true flag + renderer) — fixes the screenshot; low risk.
3. Web display sweep.
4. Mobile sweep.
5. PDFs (customer ledger + invoice) — snapshot + GST regression.
6. CI guard.
7. (Optional) custom web date-picker for input-box display.

Each phase is independently shippable and green-gated. GST/Tally/export code is never edited.

## Confirmations needed before Phase 1
- **Report CSV**: keep dates as `YYYY-MM-DD` in the downloadable CSV (Excel-safe / re-import-safe) while the on-screen table shows `dd/MM/yyyy`? (Recommended: yes — CSV stays ISO.)
- **`reportsService.dayKey` UTC→local fix**: include now (correctness) or leave for a separate change to keep this purely cosmetic?
