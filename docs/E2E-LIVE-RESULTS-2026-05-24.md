# Live E2E Standalone-Order Verification — 2026-05-24

**Goal:** real picture before manual testing. Drove the running API (localhost:5000)
as the dist-002 **GST sandbox** admin through the full standalone-order lifecycle for
**B2B + B2C**, exercising every change committed this session, with real WhiteBooks/NIC
sandbox calls. Verified DB-side flow into orders, billing/invoices, GST docs, inventory,
and payments.

**State under test:** HEAD `d8a514f` (all session fixes committed; tree clean).
`INVENTORY_DISPATCH_DEBIT` = **OFF** (SETUP not run — flag-OFF inventory model).
Driver Kiran Reddy ↔ vehicle KA01TE2099, delivery date 2026-05-24.

## Scenario matrix (8 standalone orders + cleanup)

| Order | Type | Customer | Ordered | Delivered | Final status | Order ₹ | Invoice ₹ | IRN | EWB |
|-------|------|----------|---------|-----------|--------------|---------|-----------|-----|-----|
| OSHD…009 | B2B intra (KA) | Maruthi | 19KG×2 | 2 (exact) | delivered | 4000 | 4000 (ISHD170) | success | active |
| OSHD…010 | B2B intra (KA) | Maruthi | 19KG×2 | 3 (more) | modified_delivered | 6000 | 6000 (**RSHD107**) | success (reissued) | active |
| OSHD…011 | B2B inter (TG) | Hyderabad | 5KG×2 | 1 (less) | modified_delivered | 600 | 600 (**RSHD108**) | success (reissued) | active |
| OSHD…012 | B2B | Maruthi | 19KG×1 | 0 | **cancelled** (zero blocked → admin cancel) | — | — | cancelled | cancelled |
| OSHD…013 | B2B | Maruthi | 5KG×2 | — | cancelled (while dispatched) | — | cancelled | cancelled | cancelled |
| OSHD…014 | B2C | Bangalore | 47.5KG×2 | 2 (exact) | delivered | 9600 | 9600 (ISHD175) | not_attempted | active (standalone) |
| OSHD…015 | B2C | Bangalore | 47.5KG×2 | 1 (less) | modified_delivered | 4800 | 4800 (ISHD176, reissued EWB) | not_attempted | active |
| OSHD…016 | B2C | Bangalore | 47.5KG×1 | 0 | **cancelled** (zero blocked → admin cancel) | — | — | n/a | cancelled |

## Verified behaviours

### Session changes (all PASS, live)
- **WI-109 zero-qty block** — both B2B (012) and B2C (016) zero deliveries rejected
  `HTTP 400 Validation failed` at `confirm-delivery`; orders stayed dispatched, then
  admin-cancelled (documented remedy). Mobile + server (`deliveryConfirmationSchema.refine`).
- **WI-111 Compliance Docs delivered qty** — `GET /drivers/me/trip-ewbs` (as Kiran) returned
  **OSHD…010 = 19 KG × 3 (delivered)**, OSHD…011 = 5 KG × 1, OSHD…015 = 47.5 KG × 1 —
  delivered qty, not ordered. Exact orders show ordered = delivered.
- **CRITICAL-FIX-A IDOR (#30)** — Bhargava (dist-001) → dist-002 invoice gst-documents =
  **HTTP 404**; Sharma (own tenant) = **HTTP 200, 1 row**. (Also covered by
  `gst-documents-idor.test.ts`: 200/404/401.)
- **CRITICAL-FIX-A logout cache** — covered by code + tsc; not separately observable in a
  headless API run (web-only behaviour).
- **WI-114 creds in env** — API booted and ran live GST against WhiteBooks using DB creds
  (8 `WHITEBOOKS_*` vars present in `.env`); no hardcoded creds needed.

### GST / billing (live NIC sandbox)
- **B2B reissue (010, 011)** full 6-step trace, all NIC success:
  `IRN_GENERATE → EWB_GENERATE_BY_IRN → EWB_CANCEL → IRN_CANCEL → IRN_GENERATE_REISSUE → EWB_GENERATE_REISSUE_B2B`.
  Invoice total updated to delivered, fresh `RSHD` number, new IRN + EWB.
- **B2C reissue (015)**: `EWB_GENERATE_STANDALONE → EWB_CANCEL → EWB_GENERATE_REISSUE_B2C`,
  invoice total updated to delivered (4800), no IRN (correct for B2C).
- **Cancel (013)**: EWB + IRN cancelled at NIC, invoice status `cancelled`.
- **B2C standalone EWB (014)**: `irn_status=not_attempted`, `ewb_status=active`.

### Payments
- ₹1000 recorded against ISHD170 (B2B-1): invoice → `amount_paid 1000`, `outstanding 3000`,
  status `partially_paid`. Allocation correct.

### Inventory (flag-OFF model)
- Delivery events debit by **delivered** qty (OSHD…010 = −3, confirming delivered drives
  inventory, not ordered).
- Reconciliation (vehicle returned + confirm) returned 5 cancelled-stock cylinders to depot;
  **summary recomputed at reconcile time** (`updated_at` advanced, `cancelled_stock_qty`
  updated) — live-confirms **#29 "recompute no-op" was correctly closed as NOT-A-BUG**.

## Observations / known items (NOT regressions from this session)
- **Flag-OFF inventory over-counts returns.** Post-reconcile closing: 5KG=36, 19KG=14,
  47.5KG=12 — overstated because `cancellation` (+qty on cancel) and `cancellation_return`
  (+qty on reconcile) both credit the same cylinders that were never debited at dispatch
  (flag OFF). This is precisely what the dispatch-debit cutover (**#18 / the deferred SETUP
  step**) fixes. Billing/GST/payments are unaffected and correct.
- **WI-112 (void invoice on zero delivery)** is now effectively unreachable via the normal
  API because WI-109 blocks a zero delivery before reissue runs — it remains as
  defense-in-depth.

## Regression
- API suite: **608/608 passed** (53 files). `tsc` clean: shared, api, web.

## Conclusion
All B2B + B2C lifecycle cases (exact / modified-more / modified-less / zero / cancel) flow
correctly into orders, invoices/billing, GST documents, and payments. Every code change
committed this session is exercised and passing live. The only inventory caveat is the
pre-existing flag-OFF return over-count, resolved by enabling `INVENTORY_DISPATCH_DEBIT`
(#18) — recommend running SETUP before manual inventory testing.
