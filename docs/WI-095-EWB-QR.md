# WI-095 — EWB QR Code (PARKED, implementation-ready)

**Status:** Parked pending Suneel approval (deferred in Session 4).
**Effort:** LOW (~1–2 hours — same pattern as the existing IRN QR).
**Risk:** Low. Additive only; no schema change, no new external API call.

---

## 1. What we confirmed from device testing

NIC's e-Way Bill document renders its QR as a **plain text string** (NOT a
NIC-signed payload, and NOT returned by the EWB API). The on-document format is:

```
EWB No. : {ewbNo} / GSTIN : {generatorGstin} / Date : {ewbDate}
```

This is a *convenience / quick-reference* QR — it is **not** the cryptographically
signed QR that the IRN carries. (The IRN `SignedQRCode` is the only NIC-signed QR
in the system; the EWB API response contains only `ewayBillNo`, `ewayBillDate`,
`validUpto` and no signed blob — verified against a real `gst_api_logs` row for
dist-002.) A roadside inspector still verifies the EWB number on the NIC portal;
the QR just saves them typing the number.

## 2. Data already available (no extra API call)

Everything needed is already persisted at dispatch time:

| Field            | Source                                                        |
|------------------|---------------------------------------------------------------|
| `ewbNo`          | `gst_documents.ewb_no`                                         |
| `ewbDate`        | `gst_documents.ewb_date`                                       |
| `generatorGstin` | the distributor's GSTIN (`distributors` / GST credential row) |

No additional WhiteBooks/NIC call is required to build the QR.

## 3. Library

Reuse the **`qrcode`** npm package already used for the IRN QR in
`packages/api/src/services/pdf/invoicePdfService.ts`
(`QRCode.toBuffer(signedQr, { type: 'png', width, margin: 1 })`).
No new dependency.

## 4. Where to add

**a) `packages/api/src/services/pdf/tripSheetPdfService.ts`**
   - Draw a small QR beside each order's EWB number (the file currently renders
     the EWB *number* only — no QR anywhere today).
   - Encode the text string from §1 per order.

**b) Mobile compliance docs (`packages/mobile/app/(driver)/trip.tsx`)**
   - Render a QR inline for each EWB in the EWB list, so the driver can show it
     at a checkpoint without printing.
   - On RN, generate via a QR component (e.g. `react-native-qrcode-svg`) OR
     reuse a server-rendered PNG endpoint — decide at implementation time.

## 5. Implementation effort

**LOW — 1–2 hours.** Same draw-a-QR pattern as the IRN QR already shipped. The
only new decision is the mobile-side QR renderer (server PNG vs. RN component).

## 6. Blocked on

**Suneel approval** (parked per Session 4). Unblock by confirming with Suneel
when web testing resumes. Once approved, this becomes a straightforward
additive change with a trip-sheet PDF golden-snapshot check.
