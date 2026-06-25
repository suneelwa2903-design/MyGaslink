# Backdated IRN + EWB + Inventory Adjustment — DB / WhiteBooks confirmation

_Read-only investigation against the live dev DB on 2026-06-25._

---

## Conclusion (TL;DR)

✅ **Invoice ISHD2627026942 IS backdated correctly at the NIC level.**

| Field | Value | Interpretation |
|---|---|---|
| `invoice.issueDate` (our DB) | **2026-06-22** | the backdated date the operator entered |
| `DocDtls.Dt` (sent to NIC in IRN payload) | **22/06/2026** | matches issueDate ✓ |
| `DocDtls.No` | `ISHD2627026942` | our structured invoice number |
| `AckDt` (NIC response) | **2026-06-25 13:06:00** | NIC's stamp — when it processed the request. Today, as expected |
| `AckNo` (NIC response) | `112610253450978` | NIC accepted the IRN |
| `Irn` (NIC response) | `356ac87b…b9d88353` | 64-char IRN |
| HTTP status | `200` | success |

The same backdated date flows through **both** the IRN payload (`DocDtls.Dt`) and the EWB payload (`docDate`, `transDocDate`), all set to `22/06/2026`. NIC's clock stamps stay on today (AckDt, ewayBillDate) — that is **expected behaviour** and matches every commercial GST stack.

Backdated invoice OSHD2627000828 also had its inventory adjustment applied today (2026-06-25 07:36:43Z), writing 2 `manual_adjustment` events dated today as designed.

---

## Q1 — Invoice row `ISHD2627026942`

```
id                   = b9d21e69-abcb-480e-8985-171c8a9881ba
invoice_number       = ISHD2627026942
issue_date           = 2026-06-22T00:00:00.000Z          ← backdated
created_at           = 2026-06-25T07:35:46.119Z          ← today (audit)
irn                  = 356ac87be1668659357629ef94bd8d71c66db631f72866d66ef8e718b9d88353
ack_no               = 112610253450978
ack_date             = 2026-06-25T07:36:00.000Z          ← NIC processed today
order_id             = 0e94c40f-c503-4a33-bd2b-6519bec34c0c
```

`issueDate` is 2026-06-22 and `createdAt` is 2026-06-25 — that's the exact backdated invariant Brief 3 specifies. `ack_date` of today is NIC's clock and doesn't influence what gets reported under that month.

---

## Q2 — `IRN_GENERATE` log

**Request (what WE sent to NIC):**

```
apiType:           IRN_GENERATE
httpStatus:        200
errorCode:         null
errorMessage:      null
createdAt:         2026-06-25T07:35:46.977Z

DocDtls: {
  "Dt":  "22/06/2026"        ← backdated date in the IRN payload
  "No":  "ISHD2627026942",
  "Typ": "INV"
}

Full top-level request keys:
  PoDtls, DocDtls, ValDtls, Version, ItemList, TranDtls, BuyerDtls, SellerDtls
```

**Response (what NIC returned):**

```
AckDt:  "2026-06-25 13:06:00"
AckNo:  112610253450978
Irn:    356ac87b…b9d88353

Full top-level response keys:
  irp, data, status_cd, status_desc
```

**Confirmation:** `DocDtls.Dt = "22/06/2026" = invoice.issueDate`. The IRN payload that hit NIC carried the backdated date, **not today's**.

---

## Q3 — `EWB_GENERATE_BY_IRN` log

The B2B path used the chained EWB-from-IRN endpoint.

**Request:**

```
apiType:           EWB_GENERATE_BY_IRN
httpStatus:        200
createdAt:         2026-06-25T07:35:47.465Z

docNo:           ISHD2627026942
docDate:         22/06/2026            ← backdated invoice date
docType:         INV
transDocDate:    22/06/2026            ← backdated transport doc date too
vehicleNo:       KA01DT0002
transDistance:   2 (km)
transMode:       1 (road)
fromGstin:       29AAGCB1286Q000  (Sharma Gas Distributors Pvt Ltd)
toGstin:         29AWGPV7107B1Z1  (Maruthi Agencies)
totalValue:      10339
totInvValue:     12200
cgstValue:       930.51
sgstValue:       930.51
itemList:
  - 19 KG    × 2  hsn=27111900  taxableAmount=3050.86
  - 47.5 KG  × 2  hsn=27111900  taxableAmount=7288.14
```

**Response:**

```
ewayBillNo:      171012096665
ewayBillDate:    25/06/2026 01:06:00 PM     ← NIC stamp = today
validUpto:       26/06/2026 11:59:00 PM     ← +1 day from today (distance 2 km)
status_cd:       "1"
status_desc:     "EWAYBILL request succeeds"
```

**Confirmation:** `docDate = transDocDate = "22/06/2026" = invoice.issueDate`. The EWB payload was also stamped with the backdated date end-to-end. NIC's `ewayBillDate` and `validUpto` are computed from today's clock — same expected NIC behaviour.

> _Side note for distributor-operator awareness:_ `validUpto = 26/06/2026 11:59 PM` is **1 day from today** because `transDistance = 2 km`. NIC's EWB validity rule is distance-based (≤100 km → 1 day), not invoice-date based. The truck has from today through tomorrow night to physically complete the move — even though the invoice itself is dated 22/06.

---

## Q4 — `inventory_events` for order OSHD2627000828

**Order row:**

```
id                       = 0e94c40f-c503-4a33-bd2b-6519bec34c0c
order_number             = OSHD2627000828
delivery_date            = 2026-06-22T00:00:00.000Z          ← backdated
is_backdated             = true
inventory_adjusted_at    = 2026-06-25T07:36:43.645Z          ← settled today
```

**Events written by the apply-adjustment service:** 2 rows, both `manual_adjustment`, both dated **today** (not the backdated delivery date — by design).

```
Event 1:
  eventType:      manual_adjustment
  fullsChange:    -2
  emptiesChange:  0
  eventDate:      2026-06-25                                ← TODAY (no historical cascade)
  referenceType:  backdated_inventory_adjustment
  notes:          "Backdated adjustment for order OSHD2627000828 (delivered 2026-06-22)"
  createdAt:      2026-06-25T07:36:43.637Z

Event 2:
  eventType:      manual_adjustment
  fullsChange:    -2
  emptiesChange:  0
  eventDate:      2026-06-25                                ← TODAY
  referenceType:  backdated_inventory_adjustment
  notes:          "Backdated adjustment for order OSHD2627000828 (delivered 2026-06-22)"
  createdAt:      2026-06-25T07:36:43.641Z
```

**Confirmation:** 2 events written, one per cylinder type (19 KG + 47.5 KG), each `fullsChange = -2` to debit the depot for the 2 delivered cylinders of each type. Both dated **today** with `referenceType='backdated_inventory_adjustment'` — exactly as the locked Brief §5 design specifies.

The notes carry both the order number AND the original backdated delivery date — readable audit trail.

---

## Q5 — `order_items` for OSHD2627000828

```
Item 1:  cylinderType = 19 KG    (f28f393a)
         quantity              = 2
         delivered_quantity    = 2
         empties_collected     = NULL

Item 2:  cylinderType = 47.5 KG  (4c6702c1)
         quantity              = 2
         delivered_quantity    = 2
         empties_collected     = NULL
```

**Why no `reconciliation_empties_return` events?** Because `empties_collected IS NULL` on both items. The apply-adjustment service correctly skips writing the empties event when `emptiesCollected <= 0` (mirrors the godown `confirmDelivery` zero-quantity skip). No event is written, no closingEmpties is touched — which is the right behavior.

If the operator wanted to credit empties for these cylinders, they'd need to:
1. Pre-populate `order_items.empties_collected` before clicking "Apply Adjustment", OR
2. Use the standard "Adjust Stock → Empties bucket" path on the Daily Summary tab.

The current backdated-order creation form doesn't expose `emptiesCollected` — by design, the field defaults to NULL/0 on creation and the operator has to handle empties separately.

---

## Summary table

| Check | Expected | Actual | Result |
|---|---|---|---|
| `invoice.issueDate = backdated date` | 2026-06-22 | 2026-06-22 | ✅ |
| `DocDtls.Dt = issueDate` in IRN payload | 22/06/2026 | 22/06/2026 | ✅ |
| `AckDt = today` in NIC response | 2026-06-25 | 2026-06-25 13:06:00 | ✅ |
| IRN HTTP 200 + AckNo present | yes | yes (112610253450978) | ✅ |
| EWB `docDate = issueDate` in payload | 22/06/2026 | 22/06/2026 | ✅ |
| EWB `transDocDate = issueDate` in payload | 22/06/2026 | 22/06/2026 | ✅ |
| EWB `ewayBillDate = today` in response | 2026-06-25 | 25/06/2026 01:06:00 PM | ✅ (NIC clock) |
| EWB HTTP 200 + ewayBillNo present | yes | yes (171012096665) | ✅ |
| Inventory events dated today | yes | yes, both events on 2026-06-25 | ✅ |
| Events use `backdated_inventory_adjustment` refType | yes | yes | ✅ |
| Notes carry order # + delivery date | yes | yes (both rows) | ✅ |
| `inventoryAdjustedAt` stamped to now | yes | 2026-06-25T07:36:43.645Z | ✅ |
| `reconciliation_empties_return` only when empties > 0 | yes | none written (empties=NULL) | ✅ |

**End-to-end backdated invoicing is working correctly at every layer:** our DB, our payload builders, the WhiteBooks request, NIC's response, and the downstream inventory adjustment. No code changes required.
