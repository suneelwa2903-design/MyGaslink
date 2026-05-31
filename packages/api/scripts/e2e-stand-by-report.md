E2E stand-by run starting — TODAY (IST) = 2026-05-30  TOMORROW = 2026-05-31
API = http://localhost:5000/api  DIST = dist-002

▸ Logging in as sharma@gasdist.com
  ✓ token acquired
▸ Wiping today's transactional data for dist-002
  ✓ wipe done: 0 orders, 0 invoices, 1 payments
▸ Ensuring vehicle mappings for today
  ✓ mappings set

━━━ S1 ━━━
━━━ S2 ━━━
━━━ S3 ━━━
━━━ S4 ━━━
━━━ S5 ━━━
━━━ S6 ━━━
━━━ S7 ━━━
━━━ S8 ━━━
━━━ S9 ━━━
━━━ S10 ━━━

Inline per-scenario summary:
  ✓ S1 B2B normal lifecycle — Hyderabad Caterers
  ✓ S2 Modified delivery RSHD — Maruthi Agencies
  ✓ S3 B2C order — Bangalore Foods
  ✓ S4 Mixed B2B + B2C single trip
  ✓ S5 Cancelled order after dispatch
  ✓ S6 Returns-only order
  ✓ S7 Payment + CN with role gate (admin + finance approve, inventory blocked)
  ✓ S8 Pending Action from NIC failure (invalid vehicle plate)
  ✓ S9 Vehicle Mapping confirm (today) + tomorrow auto-copy
  ✓ S10 Inventory incoming-fulls + lock-summary + GET summary

════════════════════════════════════════════════════════════════════════
E2E STAND-BY REPORT  —  dist-002  —  2026-05-30
════════════════════════════════════════════════════════════════════════

## Data Wipe
  Confirmed: yes
  Invoice scoping field: issueDate
  Records deleted: 0 orders, 0 invoices, 1 payments, 0 inventory_events, 0 inventory_summaries, 0 DVAs, 0 gst_documents, 24 gst_api_logs, 2 cancelled_stock_events, 4 pending_actions, 1 payment_allocations, 0 invoice_items, 0 invoice_revisions, 0 credit_notes, 0 debit_notes, 11 ledger_entries, 0 order_status_logs, 0 driver_assignments, 0 reconciliation_empties, 0 stock_mismatch, 0 vehicle_inventory

## Scenario Results
| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | B2B normal lifecycle — Hyderabad Caterers | PASS | order=OSHD2627000380 (e01f2942) • invoice=ISHD2627005671 irn=1ed59bf383115040… ewb=151012069757 • final: order=delivered invoice=paid outstanding=0 |
| 2 | Modified delivery RSHD — Maruthi Agencies | PASS | order=OSHD2627000381 • initial=ISHD2627005672 irn=efc9a1808e7c… • final order.status=modified_delivered invoice=RSHD2627002156 irn=efc9a1808e7c… |
| 3 | B2C order — Bangalore Foods | PASS | order=OSHD2627000382 • invoice=ISHD2627005673 irn=null ewb=191012069759 • final: order=delivered irn=null ewb=191012069759 |
| 4 | Mixed B2B + B2C single trip | PASS | B2B=OSHD2627000383 B2C=OSHD2627000384 • B2B: irn=d9468449db94 ewb=151012069760 status=pending_delivery • B2C: irn=null ewb=121012069761 status=pending_delivery |
| 5 | Cancelled order after dispatch | PASS | order=OSHD2627000385 • dispatched: invoice=ISHD2627005676 irn=da3023cecb0e ewb=191012069762 • final: order=cancelled irnStatus=cancelled ewbStatus=cancelled |
| 6 | Returns-only order | PASS | order=OSHD2627000386 orderType=returns_only status=pending_driver_assignment |
| 7 | Payment + CN with role gate (admin + finance approve, inventory blocked) | PASS | target invoice=ISHD2627005671 total=4000 outstanding=0 status=paid • CN created=CSHD2627000258 (2236e54d) status=pending amount=₹400 • admin approve HTTP 200 • finance approve HTTP 200 (expected 200 per STEP-1A) • inventory approve HTTP 403 (expected 403 per STEP-1A) |
| 8 | Pending Action from NIC failure (invalid vehicle plate) | PASS | mutated KA01-MN-9999 → INVALIDPLATEXYZ999 • order=OSHD2627000387 • preflight HTTP 200 • pending_actions for this invoice/order: 1 • post-preflight: irnStatus=success ewbStatus=failed ewbNo=null • top PA: type=EWB_GENERATION status=open desc="Invoice ISHD2627005677 for Hyderabad Caterers: e-Way Bill generation failed unexpectedly. Click Retry to attempt again." • (description is generic "failed unexpectedly" — anti-pattern #11) • cleanup: reverted plate → KA01-MN-9999 |
| 9 | Vehicle Mapping confirm (today) + tomorrow auto-copy | PASS | today HTTP 200 confirmed=1 • tomorrow HTTP 200 confirmed=1 copiedFromPrevious=undefined • cleanup: removed 2 tomorrow DVA rows |
| 10 | Inventory incoming-fulls + lock-summary + GET summary | PASS | incoming-fulls HTTP 201 • lock-summary HTTP 200 • summary rows=4 • 19KG: incomingFulls=100 closingFulls=398 isLocked=true |

## Any failures or surprises
- (none) all 10 scenarios passed

## Awaiting Suneel's manual testing feedback before any further commits.
