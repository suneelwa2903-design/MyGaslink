# RCM (Reverse Charge Mechanism) — Investigation Brief

**Date:** 2026-07-10
**Investigator:** Claude Code (read-only)
**Trigger:** Vanasthali (dist prod-id `6a749f20-5a82-4b74-9977-51eac69049f2`) shows 4 invoices — Kinara Group of Hotels, Sri Venkata Sai Swagruha Foods, Swaad Kitchen — in GSTR-1 **Table 4B (B2B Reverse Charge)** with ₹39,450.84 taxable / ₹3,550.59 GST.

---

## TL;DR

The prior briefing was based on **wrong memory**. Commit `132184e` (the "fix") was **REVERTED 3 minutes later** by commit `1de2e46` on 2026-05-15. `RegRev='Y'` is **CURRENT and live in production code TODAY**. Every B2B IRN we've ever generated — including one issued at 03:20:44 IST today — has been marked Reverse Charge = Yes on NIC. The 4 invoices you're seeing at Vanasthali are the tip of the iceberg. Sharma alone has **554 successful B2B IRNs since 2026-05-31** — all filed under 4B. Same code path, same bug, all distributors affected.

---

## PHASE 1 — Code state (source of truth)

### File: [packages/api/src/services/gst/payloadBuilders.ts](packages/api/src/services/gst/payloadBuilders.ts)

```ts
// Line 284-291 (current HEAD)
const payload: IrnPayload = {
  Version: '1.1',
  TranDtls: {
    TaxSch: 'GST',
    SupTyp: isB2C ? 'B2C' : 'B2B',
    RegRev: 'Y',                                    // ← HARDCODED to 'Y'
    IgstOnIntra: 'N',
  },
  ...
};
```

- **RegRev is hardcoded to `'Y'`**.
- No conditional path. No caller override.
- No guard test in `gst-payload-shape.test.ts` (grep confirmed).

### Our own DB stores the correct semantic

[packages/api/src/services/invoiceService.ts:328,357,511](packages/api/src/services/invoiceService.ts):
```ts
// Comment at line 328: "reverseCharge: false — LPG retail is NOT reverse charge."
reverseCharge: false,   // set on every Invoice.reverseCharge write
```

**Contradiction confirmed:** internally we correctly record `reverseCharge=false`, but the outgoing NIC payload says `RegRev='Y'`.

---

## PHASE 2 — Live payloads (gst_api_logs)

5 most recent B2B IRN_GENERATE calls on dist-002 (Sharma) — the sample is representative:

| api_type | RegRev | SupTyp | created_at |
|---|---|---|---|
| IRN_GENERATE | **Y** | B2B | 2026-07-10 03:20:44 |
| IRN_GENERATE | **Y** | B2B | 2026-07-10 03:20:11 |
| IRN_GENERATE | **Y** | B2B | 2026-07-10 03:15:17 |
| IRN_GENERATE | **Y** | B2B | 2026-07-10 03:15:10 |
| IRN_GENERATE | **Y** | B2B | 2026-07-10 03:14:54 |

**Every call today. Every call historically.** The value is baked in by the payload builder — there's no other place to look.

Same rows on our side:

| invoice_number | reverse_charge | CGST | SGST | Total | irn_status |
|---|---|---|---|---|---|
| ISHD2627028333 | **false** | 137.29 | 137.29 | 1800.00 | success |
| ISHD2627028332 | **false** | 686.44 | 686.44 | 9000.00 | success |
| ISHD2627028331 | **false** | 0.00 | 0.00 | 4000.00 | success |
| ISHD2627028330 | **false** | 686.44 | 686.44 | 9000.00 | success |
| ISHD2627028329 | **false** | 274.58 | 274.58 | 3600.00 | success |

The **logical contradiction** the original commit message described is real: we charge the buyer CGST+SGST on our invoice, then tell NIC "the buyer pays under RCM." NIC accepts the payload (no validation error because both fields are individually valid), but GSTR-1 auto-classifies to 4B based on `RegRev`.

---

## PHASE 3 — Git archaeology

### The one-day round trip on 2026-05-15

```
132184e  22:19:29 IST  fix(gst): TranDtls.RegRev='N' (was 'Y')
1de2e46  22:22:48 IST  Revert "fix(gst): TranDtls.RegRev='N' (was 'Y')"
```

**3-minute window.** Diff of `1de2e46`:
- `packages/api/src/services/gst/payloadBuilders.ts`: 12 lines removed (RegRev back to `'Y'`)
- `packages/api/src/__tests__/gst-payload-shape.test.ts`: 13 lines removed (guard test deleted)

### Why the revert happened — probable misdiagnosis

CLAUDE.md **anti-pattern #10** documents that the 2026-05-15 NIC 5002 storm was actually caused by **inline `EwbDtls` field in the IRN payload**, not by RegRev. The real fixes landed hours later in the same session:
- `0920627` (05-15) — fix inline EwbDtls field casing
- `7aa4fbc` (05-15) — drop inline EwbDtls, use two-step IRN → EWB flow
- `81e6a10` (05-15) — comprehensive audit removing inline EwbDtls dead code

So the RegRev revert was a **wrong turn** during the firefight. The team correctly identified inline EwbDtls as the 5002 cause and fixed that — but the RegRev fix was left reverted and forgotten. The commit message `132184e` correctly diagnosed the RegRev issue; the revert wasn't because RegRev='N' failed live testing (there's no live-testing evidence in the git history around 22:22 — the next NIC-touching commit is `0920627` almost 24 hours later on 05-16).

---

## PHASE 4 — Scope on the DEV DB

Sharma (dist-002) alone, on the dev DB:

| Metric | Value |
|---|---|
| B2B invoices with `irn_status='success'` | **554** |
| Earliest | 2026-05-31 |
| Latest | 2026-07-10 (today) |
| All with `reverse_charge=false` in our DB | ✓ |
| All with `RegRev='Y'` in NIC payload | ✓ |

Vanasthali (`6a749f20-...`) is **not on this dev DB** — it exists only in prod. The screenshot showed 4 affected invoices. The prod exposure is:
- 4 for Vanasthali (visible)
- Unknown but likely ~500+ for Sharma prod (same code path)
- All 4B classifications on GSTR-1

---

## PHASE 5 — Answers to your two questions

### Q1: What happens if you (seller) pay the GST anyway?

**Don't.** You'd be over-paying.

Under RCM (4B), GSTN's model says:
- Seller does NOT collect GST from buyer
- Buyer self-deposits GST directly to government
- Buyer claims Input Tax Credit (ITC) as usual

You've **already collected GST** on the invoice (CGST + SGST are non-zero, buyer paid you). So the tax is with you, not with the government. If you also self-deposit under normal B2B rules, that's fine — but the buyer's records show a 4B invoice, meaning THEIR CA thinks they owe the tax to government too.

**Two scenarios:**
- **Buyer's CA follows GSTR-1 blindly** → self-deposits GST → **double tax paid to government**, huge ITC reconciliation mess for buyer, no way for you to reclaim.
- **Buyer's CA reads your invoice, sees CGST+SGST charged** → knows tax was collected → does NOT self-deposit, claims full ITC → clean, no mismatch. Requires buyer awareness.

Recommended path: fix the classification via GSTR-1 amendment so buyer doesn't have to hand-reconcile.

### Q2: Will fixing RegRev='N' break ongoing IRN calls?

**No — the risk is low, evidence-backed:**

- The 2026-05-15 commit message hypothesized RegRev='Y' + CGST/SGST = 5002 error. It was reverted 3 minutes later without live evidence.
- CLAUDE.md anti-pattern #10 documents the *actual* 5002 root cause: inline `EwbDtls`. That's fixed.
- Since May 15 we've generated 500+ IRNs with RegRev='Y' AND non-zero CGST/SGST → NIC accepts every one. So the "combination" itself doesn't trigger 5002.
- NIC's schema for `RegRev` accepts either 'Y' or 'N' without cross-validating against CGST/SGST amounts. GSTR-1 4A/4B classification is a filing-time downstream consequence, not a payload validator rule.

**BUT** — you have to prove it live before rolling out, not on trust. Do a low-blast-radius sandbox test first (below).

---

## Options — end to end

### Option A — Amend historical invoices via GSTR-1 Table 9A (RECOMMENDED)

**Scope:** ALL B2B invoices with RegRev='Y' filed so far. For Vanasthali: 4 invoices in the affected month. For Sharma: ~500+ across May-July.

**How:** Filer opens GSTR-1 for the return period, goes to **Table 9A — Amended B2B Invoices**, moves each affected invoice from **4B → 4A** (change "Reverse Charge = Yes" → "No"). This is a standard, in-portal, no-code, no-IRN-cancel operation. GSTN reclassifies the record; buyer's ITC statement rebuilds correctly at the next fetch.

**Risk:** Low. The amendment path exists specifically for this class of error. No coordination with buyer needed *for the amendment itself* — but you should still notify them so their CA doesn't panic-file based on the pre-amendment 4B view.

**Effort:** ~5 min per invoice on the portal, batched by month. For Sharma's ~500, expect 1 day of portal work spread across the ~2 months affected.

### Option B — Credit Note + fresh IRN per affected invoice (NOT recommended)

Cancel each IRN via NIC cancel API → issue Credit Note → generate new invoice + IRN with RegRev='N' → filing period matches new invoice.

**Why not:**
- Requires cancelling IRN within 24 hours of generation (impossible for anything older than 1 day).
- Buyer's ITC gets reversed then re-claimed → cash-flow disruption.
- Massive coordination with each buyer.
- Compounds if you have any other IRN cancel gates active (EWB active, etc. — see CLAUDE.md anti-pattern #20 cancel sequence).

### Option C — Do nothing, notify buyers only (RISKY)

Tell each B2B buyer that 4B rows in their inbox are misclassified. Their CA handles at GSTR-3B reconciliation.

**Why risky:**
- Depends on every buyer's CA reading your invoice correctly and NOT self-depositing.
- Large customers (Kinara Group, hotels) have automated ITC workflows — high chance of blind self-deposit → double tax.
- Your GSTR-1 stays showing 4B → recurring monthly problem until you amend or the buyer complains.

### Option D — Fix the code first + Option A for history (RECOMMENDED FULL PLAN)

1. **Code fix** — one line: `RegRev: 'Y'` → `RegRev: 'N'` at [payloadBuilders.ts:289](packages/api/src/services/gst/payloadBuilders.ts:289).
2. **Guard test** — restore the deleted assertion in `gst-payload-shape.test.ts` so this can't regress silently.
3. **Sandbox verification** — before deploying: fire ONE test IRN with RegRev='N' against Sharma's WhiteBooks sandbox and confirm NIC accepts (per anti-pattern #10 rule: never trust mock-only verification for external API changes).
4. **Deploy + monitor** — check `gst_api_logs` for the first 10 post-deploy IRNs to confirm NIC still returns success.
5. **Amend history** — Option A on GSTR-1 portal for both Vanasthali's 4 and Sharma's ~500.

---

## Risk-mitigated rollout — step by step

### Step 0 — Communication (before touching code)
- Suneel → tell Vanasthali distributor (Sandeep?) that 4 GSTR-1 rows will be amended from 4B → 4A this month. Their buyers' CAs should treat those 4 as normal B2B for ITC.
- Same for Sharma distributor about the ~500 rows.

### Step 1 — Sandbox live test (5 min, low risk)
- On a fresh dev DB (or Sharma sandbox), change RegRev='N' in the payload builder.
- Generate ONE IRN through the standard preflight flow.
- Verify:
  - NIC returns `status_cd=1` with valid IRN.
  - Response `EwbDtls` (if any) has no 5002.
  - The written `gst_documents` row has `RegRev='N'`.
- If pass → proceed. If NIC rejects → document the exact 5002 body (per anti-pattern #11) and re-plan.

### Step 2 — Code fix + guard test (single commit)
- `payloadBuilders.ts:289`: `'Y'` → `'N'`.
- `gst-payload-shape.test.ts`: add `expect(payload.TranDtls.RegRev).toBe('N')` for both B2B and B2C payload branches (restoring what the 05-15 revert deleted).
- Full test suite must pass.

### Step 3 — Deploy to prod
- Deploy the commit.
- Watch `gst_api_logs` for the first hour of prod IRN activity — confirm every new row has `RegRev='N'` and NIC still returns success.

### Step 4 — Amend GSTR-1 for filing period
- For each affected month, open GSTR-1, Table 9A, move affected invoices to 4A. This is a per-invoice manual portal operation.

### Step 5 — Verify next-month GSTR-1
- Next monthly filing: check the summary page again. Confirm 4B total drops to ₹0 (or whatever legitimate RCM sales you may have — for pure LPG retail, should be ₹0).

---

## What could go wrong (and how to catch it fast)

| Risk | Likelihood | Mitigation |
|---|---|---|
| NIC rejects RegRev='N' with 5002 | Low (500+ successes already, just with wrong flag) | Sandbox test in Step 1 gates deploy |
| Buyer's CA already self-deposited | Medium for large chains | Comms in Step 0; amendment reverses on their statement |
| We miss some affected invoices in Table 9A pass | Medium | Query pinned in Phase 4 gives exact IDs; amend all |
| Regression re-introduces RegRev='Y' later | Low but silent | Guard test in Step 2 |
| Existing "IRN success but wrong classification" gets re-cancelled unnecessarily | N/A — Table 9A doesn't touch IRN | — |

---

## Ready-to-run SQL for the code fix pass

**On prod RDS — read only, gives you the full amendment list per month:**

```sql
-- Every B2B invoice ever filed under 4B (all distributors, all months)
SELECT
  d.business_name              AS distributor,
  DATE_TRUNC('month', i.created_at)::date AS return_period,
  i.invoice_number,
  i.irn,
  c.customer_name,
  c.business_name              AS buyer,
  c.gstin,
  i.total_amount,
  i.cgst_value + i.sgst_value + i.igst_value AS gst_amount
FROM invoices i
JOIN customers c ON c.customer_id = i.customer_id
JOIN distributors d ON d.distributor_id = i.distributor_id
WHERE i.irn IS NOT NULL
  AND i.irn_status = 'success'
  AND c.customer_type = 'B2B'
ORDER BY distributor, return_period, i.created_at;
```

Group the output by `(distributor, return_period)` — that's your Table 9A amendment worksheet.

---

## Files & lines cited

- **Bug site:** [packages/api/src/services/gst/payloadBuilders.ts:289](packages/api/src/services/gst/payloadBuilders.ts:289)
- **Correct semantic in our DB (proof of contradiction):** [packages/api/src/services/invoiceService.ts:328,357,511](packages/api/src/services/invoiceService.ts:328)
- **Deleted guard test (needs restoration):** [packages/api/src/__tests__/gst-payload-shape.test.ts](packages/api/src/__tests__/gst-payload-shape.test.ts)
- **Root-cause history:** commit `132184e` (fix), `1de2e46` (revert), CLAUDE.md anti-pattern #10 (why revert was wrong)

**No files or DB rows were modified during this investigation.**
