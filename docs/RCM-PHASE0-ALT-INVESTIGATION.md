# RCM Phase 0 — ALT investigation: reuse On-Demand invoice flow?

**Question:** *"Can I use existing On-Demand order flow (after manually cancelling the old 7 invoices) instead of building a new cancel-and-reissue script?"*

**Short answer:** Technically yes. But the manual cancel is 4 SQL statements per invoice (28 total) plus one WhatsApp per buyer explaining why they have TWO orders on 09-Jul. The "manual" part is not a shortcut — it's identical work to what the script would automate. And it introduces a new failure mode: the buyer's records now show two orders for one physical delivery, forever.

**Read this alongside** [docs/RCM-PHASE0-DEEP.md](RCM-PHASE0-DEEP.md).

---

## How the On-Demand path works

**File:** [packages/api/src/services/backdatedOrderService.ts:39](packages/api/src/services/backdatedOrderService.ts:39) (`createBackdatedOrder`)

**What it does inside a single `$transaction`:**
1. Allocate NEW order number via `allocateNumber(tx, distId, 'O', issueDate, 'VGS')` → `OVGS2627000XXX`
2. Create NEW `orders` row: `status='delivered', isBackdated=true, orderDate=deliveryDate=deliveredAt=2026-07-09, driverId+vehicleId as passed`
3. Write `orderStatusLog` entry: "Backdated order created for 2026-07-09"
4. Call `createInvoiceFromOrder(tx, order.id, dist, userId, { issueDateOverride: 2026-07-09 })` — creates:
   - NEW `invoices` row: `invoiceNumber = IVGS2627000XXX (fresh)`, `issueDate = 2026-07-09` ✓
   - NEW `customer_ledger_entries` row: `entryType='invoice_entry', amountDelta = totalAmount, entryDate = 2026-07-09` ✓
5. **Post-commit fire-and-forget** `processInvoiceGst(invoice.id, dist)` → new IRN + EWB with `RegRev='N'` (after Phase 1 lands).
6. Comment at line 33 confirms: **"NO inventory events. NO CustomerInventoryBalance update. By design."**

**Auto-apply-inventory checkbox (Q2 fix, earlier this session):** if `applyInventoryAdjustment=true` is passed, a *separate* call to `applyBackdatedInventoryAdjustment` fires — writing `manual_adjustment` + `collection` + `reconciliation_empties_return` events. **Must be UNCHECKED for our use case** (inventory already debited via original delivery events).

---

## What the On-Demand path gives us — feature checklist

| User requirement | On-Demand delivers? |
|---|---|
| New invoice number starts with `I` (not `R`) | ✅ Yes — `IVGS2627000XXX` from next-in-sequence |
| New `issue_date = 2026-07-09` (original) | ✅ Yes — `issueDateOverride` passes through to `createInvoiceFromOrder` line 374 → `entryDate` on ledger too |
| New IRN with `RegRev='N'` | ✅ Yes — after Phase 1 code fix, `processInvoiceGst` uses the fixed builder |
| Same items / qty / amount as original | ✅ Yes — Suneel enters them in the modal exactly as original |
| Ledger dated 2026-07-09 (not today) | ✅ Yes — `entryDate: issueDate` at [invoiceService.ts:374](packages/api/src/services/invoiceService.ts:374) |
| Inventory not touched | ✅ Yes — provided "Also update inventory stock now" checkbox is **UNCHECKED**. Backdated order flow writes zero inventory events by design. |
| Driver + vehicle preserved on new order | ⚠️ Only if Suneel remembers to pick them in the modal for each of 7 |
| New EWB tied to new IRN | ⚠️ Only if vehicle is picked on the new order (EWB gate) |

---

## What the On-Demand path does NOT do — the "manual" part still required

The user's "manual cancellation" of the old 7 invoices is 4 operations per row, not one click. There is **no "Cancel Invoice" web UI button** — the closest thing is `POST /api/invoices/:id/cancel-regenerate` which calls the *buggy* `cancelAndRegenerateInvoice` we identified 5 bugs in.

For each of the 7 old invoices, the manual work is:

```sql
-- (a) Cancel EWB at NIC — requires either portal login OR our cancelEwb() function
--     (portal manual: login → EWB → search by ewb_no → Cancel → reason)
-- (b) Cancel IRN at NIC — same portal path OR our cancelIrn() (only after EWB is cancelled)
-- (c) Reverse the ledger row for the old invoice
INSERT INTO customer_ledger_entries (
  distributor_id, customer_id, entry_type, invoice_id, reference_id,
  amount_delta, entry_date, narration, created_by
) SELECT
  distributor_id, customer_id, 'adjustment', invoice_id, invoice_id,
  -amount_delta, entry_date,
  'RCM correction: Invoice ' || (SELECT invoice_number FROM invoices WHERE invoice_id = cle.invoice_id) || ' cancelled — see On-Demand replacement',
  '<userId>'
FROM customer_ledger_entries cle
WHERE invoice_id = '<old_invoice_id>' AND entry_type = 'invoice_entry';

-- (d) Soft-delete the old invoice + update statuses
UPDATE invoices
   SET status = 'cancelled',
       deleted_at = NOW(),
       irn_status = 'cancelled',
       ewb_status = 'cancelled'
 WHERE invoice_id = '<old_invoice_id>';
```

Multiply by 7 rows. Any typo in an `invoice_id` = wrong ledger reversal. Any order of operations mistake = compliance mess.

**The "manual" isn't manual — it's SQL that does exactly what the script would do, just typed by hand across 7 rows.**

---

## The audit trail problem

### Script approach (docs/RCM-PHASE0-DEEP.md recommendation)
Timeline in the customer's records:
```
09-Jul  Invoice IVGS...OLD    +₹54,247  (cancelled — reversal below)
09-Jul  RCM correction: OLD cancelled  −₹54,247  (adjustment)
09-Jul  Invoice IVGS...NEW    +₹54,247  (reissued from OLD)
```
One order (`OVGS...OLD`), one story, clear reversal.

### On-Demand approach
Timeline in the customer's records:
```
09-Jul  Invoice IVGS...OLD    +₹54,247  (cancelled — needs manual reversal)
09-Jul  RCM correction: OLD cancelled  −₹54,247  (adjustment, manual)
09-Jul  Invoice IVGS...NEW    +₹54,247  (new backdated order OVGS...NEW)
```
**TWO orders now exist** for what was ONE physical delivery. Order status logs on the new one say "Backdated order created for 2026-07-09 by user X on 2026-07-10". Anyone looking at the customer's history 6 months from now sees a mystery duplicate order with no explanation.

Same customer-facing math (running balance identical). But messier internal record for audits/handoffs.

---

## Third option — reuse the ORIGINAL order (no new order at all)

**Cleanest path, if you're OK writing minimal SQL**:

```sql
BEGIN;
-- (a) Cancel EWB via NIC (script or portal)
-- (b) Cancel IRN via NIC (script or portal)
-- (c) Reverse ledger for old invoice
INSERT INTO customer_ledger_entries (...) VALUES (... , -amount_delta, ...);
-- (d) Soft-delete old invoice AND unlink from order
UPDATE invoices SET status='cancelled', deleted_at=NOW() WHERE invoice_id = '<old>';
UPDATE orders  SET invoice_id_removed_via_relation  -- Prisma abstraction, done via disconnect
COMMIT;

-- Then call our existing service: createInvoiceFromOrder(tx, ORIGINAL_order_id, dist, user, {issueDateOverride: '2026-07-09'})
-- Then call processInvoiceGst(new_invoice.id, dist)
```

This uses `createInvoiceFromOrder` on the **original** order — no new `OVGS...` number, no duplicate order in the buyer's history. The order keeps its `driverId` + `vehicleId` so EWB regenerates on the same vehicle. And it's the same underlying code path as On-Demand, minus the "backdated order create" step.

**But** — you still need the 4 manual DB writes per invoice (or a script to automate them). At which point you've built the script the Phase 2 plan proposed, just for a slightly narrower scope.

---

## Comparison — all three approaches head-to-head

| Dimension | Path A: Custom script (Phase 2 plan) | Path B: Manual cancel + On-Demand | Path C: Manual cancel + reuse original order |
|---|---|---|---|
| **Old invoice cancelled at NIC** | Script does it | Manual (portal or ad-hoc script) | Manual (portal or ad-hoc script) |
| **Old ledger reversed** | Script does it | Manual SQL | Manual SQL |
| **New order created** | ❌ No — reuses original | ✅ New `OVGS...` | ❌ No — reuses original |
| **New invoice number** | `IVGS...` next-in-seq ✓ | `IVGS...` next-in-seq ✓ | `IVGS...` next-in-seq ✓ |
| **New `issue_date` = 2026-07-09** | ✓ | ✓ | ✓ |
| **Ledger `entry_date` = 2026-07-09** | ✓ | ✓ | ✓ |
| **New IRN / EWB after Phase 1** | ✓ | ✓ | ✓ |
| **Driver + vehicle preserved** | ✓ automatic | ⚠️ operator must pick each time | ✓ automatic |
| **Inventory double-count risk** | 0 — script doesn't touch | Nonzero — operator must UNCHECK auto-apply | 0 — nothing touched |
| **Audit trail** | One order, clear cancel + reissue | Two orders per delivery ⚠️ | One order, ledger tells the story |
| **Effort per invoice** | 0 after script written | ~2 min UI + 4 SQL writes = ~5 min | ~1 min if scripted, ~5 min if hand-SQL |
| **Failure mode** | Per-tx rollback, per-invoice log | Manual cleanup on any step | Manual cleanup on any step |
| **Total code to write** | ~150 lines (one-shot script) | ~50 lines SQL (batched) | ~30 lines SQL + reuse `createInvoiceFromOrder` |

---

## Recommendation

**Still Path A** (custom script `scripts/rcm-reissue-vanasthali-24h.ts`). Reasons:
1. Zero human error on 4 × 7 = 28 SQL writes.
2. Clean audit trail — one order per delivery.
3. `driver_id` + `vehicle_id` preserved automatically so EWB regenerates correctly.
4. Runs as one batch, failure-per-invoice logged, next continues.
5. Total script ~150 lines. Similar-shape to what you already have in `scripts/backfill-backdated-adjustment-dates.ts` and `scripts/backfill-backdated-collection-events.ts` from earlier this session.

**Path B (On-Demand)** is only faster IF the manual cancel is also automated — at which point you've written 80% of Path A already. And you're left with the duplicate-order audit problem forever.

**Path C (reuse original order)** is Path A minus the "wrapper" — cleaner code, same output. If we build Path A, we should structure it internally as Path C anyway (reuse original order, don't create new one).

---

## What Phase 1 dependency looks like for all three paths

**Every path requires Phase 1 to land FIRST.** Otherwise:
- Path A's regenerated IRN carries `RegRev='Y'` → still lands in 4B → we've done all this work for nothing
- Path B's On-Demand IRN carries `RegRev='Y'` → same
- Path C's reused-order IRN carries `RegRev='Y'` → same

Phase 1 is one line: `RegRev: 'Y'` → `'N'` at [payloadBuilders.ts:289](packages/api/src/services/gst/payloadBuilders.ts:289) + guard test + full suite + sandbox verify. **Land Phase 1 first, regardless of which reissue path you pick.**

---

## What I need from you before proceeding

Still the same as the previous investigation:

1. **Approve Phase 1?** (`RegRev='N'` + guard test + sandbox verify, no push). Universal prerequisite.
2. **Pick a Phase 2 path.** A / B / C — I recommend A.
3. **Buyer PDF comms** — you'll WhatsApp/email each of the 7 buyers with the new invoice PDF and a note about the classification correction? Confirm.

**Nothing pushed. Nothing running. Waiting.**
