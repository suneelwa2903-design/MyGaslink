-- Godown pickup flag. Customer self-collects from the depot — no vehicle,
-- no driver, no EWB. IRN still fires for B2B. Default false preserves
-- the existing delivery-flow semantics for every legacy row.
--
-- See docs/GODOWN-PICKUP-INVESTIGATION.md for the full impact surface +
-- the CRITICAL inventory-event synthesis required in confirmDelivery
-- under INVENTORY_DISPATCH_DEBIT=true (closingFulls would otherwise
-- inflate forever).
ALTER TABLE "orders" ADD COLUMN "is_godown_pickup" BOOLEAN NOT NULL DEFAULT false;
