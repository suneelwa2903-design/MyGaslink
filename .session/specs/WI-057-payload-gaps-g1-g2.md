# WI-057 — Close GST payload gaps G1 + G2 + payload guards

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)
**Reference:** [docs/Whitebooks/REFERENCE_NOTES.md](../docs/Whitebooks/REFERENCE_NOTES.md)
gaps G1 / G2; vehicleNo regex; transDistance.

---

## Investigation findings (no theory, just code)

| Concern | Code today | Verdict |
|---|---|---|
| `transactionType` | [`payloadBuilders.ts:356`](../packages/api/src/services/gst/payloadBuilders.ts) — `isB2C ? 2 : 1` | **G1 confirmed.** Per REFERENCE_NOTES §4: 1 = Regular (use everywhere for LPG, where Bill To = Ship To = customer); 2 = "Bill To ≠ Ship To". B2C is still a single-recipient transaction; sending 2 trips NIC error **611** ("invalid document type for the given supply type"). |
| `vehicleNo` sanitiser | [`payloadBuilders.ts:298-301`](../packages/api/src/services/gst/payloadBuilders.ts) — `.replace(/[^A-Za-z0-9]/g,'').toUpperCase().substring(0,15)` | ✅ Already correct. `KA01-MN-9999` → `KA01MN9999`. Just needs a payload-shape guard test so a future "preserve hyphens" change doesn't slip through. |
| `transDistance` | [`payloadBuilders.ts:305`](../packages/api/src/services/gst/payloadBuilders.ts) — `Math.max(1, Math.min(4000, distance \|\| 1))` | ✅ Already safe. Never 0 → error 721 immune. Same — needs a regression guard test. WhiteBooks Postman shows `transDistance: "0"` as the "auto-calc" sentinel, but the live sandbox accepts `"1"` as the minimum and we already clamp there, so the safer behaviour stands. |
| IRN 2150 recovery | [`gstService.ts:369-371`](../packages/api/src/services/gst/gstService.ts) — marks `irnStatus='success'` but never fills `invoice.irn` | **G2 confirmed.** When NIC says "IRN already exists for this docNo+docType+docDate", we know it's on the portal but never call GETIRNBYDOCDETAILS to recover the actual 64-char IRN. Downstream PDF generation, EWB recovery, and CN/DN flows all silently break because they read `invoice.irn` and find NULL. |

## Changes

### 1. `payloadBuilders.ts` — `transactionType` always 1
```diff
- transactionType: isB2C ? 2 : 1,
+ // REFERENCE_NOTES §4 + WI-057 gap G1: for LPG distribution the same
+ // customer is both Bill To and Ship To. 1 = Regular is the only correct
+ // value. Sending 2 for B2C tripped NIC 611 on every B2C dispatch.
+ transactionType: 1,
```
`isB2C` is still used for `SupTyp`, `Gstin`, `toGstin`, `shipToGSTIN` — those branches stay.

### 2. `whitebooksClient.ts` / `gstService.ts` — `getIrnByDocDetails`
New exported function in `gstService.ts`:
```ts
export async function getIrnByDocDetails(
  distributorId: string,
  docType: 'INV' | 'CRN' | 'DBN',
  docNo: string,
  docDate: Date,
): Promise<{ irn?: string; ackNo?: string; ackDate?: Date; signedQr?: string } | null>
```

Calls NIC via `callWithLog`:
```
GET /einvoice/type/GETIRNBYDOCDETAILS/version/V1_03
    ?param1=<docType>:<docNo>:<DD/MM/YYYY>
    &email=<creds.email>
```
apiType: `IRN_GET_BY_DOC` (new logging label).

`processInvoiceGst` 2150 branch updated:
```ts
if (irnErr.code === '2150') {
  let recoveredIrn: string | null = null;
  try {
    const r = await getIrnByDocDetails(
      distributorId, 'INV',
      invoice.invoiceNumber,
      invoice.issueDate ?? invoice.createdAt,
    );
    if (r?.irn) {
      recoveredIrn = r.irn;
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          irn: r.irn,
          ackNo: r.ackNo,
          ackDate: r.ackDate ?? null,
          irnStatus: 'success',
        },
      });
      irnPersisted = true;
    } else {
      // Couldn't recover — still mark success (portal accepts it)
      // but log so admin can chase.
      await prisma.invoice.update({ where: { id: invoiceId }, data: { irnStatus: 'success' } });
    }
  } catch (recoverErr: any) {
    logger.error('GETIRNBYDOCDETAILS lookup failed after 2150', {
      invoiceId, err: recoverErr.message,
    });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { irnStatus: 'success' } });
  }
  result.irn = { status: 'duplicate', message: 'IRN already exists on portal', recoveredIrn };
  // ... existing EWB block continues
}
```

### 3. Payload-shape guard tests
Added to `gst-payload-shape.test.ts`:
- `transactionType is always 1` (B2B AND B2C fixtures).
- `vehicleNo strips hyphens / spaces / slashes and uppercases`.
- `vehicleNo never exceeds 15 chars`.
- `transDistance is "1" minimum even when distance: 0 is passed`.

### 4. New file `gst-2150-recovery.test.ts`
- Mock `apiCall` to throw `GstError('IRN already exists', '2150')` on
  IRN_GENERATE.
- Stub GETIRNBYDOCDETAILS to return `{ data: { Irn: 'a'.repeat(64), AckNo: '...', AckDt: '...' } }`.
- Assert `processInvoiceGst` writes the recovered IRN to the invoice.
- Assert `gst_api_logs` row captured with `apiType=IRN_GET_BY_DOC`.
- Assert when both 2150 AND GETIRNBYDOCDETAILS fail, `irnStatus` stays
  `success` (portal has it) but `recoveredIrn` is null.

## Out of scope (deferred)
- **G3** — B2C EWB recovery via GETEWAYBILLGENERATEDBYCONSIGNER. Separate WI.
- **G5** — Part-B vehicle update / EWB extend routes. Separate WI.
- **G6** — Any other gaps noted in REFERENCE_NOTES.md.
- Migrating CreditNote / DebitNote to call `getIrnByDocDetails` in their
  own duplicate-IRN branches. Same pattern, different doc types — once
  this lands, opening a follow-up WI is straightforward.

## Acceptance
- Typecheck clean (api + shared + web).
- Vitest suite ≥ 372 (366 + 6 new).
- payload-shape tests guard #G1, vehicleNo, transDistance.
- 2150 recovery test asserts the recovered IRN ends up on the invoice row.
- Migrating to the new behaviour does not change any existing test
  result outside of the payload-shape file.
