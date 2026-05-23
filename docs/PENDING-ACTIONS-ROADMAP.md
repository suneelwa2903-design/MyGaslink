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
