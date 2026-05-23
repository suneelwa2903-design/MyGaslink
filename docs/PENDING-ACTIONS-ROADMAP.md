# Pending Actions — Roadmap (Parked)

## Known bugs to fix (post-launch)
- WI-105 message builder fails to resolve invoice
  number/customer name for some EWB actions —
  outputs "Invoice this invoice for customer"
  fallback string. Fix the null-guard in
  buildPendingActionDescription.
- Historical pending actions created before WI-105
  still show raw technical messages. One-time
  migration needed to reformat existing open actions.
- Duplicate historical records need a one-time
  cleanup script.

## Improvements needed (post-launch)
- Date-wise grouping: today / overdue / upcoming
- SLA deadlines: configurable per actionType,
  EOD enforcement for GST actions
- Role-based actioning: Finance role for billing
  actions, Inventory role for stock actions,
  Distributor Admin for all
- Bulk resolve for multiple actions
- Overdue status distinct from open
- Email/SMS alert when high severity action
  is unresolved past SLA

## Action types coming (not yet built)
- MODIFIED_DELIVERY_REVIEW — driver delivered
  different qty, admin approves GST reissue (WI-099)
- CREDIT_NOTE_APPROVAL — credit note above
  threshold requires approval
- DEBIT_NOTE_APPROVAL — same for debit notes
- PAYMENT_RECONCILIATION_MISMATCH — payment
  amount doesn't match invoice
- STOCK_MISMATCH_REVIEW — physical stock differs
  from system at reconciliation

## Delivery Flow

### Over-delivery guard (parked)
When a driver enters a delivered qty greater than
ordered, the system currently allows it with only
a warning (WI-104). No upper bound is enforced.

The correct guard: total delivered of a cylinder
type across all orders on the trip cannot exceed
total loaded of that type on the vehicle.

Implementation path (all data already available):
- trip-stock endpoint already returns fullQuantity
  per cylinder type (remaining deliverable)
- delivery modal needs to call trip-stock before
  submit and cap input at fullQuantity per type
- No new API queries needed

Dependencies:
- Needs dispatch event (inventory work item) to
  be accurate, otherwise "loaded" is derived from
  order quantities not actual physical load
- Park until post-launch alongside dispatch event
  implementation

## NIC Response Integrity

### #24 — Null-value guard on all NIC success responses

**What the problem is:**
NIC can return status_cd=1 (success) with a null or empty IRN or EWB
number field. This is a known NIC sandbox quirk, observed once during live
verification. WI-091 patched this for dispatch EWB only. The same guard is
needed across all four NIC calls that return critical identifiers.

**Two scenarios and who acts:**

Scenario A — Blank IRN at dispatch:
- Driver has NOT been dispatched. Order stays pending_dispatch.
- Dispatch is blocked. No billing entry created.
- High severity pending action raised:
  "Invoice for [Customer]: NIC returned a blank IRN number despite
  confirming success. Click Retry to attempt dispatch again."
- Who acts: Distributor Admin
- What they do: Click Retry on pending action. Dispatch runs again from
  beginning. If NIC behaves properly, full dispatch completes
  (IRN + EWB + driver trip).
- Driver impact: Zero. Driver sees nothing until dispatch fully completes.

Scenario B — Blank EWB after modified delivery reissue:
- Driver already delivered. Old IRN cancelled, new IRN generated
  successfully, but EWB came back blank.
- State: order=modified_delivered, new IRN=active, EWB=missing.
- High severity pending action raised:
  "Invoice [RSHD-XXX] for [Customer]: New e-Way Bill generation returned
  blank from NIC. Driver EWB at checkpoint may be invalid. Click Retry to
  generate the EWB."
- Who acts: Distributor Admin — must resolve before driver reaches next
  checkpoint.
- What they do: Click Retry. System attempts EWB generation only (IRN
  already valid, not touched). EWB generated. Driver Compliance Docs
  updates within 30 seconds via auto-refresh.
- Driver impact: No valid EWB until admin retries. Admin should contact
  driver if checkpoint is imminent.

**Four paths to audit and fix:**
1. Dispatch IRN generation: if status_cd=1 but Irn is null →
   irnStatus=failed, raise IRN_GENERATION pending action, block entry
2. Dispatch EWB generation: ✅ WI-091 already handled
3. Reissue IRN generation (regenerateB2bIrn): if status_cd=1 but Irn is
   null → same as #1
4. Reissue EWB generation (generateEwbFromIrn): if status_cd=1 but ewbNo is
   null → ewbStatus=failed, raise EWB_GENERATION pending action (never
   store active with a null number)

**Touch point:** gstService.ts and gstReissueService.ts — the success
branches that currently log a warning but still write active/success with a
null identifier.

**Priority:** High. Low frequency but direct compliance risk — driver at
checkpoint with an invalid EWB document.
