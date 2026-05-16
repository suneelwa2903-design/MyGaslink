# WI-061 — Trip sheet scoping + DN PDF parity + DVA dedup

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)

---

## Two coupled bugs surfaced during 2026-05-16 manual testing.

### Bug A — Trip sheet PDF includes wrong orders

[`tripSheetPdfService.ts:46-60`](../packages/api/src/services/pdf/tripSheetPdfService.ts):

```ts
const orders = await prisma.order.findMany({
  where: {
    distributorId,
    driverId: assignment.driverId,
    deliveryDate: assignment.assignmentDate,
    deletedAt: null,
    status: { in: ['pending_delivery', 'delivered', 'modified_delivered'] },
  },
  ...
});
```

Two failures:
- **Status filter is too wide.** A trip sheet is a *transit* document. Once
  delivered, the order is off the truck — including it in a later
  trip's sheet is wrong. Including `modified_delivered` is wronger still.
- **No assignment scoping.** Filter is `(distributorId, driverId,
  deliveryDate)` only. A driver doing two trips in one day (trip 1
  delivered by lunch, trip 2 dispatches afternoon) → the afternoon
  trip sheet inherits the morning's already-delivered orders.

**State observed today (dist-002 / 2026-05-16):**
6 orders in `delivered` status from the morning batch + 1 fresh
`pending_delivery` order. A trip sheet for the afternoon assignment
shows all 7. Should show 1.

### Bug B — DN PDF missing IRN block

[`debitNotePdfService.ts`](../packages/api/src/services/pdf/debitNotePdfService.ts) — 187 lines.
[`creditNotePdfService.ts`](../packages/api/src/services/pdf/creditNotePdfService.ts) — 314 lines.

CN PDF got the WI-056 + cleanup-fix upgrade: reads
`gst_documents.docType='CRN'` and renders the IRN/Ack/QR box, with
"Pending" / "Failed" fallback text. DN PDF never got the same upgrade.
The DBN IRN exists in `gst_documents` after approval (`processDebitNoteGst`
writes it) — the PDF just doesn't read it back.

Customer holds CN PDF (with QR + IRN) and DN PDF (no IRN) side by
side and asks why the debit note can't be verified on the GST portal.
The answer is "it's a render gap, not a missing IRN".

### Bug A.5 — Duplicate `driver_vehicle_assignments` rows

Today's DB has 4 DVA rows for `(driver=Kiran, date=2026-05-16)`. Two
were leaked by my own `INSERT … ON CONFLICT DO NOTHING` calls during
the session (the conflict never fired because there's no unique
constraint on `(driver_id, assignment_date)` / `(driver_id, assignment_date, trip_number)`).
Each row gets a different UUID, and the trip-sheet route queries by
that UUID — so the UX is "click trip sheet for assignment X, get the
sheet rendered against a different X". Cosmetic now, breaking later.

---

## Fix scope

### A. Trip sheet query

[`tripSheetPdfService.ts`](../packages/api/src/services/pdf/tripSheetPdfService.ts) lines 46-60:

- Status set narrows to **`pending_delivery` only**. The two prior
  inclusions (`delivered`, `modified_delivered`) leaked finished
  orders into the live transit document.
- Add a `updatedAt: { gte: assignment.updatedAt }` lower bound. The
  DVA row is reused across trips and bumped on each trip increment
  (see `preflightDispatch` lines 146-154 where `tripNumber: { increment: 1 }`
  fires an `updatedAt` refresh). Using DVA's `updatedAt` correctly
  partitions multi-trip days: trip 1 orders all transition to
  pending_delivery before the DVA's last update; trip 2 orders all
  transition AFTER. This is more robust than `createdAt` (which never
  changes after the original DVA creation).
- Also include `o.driverAssignments` history check by joining
  through `OrderStatusLog`? Out of scope — the (status + DVA updatedAt)
  pair is correct for every dispatch path we have today.

Empty result must still produce a clean 400 (existing behaviour) —
"No EWB available for trip sheet — no orders on this route have an
e-Way Bill yet" — but with a softer phrasing that also covers the
"all delivered, nothing to ship" case.

### B. DN PDF — mirror CN's IRN block

Mirror the CN PDF body from [creditNotePdfService.ts:287-336](../packages/api/src/services/pdf/creditNotePdfService.ts):

After the existing Amount line, append:
1. Query `prisma.gstDocument.findFirst({ where: { invoiceId, docType: 'DBN', isLatest: true, deletedAt: null } })`.
2. **If row exists and has irn**: reuse `drawCrnDetailsBox` (rename to a generic `drawIrnDetailsBox` taking a `label` arg — used by both CN and DN). Render IRN / Ack No / Ack Date / QR.
3. **No row OR `irnStatus='not_attempted'`**: grey "e-Invoice (IRN): Pending generation".
4. **`irnStatus='failed'`**: red "e-Invoice (IRN): Generation failed — retry from Billing page".

Footer text aligned with CN:
- CN says `"This is a computer generated credit note."`
- DN currently says `"This is a computer-generated debit note and does not require a signature."`
- DN updated to `"This is a computer generated debit note."` — symmetry beats the slight phrasing redundancy.

### A.5. DVA dedup + unique constraint

1. **Data cleanup (one-off SQL):**
   ```sql
   DELETE FROM driver_vehicle_assignments
   WHERE assignment_id NOT IN (
     SELECT DISTINCT ON (driver_id, assignment_date)
       assignment_id
     FROM driver_vehicle_assignments
     ORDER BY driver_id, assignment_date, created_at ASC
   );
   ```
   Keeps the **earliest** row per (driver, date) — that's the one preflight
   has been incrementing trip_number on, so its history is the canonical record.

2. **Prisma schema** — add to `DriverVehicleAssignment`:
   ```prisma
   @@unique([driverId, assignmentDate, tripNumber])
   ```

3. **Migration** `20260516120000_dva_unique_driver_date_trip`:
   ```sql
   -- Defensive cleanup in case prod has stragglers
   DELETE FROM driver_vehicle_assignments a USING (
     SELECT MIN(created_at) AS keep_at, driver_id, assignment_date, trip_number
     FROM driver_vehicle_assignments
     GROUP BY driver_id, assignment_date, trip_number
     HAVING COUNT(*) > 1
   ) dups
   WHERE a.driver_id = dups.driver_id
     AND a.assignment_date = dups.assignment_date
     AND a.trip_number = dups.trip_number
     AND a.created_at > dups.keep_at;

   CREATE UNIQUE INDEX "driver_vehicle_assignments_driver_date_trip_unique"
     ON "driver_vehicle_assignments" ("driver_id","assignment_date","trip_number");
   ```

## Tests

`gst-trip-sheet-dn-pdf.test.ts` (new file):

**Trip sheet:**
1. Trip sheet PDF only includes `pending_delivery` orders (seed 2 delivered + 1 pending → PDF text contains 1 order number).
2. Trip sheet excludes orders updated BEFORE the assignment's `updatedAt` (simulating an earlier-trip order whose update predates the current trip dispatch).
3. Empty trip sheet (all delivered) returns 400 with the "no EWB available" message.

**DN PDF:**
4. DN PDF text contains the IRN string when `gst_documents.docType='DBN'` row has `irnStatus='success'` and a real IRN.
5. DN PDF text contains `"e-Invoice (IRN): Pending generation"` when no DBN row exists.
6. DN PDF text contains `"e-Invoice (IRN): Generation failed"` when DBN row has `irnStatus='failed'`.
7. CN and DN footers are identical wording (`"This is a computer generated <kind> note."`).

PDF-text assertions reuse the `PDFDocument.prototype.text` spy pattern
from WI-056 (pdfkit deflate-compresses content streams, so buffer
regex won't work).

## Anti-pattern checks
- **#1 / multi-tenant:** new gst_documents query for DN scopes by
  `invoiceId` (which is already tenant-scoped via the invoice). Safe.
- **#9 / shape:** no API response shape changes.
- **#13 / unscoped findFirst:** the new query has explicit invoiceId
  + docType + isLatest filters.

## Acceptance
- Typecheck clean (api + shared + web).
- Vitest ≥ 397 (390 + 7).
- Live retry: trip sheet on assignment X renders ONLY this trip's
  in-transit orders; DN PDF download shows IRN block when the DN
  has been approved + processDebitNoteGst succeeded.
