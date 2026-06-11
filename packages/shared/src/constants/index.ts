// ─── GST Constants ───────────────────────────────────────────────────────────

export const GST_RATES = {
  CGST: 0.09,
  SGST: 0.09,
  IGST: 0.18,
  CESS: 0,
} as const;

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
