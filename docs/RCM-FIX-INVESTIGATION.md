# RCM Fix — Phase 0 Investigation (Read-Only)

**Date:** 2026-07-10
**Distributor:** Vanasthali Gas Service (`distributor_id = 6a749f20-5a82-4b74-9977-51eac69049f2`)
**Prod query wall clock:** `2026-07-10 04:10:18 UTC` (09:40 IST)
**Investigator:** Claude Code
**Status:** Phase 0 complete. **STOP HERE.** No code or DB changed. Waiting for Suneel go-ahead before Phase 1.

---

## Summary — decision-time bottom line

- **Zero invoices are eligible for cancel + re-raise.** All 7 invoices inside the 24-hour NIC cancel window are `order.status = 'delivered'` with **active EWBs** — buyer already has the physical invoice PDF. Cancel-and-re-raise on delivered invoices is a hard no per your brief.
- **58 invoices need GSTR-1 Table 9A amendment** for the July return period. Total: ₹13,75,174.00 taxable, ₹2,09,772.24 GST.
- **`RegRev='Y'` is confirmed live on both prod code and prod payload logs.** Every B2B and B2C IRN generated since day 1 has been misclassified — Vanasthali is only the visible sample.
- **`gstReissueService.ts` (WI-037) already exists** — designed for delivery-mismatch reissue. It emits a fresh `RVGS...` (revision) invoice number, cancels EWB-then-IRN in correct order, writes an `invoice_revisions` audit row. It is NOT designed for RCM classification fix but could technically be re-purposed.
- **No RegRev guard test exists** in `gst-payload-shape.test.ts` (0 matches on grep). The revert on 2026-05-15 deleted it.

---

## 0A — Invoice numbering format

**Code source:** [packages/api/src/services/numberingService.ts](packages/api/src/services/numberingService.ts) (WI-108)

**Format:** `<TYPE:1><CODE:3><FY:4><SEQ:6>` → 14 chars

| Segment | Meaning | Example |
|---|---|---|
| TYPE | `I`=invoice, `R`=revision, `C`=credit-note, `D`=debit-note, `O`=order | `I` |
| CODE | Distributor's 3-letter `doc_code` (uppercase) | `VGS` for Vanasthali |
| FY | Indian FY (Apr-Mar), last 2 digits of each year | `2627` for FY 2026-27 |
| SEQ | Atomic per-(distributor, type, FY) counter, zero-padded to 6 | `000288` |

**Allocation:** atomic upsert-increment on `invoice_counters(distributor_id, type, financial_year)`. Runs inside caller's Prisma `$transaction` so a rollback frees the number (gapless).

**Vanasthali doc_code (prod):** `VGS`. Full example number: `IVGS2627000288`.

### Prod verification — last 10 Vanasthali B2B IRN invoices

```
+----------------+------------+------------+-------------------------+
| invoice_number |   issued   | irn_status |         irn_gen         |
+----------------+------------+------------+-------------------------+
| IVGS2627000288 | 2026-07-09 | success    | 2026-07-09 15:46:25.422 |
| IVGS2627000278 | 2026-07-09 | success    | 2026-07-09 15:46:22.854 |
| IVGS2627000277 | 2026-07-09 | success    | 2026-07-09 15:46:22.394 |
| IVGS2627000270 | 2026-07-09 | success    | 2026-07-09 15:32:53.841 |
| IVGS2627000268 | 2026-07-09 | success    | 2026-07-09 15:32:53.228 |
| IVGS2627000265 | 2026-07-09 | success    | 2026-07-09 15:32:52.386 |
| IVGS2627000262 | 2026-07-09 | success    | 2026-07-09 15:32:51.474 |
| IVGS2627000254 | 2026-07-08 | success    | 2026-07-08 18:02:09.043 |
| IVGS2627000251 | 2026-07-08 | success    | 2026-07-08 18:02:08.199 |
| IVGS2627000245 | 2026-07-08 | success    | 2026-07-08 17:52:17.025 |
+----------------+------------+------------+-------------------------+
```

Format matches. Confirms the code path is live for this distributor.

---

## 0B — Invoices inside the 24-hour NIC cancel window

Filter: `created_at >= NOW() - INTERVAL '24 hours'` on B2B success IRNs.

```
+----------------+--------------------------------+-----------------+----------+--------+----------+--------------+----------------+
| invoice_number |         customer_name          |      gstin      |  total   |  ewb   |   age    | order_status |  order_number  |
+----------------+--------------------------------+-----------------+----------+--------+----------+--------------+----------------+
| IVGS2627000288 | SWAAD KITCHEN                  | 36AFCFS7563K1ZG |  9573.00 | active | 12:24:40 | delivered    | OVGS2627000301 |
| IVGS2627000278 | KINARA GRAND HUBSIGUDA         | 36AALCS0630E1ZM | 25528.00 | active | 12:24:43 | delivered    | OVGS2627000291 |
| IVGS2627000277 | KINARA GRAND AS RAO NAGAR      | 36AALCS0630E1ZM | 63820.00 | active | 12:24:43 | delivered    | OVGS2627000290 |
| IVGS2627000270 | SILVERPLATE NAGOLE             | 36AEMFS5401H1ZY |  6382.00 | active | 12:38:12 | delivered    | OVGS2627000283 |
| IVGS2627000268 | Shah Ghouse Hotel              | 36EMEPM0985A1Z5 | 31910.00 | active | 12:38:12 | delivered    | OVGS2627000281 |
| IVGS2627000265 | SRI VENKATA SAI SWAGRUHA FOODS | 36AEYFS5782F1Z6 |  3191.00 | active | 12:38:13 | delivered    | OVGS2627000278 |
| IVGS2627000262 | Hotel Kinara Grand Ameerpet    | 36AAJCS8144B1ZD | 54247.00 | active | 12:38:14 | delivered    | OVGS2627000275 |
+----------------+--------------------------------+-----------------+----------+--------+----------+--------------+----------------+
Total: 7 rows | ₹1,94,651
```

### Blockers on Phase 2 (cancel + re-raise) for these 7:

| Blocker | Count | Detail |
|---|---:|---|
| Order status = `delivered` | **7/7** | Buyer has already received the physical invoice PDF via email/print. Silent re-raise = document mismatch. **Your brief says: STOP, flag for Suneel.** |
| Active EWB | **7/7** | Every row has `ewb_status='active'`. Requires EWB cancel before IRN cancel (anti-pattern #20 already codified in [gstService.ts:964-978](packages/api/src/services/gst/gstService.ts)). |
| Cancelled EWB | 0 | None already cancelled. |
| Other EWB states | 0 | — |

**All 7 are blocked from Phase 2 by the `delivered` gate.** Phase 2 scope: **0 invoices**.

---

## 0C — Amendment list (>24hr window, July 2026)

Filter: `created_at < NOW() - INTERVAL '24 hours'` AND `issue_date ∈ [2026-07-01, 2026-08-01)`.

```
+------------+----------+--------------+-------------+
|   period   | invoices |    billed    |     gst     |
+------------+----------+--------------+-------------+
| 2026-07-01 |       58 | 1375174.0000 | 209772.2400 |
+------------+----------+--------------+-------------+
```

**58 invoices, ₹13,75,174.00 taxable, ₹2,09,772.24 GST** → Table 9A candidates for July return.

Combined with 0B (7 rows): **July total is still 65 invoices as flagged earlier.** Split:
- 58 → Table 9A amendment (already-baked, past 24h window)
- 7 → also Table 9A (delivered + EWB active means we can't safely re-raise)
- **Net Phase 2 scope: 0. Net Phase 3 (Table 9A) scope: 65.**

---

## 0D — Cancel + re-raise flow in code

### 1. IRN cancellation

**Function:** [`cancelIrn`](packages/api/src/services/gst/gstService.ts:951) at `packages/api/src/services/gst/gstService.ts:951`

Signature:
```ts
cancelIrn(
  invoiceId: string,
  distributorId: string,
  reason: string,
  reasonCode: GstCancelReasonCode,      // '1'..'4' per NIC codes
  userId: string | null = null,
): Promise<void>
```

**Behavior:**
- Loads `Invoice { irn, invoiceNumber, orderId }`. Throws `GstError('NO_IRN')` if no IRN.
- **Hard gate at line 964-978:** looks up latest `GstDocument` with `ewbStatus='active' AND ewbNo IS NOT NULL`. If found, throws `GstError('EWB_ACTIVE', 'Cancel the e-way bill first')`. **This is the anti-pattern #20 enforcement.** Consistent with the brief's rule.
- Calls WhiteBooks `POST /einvoice/cnl` with `{ Irn, CnlRsn: reasonCode, CnlRem: reason.substring(0, 100) }`.
- On success: updates `invoices.irn_status = 'cancelled'`, keeps `irn` value (audit trail), stamps `gst_documents.cancelledAt`.
- Writes to `gst_api_logs` via `apiLogger`.

### 2. EWB cancellation

**Function:** [`cancelEwb`](packages/api/src/services/gst/gstService.ts:1022) at `packages/api/src/services/gst/gstService.ts:1022`

Signature identical shape to `cancelIrn`. Calls WhiteBooks `POST /ewaybillapi/v1.03/ewayapi/canewb` with `{ ewbNo, cancelRsnCode, cancelRmrk }`. Updates `invoices.ewb_status = 'cancelled'` and `gst_documents.ewbStatus = 'cancelled', cancelledAt`.

### 3. Reissue / regeneration

**Existing service:** [`reissueForDeliveryMismatch`](packages/api/src/services/gst/gstReissueService.ts:90) at `packages/api/src/services/gst/gstReissueService.ts:90` (WI-037).

**What it does:**
1. Loads invoice + items + customer + order.
2. Aborts if `gstMode='disabled'` or if there's no live IRN/EWB.
3. Zero-delivery void path (WI-112) — if `SUM(deliveredQuantity)=0`, cancels EWB+IRN and voids the invoice.
4. Otherwise: cancels EWB (if active) → cancels IRN (if success) → creates a **new** revision invoice using `allocateNumber(tx, distributorId, 'R', new Date(), docCode)` → generates **new IRN** with fresh number → generates **new EWB** if B2B.
5. Writes an `invoice_revisions` audit row snapshotting original items + total.

**New invoice number format for a revision:** `R<CODE><FY><SEQ>` — e.g. `RVGS2627000001`, `RVGS2627000002`, ... The prefix flips from `I` → `R`.

**Critical for the RCM path:** the reissue path is designed for **quantity/amount mismatch**, not for classification fix. The new payload built by `buildIrnPayload` inherits **the same `RegRev='Y'`** unless the code fix (Phase 1) lands first. So even reissue is a no-op for the RCM fix without Phase 1.

Also — the reissue re-uses the same `order_id`, same `items`, same amounts. It does NOT let you keep the same invoice_number. Downstream: the buyer's copy carries `I...` prefix; the new one carries `R...` prefix. Sandeep would need to communicate the swap to each buyer.

### 4. Order status of the 24hr-window rows

```
+-----------+-------+
|  status   | count |
+-----------+-------+
| delivered |     7 |
+-----------+-------+
```

**100% delivered.** Aligns with the fact these are Vanasthali's most recent successfully-dispatched B2B deliveries. Physical goods are with the buyer. Their PDF invoice is in their inbox.

### 5. Is there a "cancel and regenerate for RCM" function today?

`grep -r "regenerate\|reGenerate\|re_generate\|retryIrn\|retryInvoice" packages/api/src/ --include="*.ts" -l` — nothing new beyond the WI-037 reissue path.
`grep -r "cancelAndRegenerate\|cancelAndRegen" packages/api/src/ --include="*.ts" -l` — no matches.

**Conclusion:** no ready-made batch RCM cancel + re-raise script. Would have to be built.

---

## 0E — payloadBuilders.ts current state

**File:** [packages/api/src/services/gst/payloadBuilders.ts:284-291](packages/api/src/services/gst/payloadBuilders.ts:284)

```ts
const payload: IrnPayload = {
  Version: '1.1',
  TranDtls: {
    TaxSch: 'GST',
    SupTyp: isB2C ? 'B2C' : 'B2B',
    RegRev: 'Y',                                                   // ← still 'Y'
    IgstOnIntra: 'N', // Only 'Y' for special intra-state IGST cases (SEZ etc.)
  },
  ...
};
```

**No conditional path. No caller override.** All IRNs — B2B and B2C — carry `RegRev='Y'`.

**Guard test in `gst-payload-shape.test.ts`:** `grep -c "RegRev|reverseCharge"` returns **0**. There is currently NO assertion in the guard suite pinning the value of `RegRev`. Revert commit `1de2e46` deleted the assertion added by commit `132184e`.

### Prod payload verification

The 123 `IRN_GENERATE` calls this month for Vanasthali all show `RegRev='Y'` in `gst_api_logs.request_payload` (query in [docs/RCM-INVESTIGATION.md](RCM-INVESTIGATION.md) Phase 2). Same as dist-002 Sharma dev — the code path is universal.

---

## Recommended sequence — post go-ahead

### Phase 1 (code fix)
- 1A: `RegRev: 'Y'` → `'N'` at [payloadBuilders.ts:289](packages/api/src/services/gst/payloadBuilders.ts:289) — 1 line.
- 1B: Restore guard test in `gst-payload-shape.test.ts` — B2B branch: `expect(payload.TranDtls.RegRev).toBe('N')`; B2C branch: `expect(payload.TranDtls.RegRev).toBe('N')`.
- 1C: Full test suite.
- 1D: Sandbox verify against Sharma sandbox (single test IRN, confirm NIC returns `status_cd=1`, confirm `gst_api_logs.request_payload -> RegRev = 'N'`).
- 1E: Deploy + monitor first 30 min.

### Phase 2 (cancel + re-raise for 24hr window)
- **SCOPE IS ZERO.** All 7 candidates are `delivered` with active EWBs. Skip Phase 2.
- Alternative if Suneel wants to force-reissue delivered invoices: build a `reissueForRcmClassification()` service (~4 hours of work, +tests, +buyer-email flow). Would produce `RVGS...` numbers for each of the 7 and require buyer coordination. Not recommended — Table 9A handles it.

### Phase 3 (Excel output)
- Sheet 1 "Cancelled & Re-raised": **empty** (Phase 2 scope = 0).
- Sheet 2 "Needs GSTR-1 Amendment (Table 9A)": **all 65 invoices** for July return period.

---

## Files & lines cited

- Bug site: [packages/api/src/services/gst/payloadBuilders.ts:289](packages/api/src/services/gst/payloadBuilders.ts:289)
- IRN cancel: [packages/api/src/services/gst/gstService.ts:951](packages/api/src/services/gst/gstService.ts:951)
- EWB cancel: [packages/api/src/services/gst/gstService.ts:1022](packages/api/src/services/gst/gstService.ts:1022)
- Reissue: [packages/api/src/services/gst/gstReissueService.ts:90](packages/api/src/services/gst/gstReissueService.ts:90)
- Numbering: [packages/api/src/services/numberingService.ts](packages/api/src/services/numberingService.ts)
- Missing guard test file: [packages/api/src/__tests__/gst-payload-shape.test.ts](packages/api/src/__tests__/gst-payload-shape.test.ts)

**No code or DB rows were modified during Phase 0.** Prod tmp file `/tmp/pm2.json` (contained DB creds) removed from EC2 after use.
