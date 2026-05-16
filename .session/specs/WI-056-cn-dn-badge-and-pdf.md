# WI-056 — Invoice list CN/DN count badges + CN PDF fields

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)
**Branch:** master

---

## Problem

**A. Invoice list response shape.**
`GET /api/invoices` includes `creditNotes: true` + `debitNotes: true` in
the Prisma include — meaning every list call ships the full CN/DN array
on every row. For an invoice with 5 CNs that's 5×(reason/amount/status/
issuedBy/approvedBy/timestamps) shipped to render a small badge. The
View modal then fetches the same data again via `GET /invoices/:id/
credit-notes`. Wasted bandwidth, duplicate state.

No visual signal on the invoice list: a row with 3 active CNs renders
identically to one with none.

**B. CN PDF IRN block dead code.**
[creditNotePdfService.ts:287-301](packages/api/src/services/pdf/creditNotePdfService.ts) gates the IRN/QR section on
`cnAny.irn || cnAny.ackNo || cnAny.signedQrCode` — fields that the
CreditNote Prisma model **does not have**. The comment in the file
admits it: *"if your Prisma model does not have those fields yet, this
section is safely skipped."* It always skips. CN PDFs never render the
IRN block even when `processCreditNoteGst` successfully writes a `CRN`
GstDocument row holding the actual IRN/ackNo/signedQr.

## Goal

### A. Counts not arrays on list responses
- Replace `creditNotes: true / debitNotes: true` include on the list
  endpoint with `_count: { select: { creditNotes: true, debitNotes: true } }`.
- Add `creditNotesCount: number` and `debitNotesCount: number` to the
  mapper output for list responses. Detail / get-by-id endpoint
  continues to include the full arrays (still needed by the View modal).
- Web: render small pills `[CN: 2]` `[DN: 1]` in the invoice list row
  status column when count > 0.

### B. CN PDF IRN block from gst_documents
- The IRN for a credit note already lives in `gst_documents` where
  `doc_type = 'CRN'` and `invoice_id` matches the CN's invoice — written
  by `processCreditNoteGst`. Read from there in the PDF generator instead
  of looking up phantom columns on the CreditNote model.
- New helper inside the PDF service: look up the latest CRN-type
  `gst_documents` row joined to the credit note's invoice. If found,
  render the existing CRN box (IRN, AckNo, AckDate, QR).
- Keep the existing fallback behaviour (skip the box entirely if no GST
  doc was generated — distributors with GST disabled).

## Out of scope
- Migrating CreditNote model to carry its own IRN columns. The
  gst_documents row already holds them — denormalising would be redundant.
- Reading IRN data into the View modal UI (separate WI if needed).

## Tests
- Unit: list response includes `creditNotesCount` (number) and
  `debitNotesCount` (number); does NOT include `creditNotes[]` or
  `debitNotes[]` arrays.
- Unit: detail / get-by-id response still includes the full
  `creditNotes` and `debitNotes` arrays for the View modal.
- Integration: invoice with 2 CNs returns `creditNotesCount: 2`.
- Integration: CN PDF endpoint returns 200 + application/pdf even
  when the related gst_documents row is absent (GST disabled distributor).
- Anti-pattern #9 guard: list response keys do NOT include `creditNotes` /
  `debitNotes` arrays (would re-introduce the bandwidth waste).
- PDF content guard: when a CRN gst_documents row exists, the PDF
  buffer's text dump contains "IRN" (a smoke check that the block ran).

## Acceptance
- Typecheck clean.
- Suite ≥ 363 (360 + 3 new).
- Invoice list rows visually show `[CN]` / `[DN]` badges.
- CN PDF for a B2B invoice with `irn_status=success` renders the IRN box.
