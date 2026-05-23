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
