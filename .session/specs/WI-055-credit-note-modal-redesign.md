# WI-055 — Credit/Debit Note modal: amount-based (drop items grid)

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)
**Branch:** master

---

## Problem

Today's Credit Note / Debit Note modals ask the user to enter the same
four-column grid they would fill on the original invoice: cylinder type,
qty, unit price, GST rate. For LPG distributor operations this is the
wrong abstraction — the finance team almost always just wants to credit
or debit a **specific rupee amount** for a stated reason (price
correction, returned cylinders, billing error, post-delivery adjustment).

The current form:

- Forces a cylinder-type selection that often has no real meaning for a
  pure-money adjustment.
- Computes the CN/DN total from the line items the user must reconstruct
  — easy to get wrong against the original invoice.
- Has no free-text "note" field for the customer-visible explanation
  beyond a single one-line "reason".

## Goal

A two-or-three-field modal:
```
Credit Note — INV-…
  Reason*           (text)
  Credit Amount*    (₹, min 0.01, ≤ invoice total)
  Note              (optional textarea)
  [Cancel] [Create Credit Note]
```

Debit Note mirrors this with no upper bound on the amount (debits can
exceed the original invoice — e.g. delivery surcharge billed after the
fact).

## Scope

### Backend
- Shared schema (`packages/shared/src/schemas/index.ts`):
  ```ts
  createCreditNoteSchema = z.object({
    invoiceId: uuid,
    reason: z.string().min(1).max(500),
    amount: positiveNumber,           // > 0
    note: z.string().max(500).optional(),
  });
  createDebitNoteSchema = z.object({
    invoiceId: uuid,
    reason: z.string().min(1).max(500),
    amount: positiveNumber,           // > 0
    note: z.string().max(500).optional(),
  });
  ```
  The `items[]` array is removed from both schemas.

- `invoiceService.createCreditNote()` / `createDebitNote()`:
  - Stop computing `totalAmount` from items; use the request `amount`
    directly.
  - Enforce `amount <= invoice.totalAmount` for credit notes (400 on
    violation). No upper bound for debit notes.
  - Persist the optional `note` field (column already exists per spec —
    confirmed via schema.prisma review during implementation; if absent,
    add it via a small migration).
  - Items relation: leave existing rows untouched (data preservation);
    no new items created in the amount-based flow.

- Backward compat: existing approved CNs/DNs in DB (built via the old
  items flow) keep working — read path unchanged, only the create path
  changes.

### Frontend
- `BillingPaymentsPage.tsx` `CreditNoteModal` + `DebitNoteModal`:
  - Drop `useFieldArray` items grid and all related markup.
  - Render: Reason (Input), Amount (Input type=number), Note (textarea).
  - Show helper text under Amount: `Invoice total: ₹{invoice.totalAmount}`.
  - For CN, set `max` and validation message to "Cannot exceed invoice total".
  - Keep the existing `apiPost('/invoices/credit-notes', data)` shape.

### Tests
- Unit (schema): amount > 0 accepted; amount = 0 rejected.
- Integration: POST CN with `amount > invoice.totalAmount` → 400.
- Integration: POST CN with valid amount creates CN with `totalAmount`
  equal to request amount.
- Integration: POST DN with `amount > invoice.totalAmount` → 200 (allowed).
- Integration: existing CN list endpoint still returns previously-created
  items-based CNs (read path regression guard).

### Anti-pattern compliance
- **#9** — the route response shape for `POST .../credit-notes` keeps
  the existing envelope; only the request shape changes. Web reads
  the response via `mapCreditNote()` which already serialises the
  Prisma row → wire shape; new `note` field surfaces in the next list
  fetch.

## Acceptance
- Typecheck clean.
- Vitest ≥ 357 (353 + 4 new).
- Manual: modal renders three fields; submit creates a CN whose
  `totalAmount` equals the entered amount.
