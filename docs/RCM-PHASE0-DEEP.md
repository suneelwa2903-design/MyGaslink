# RCM Fix — Phase 0 Deep Investigation

**Date:** 2026-07-10
**Distributor:** Vanasthali Gas Service (`6a749f20-5a82-4b74-9977-51eac69049f2`)
**Scope:** 7 invoices dated 2026-07-09 (inside 24h NIC cancel window)
**Status:** Phase 0 complete. **STOP HERE.** No code or DB changed. Waiting for Suneel go-ahead.

---

## STOP-THE-PRESSES FINDINGS — read this section first

The brief assumes we can call `cancelAndRegenerateInvoice` and just guard the ledger. Wrong — the function has **five defects**, three of them silent, that would break every one of the 7 rows on this run.

| # | Bug | What breaks | Where |
|---|---|---|---|
| **1** | **No `cancelEwb` call before `cancelIrn`** | `cancelIrn` throws `EWB_ACTIVE` (hard gate at `gstService.ts:964-978`); the `try/catch` on `gstService.ts:1447-1451` SWALLOWS it. Invoice's `irn_status` stays `'success'` in our DB and at NIC. Then flow proceeds: old IRN not cancelled at NIC, new IRN created. **NIC ends up with TWO live IRNs for the same delivery.** | [gstService.ts:1446-1451](packages/api/src/services/gst/gstService.ts:1446) |
| **2** | **Phantom ledger** (the exact bug the brief flags) | `createInvoiceFromOrder` writes a NEW debit at `amountDelta = totalAmount`. Old ledger row untouched. Customer's running balance shows DOUBLE for every reissue. | [invoiceService.ts:365-377](packages/api/src/services/invoiceService.ts:365) + [gstService.ts:1461-1464](packages/api/src/services/gst/gstService.ts:1461) |
| **3** | **New invoice dated `NOW()` not original `issueDate`** | `createInvoiceFromOrder` sets `issueDate = options?.issueDateOverride ?? new Date()`. `cancelAndRegenerateInvoice` passes no override. New invoice reads today (2026-07-10) instead of 2026-07-09. Ledger `entry_date` also becomes today. | [invoiceService.ts:186](packages/api/src/services/invoiceService.ts:186) |
| **4** | **No transaction wrapping the outer flow** | `cancelIrn` runs outside `$transaction`; if NIC succeeds but the `createInvoiceFromOrder` fails, orphan cancelled IRN with no reissue. | [gstService.ts:1434-1472](packages/api/src/services/gst/gstService.ts:1434) |
| **5** | **`order: { disconnect: true }`** — old invoice detaches from order, but `createInvoiceFromOrder` reads `order.invoice` at least once implicitly. Fragile — works today, breaks if a future PR reads order → invoice inverse relation before the new invoice is created inside the tx. | [gstService.ts:1457](packages/api/src/services/gst/gstService.ts:1457) |

**Conclusion:** the existing function is unsafe for this migration. Building a NEW targeted service (`cancelAndReissueForRcm`) is safer than adding 3 patches to a function that has other callers ([routes/deliveryWorkflow.ts:52](packages/api/src/routes/deliveryWorkflow.ts:52) and [routes/invoices.ts:308](packages/api/src/routes/invoices.ts:308)) whose semantics we don't want to change.

---

## 0A — `gstReissueService.ts` full read (WI-037)

**Answering all 10 questions:**

1. **Cancel EWB before IRN?** ✅ Yes. Line 205-219 (`hasActiveEwb → cancelEwb`), line 224-251 (`cancelIrn` after). Non-fatal on EWB fail, hard-fail on IRN cancel fail.
2. **DB tables written after cancel:** `invoices` (status, irnStatus, ewbStatus), `gst_documents` (ewbStatus, ackDate, cancelledAt).
3. **DB tables written when creating the new invoice:** *NONE* — this service updates the SAME invoice in place. `invoiceItem.update()` for quantities. Then `invoice.update()` for totals. Then `invoiceRevision.create()` for audit.
4. **Ledger:** **NOT TOUCHED.** WI-037 is a delivery-mismatch reissue — quantities change but the invoice_id stays the same so the existing ledger row's `amountDelta` is stale (this is a known separate bug, not what we're solving today).
5. **Payment allocations:** untouched — same `invoice_id`, allocations stay attached.
6. **New invoice number:** **`RVGS...` (R-prefix, revision).** Line 518-522: `freshRevisionNumber(...)` → calls `allocateNumber(tx, distributorId, 'R', new Date(), docCode)`. **The user's brief demands `IVGS...` — this service will not produce that.**
7. **Inventory:** untouched. The delivery events were already written at `deliveryWorkflowService.confirmDelivery` time keyed on `order_id`, not `invoice_id`.
8. **Driver assignment:** untouched.
9. **Order date / delivery date:** untouched.
10. **`issue_date`:** untouched. The original `invoice.issueDate` remains.

**Verdict on WI-037 for our use case:** wrong tool. Prefix is `R`, and it edits-in-place (leaving one ledger row that then represents a "cancelled" doc — muddies audit trail).

---

## 0B — `cancelAndRegenerateInvoice` full read

**File:** [gstService.ts:1434-1472](packages/api/src/services/gst/gstService.ts:1434)

**Full source:**
```ts
export async function cancelAndRegenerateInvoice(
  invoiceId: string,
  distributorId: string,
  userId: string,
  orderId: string
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { irn: true, irnStatus: true, ewbStatus: true },
  });

  // If IRN was generated, cancel it first
  if (invoice?.irn && invoice.irnStatus === 'success') {
    try {
      await cancelIrn(invoiceId, distributorId, 'Order items changed - regenerating invoice', '4');
    } catch (err: unknown) {
      logger.warn('Failed to cancel IRN during regeneration', { invoiceId, error: errInfo(err).message });
    }
  }

  // Cancel the invoice and unlink from order (so new invoice can be created)
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'cancelled', deletedAt: new Date(), order: { disconnect: true } },
  });

  // Create new invoice from order
  const { createInvoiceFromOrder } = await import('../invoiceService.js');
  const newInvoice = await prisma.$transaction(async (tx) => {
    return createInvoiceFromOrder(tx, orderId, distributorId, userId);
  });

  // Process GST for new invoice
  if (newInvoice) {
    await processInvoiceGst(newInvoice.id, distributorId);
  }

  return newInvoice;
}
```

**Confirm phantom ledger bug present?** ✅ **YES.**
- No reversal write for old invoice's `customer_ledger_entries` row before soft-delete.
- `createInvoiceFromOrder` (line 340-377 of invoiceService.ts) unconditionally writes a fresh ledger row with `amountDelta = totalAmount`.
- Net effect on customer running balance: **DOUBLED** by the amount of the invoice.

**Ledger write site:** [invoiceService.ts:365-377](packages/api/src/services/invoiceService.ts:365):
```ts
await tx.customerLedgerEntry.create({
  data: {
    distributorId,
    customerId: order.customerId,
    entryType: 'invoice_entry',
    referenceId: invoice.id,
    invoiceId: invoice.id,
    amountDelta: totalAmount,
    narration: `Invoice ${invoiceNumber} for order ${order.orderNumber}`,
    entryDate: issueDate,           // ← issueDate is today by default
    createdBy: userId,
  },
});
```

**All ledger-write sites in code** (grep `customerLedgerEntry.create` — 4 hits):
| Site | Purpose |
|---|---|
| [invoiceService.ts:365](packages/api/src/services/invoiceService.ts:365) | `createInvoiceFromOrder` — invoice_entry (this is the one that fires on reissue) |
| [invoiceService.ts:519](packages/api/src/services/invoiceService.ts:519) | `createManualInvoice` — invoice_entry |
| [invoiceService.ts:662](packages/api/src/services/invoiceService.ts:662) | Credit Note issue — credit_note |
| [invoiceService.ts:783](packages/api/src/services/invoiceService.ts:783) | Debit Note issue — debit_note |

**`LedgerEntryType` enum** ([schema.prisma:309-321](packages/api/prisma/schema.prisma:309)) accepts: `invoice_entry`, `credit_note`, `debit_note`, `payment_entry`, `adjustment`, `empties_return`. **No `invoice_reversal` type exists.** We must use `adjustment` (or `credit_note`) for the reversal write — recommending `adjustment` with narration `"RCM correction — invoice IVGS... cancelled"` to keep it out of the CN flow.

---

## 0C — Inventory update flow for delivered orders

**Trigger:** `deliveryWorkflowService.confirmDelivery` (customer-portal path) and driver-side delivery confirm.

**Events written on delivery** ([deliveryWorkflowService.ts:170-198](packages/api/src/services/deliveryWorkflowService.ts:170)):
```ts
await createInventoryEvent(tx, {
  eventType: 'delivery',
  fullsChange: -ci.confirmedDelivered,
  eventDate: order.deliveryDate,       // ← keyed on order.deliveryDate
  referenceId: orderId,                 // ← keyed on ORDER, not invoice
  referenceType: 'order',
  ...
});
```

**Answers:**
1. **Was inventory already debited when these 7 orders were delivered?** ✅ YES. Each order has `dispatch`+`delivery`+`collection` events keyed on `order_id`.
2. **If we cancel the invoice (NOT the order), does inventory re-credit incorrectly?** **NO.** No path re-credits inventory when an invoice is cancelled. The `order.status='delivered'` stays; delivery events untouched.
3. **If we re-raise the invoice, does a second inventory debit fire?** **NO.** `createInvoiceFromOrder` writes no inventory events — see grep confirmation below.
4. **Net:** inventory should be **completely untouched** by this operation. ✅

**Verified by grep:** `createInventoryEvent` is NOT called from `invoiceService.ts` or `gstService.ts` at all. Only from `deliveryWorkflowService.ts`, `orderService.ts` (cancel paths), `stockMismatchService.ts`, `emptiesReturnService.ts`, `backdatedAdjustmentService.ts`. Reissue is safe.

---

## 0D — Driver assignment tables

**No `driver_assignments` table exists.** The brief's SQL will fail. Two real tables serve this purpose:

1. **`orders.driver_id + orders.vehicle_id`** — the direct assignment on each order (what the driver mobile reads).
2. **`driver_vehicle_assignments` (DVA)** — the trip-level assignment linking driver + vehicle + `assignment_date` + `trip_number`. See [schema.prisma:1014](packages/api/prisma/schema.prisma:1014).

**Does reissue touch either?** **NO.**
- `cancelAndRegenerateInvoice` doesn't touch `orders` beyond the `disconnect` (which unsets `orders.invoice`, not `orders.driver_id`).
- `createInvoiceFromOrder` reads from the order but writes only to `invoices`, `invoice_items`, `customer_ledger_entries`, `invoice_counters`.
- DVAs are trip records — completely separate from invoicing.

**Verified for 7 orders — driver + vehicle intact:**
```
IVGS2627000262 → driver 4318e2fc / vehicle 72fe1c7d (delivery 2026-07-09)
IVGS2627000265 → driver 4318e2fc / vehicle 72fe1c7d
IVGS2627000268 → driver 4318e2fc / vehicle 72fe1c7d
IVGS2627000270 → driver 4318e2fc / vehicle 72fe1c7d
IVGS2627000277 → driver 1da127b3 / vehicle 569d457c
IVGS2627000278 → driver 1da127b3 / vehicle 569d457c
IVGS2627000288 → driver 1da127b3 / vehicle 569d457c
```

2 drivers, 2 vehicles, 2 trips — 4 orders on trip A, 3 on trip B. All will remain assigned exactly as they are.

---

## 0E — Full state snapshot of all 7 invoices

### Invoice state
```
+----------------+------------+------------+-------------+--------+------------+------------+--------------+
| invoice_number |   issued   |   total    | outstanding | status | irn_status | ewb_status | order_status |
+----------------+------------+------------+-------------+--------+------------+------------+--------------+
| IVGS2627000262 | 2026-07-09 | 54247.0000 | 54247.0000  | issued | success    | active     | delivered    |
| IVGS2627000265 | 2026-07-09 |  3191.0000 |  3191.0000  | issued | success    | active     | delivered    |
| IVGS2627000268 | 2026-07-09 | 31910.0000 | 31910.0000  | issued | success    | active     | delivered    |
| IVGS2627000270 | 2026-07-09 |  6382.0000 |  6382.0000  | issued | success    | active     | delivered    |
| IVGS2627000277 | 2026-07-09 | 63820.0000 | 63820.0000  | issued | success    | active     | delivered    |
| IVGS2627000278 | 2026-07-09 | 25528.0000 | 25528.0000  | issued | success    | active     | delivered    |
| IVGS2627000288 | 2026-07-09 |  9573.0000 |  9573.0000  | issued | success    | active     | delivered    |
+----------------+------------+------------+-------------+--------+------------+------------+--------------+
Sum total: ₹1,94,651.00 | Sum outstanding: ₹1,94,651.00 (all unpaid)
```

### Ledger entries (all clean, one debit each)
```
+----------------+------------+------------+------------+
| invoice_number | entry_type |   delta    | entry_date |
+----------------+------------+------------+------------+
| IVGS2627000262 | invoice    | 54247.0000 | 2026-07-09 |
| IVGS2627000265 | invoice    |  3191.0000 | 2026-07-09 |
| IVGS2627000268 | invoice    | 31910.0000 | 2026-07-09 |
| IVGS2627000270 | invoice    |  6382.0000 | 2026-07-09 |
| IVGS2627000277 | invoice    | 63820.0000 | 2026-07-09 |
| IVGS2627000278 | invoice    | 25528.0000 | 2026-07-09 |
| IVGS2627000288 | invoice    |  9573.0000 | 2026-07-09 |
+----------------+------------+------------+------------+
Total customer receivable adjustment scope: ₹1,94,651
```

### Payment allocations
**ZERO.** No customer has paid these yet. Excellent — no allocation surgery needed.

### EWB detail (critical timing!)
```
+----------------+--------------+---------------------+-----------+
| invoice_number |    ewb_no    |   ewb_valid_till    | is_latest |
+----------------+--------------+---------------------+-----------+
| IVGS2627000262 | 192482289964 | 2026-07-10 18:29:00 | t         |
| IVGS2627000265 | 102482289983 | 2026-07-10 18:29:00 | t         |
| IVGS2627000268 | 102482290000 | 2026-07-10 18:29:00 | t         |
| IVGS2627000270 | 162482290011 | 2026-07-10 18:29:00 | t         |
| IVGS2627000277 | 182482296974 | 2026-07-10 18:29:00 | t         |
| IVGS2627000278 | 192482296980 | 2026-07-10 18:29:00 | t         |
| IVGS2627000288 | 172482297015 | 2026-07-10 18:29:00 | t         |
+----------------+--------------+---------------------+-----------+
```

**Every EWB expires today at 18:29 IST (~19 minutes from now if you kick off during the current session at 09:40 IST — plenty of time).** After 18:29 IST, EWB cancellation requires manual NIC portal action.

Also — the 24hr IRN cancel window is anchored to `created_at`. Oldest of the 7 = 2026-07-09 15:32 IST → deadline **2026-07-10 15:32 IST** (~6 hours from now).

**Both windows are tight but not immediate.** Plenty of time for Phase 1 sandbox verify + Phase 2 batch, provided we don't spend the day investigating more.

---

## Recommended Phase 2 implementation

**Do not call `cancelAndRegenerateInvoice`.** Build a new one-shot script that:

### `scripts/rcm-reissue-vanasthali-24h.ts`

Not a service — a one-shot script. Reasons:
- Only run once for these 7 invoices ever
- Zero risk of breaking other callers of `cancelAndRegenerateInvoice`
- Failure mode is per-invoice (log + move on), which is what the brief asks for

### For each invoice (7 iterations):

```
Step A: cancelEwb(invoiceId, dist, "RCM classification correction", "4")
        Wait for WhiteBooks success
        Assert invoices.ewb_status='cancelled' in DB

Step B: cancelIrn(invoiceId, dist, "RCM classification correction", "4")
        Wait for WhiteBooks success  
        Assert invoices.irn_status='cancelled' in DB
        (guard test: EWB-active throw would have prevented this if step A failed)

Step C (single Prisma $transaction):
  - Load original invoice + items + issueDate + totalAmount
  - Update old invoice: status='cancelled', deletedAt=NOW
  - Write REVERSAL ledger entry:
      entryType='adjustment'
      amountDelta = -totalAmount
      entryDate = original.issueDate       (= 2026-07-09)
      invoiceId = original.invoiceId
      narration = `RCM correction: Invoice ${old_number} cancelled — reissued as ${new_number}`
  - Allocate new number: allocateNumber(tx, distId, 'I', new Date(), 'VGS') → IVGS2627000XXX
  - Copy invoice_items from old to new (same qty, unit price, discount, gst rate, total)
  - Create new invoice:
      invoiceId = new UUID
      invoiceNumber = new IVGS...
      orderId = ORIGINAL order_id
      issueDate = original.issueDate       (= 2026-07-09)
      dueDate = original.dueDate
      totalAmount, cgstValue, sgstValue, igstValue, taxableValue — copied
      status='issued', irnStatus='pending', ewbStatus='pending'
      outstandingAmount = totalAmount (no payments were allocated per 0E-3)
      reverseCharge = false
      customerGstinSnapshot = copied
      poNumber = copied
  - Write NEW ledger debit:
      entryType='invoice_entry'
      amountDelta = totalAmount
      entryDate = original.issueDate       (= 2026-07-09) ← not today
      invoiceId = new.invoiceId
      narration = `Invoice ${new_number} for order ${order.orderNumber} — reissued from ${old_number}`

Step D (outside tx): processInvoiceGst(newInvoice.id, distId)
        Generates new IRN with RegRev='N' (Phase 1 code fix must be live)
        Assert gst_api_logs.request_payload TranDtls.RegRev = 'N'

Step E (outside tx): if original had EWB → generateEwbFromIrn on the new IRN
        Assert new gst_documents.ewb_no populated
        (Phase 0E-5 confirmed all 7 had active EWBs → all 7 get new EWBs)

Step F: Log to docs/RCM-RERAISED-LOG.md
```

### Ledger net effect per invoice (worked example — IVGS2627000262, ₹54,247)

| Before | Change | After |
|---|---|---|
| Invoice IVGS...262 → +₹54,247 (2026-07-09) | REVERSAL: −₹54,247 (2026-07-09) → running balance flat | Old invoice cancelled, ledger neutral |
| — | NEW debit: +₹54,247 (2026-07-09, new invoice) | Customer owes exactly ₹54,247 for the same delivery — dated the same day |

**Running balance for the customer is invariant.** No double-charge. Buyer's ledger PDF shows an "adjustment" row + a new invoice row, dated same day, netting to the original amount owed.

---

## Blockers I need Suneel to confirm before Phase 1

1. **Buyer physical PDF mismatch.** All 7 orders are `delivered`. The buyer received the original `IVGS...` PDF via email (or print) yesterday. After reissue, our DB says `IVGS...NEW`; they hold `IVGS...OLD`. Options:
   - **A** (recommended) — after reissue completes, WhatsApp/email each buyer the new PDF with a note: "Our invoice IVGS...OLD dated 09-Jul was replaced by IVGS...NEW (same amount, same date, tax classification correction). Please update your records — the OLD one carried an incorrect Reverse Charge flag."
   - **B** — reuse the OLD `invoiceNumber` on the NEW invoice row (impossible — NIC returns 2278 for cancelled doc numbers, per code comment at [gstReissueService.ts:496-503](packages/api/src/services/gst/gstReissueService.ts:496)).
2. **NIC 5002 / retry.** Cancel and regenerate calls hit NIC live. If NIC is having a 5002 day, we might strand an invoice mid-cycle. The per-invoice transaction handles this but the batch may have partial success. Acceptable? Yes per brief step 10 ("Do NOT abort entire batch").
3. **New service vs. patch.** I recommend building a one-shot script `scripts/rcm-reissue-vanasthali-24h.ts` rather than modifying `cancelAndRegenerateInvoice` (which has 2 other callers we don't want to touch). Confirm you're OK with a script.

---

## What Phase 1 changes

Just the code fix:
- `RegRev: 'Y'` → `'N'` in [payloadBuilders.ts:289](packages/api/src/services/gst/payloadBuilders.ts:289)
- Guard test in `gst-payload-shape.test.ts` — B2B AND B2C both pin `RegRev='N'`
- Full test suite must pass
- Sandbox verify against Sharma sandbox before deploy

Nothing else in Phase 1.

---

## Files & prod facts cited

- Bug site: [payloadBuilders.ts:289](packages/api/src/services/gst/payloadBuilders.ts:289)
- Reissue-in-place: [gstReissueService.ts:90-475](packages/api/src/services/gst/gstReissueService.ts:90) — R prefix
- Cancel + regenerate: [gstService.ts:1434-1472](packages/api/src/services/gst/gstService.ts:1434) — 5 bugs
- Ledger write site: [invoiceService.ts:365-377](packages/api/src/services/invoiceService.ts:365)
- Delivery inventory events: [deliveryWorkflowService.ts:170-198](packages/api/src/services/deliveryWorkflowService.ts:170)
- EWB active gate on cancelIrn: [gstService.ts:964-978](packages/api/src/services/gst/gstService.ts:964)
- Numbering: [numberingService.ts](packages/api/src/services/numberingService.ts) — allocateNumber(type='I')
- Prod state timestamp: 2026-07-10 04:10 UTC (09:40 IST)
- EWB expiry deadline: 2026-07-10 18:29 IST for all 7
- IRN cancel deadline: 2026-07-10 15:32 IST for the oldest of the 7

**No code or DB rows were modified during Phase 0 deep. Prod tmp file `/tmp/pm2.json` (contained DB creds) removed from EC2 after use.**
