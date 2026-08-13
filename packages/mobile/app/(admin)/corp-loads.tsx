/**
 * Corp. Loads — full corporation ledger for a REGULAR distributor_admin
 * (2026-08-13, Suneel).
 *
 * This is the mobile counterpart of the web CorporationLedgerPage: OMC/source-
 * distributor loads, supplier ledger (purchases + payments + supplier CN/DN +
 * ERV empties, all interleaved with a running balance), and the FIFO Cost
 * Layers / landed-cost valuation.
 *
 * It reuses the exact same screen component as the mini-operator Purchases tab
 * — `PurchasesScreen` carries no internal role gate, so the only differences
 * are (a) which tab surfaces it (see (admin)/_layout.tsx) and (b) the screen
 * reads the active route via `useSegments()` to relabel the header "Corp.
 * Loads" and reveal the Cost Layers card. Re-exporting keeps a single source
 * of truth for the 2000-line purchases/ledger logic.
 */
export { default } from './purchases';
