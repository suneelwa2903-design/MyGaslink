import { z } from 'zod';
import {
  UserRole, PaymentMethod, OrderStatus, InvoiceStatus,
  CustomerStatus, GstMode, AccountabilityType,
} from '../enums/index.js';
import { GSTIN_REGEX } from '../constants/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Main phone helper for primary user/customer/driver phone columns. Looser
// than the original strict regex so natural Indian formats (+91, spaces,
// hyphens) are accepted; human-readable error messages so the failure mode
// is obvious in the inline error text.
const phone = z
  .string()
  .min(10, 'Phone number is too short (need at least 10 digits)')
  .max(15, 'Phone number is too long (max 15 characters)')
  .regex(/^[+]?[\d\s-]+$/, 'Phone number can contain digits, spaces, hyphens, and an optional leading +');
const email = z.string().trim().toLowerCase().email();
const gstin = z.string().regex(GSTIN_REGEX, 'Invalid GSTIN format').optional().or(z.literal(''));
const positiveNumber = z.number().positive();
const nonNegativeNumber = z.number().min(0);
// Group D1 (2026-06-11): 6-digit Indian pincode helper. Addresses remain
// optional everywhere they're already optional — blank passes; only a
// non-empty value that isn't exactly six digits is rejected. Mobile already
// enforces the same shape client-side (packages/mobile/src/screens/
// CustomerForm.tsx:70); web was relying on `max(10)` which silently let
// "5000" / "abc123" / "500034 " through.
const pincode = z.string().regex(/^\d{6}$/, 'Pincode must be exactly 6 digits').optional().or(z.literal(''));

// ─── Auth Schemas ────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: email,
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
}).refine((data) => data.currentPassword !== data.newPassword, {
  message: 'New password must be different from current password',
  path: ['newPassword'],
});

export const forgotPasswordSchema = z.object({
  identifier: z.string().min(1, 'Email or phone is required'),
});

export const verifyResetOtpSchema = z.object({
  identifier: z.string().min(1, 'Email or phone is required'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
});

export const resetPasswordSchema = z.object({
  resetToken: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

// ─── User Schemas ────────────────────────────────────────────────────────────

export const createUserSchema = z.object({
  email: email,
  password: z.string().min(8),
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
  phone: phone.optional(),
  role: z.nativeEnum(UserRole),
  distributorId: uuid.optional(),
  customerId: uuid.optional(),
  // Group B Part 3 — one-shot wiring instruction (NOT a User column).
  // When the Add User modal's role=driver flow picks a driver, the route
  // creates the User row, then writes drivers.user_id = newUser.id. The
  // field is unused for any other role. driver_id is the ONLY direction
  // available for the Driver→User link because the FK lives on the
  // Driver side (1:0..1, @unique).
  driverId: uuid.optional(),
});

export const updateUserSchema = createUserSchema.partial().omit({ password: true });

// STAGE-E: self-edit schema for `PUT /api/users/me`. STRICT subset of
// updateUserSchema — email, role, distributorId, customerId are intentionally
// omitted so a user can never change their own identity, tenant, or privileges
// via this endpoint (Zod's default strip silently drops any extras). All three
// editable fields use the same min/max constraints as updateUserSchema's
// underlying createUserSchema definitions above.
export const updateOwnProfileSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(100).optional(),
  lastName: z.string().min(1, 'Last name is required').max(100).optional(),
  phone: phone.optional(),
});

// ─── Customer Schemas ────────────────────────────────────────────────────────

// Contact phone: looser than the main `phone` helper. Contacts are secondary
// people on a customer record (e.g. site manager, accountant) — admins enter
// names + whatever phone shape they happen to have. Forcing the strict 10-15
// digit, no-parens regex meant any natural format ("+91 (98765) 43210",
// "98765.43210", or just blank with name only) silently blocked submit at the
// client-side resolver, with no visible error. KN Murthy (Vanasthali) hit this
// during onboarding. New rules:
//   - phone is OPTIONAL (name alone is enough to add a contact)
//   - if provided, accept any of: digits, spaces, hyphens, +, (), .
//   - require at least 7 digits after stripping non-digits (so a typo'd "12"
//     or accidental keystroke is still rejected)
const contactPhone = z
  .string()
  .regex(
    /^[+\d\s\-().]+$/,
    'Phone number format is invalid. Use digits, spaces, or hyphens (e.g. 98765 43210)',
  )
  .refine((v) => v.replace(/\D/g, '').length >= 7, {
    message: 'Phone number is too short (need at least 7 digits)',
  })
  .refine((v) => v.replace(/\D/g, '').length <= 15, {
    message: 'Phone number is too long (max 15 digits)',
  });

const customerContactSchema = z.object({
  name: z.string().min(1, 'Contact name is required').max(100),
  phone: contactPhone.optional().or(z.literal('')),
  email: email.optional().or(z.literal('')),
  isPrimary: z.boolean().default(false),
});

const cylinderDiscountSchema = z.object({
  cylinderTypeId: uuid,
  discountPerUnit: nonNegativeNumber,
});

export const createCustomerSchema = z.object({
  customerName: z.string().min(1, 'Customer name is required').max(200),
  businessName: z.string().max(200).optional(),
  gstin: gstin,
  phone: phone,
  email: email.optional().or(z.literal('')),
  billingAddressLine1: z.string().max(500).optional(),
  billingAddressLine2: z.string().max(500).optional(),
  billingCity: z.string().max(100).optional(),
  billingState: z.string().max(100).optional(),
  billingPincode: pincode,
  shippingAddressLine1: z.string().max(500).optional(),
  shippingAddressLine2: z.string().max(500).optional(),
  shippingCity: z.string().max(100).optional(),
  shippingState: z.string().max(100).optional(),
  shippingPincode: pincode,
  creditPeriodDays: z.number().int().min(0).max(365).default(30),
  // Optional inward transport charge, ₹ per delivered cylinder (GST-inclusive). 0 = none.
  transportChargePerCylinder: z.number().min(0).max(100000).default(0),
  contacts: z.array(customerContactSchema).optional(),
  cylinderDiscounts: z.array(cylinderDiscountSchema).optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

// ─── Order Schemas ───────────────────────────────────────────────────────────

const orderItemSchema = z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().positive('Quantity must be at least 1'),
});

export const createOrderSchema = z.object({
  customerId: uuid,
  deliveryDate: dateString,
  specialInstructions: z.string().max(500).optional(),
  items: z.array(orderItemSchema).min(1, 'At least one item is required'),
  orderType: z.enum(['delivery', 'returns_only']).default('delivery').optional(),
  cancelledStockEventId: uuid.optional(),
});

export const returnsOnlyOrderSchema = z.object({
  customerId: uuid,
  scheduledDate: dateString,
  specialInstructions: z.string().max(500).optional(),
  items: z.array(z.object({
    cylinderTypeId: uuid,
    expectedQuantity: z.number().int().positive('Quantity must be at least 1'),
  })).min(1, 'At least one item is required'),
});

export const returnsConfirmationSchema = z.object({
  items: z.array(z.object({
    cylinderTypeId: uuid,
    collectedQuantity: z.number().int().min(0),
  })).min(1),
  notes: z.string().max(500).optional(),
});

export const updateOrderSchema = z.object({
  deliveryDate: dateString.optional(),
  specialInstructions: z.string().max(500).optional(),
  items: z.array(orderItemSchema).min(1).optional(),
});

export const deliveryConfirmationSchema = z.object({
  // WI-109: individual items may be 0 (legitimate partial delivery — some
  // cylinder types delivered, others refused), but at least one item must have
  // a delivered quantity > 0. An all-zero delivery is not a delivery; the order
  // must be cancelled by an admin instead (voids invoice + EWB).
  items: z.array(z.object({
    cylinderTypeId: uuid,
    deliveredQuantity: z.number().int().min(0),
    emptiesCollected: z.number().int().min(0),
  })).min(1).refine(
    (items) => items.some((i) => i.deliveredQuantity > 0),
    { message: 'At least one item must have a delivered quantity greater than zero' },
  ),
  deliveryLatitude: z.number().optional(),
  deliveryLongitude: z.number().optional(),
  notes: z.string().max(500).optional(),
});

export const assignDriverSchema = z.object({
  driverId: uuid,
  vehicleId: uuid.optional(),
});

export const bulkAssignDriverSchema = z.object({
  orderIds: z.array(uuid).min(1),
  driverId: uuid,
  vehicleId: uuid.optional(),
});

// ─── Payment Schemas ─────────────────────────────────────────────────────────

export const createPaymentSchema = z.object({
  customerId: uuid,
  amount: positiveNumber,
  paymentMethod: z.nativeEnum(PaymentMethod),
  referenceNumber: z.string().max(100).optional(),
  transactionDate: dateString,
  allocations: z.array(z.object({
    invoiceId: uuid,
    amount: positiveNumber,
  })).optional(),
});

// ─── Credit / Debit Note Schemas ─────────────────────────────────────────────

// WI-055: CN/DN modal redesigned from items-grid → single amount field.
// Items-based create path removed from the request schema; existing
// items rows in the DB are preserved for legacy notes (read path
// unchanged). The amount is bounded ≤ invoice total for credit notes
// in the service layer (debit notes have no upper bound — surcharges
// can legitimately exceed the original invoice).
export const createCreditNoteSchema = z.object({
  invoiceId: uuid,
  reason: z.string().min(1, 'Reason is required').max(500),
  amount: positiveNumber,
  note: z.string().max(500).optional(),
});

export const createDebitNoteSchema = z.object({
  invoiceId: uuid,
  reason: z.string().min(1, 'Reason is required').max(500),
  amount: positiveNumber,
  note: z.string().max(500).optional(),
});

// ─── Inventory Schemas ───────────────────────────────────────────────────────

// WI-1.4 — Incoming Fulls modal: "Supply Type" / "Supply Reference No." /
// "Supply Date" are display labels for documentType / documentNumber /
// documentDate (backend columns unchanged). `amount` is the optional total
// invoice value from the corporation, captured for reconciliation.
export const incomingFullsSchema = z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().positive(),
  documentType: z.string().min(1, 'Supply type is required').max(50),
  documentNumber: z.string().min(1).max(100),
  documentDate: dateString,
  vehicleNumber: z.string().max(20).optional(),
  driverName: z.string().max(100).optional(),
  vehicleId: uuid.optional(),
  amount: nonNegativeNumber.optional(),
  notes: z.string().max(500).optional(),
});

// WI-1.4 — Outgoing Empties modal: "Challan Type" / "Challan No." /
// "Challan Date" are display labels for documentType / documentNumber /
// documentDate. `authorizationRef`, `amount`, `condition` are new metadata
// fields the modal collects (all optional).
export const outgoingEmptiesSchema = z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().positive(),
  documentType: z.string().min(1, 'Challan type is required').max(50),
  documentNumber: z.string().min(1).max(100),
  documentDate: dateString,
  vehicleNumber: z.string().max(20).optional(),
  driverName: z.string().max(100).optional(),
  vehicleId: uuid.optional(),
  authorizationRef: z.string().max(100).optional(),
  amount: nonNegativeNumber.optional(),
  condition: z.enum(['good', 'defective']).optional(),
  notes: z.string().max(500).optional(),
});

// WI-3 — Adjust Stock now supports both Fulls and Empties adjustments via
// a `bucket` discriminator. Existing payloads (no bucket) default to 'fulls'
// for backward compatibility with the original modal.
export const manualAdjustmentSchema = z.object({
  cylinderTypeId: uuid,
  bucket: z.enum(['fulls', 'empties']).default('fulls'),
  adjustmentType: z.enum(['add', 'subtract']),
  quantity: z.number().int().positive(),
  reason: z.string().min(1, 'Reason is required').max(500),
  adjustmentDate: dateString,
});

export const cancelledStockReturnSchema = z.object({
  eventIds: z.array(uuid).min(1),
  returnDate: dateString,
  notes: z.string().max(500).optional(),
});

export const customerBalanceSetupSchema = z.object({
  customerId: uuid,
  balances: z.array(z.object({
    cylinderTypeId: uuid,
    withCustomerQty: nonNegativeNumber.default(0),
    pendingReturns: nonNegativeNumber.default(0),
  })).min(1),
});

export const cylinderThresholdSchema = z.object({
  cylinderTypeId: uuid,
  warningLevel: z.number().int().min(0),
  criticalLevel: z.number().int().min(0),
  alertEnabled: z.boolean().default(true),
}).refine((data) => data.criticalLevel <= data.warningLevel, {
  message: 'Critical level must be less than or equal to warning level',
  path: ['criticalLevel'],
});

// ─── Settings Schemas ────────────────────────────────────────────────────────

export const gstCredentialsSchema = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  clientSecret: z.string().min(1, 'Client secret is required'),
  username: z.string().min(1, 'Username is required'),
  // WI-042: password is required by WhiteBooks for both scopes; the
  // existing service falls back to clientSecret when omitted (legacy),
  // but the UI now collects it explicitly.
  password: z.string().min(1, 'Password is required').optional(),
  gstin: z.string().regex(GSTIN_REGEX, 'Invalid GSTIN format'),
  email: z.string().email().optional(),
  scope: z.enum(['einvoice', 'ewaybill']).optional(),
});

export const gstModeSchema = z.object({
  mode: z.nativeEnum(GstMode),
});

// ─── Group A: Atomic GST Activation (super-admin only) ───────────────────────
//
// Per-scope Layer 2 credentials. Layer 1 (client_id/client_secret/email) is
// read from env vars at runtime — never accepted from a request body. Email
// is GasLink-global, not per-distributor (one MyGasLink WhiteBooks account
// per scope × environment).
export const gstLayer2CredentialsSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

// Reason enum — drives the audit_log details JSON. 'other' requires reasonText.
export const gstActivationReasonSchema = z.enum([
  'new_distributor_activation',
  'credential_rotation',
  'mode_change',
  'revoke_access',
  'other',
]);

export const gstActivationSchema = z
  .object({
    mode: z.enum(['live', 'sandbox']),
    einvoice: gstLayer2CredentialsSchema,
    // ewaybill may be the literal string 'same_as_einvoice' to copy the einvoice
    // credentials into the ewaybill row (the common case — most taxpayers use
    // identical NIC creds for both portals).
    ewaybill: z.union([gstLayer2CredentialsSchema, z.literal('same_as_einvoice')]),
    reason: gstActivationReasonSchema,
    reasonText: z.string().max(500).optional(),
  })
  .refine((d) => d.reason !== 'other' || (d.reasonText && d.reasonText.length > 0), {
    message: 'reasonText is required when reason is "other"',
    path: ['reasonText'],
  });

export const gstDisableSchema = z
  .object({
    reason: gstActivationReasonSchema,
    reasonText: z.string().max(500).optional(),
  })
  .refine((d) => d.reason !== 'other' || (d.reasonText && d.reasonText.length > 0), {
    message: 'reasonText is required when reason is "other"',
    path: ['reasonText'],
  });

// Body-creds variant for Test Connection on the activation form (creds not
// yet saved). Body is optional — when present, used in place of DB rows.
export const gstTestConnectionRequestSchema = z.object({
  scope: z.enum(['einvoice', 'ewaybill']),
  mode: z.enum(['sandbox', 'live']),
  credentials: gstLayer2CredentialsSchema.optional(),
});

export const approvalWorkflowSchema = z.object({
  action: z.string().min(1),
  requiresApproval: z.boolean(),
  approverRoles: z.array(z.nativeEnum(UserRole)).min(1),
});

// ─── Accountability Schemas ──────────────────────────────────────────────────

export const createAccountabilitySchema = z.object({
  driverId: uuid.optional(),
  customerId: uuid.optional(),
  cylinderTypeId: uuid.optional(),
  incidentType: z.nativeEnum(AccountabilityType),
  incidentDate: dateString,
  quantity: z.number().int().positive(),
  description: z.string().min(1).max(1000),
});

export const resolveAccountabilitySchema = z.object({
  resolutionNotes: z.string().min(1, 'Resolution notes are required').max(1000),
  costAmount: nonNegativeNumber.optional(),
  status: z.enum(['resolved_recovered', 'resolved_written_off', 'resolved_charged']),
});

// ─── Contact Form Schema ─────────────────────────────────────────────────────

export const contactFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  phone: phone,
  email: email.optional(),
  agency: z.string().min(1, 'Agency type is required'),
  agencyName: z.string().min(1, 'Agency name is required').max(200),
  monthlySale: z.string().min(1, 'Monthly sale is required'),
});

// ─── Distributor Schemas ─────────────────────────────────────────────────────

// Group L2 (2026-06-11): 3-letter tenant code used to prefix invoice +
// order numbers (e.g. "VAN" → IVAN2526000001). 2–6 uppercase letters or
// digits. Optional at create time — distributors can be created without
// a docCode and have one assigned later, BEFORE the first invoice runs
// (the legacy `INV-`/`ORD-` random format kicks in if docCode is unset).
const docCode = z.string()
  .regex(/^[A-Z0-9]{2,6}$/, 'Document code must be 2-6 uppercase letters or digits')
  .optional()
  .or(z.literal(''));

export const createDistributorSchema = z.object({
  businessName: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200),
  docCode: docCode,
  gstin: gstin,
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: pincode,
  phone: phone.optional(),
  email: email.optional(),
  providerCodes: z.array(z.string()).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  // Godown / Warehouse address
  godownAddress: z.string().max(500).optional(),
  godownCity: z.string().max(100).optional(),
  godownState: z.string().max(100).optional(),
  godownPincode: pincode,
  godownLatitude: z.number().optional(),
  godownLongitude: z.number().optional(),
  // Office address
  officeAddress: z.string().max(500).optional(),
  officeCity: z.string().max(100).optional(),
  officeState: z.string().max(100).optional(),
  officePincode: pincode,
});

// Group A Step 6: gstMode is intentionally absent from updateDistributorSchema.
// The ONLY way to change gst_mode after Group A is the dedicated activation
// flow at POST /api/admin/distributors/:id/gst/{activate,disable}. The
// distributor PUT route silently strips gstMode if a client sends it (legacy
// callers stay functional but the field is ignored).
export const updateDistributorSchema = createDistributorSchema.partial().extend({
  status: z.enum(['active', 'suspended', 'inactive']).optional(),
  subscriptionPlan: z.enum(['starter', 'growth', 'business', 'enterprise']).nullable().optional(),
  billingTier: z.enum(['tier_1', 'tier_2', 'tier_3', 'tier_4']).nullable().optional(),
  gaslinkBillingEnabled: z.boolean().optional(),
});

// ─── Filter/Query Schemas ────────────────────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const dateRangeSchema = z.object({
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
});

export const orderFilterSchema = paginationSchema.merge(dateRangeSchema).extend({
  status: z.nativeEnum(OrderStatus).optional(),
  customerId: uuid.optional(),
  driverId: uuid.optional(),
  search: z.string().optional(),
});

export const invoiceFilterSchema = paginationSchema.merge(dateRangeSchema).extend({
  status: z.nativeEnum(InvoiceStatus).optional(),
  customerId: uuid.optional(),
  irnStatus: z.string().optional(),
});

export const paymentFilterSchema = paginationSchema.merge(dateRangeSchema).extend({
  customerId: uuid.optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  // Comma-separated for "in" semantics, e.g. ?allocationStatus=unallocated,partially_allocated
  allocationStatus: z.string().optional().transform((v) =>
    v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  ),
  sortBy: z.enum(['createdAt', 'amount', 'transactionDate']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export const customerFilterSchema = paginationSchema.extend({
  status: z.nativeEnum(CustomerStatus).optional(),
  search: z.string().optional(),
  // Group B Part 3 — `unlinked=true` returns only customers that have no
  // app-login user row pointing at them via User.customerId. Drives the
  // smart Add User modal's role=customer dropdown.
  unlinked: z.union([z.literal('true'), z.literal('1'), z.literal('false'), z.literal('0')]).optional(),
});

// ─── Type exports from schemas ───────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type VerifyResetOtpInput = z.infer<typeof verifyResetOtpSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type DeliveryConfirmationInput = z.infer<typeof deliveryConfirmationSchema>;
export type AssignDriverInput = z.infer<typeof assignDriverSchema>;
export type BulkAssignDriverInput = z.infer<typeof bulkAssignDriverSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;
export type CreateDebitNoteInput = z.infer<typeof createDebitNoteSchema>;
export type IncomingFullsInput = z.infer<typeof incomingFullsSchema>;
export type OutgoingEmptiesInput = z.infer<typeof outgoingEmptiesSchema>;
export type ManualAdjustmentInput = z.infer<typeof manualAdjustmentSchema>;
export type CancelledStockReturnInput = z.infer<typeof cancelledStockReturnSchema>;
export type CustomerBalanceSetupInput = z.infer<typeof customerBalanceSetupSchema>;
export type CylinderThresholdInput = z.infer<typeof cylinderThresholdSchema>;
export type GstCredentialsInput = z.infer<typeof gstCredentialsSchema>;
export type ApprovalWorkflowInput = z.infer<typeof approvalWorkflowSchema>;
export type CreateAccountabilityInput = z.infer<typeof createAccountabilitySchema>;
export type ResolveAccountabilityInput = z.infer<typeof resolveAccountabilitySchema>;
export type ContactFormInput = z.infer<typeof contactFormSchema>;
export type CreateDistributorInput = z.infer<typeof createDistributorSchema>;
export type UpdateDistributorInput = z.infer<typeof updateDistributorSchema>;
export type OrderFilterInput = z.infer<typeof orderFilterSchema>;
export type InvoiceFilterInput = z.infer<typeof invoiceFilterSchema>;
export type PaymentFilterInput = z.infer<typeof paymentFilterSchema>;
export type CustomerFilterInput = z.infer<typeof customerFilterSchema>;
export type ReturnsOnlyOrderInput = z.infer<typeof returnsOnlyOrderSchema>;
export type ReturnsConfirmationInput = z.infer<typeof returnsConfirmationSchema>;
