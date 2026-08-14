/**
 * Corp. Loads for the finance role — same screen the admin uses. Finance has
 * full access to the corp/purchase endpoints (source-distributors,
 * purchase-payments, purchase CN/DN), so the admin CorpLoadsScreen works
 * unchanged; re-exporting keeps a single source of truth. Mounted under
 * (finance) so navigation stays inside the finance tab layout.
 */
export { default } from '../(admin)/corp-loads';
