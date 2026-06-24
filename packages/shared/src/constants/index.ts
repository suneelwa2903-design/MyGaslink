// ─── GST Constants ───────────────────────────────────────────────────────────

// Legacy decimal-form GST rates retained for the inter-state CGST/SGST vs
// IGST split where the per-line rate is the platform default (18%). New
// code paths derive the split dynamically from InvoiceItem.gstRate so a
// per-customer override (Customer.gstRateOverride) flows through correctly
// — see invoiceService.createInvoiceFromOrder + createManualInvoice.
export const GST_RATES = {
  CGST: 0.09,
  SGST: 0.09,
  IGST: 0.18,
  CESS: 0,
} as const;

// Permitted values for Customer.gstRateOverride and InvoiceItem.gstRate at
// the API boundary. 5% applies to food-service customers (hotels,
// restaurants, canteens — commercial LPG used for food preparation); 18%
// is the default for everyone else. New rates require BOTH a Zod schema
// update AND a NIC-sandbox A/B verification per CLAUDE.md anti-pattern #10
// (the HSN→rate compatibility matrix at NIC is not in our control).
export const ALLOWED_GST_RATES = [5, 18] as const;
export type AllowedGstRate = typeof ALLOWED_GST_RATES[number];

export const GST_DEFAULT_HSN = '27111900'; // LPG HSN code
export const GST_DEFAULT_UOM = 'NOS'; // Numbers

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// Phase 3 (2026-06-12): IFSC + UPI handle format checks. RBI IFSC spec is
// fixed: 4 uppercase letters (bank code) + "0" (reserved) + 6 alphanumeric
// characters (branch code). Lowercase IFSC is invalid — the UI auto-uppercases
// on input so this regex matches what the user actually sees. UPI handle
// follows NPCI's de-facto pattern: a user portion of letters/digits with
// `.`/`-`/`_` separators, an `@`, and a provider/bank slug of letters only
// (e.g. `gasagency@hdfc`, `acme.ltd@axisbank`). Length caps mirror NPCI's
// 50-char user-side + 64-char total guidance.
export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,50}@[a-zA-Z]{2,20}$/;

// ─── Inventory Constants ─────────────────────────────────────────────────────

export const INVENTORY_THRESHOLD_LEVELS = {
  WARNING: 'warning',
  CRITICAL: 'critical',
} as const;

export const DEFAULT_CARRY_FORWARD_LOOKBACK_DAYS = 30;

// ─── Auth Constants ──────────────────────────────────────────────────────────

export const ACCESS_TOKEN_EXPIRY = '15m';
export const REFRESH_TOKEN_EXPIRY = '7d';
export const OTP_EXPIRY_MINUTES = 5;
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MINUTES = 15;

// ─── Pagination ──────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// ─── Billing Constants ───────────────────────────────────────────────────────

export const BILLING_GRACE_PERIOD_DAYS = 7;
export const BILLING_OVERDUE_SUSPEND_DAYS = 30;

// ─── Pending Action SLA (hours) ──────────────────────────────────────────────

export const DEFAULT_SLA_HOURS = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168, // 7 days
} as const;

// ─── Customer Inventory ──────────────────────────────────────────────────────

export const PENDING_RETURN_OVERDUE_DAYS = 30;
export const MISSING_CYLINDER_THRESHOLD_DAYS = 60;

// ─── API Response Codes ──────────────────────────────────────────────────────

export const API_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BILLING_SUSPENDED: 'BILLING_SUSPENDED',
  GST_CREDENTIALS_MISSING: 'GST_CREDENTIALS_MISSING',
  GST_API_ERROR: 'GST_API_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// ─── Indian States (for GST) ─────────────────────────────────────────────────

export const INDIAN_STATES = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman & Diu',
  '26': 'Dadra & Nagar Haveli',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (New)',
  '38': 'Ladakh',
} as const;

// Group D1 (2026-06-11): sorted, de-duplicated list of state NAMES for the
// state-dropdown UI on customer / distributor forms. INDIAN_STATES above is
// keyed by 2-digit GST code (37 + 38 both alias "Andhra Pradesh" in
// practice); we want the user-facing dropdown to show each name exactly
// once, alphabetised. Daman & Diu / Dadra & Nagar Haveli were merged into
// "Dadra & Nagar Haveli and Daman & Diu" in 2026; keeping both legacy names
// in the dropdown so legacy GSTIN-lookup state values still find a match.
export const INDIAN_STATE_NAMES: readonly string[] = Array.from(
  new Set(Object.values(INDIAN_STATES) as readonly string[]),
).sort((a, b) => a.localeCompare(b));

// Phase D (2026-06-12): local-TZ today helper. Returns YYYY-MM-DD for
// TODAY in the process's local timezone, NOT UTC. The codebase had ~40
// sites doing `new Date().toISOString().split('T')[0]` — the UTC
// equivalent — for date defaults on forms that POST to APIs validating
// against local-TZ midnight (CLAUDE.md anti-pattern #21). Between 18:30
// UTC and 23:59 UTC the UTC date lags one day behind IST, so every user
// filling in a date filter or submitting a new order between midnight
// and 05:30 IST got yesterday's date silently substituted. Hidden for
// months because failing tests were mislabeled as flakes (see commit
// 53cb40c).
//
// Use this in any TS code (server, web, mobile, tests) that needs the
// calendar date IN THE USER'S TIMEZONE — which is almost always what
// you want. The test-suite helper at packages/api/src/__tests__/
// helpers.ts > today() is the same impl, kept duplicated only because
// tests can't easily import from @gaslink/shared without a build cycle.
export function localTodayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Phase 5 (2026-06-12): reverse map (state name → 2-digit code) used by
// the invoiceService when writing Invoice.placeOfSupplyCode at issue
// time. NIC's GSTR-1 schema expects a 2-digit string code, not a name.
// Built from INDIAN_STATES so a single edit there propagates to both
// directions; duplicates (37/38 both → "Andhra Pradesh") resolve to the
// LOWER code, which is the canonical post-2014-split code for GSTR-1.
export const STATE_CODE_BY_NAME: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const [code, name] of Object.entries(INDIAN_STATES)) {
    if (!(name in map) || code < map[name]!) map[name] = code;
  }
  return map;
})();

// Phase 5 (2026-06-12): pull a 2-digit GSTR-1 state code out of a GSTIN
// (first 2 characters) when present, else fall back to looking up the
// billingState name via STATE_CODE_BY_NAME, else null. Returns null
// when the inputs leave the place of supply genuinely undetermined —
// the GSTR-1 export decides whether to drop the row, default to the
// distributor's own state, or surface as a data-quality flag.
export function deriveStateCode(
  customerGstin: string | null | undefined,
  billingState: string | null | undefined,
): string | null {
  if (customerGstin && /^\d{2}/.test(customerGstin)) return customerGstin.slice(0, 2);
  if (billingState && STATE_CODE_BY_NAME[billingState]) return STATE_CODE_BY_NAME[billingState]!;
  return null;
}
