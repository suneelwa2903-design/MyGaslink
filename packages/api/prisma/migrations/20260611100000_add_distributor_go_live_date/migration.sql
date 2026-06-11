-- Group 5 (2026-06-11) — operational go-live date per distributor.
-- Drives default `dateFrom` on reports + OB-invoice backdating.
ALTER TABLE "distributors" ADD COLUMN "go_live_date" DATE;
