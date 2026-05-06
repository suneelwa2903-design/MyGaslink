-- Add opening-balance flag + free-text notes to invoices.
-- Used by the onboarding flow to back-fill prior dues as synthetic
-- overdue invoices so they appear in Collections / overdue-call-list
-- without bypassing existing Invoice-driven UI.
ALTER TABLE "invoices"
  ADD COLUMN "is_opening_balance" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notes" TEXT;
