import type {
  UserRole, UserStatus, ProvisioningStatus, DistributorStatus, GstMode, SubscriptionPlan,
  CustomerStatus, OrderStatus, OrderType, OrderSource, InvoiceStatus, IrnStatus, EwbStatus,
  DriverStatus, VehicleStatus, AssignmentStatus,
  CancelledStockStatus, PaymentMethod, PaymentAllocationStatus,
  BillingPeriodType, BillingStatus,
  BillingTier, BillingItemType, PendingActionModule, PendingActionStatus,
  PendingActionSeverity, AccountabilityType, AccountabilityStatus,
  LedgerEntryType, InventoryEventType, LicenseType, AccountType,
} from '../enums/index.js';

// ─── API Response ────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  code?: string;
  meta?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedRequest {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  distributorId: string | null;
  customerId: string | null;
  // Feature A (2026-07-15): populated for role='customer_hq' only —
  // the CustomerGroup this HQ login can read. Null for every other
  // role. Kept optional so old JWTs in-flight during a rolling deploy
  // remain valid (authenticate() reads groupId from the DB row, not
  // the token, so a missing claim is harmless anyway).
  groupId?: string | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  tokens: AuthTokens;
  user: UserProfile;
}

export interface UserProfile {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  distributorId: string | null;
  // Distributor.businessName joined at /auth/me + login time so the web
  // sidebar and mobile header can show tenant context without an extra
  // fetch. null for super_admin (who isn't pinned to one tenant) and for
  // any user whose distributorId is null.
  distributorName: string | null;
  customerId: string | null;
  requiresPasswordReset: boolean;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export interface User {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  provisioningStatus: ProvisioningStatus;
  distributorId: string | null;
  customerId: string | null;
  requiresPasswordReset: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Group L1 (2026-06-11): nested distributor record when the API
  // includes it (super-admin Users list). Optional so non-list responses
  // (e.g. /auth/me, single-user GET) don't break.
  distributor?: { id: string; businessName: string } | null;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: UserRole;
  distributorId?: string;
  customerId?: string;
}

// ─── Distributors ────────────────────────────────────────────────────────────

export interface Distributor {
  distributorId: string;
  businessName: string;
  legalName: string;
  // Group L2 (2026-06-11): 2-6 char alphanumeric code used to prefix
  // structured invoice + order numbers (e.g. "VAN" → IVAN2526000001).
  // Optional — distributors can exist without one and fall back to
  // the legacy random `INV-`/`ORD-` format.
  docCode: string | null;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  status: DistributorStatus;
  gstMode: GstMode;
  // Mini-Operator (2026-07-16): distributor variant discriminator. Present
  // on every wire response after the migration; 'distributor' for every
  // existing tenant. Web + mobile use this to filter the sidebar and the
  // Super Admin uses it to gate GST-activation UI.
  accountType: AccountType;
  providerCodes: string[];
  subscriptionPlan: SubscriptionPlan | null;
  billingTier: BillingTier | null;
  billingSuspended: boolean;
  gaslinkBillingEnabled: boolean;
  latitude: number | null;
  longitude: number | null;
  godownAddress: string | null;
  godownCity: string | null;
  godownState: string | null;
  godownPincode: string | null;
  godownLatitude: number | null;
  godownLongitude: number | null;
  officeAddress: string | null;
  officeCity: string | null;
  officeState: string | null;
  officePincode: string | null;
  // Phase 3 (2026-06-12): bank + UPI payment details rendered on invoice
  // and customer-ledger PDFs. All nullable. The PDFs check
  // `bankAccountNumber && ifscCode` before emitting the "Payment Details"
  // block; UPI line is appended only when `upiId` is also set.
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchName: string | null;
  ifscCode: string | null;
  upiId: string | null;
  // Group A: gate that allows sandbox gstMode. Only dist-demo + internal test
  // tenants have this true; production distributors transition disabled → live
  // without ever passing through sandbox.
  isTestTenant?: boolean;
  // Phase F (2026-06-12) — per-distributor Razorpay configuration. Only
  // the PUBLIC fields are present on this wire type; key_secret +
  // webhook_secret are NEVER returned in any API response (see
  // distributorSelect in distributorService.ts). The boolean flag gates
  // the customer-portal Pay Now button; razorpayKeyId is shown in the
  // super-admin edit form so they can see WHICH key is configured.
  razorpayEnabled?: boolean;
  razorpayKeyId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GstinLookupResult {
  gstin: string;
  legalName: string;
  tradeName: string;
  address: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  status: string;
  registrationType: string;
  businessType: string;
}

// ─── Customers ───────────────────────────────────────────────────────────────

export interface Customer {
  customerId: string;
  distributorId: string;
  customerName: string;
  businessName: string | null;
  gstin: string | null;
  customerType: 'B2B' | 'B2C';
  phone: string;
  email: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPincode: string | null;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPincode: string | null;
  creditPeriodDays: number;
  transportChargePerCylinder: number;
  // GST rate (percent) applied to this customer's invoice lines. null = use
  // platform default 18%. Only values from ALLOWED_GST_RATES (5 | 18) are
  // accepted at the API boundary.
  gstRateOverride: number | null;
  status: CustomerStatus;
  stopSupply: boolean;
  // Proof-of-collection Phase 1 (2026-07-15): when true, driver's
  // confirm-delivery flow requires proof capture (signature/photo/OTP).
  // Default false — existing behaviour.
  requireDeliveryVerification: boolean;
  preferredDriverId: string | null;
  contacts: CustomerContact[];
  cylinderDiscounts: CustomerCylinderDiscount[];
  createdAt: string;
  updatedAt: string;
}

// Proof-of-collection Phase 1 (2026-07-15): per-order proof-of-delivery
// artifact. See packages/api/prisma/schema.prisma DeliveryProof model +
// docs/PROOF-OF-COLLECTION-IMPL-PLAN.md §1.3 for design rationale.
export interface DeliveryProof {
  id: string;
  orderId: string;
  distributorId: string;
  proofType: 'signature' | 'photo' | 'otp';
  s3Key: string | null;
  signingPartyPhone: string | null;
  // OTP fields are Phase-3 only; null for signature/photo methods.
  // Plaintext (no hash) — customer portal must display the code.
  otpCode: string | null;
  otpExpiresAt: string | null;
  otpVerifiedAt: string | null;
  capturedLat: number | null;
  capturedLng: number | null;
  capturedAt: string;
  capturedBy: string;
}

export interface CustomerContact {
  contactId: string;
  name: string;
  phone: string;
  email: string | null;
  isPrimary: boolean;
}

// Feature A (2026-07-15): HQ CustomerGroup + membership + summary
// shapes surfaced by /api/customer-groups (distributor-facing
// management) and consumed by the web Groups tab.
export interface CustomerGroupMember {
  id: string;
  groupId: string;
  customerId: string;
  customerName: string;
  businessName: string | null;
  gstin: string | null;
  customerType: string;
  addedAt: string;
}

export interface CustomerGroupPortalUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  // Feature A follow-up (2026-07-15): traceability back to the
  // CustomerContact this HQ login was promoted from (if any). null =
  // free-form provision (no source contact) — legitimate for
  // corporate HQ staff who aren't listed against any specific member.
  sourceContactId: string | null;
  sourceContactName: string | null;
  // The customer that owns the source contact — so the admin can see
  // "hq-xyz@... is a contact of Property A" without a second lookup.
  sourceCustomerId: string | null;
  sourceCustomerName: string | null;
}

export interface CustomerGroup {
  id: string;
  distributorId: string;
  name: string;
  memberCount: number;
  members: CustomerGroupMember[];
  hasPortalAccess: boolean;
  // Feature A follow-up (2026-07-15): a group can now have multiple
  // active HQ logins (previously singular `portalUser`). Empty array
  // means no active login. `hasPortalAccess` is kept as a derived
  // convenience for callers that only care about the boolean.
  portalUsers: CustomerGroupPortalUser[];
  createdAt: string;
  updatedAt: string;
}

// Compact list-row shape (no members array, just the count) — used by
// the Groups tab listing before drill-into a detail modal.
export interface CustomerGroupSummary {
  id: string;
  distributorId: string;
  name: string;
  memberCount: number;
  hasPortalAccess: boolean;
  // Feature A follow-up: emails of the FIRST FEW active HQ logins
  // (capped at 3 for display; total count is on portalUserCount). Kept
  // as an array so the list card can show "user1@…, user2@… +1 more".
  portalEmails: string[];
  portalUserCount: number;
  createdAt: string;
  updatedAt: string;
}

// Feature A follow-up: shape returned by GET /customer-groups/:id/contacts —
// candidate contacts (from every group member customer) that the admin
// can promote to an HQ login. `hasLogin` = true when this contact has
// already been promoted (via User.sourceContactId).
export interface GroupCandidateContact {
  contactId: string;
  name: string;
  email: string | null;
  phone: string;
  isPrimary: boolean;
  customerId: string;
  customerName: string;
  hasLogin: boolean;
}

export interface CustomerCylinderDiscount {
  discountId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  discountPerUnit: number;
}

export interface CreateCustomerRequest {
  customerName: string;
  businessName?: string;
  gstin?: string;
  phone: string;
  email?: string;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingState?: string;
  billingPincode?: string;
  shippingAddressLine1?: string;
  shippingAddressLine2?: string;
  shippingCity?: string;
  shippingState?: string;
  shippingPincode?: string;
  creditPeriodDays?: number;
  contacts?: Omit<CustomerContact, 'contactId'>[];
  cylinderDiscounts?: { cylinderTypeId: string; discountPerUnit: number }[];
}

// ─── Cylinder Types & Prices ─────────────────────────────────────────────────

export interface CylinderType {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  unit: string;
  hsnCode: string;
  distributorId: string;
  createdAt: string;
}

export interface CylinderPrice {
  priceId: string;
  cylinderTypeId: string;
  price: number;
  effectiveDate: string;
  distributorId: string;
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export interface Order {
  orderId: string;
  orderNumber: string;
  distributorId: string;
  customerId: string;
  customerName: string;
  driverId: string | null;
  driverName: string | null;
  driverPhone?: string | null;
  // Mini-Operator (2026-07-16): free-text driver name for mini-operator
  // tenants that don't maintain Driver records. Null on regular
  // distributor orders (they use driverId → driverName). Written by the
  // order-create form and rendered on invoice PDF + admin order detail.
  driverNameFreeText?: string | null;
  vehicleId: string | null;
  vehicleNumber: string | null;
  orderDate: string;
  deliveryDate: string;
  status: OrderStatus;
  orderType?: OrderType;
  // FLOAT-001 (2026-06-17): present on every Order returned from the API after
  // the migration; optional in the wire type so legacy consumers compile.
  // Default value is OrderSource.REGULAR for all pre-existing rows.
  orderSource?: OrderSource;
  totalAmount: number;
  specialInstructions: string | null;
  // Buyer's PO number (B2B). Null when not provided. Max 16 chars at API edge
  // to match NIC PoDtls.PoNo. Surfaced on invoice PDF + IRN payload when set.
  poNumber: string | null;
  // Customer self-collects from godown. No vehicle, no driver, no EWB.
  // Defaults false; existing orders are unaffected. Set this at create
  // time only — flipping it later doesn't retroactively change the
  // downstream invoice/inventory writes.
  isGodownPickup: boolean;
  // Brief 3: a backdated/on-demand order — entered after the fact for a
  // delivery that already happened. orderDate/deliveryDate/deliveredAt are
  // historical; createdAt stays at "now". No inventory writes at creation.
  isBackdated: boolean;
  // Backdated-Inventory-Adjustment: timestamp the operator settled
  // today's stock for this backdated order. null = pending (shows in
  // the Backdated Adjustments tab). Setting this is idempotent-blocking.
  inventoryAdjustedAt?: string | null;
  // Flat alias of customer.customerType ('B2B' | 'B2C'). Surfaced by mapOrder
  // so the web edit-order modal can gate B2B-only fields without traversing
  // the nested customer relation. Null when the customer has been deleted.
  customerType: 'B2B' | 'B2C' | null;
  // Proof-of-collection Phase 1 (2026-07-15): flat alias of
  // customer.requireDeliveryVerification. The driver mobile app reads this
  // to decide whether to render the proof-capture section in the confirm-
  // delivery modal. Defaults false — legacy orders and customers without
  // the flag skip proof capture entirely.
  customerRequiresVerification?: boolean;
  // Proof-of-collection Phase 3 (2026-07-15): flat alias derived from
  // Customer._count.users where role='customer'. Drives the driver's
  // OTP-tab gating (show/hide the amber "no app installed" message).
  // Only surfaced on the driver-scoped GET /orders response.
  customerHasPortalAccess?: boolean;
  // Proof-of-collection Phase 3 (2026-07-15): the 6-digit delivery
  // verification code, populated ONLY on the customer-portal GET
  // /orders response and ONLY when: order.status='pending_delivery',
  // customer.requireDeliveryVerification=true, OTP was generated, and
  // driver hasn't verified yet. Never on driver/admin responses.
  otpCode?: string | null;
  items: OrderItem[];
  // WI-127: customer dispute lifecycle (drives the order-card dispute UI).
  customerDisputeReason?: string | null;
  disputeRaisedAt?: string | null;
  disputeResolvedAt?: string | null;
  disputeResolutionNote?: string | null;
  disputeReopenedAt?: string | null;
  disputeReopenReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  orderItemId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  quantity: number;
  deliveredQuantity: number | null;
  emptiesCollected: number | null;
  unitPrice: number;
  discountPerUnit: number;
  totalPrice: number;
}

export interface CreateOrderRequest {
  customerId: string;
  deliveryDate: string;
  specialInstructions?: string;
  items: {
    cylinderTypeId: string;
    quantity: number;
  }[];
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export interface Invoice {
  invoiceId: string;
  invoiceNumber: string;
  distributorId: string;
  customerId: string | null;
  customerName: string | null;
  // WI-077: surfaced on list responses so the billing GST column can render
  // a B2B IRN+EWB pill pair vs a B2C-only EWB pill. Null when the customer
  // has been deleted.
  customerType: 'B2B' | 'B2C' | null;
  orderId: string | null;
  // WI-126: linked order status, surfaced so the customer app can gate the
  // invoice PDF download (delivered/modified_delivered only).
  orderStatus?: string | null;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  amountPaid: number;
  outstandingAmount: number;
  status: InvoiceStatus;
  irnStatus: IrnStatus;
  ewbStatus: EwbStatus;
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  // Snapshot of Order.poNumber at issue time. Survives reissue + GSTR-1 export.
  poNumber: string | null;
  // Flat alias from invoice.order.isGodownPickup so the billing UI can
  // render a "EWB N/A — Godown" chip instead of a misleading red
  // "EWB failed" pill on self-collection invoices. Defaults to false for
  // manual invoices (no parent Order) and legacy rows.
  isGodownPickup?: boolean;
  isGaslinkBilling: boolean;
  // Group 1 (2026-06-11): true when this invoice was created by the
  // opening-balance CSV importer (no Order, no GST exchange). The billing
  // list uses this to render a distinct pill, hide IRN/EWB and CN/DN
  // affordances, and route Download to the Opening Balance Certificate
  // template.
  isOpeningBalance?: boolean;
  items: InvoiceItem[];
  // WI-056: list responses carry these as derived counts (Prisma _count).
  // Detail responses (GET /invoices/:id) instead carry full creditNotes /
  // debitNotes arrays via a separate type extension on the consumer side.
  creditNotesCount?: number;
  debitNotesCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceItem {
  invoiceItemId: string;
  cylinderTypeId: string | null;
  description: string;
  hsnCode: string;
  quantity: number;
  unitPrice: number;
  discountPerUnit: number;
  gstRate: number;
  totalPrice: number;
}

// ─── Payments ────────────────────────────────────────────────────────────────

export interface Payment {
  paymentId: string;
  distributorId: string;
  customerId: string;
  customerName: string;
  amount: number;
  paymentMethod: PaymentMethod;
  referenceNumber: string | null;
  transactionDate: string;
  allocationStatus: PaymentAllocationStatus;
  allocatedAmount: number;
  unallocatedAmount: number;
  allocations: PaymentAllocation[];
  createdAt: string;
}

export interface PaymentAllocation {
  allocationId: string;
  invoiceId: string;
  invoiceNumber: string;
  // Extended in 2026-07-14 so the Payments table can render the invoice's
  // issue date alongside its number. Optional for backward-safety on any
  // consumer holding a cached older payload — treat missing as unknown.
  invoiceIssueDate?: string;
  allocatedAmount: number;
  createdAt: string;
}

export interface CreatePaymentRequest {
  customerId: string;
  amount: number;
  paymentMethod: PaymentMethod;
  referenceNumber?: string;
  transactionDate: string;
  allocations?: { invoiceId: string; amount: number }[];
}

// ─── Drivers ─────────────────────────────────────────────────────────────────

export interface Driver {
  driverId: string;
  distributorId: string;
  driverName: string;
  phone: string;
  licenseNumber: string | null;
  employmentType: string | null;
  status: DriverStatus;
  availableToday: boolean;
  vehicleId: string | null;
  vehicleNumber: string | null;
  joiningDate: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Vehicles ────────────────────────────────────────────────────────────────

export interface Vehicle {
  vehicleId: string;
  distributorId: string;
  vehicleNumber: string;
  vehicleType: string | null;
  capacity: number | null;
  status: VehicleStatus;
  // Most recent assigned driver's name — populated by GET /vehicles list so
  // Incoming Fulls / Outgoing Empties modals can auto-fill Driver Name when a
  // vehicle is selected. May be null for vehicles that have never been assigned.
  currentDriverName?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Driver-Vehicle Assignment ───────────────────────────────────────────────

export interface DriverVehicleAssignment {
  assignmentId: string;
  driverId: string;
  driverName: string;
  vehicleId: string;
  vehicleNumber: string;
  assignmentDate: string;
  tripNumber: number;
  status: AssignmentStatus;
  isReconciled: boolean;
  isSubmitted: boolean;
  orders: Order[];
  // FLOAT-001 (2026-06-17): per-trip load manifest entries (one per cylinder type).
  // Optional on the wire — present only on endpoints that explicitly include them
  // (GET /api/manifests/dva/:dvaId, reconciliation/pending response).
  loadManifest?: DVALoadManifestItem[];
}

// FLOAT-001 (2026-06-17): one row per (DVA, cylinderType, tripNumber).
// totalLoaded = orderedQty + floatQty. orderedQty is snapshotted at confirm time
// (so reconciliation reads it as-at-confirm without re-querying orders).
export interface DVALoadManifestItem {
  manifestId: string;
  dvaId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  tripNumber: number;
  totalLoaded: number;
  orderedQty: number;
  floatQty: number;
  confirmedBy: string;
  confirmedAt: string;
}

// FLOAT-001 (2026-06-17): reconciliation float-summary row (one per type).
// Surfaced in the reconciliation pending response so the inventory team can
// see at a glance how much float was sold vs. how much returns to depot.
export interface DVALoadManifestFloatSummary {
  cylinderTypeId: string;
  cylinderTypeName: string;
  totalLoaded: number;
  orderedQty: number;
  floatQty: number;
  soldFromFloat: number;
  unsoldFloat: number;
}

// ─── Inventory ───────────────────────────────────────────────────────────────

export interface InventorySummary {
  date: string;
  distributorId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  openingFulls: number;
  openingEmpties: number;
  incomingFulls: number;
  outgoingEmpties: number;
  dispatchedQty: number;
  deliveredQty: number;
  collectedEmpties: number;
  // Inventory model rework: supervisor-verified empties returned to depot at
  // reconciliation. Under the new model this — not `collectedEmpties` — drives
  // closing-empties. `collectedEmpties` stays as cumulative collected-at-doorstep
  // (audit only). `inFlightFulls` and `emptiesOnVehicle` are derived for UI.
  emptiesReturnedVerified: number;
  inFlightFulls: number;
  emptiesOnVehicle: number;
  cancelledStockQty: number;
  manualAdjustment: number;
  closingFulls: number;
  closingEmpties: number;
  thresholdWarning: number | null;
  thresholdCritical: number | null;
  isLocked: boolean;
}

export interface InventoryEvent {
  eventId: string;
  distributorId: string;
  cylinderTypeId: string;
  cylinderTypeName?: string;
  eventType: InventoryEventType;
  quantity: number;
  eventDate: string;
  referenceId: string | null;
  referenceType: string | null;
  documentType: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  vehicleNumber: string | null;
  driverName: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ProviderCatalogCylinderType {
  id: string;
  providerCode: string;
  shortName: string;
  longName: string;
  weight: number;
  hsnCode: string;
  isActive: boolean;
}

export type CustomerLedgerRowKind =
  | 'opening'
  | 'invoice'
  | 'payment'
  | 'credit_note'
  | 'debit_note'
  | 'adjustment'
  // Q3 (2026-07-09) — pure stock row for a customer empties return.
  // amountDelta = 0, running balance unchanged. Rendered with the
  // count in the empties column and no debit/credit numbers.
  | 'empties_return';

export interface CustomerLedgerRow {
  orderDate: string;
  cylinderType: string;
  fullCylsDelivered: number;
  amount: number;
  emptyCylsCollected: number;
  pendingEmptyCyls: number;
  emptyCylsCost: number;
  totalAmount: number;
  receivedAmount: number;
  dueAmount: number;
  creditDays: number;
  overDueAmount: number;
  // Group 1 (2026-06-11): emitted by getCustomerLedger so the statement PDF
  // and in-app modal can show a Narration column and treat the "Opening
  // Balance b/f" row distinctly from regular deliveries / payments.
  narration?: string;
  kind?: CustomerLedgerRowKind;
}

export interface CustomerLedgerResponse {
  rows: CustomerLedgerRow[];
  summary: {
    totalAmount: number;
    receivedAmount: number;
    dueAmount: number;
    overdueAmount: number;
    emptyCylsCost: number;
    // Group 1: when the caller passes range.from, this is the carry-forward
    // balance the "Opening Balance b/f" row displays.
    openingBalance?: number;
  };
}

export interface CustomerInventoryBalance {
  customerId: string;
  customerName: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  withCustomerQty: number;
  pendingReturns: number;
  missingQty: number;
  lastUpdated: string;
  // WI-080: current price for the cylinder type (null if none set) and
  // the date of this customer's most recent delivery (null if never).
  cylinderPrice?: number | null;
  // WI-080 amendment: empty-cylinder (container replacement) price from
  // the EmptyCylinderPrice table; null when none set for the type.
  emptyCylinderPrice?: number | null;
  lastDeliveryDate?: string | null;
}

export interface CancelledStock {
  eventId: string;
  orderId: string;
  vehicleId: string;
  vehicleNumber: string;
  driverId: string;
  driverName: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  quantity: number;
  cancellationDate: string;
  status: CancelledStockStatus;
  returnedDate: string | null;
  reconciledDate: string | null;
}

// ─── Accountability ──────────────────────────────────────────────────────────

export interface AccountabilityLog {
  logId: string;
  distributorId: string;
  driverId: string | null;
  driverName: string | null;
  customerId: string | null;
  customerName: string | null;
  cylinderTypeId: string | null;
  cylinderTypeName: string | null;
  incidentType: AccountabilityType;
  incidentDate: string;
  quantity: number;
  costAmount: number;
  description: string;
  status: AccountabilityStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  createdAt: string;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface DashboardStats {
  ordersToday: number;
  deliveredToday: number;
  revenueToday: number;
  /** Orders awaiting dispatch: pending_driver_assignment + pending_dispatch. */
  pendingDispatch: number;
  /** Dispatched, awaiting delivery: pending_delivery. */
  inFlight: number;
  overdueInvoices: number;
  totalOutstanding: number;
  inventoryAlerts: number;
  pendingActions: number;
  /** Total active (non-deleted) customers for the distributor. */
  totalCustomers: number;
}

export interface AnalyticsMetrics {
  amountInMarket: number;
  collectedAmount: number;
  dueAmount: number;
  overdueAmount: number;
  totalCapital: number;
  unrecoveredAmount: number;
  cylinderUtilizationRate: number;
  averageTurnaroundDays: number;
  inventoryShrinkage: number;
  deliveryEfficiency: number;
}

export interface OverdueCallListEntry {
  customerId: string;
  customerName: string;
  phone: string;
  totalOutstanding: number;
  overdueInvoiceCount: number;
  daysOverdue: number;
}

export interface CollectionsDashboard {
  customerId: string;
  customerName: string;
  totalDue: number;
  overdueDue: number;
  // Matches the service field name (was the mismatched `overduesDays`).
  overdueDays: number;
  missingCylinders: number;
  missingCylinderValue: number;
  excessEmptyCylinders: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  creditPeriodDays: number;
  // WI-122: most recent open payment commitment for this customer (or null).
  latestCommitment: {
    promisedDate: string | null;
    overdueAmountSnapshot: number;
    status: string;
    escalationLevel: number;
    createdAt: string;
  } | null;
}

// ─── Pending Actions ─────────────────────────────────────────────────────────

export interface PendingAction {
  actionId: string;
  distributorId: string;
  module: PendingActionModule;
  entityType: string;
  entityId: string;
  actionType: string;
  description: string;
  status: PendingActionStatus;
  severity: PendingActionSeverity;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  errorCode: string | null;
  slaDeadline: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── GasLink Billing ─────────────────────────────────────────────────────────

export interface BillingCycle {
  cycleId: string;
  distributorId: string;
  distributorName: string;
  periodType: BillingPeriodType;
  periodStartDate: string;
  periodEndDate: string;
  billingStatus: BillingStatus;
  billingTier: BillingTier;
  totalAmountExclGst: number;
  totalGstAmount: number;
  totalAmountInclGst: number;
  invoiceId: string | null;
  dueDate: string | null;
  items: BillingItem[];
}

export interface BillingItem {
  itemId: string;
  itemType: BillingItemType;
  description: string;
  hsnCode: string;
  quantity: number;
  unitPriceExclGst: number;
  gstRate: number;
  discountAmount: number;
  lineTotalExclGst: number;
  lineGstAmount: number;
  lineTotalInclGst: number;
}

export interface PricingTier {
  tierId: string;
  plan: SubscriptionPlan;
  volumeMin: number;
  volumeMax: number | null;
  monthlyPrice: number;
  quarterlyDiscount: number;
  halfYearlyDiscount: number;
  yearlyDiscount: number;
  adminSeats: number;
  financeSeats: number;
  inventorySeats: number;
  driverSeats: number;
  gstApiCallsIncluded: number;
  extraSeatPriceAdmin: number;
  extraSeatPriceDriver: number;
  customerPortalPrice: number;
  gstApiOveragePrice: number;
}

export interface GstApiUsage {
  usageId: string;
  distributorId: string;
  month: number;
  year: number;
  irnCallCount: number;
  ewbCallCount: number;
  totalCalls: number;
  allocatedCalls: number;
}

export interface SeatRequest {
  requestId: string;
  distributorId: string;
  requestedRole: string;
  requestedBy: string;
  reason: string | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  pricePerMonth: number | null;
  createdAt: string;
}

export interface DistributorConsumption {
  distributorId: string;
  businessName: string;
  subscriptionPlan: SubscriptionPlan | null;
  billingTier: string | null;
  gstMode: string;
  status: string;
  userCounts: {
    admin: number;
    finance: number;
    inventory: number;
    driver: number;
    customer: number;
  };
  seatLimits: {
    admin: number;
    finance: number;
    inventory: number;
    driver: number;
  } | null;
  gstApiUsage: {
    month: number;
    year: number;
    irnCalls: number;
    ewbCalls: number;
    totalCalls: number;
    allocated: number;
  } | null;
  billing: {
    totalPaid: number;
    totalPending: number;
    lastBillingDate: string | null;
    nextDueDate: string | null;
    currentStatus: string | null;
  };
  customerPortalUsers: number;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface DistributorSettings {
  distributorId: string;
  gstMode: GstMode;
  gstCredentials: GstCredentials | null;
  cylinderThresholds: CylinderThreshold[];
  approvalWorkflows: ApprovalWorkflowConfig[];
  pendingActionSlaHours: Record<string, number>;
  // WI-108: 3-letter tenant code that activates structured invoice/order
  // numbering. null when not yet set (legacy random format in use).
  docCode?: string | null;
  // Group 5 (2026-06-11): operational go-live date, read-only here. Writes
  // go through PUT /api/distributors/:id/go-live-date (super-admin only).
  goLiveDate?: string | null;
  // Phase 3 (2026-06-12): bank + UPI payment details surfaced from
  // GET /api/settings so the General tab Payment Details section can
  // render + prefill. Writes go through PUT /api/settings/payment-details
  // (distributor_admin + super_admin).
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankBranchName?: string | null;
  ifscCode?: string | null;
  upiId?: string | null;
}

export interface GstCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  gstin: string;
  isValid: boolean;
  lastValidated: string | null;
}

export interface CylinderThreshold {
  cylinderTypeId: string;
  cylinderTypeName: string;
  warningLevel: number;
  criticalLevel: number;
  alertEnabled: boolean;
}

export interface ApprovalWorkflowConfig {
  action: string;
  requiresApproval: boolean;
  approverRoles: UserRole[];
}

// ─── Licenses ────────────────────────────────────────────────────────────────

export interface License {
  licenseId: string;
  distributorId: string;
  licenseType: LicenseType;
  licenseName: string;
  expiryDate: string | null;
  documentUrl: string | null;
  isExpired: boolean;
  daysUntilExpiry: number | null;
}

// ─── Contact Form ────────────────────────────────────────────────────────────

export interface ContactFormSubmission {
  name: string;
  phone: string;
  agency: string;
  agencyName: string;
  monthlySale: string;
  email?: string;
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  id: string;
  distributorId: string;
  customerId: string;
  entryType: LedgerEntryType;
  referenceId: string;
  invoiceId: string | null;
  amountDelta: number;
  narration: string | null;
  entryDate: string;
  createdBy: string | null;
  createdAt: string;
  // Group 1 (2026-06-11): per-entry empties fields enriched by
  // GET /api/payments/ledger/:customerId so the in-app modal can render the
  // same Empties Collected / Pending Empties / Empties Cost columns the
  // statement PDF has. Populated only for invoice_entry rows whose invoice
  // is linked to an order; null/zero otherwise. `isOpeningBalance` lets the
  // modal pin the OB row to the top with the "Balance b/f" styling.
  isOpeningBalance?: boolean;
  emptyCylsCollected?: number;
  pendingEmptyCyls?: number;
  emptyCylsCost?: number;
}

// ─── Inventory Forecast ──────────────────────────────────────────────────────

export interface InventoryForecast {
  cylinderTypeId: string;
  cylinderTypeName: string;
  currentStock: number;
  averageDailyDemand: number;
  daysOfStockRemaining: number;
  forecastedDemand7Days: number;
  forecastedDemand30Days: number;
  recommendedReorderQty: number;
  trendDirection: 'increasing' | 'stable' | 'decreasing';
}

// ─── Mini-Operator (2026-07-16) — Source Distributors + Purchase Entries ─────

export interface SourceDistributor {
  id: string;
  distributorId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseEntryItem {
  id: string;
  purchaseEntryId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  fullsReceived: number;
  emptiesGivenOut: number;
}

export interface PurchaseEntry {
  id: string;
  purchaseNumber: string;
  distributorId: string;
  sourceDistributorId: string | null;
  // Denormalised snapshot of the source distributor's name at write time —
  // survives rename/soft-delete of the underlying SourceDistributor row.
  sourceDistributorName: string | null;
  purchaseDate: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  items: PurchaseEntryItem[];
}

// M14 v1.0 — super-admin read-only monitor for account deletion requests.
// Row shape returned by GET /api/super-admin/deletion-requests. Status is
// computed server-side at query time from completedAt/cancelledAt/scheduledAt.
export interface DeletionRequestSummary {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userPhone: string;
  userRole: string;
  distributorName: string | null;
  requestedAt: string;
  scheduledAt: string;
  daysRemaining: number;
  status: 'pending' | 'overdue' | 'executed' | 'cancelled';
  executedAt: string | null;
  cancelledAt: string | null;
}
