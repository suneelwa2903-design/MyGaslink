import { z } from 'zod';
import {
  UserRole, PaymentMethod, OrderStatus, InvoiceStatus,
  CustomerStatus, GstMode, AccountabilityType, AccountType,
} from '../enums/index.js';
import { GSTIN_REGEX, IFSC_REGEX, UPI_REGEX, localTodayISO } from '../constants/index.js';

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
  // Item 4 (2026-07-09) — optional per-device label ("iOS - iPhone 14",
  // "Chrome on Windows", etc). Persisted on the refresh_token_sessions
  // row so a future "logged in devices" screen can identify sessions.
  deviceLabel: z.string().max(120).optional(),
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
  // GST rate override (percent). null/omitted → platform default 18%. Only
  // 5 (food-service: hotels/restaurants/canteens) or 18 (standard) are
  // accepted. Free-form numbers are rejected to keep the IRN payload
  // building safe — every new rate needs an NIC-sandbox A/B verification
  // per CLAUDE.md anti-pattern #10.
  gstRateOverride: z.union([z.literal(5), z.literal(18)]).nullable().optional(),
  // Proof-of-collection Phase 1 (2026-07-15): when true, driver's
  // confirm-delivery flow requires a proof (signature/photo/OTP per phase
  // rollout). Default false = existing behaviour. updateCustomerSchema
  // inherits via .partial().extend() — no duplicate addition needed.
  requireDeliveryVerification: z.boolean().optional(),
  contacts: z.array(customerContactSchema).optional(),
  cylinderDiscounts: z.array(cylinderDiscountSchema).optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  // Status is edit-only — createCustomer ignores it; PUT /customers/:id
  // applies the change subject to a role guard in the route handler.
  status: z.nativeEnum(CustomerStatus).optional(),
});

// ─── Customer Group Schemas ─────────────────────────────────────────────────
// Feature A (2026-07-15): HQ portal group management. Routes are gated
// to super_admin | distributor_admin | finance | inventory (same as
// customer create). distributorId always sourced from JWT server-side.

export const createGroupSchema = z.object({
  name: z.string().min(1, 'Group name required').max(100),
});
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z.object({
  name: z.string().min(1, 'Group name required').max(100),
});
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const addGroupMemberSchema = z.object({
  customerId: uuid,
  // 2026-07-20 — optional short alias shown on HQ portal surfaces in
  // place of customer.customerName. Nullable to allow clearing on
  // update; empty string is coerced to null so the falsy fallback in
  // readers works uniformly.
  displayName: z
    .string()
    .trim()
    .max(80, 'Display name must be 80 characters or fewer')
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
});
export type AddGroupMemberInput = z.infer<typeof addGroupMemberSchema>;

export const updateGroupMemberSchema = z.object({
  displayName: z
    .string()
    .trim()
    .max(80, 'Display name must be 80 characters or fewer')
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});
export type UpdateGroupMemberInput = z.infer<typeof updateGroupMemberSchema>;

export const provisionGroupPortalAccessSchema = z.object({
  email: email,
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name required').max(80),
  lastName: z.string().min(1, 'Last name required').max(80),
  // Feature A follow-up (2026-07-15): when provisioning via the
  // "promote a contact" path, the client passes the source contactId
  // so the created HQ user carries traceability back to that contact.
  // Optional — the free-form path still exists.
  sourceContactId: uuid.optional(),
});
export type ProvisionGroupPortalAccessInput = z.infer<typeof provisionGroupPortalAccessSchema>;

// ─── Order Schemas ───────────────────────────────────────────────────────────

const orderItemSchema = z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().positive('Quantity must be at least 1'),
});

export const createOrderSchema = z.object({
  customerId: uuid,
  deliveryDate: dateString,
  specialInstructions: z.string().max(500).optional(),
  // Buyer's PO number (B2B). 16 chars max — NIC PoDtls.PoNo cap. UI hides the
  // field for B2C customers but the schema accepts it from any caller; the
  // IRN payload builder gates emission on customerType === 'B2B'.
  poNumber: z.string().max(16, 'PO Number must be at most 16 characters').optional(),
  // Mini-Operator (2026-07-16): free-text driver name for accountType=
  // mini_operator tenants that don't maintain Driver records. Optional
  // and unrelated to the driverId FK; regular distributors continue to
  // use driver assignment. Max 100 matches the DB column.
  driverNameFreeText: z.string().max(100).optional(),
  // Customer self-collects from godown — no driver/vehicle/EWB flow.
  // Optional + default so existing API callers keep working unchanged.
  // The orderService.createOrder pass-through (`data.isGodownPickup ?? false`)
  // normalises undefined to false at the service layer, mirroring the
  // DB column's `DEFAULT false`.
  isGodownPickup: z.boolean().default(false).optional(),
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
  // PO number is editable until the invoice is issued; after issue the
  // denormalised Invoice.poNumber snapshot still reflects the value at
  // creation time, so post-issue edits are visual-only on the Order view.
  poNumber: z.string().max(16, 'PO Number must be at most 16 characters').optional(),
  // Mini-Operator (2026-07-16): free-text driver name mirrors the field
  // on createOrderSchema so mini-operators can amend after creation.
  driverNameFreeText: z.string().max(100).optional(),
  items: z.array(orderItemSchema).min(1).optional(),
});

// Brief 3 — backdated / on-demand order create. Same-month, before-today
// guard at the schema edge plus a defence-in-depth recheck in the service.
// Both edges use `localTodayISO()` from constants — never
// `new Date().toISOString().split('T')[0]` (banned by anti-pattern #21
// and the check-tz-patterns.sh CI guard).
export const backdatedOrderSchema = z.object({
  customerId: uuid,
  issueDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .refine((date) => {
      const now = new Date();
      const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      return date.startsWith(currentYM);
    }, 'Backdated date must be within the current calendar month')
    .refine((date) => {
      const todayStr = localTodayISO();
      return date < todayStr;
    }, 'Backdated date must be before today'),
  items: z.array(z.object({
    cylinderTypeId: uuid,
    quantity: z.number().int().min(1),
    // Empties the customer handed back at the historical delivery.
    // 0 (default) is fine — many backdated deliveries have no
    // empties yet. The apply-inventory-adjustment step writes a
    // reconciliation_empties_return event only when this is > 0.
    // `.default(0).optional()` keeps both Zod input and output
    // optional — react-hook-form's TFieldValues uses the input
    // type, the service layer normalises with `?? 0`. Same pattern
    // as isGodownPickup in createOrderSchema (Brief 2 lesson).
    emptiesCollected: z.number().int().min(0).default(0).optional(),
  })).min(1),
  specialInstructions: z.string().max(500).optional(),
  driverId: uuid.optional(),
  vehicleId: uuid.optional(),
  poNumber: z.string().max(16, 'PO Number must be at most 16 characters').optional(),
  payment: z.object({
    amount: z.number().positive(),
    paymentMethod: z.enum(['cash', 'upi', 'cheque', 'neft', 'rtgs', 'other']),
    referenceNumber: z.string().optional(),
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).optional(),
}).refine(
  (data) => !(data.vehicleId && !data.driverId),
  { message: 'Driver is required when vehicle is provided', path: ['driverId'] },
);

export type BackdatedOrderInput = z.infer<typeof backdatedOrderSchema>;

// Item 7 (2026-07-09) — simple empties return. Customer hands back N
// empties of a given cylinder type; no schedule, no invoice, no money
// event. Return date may be today or up to 90 days back (an operator
// covering an old delivery that was never logged). Same anti-pattern-#21
// rules apply: use `localTodayISO()`, never `new Date().toISOString().split('T')[0]`.
export const emptiesReturnSchema = z.object({
  customerId: uuid,
  cylinderTypeId: uuid,
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
  returnDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .refine((date) => date <= localTodayISO(), 'Return date cannot be in the future')
    .refine((date) => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
      return date >= cutoffStr;
    }, 'Return date cannot be more than 90 days ago'),
  notes: z.string().max(500).optional(),
});

export type EmptiesReturnInput = z.infer<typeof emptiesReturnSchema>;

// Item 6 (2026-07-09) — backdated driver TRIP. Same-month + before-today
// guard as the single backdated order, but the payload carries a driver +
// vehicle and an array of customer orders — represents a driver run that
// was completed but never entered into the system in real time. The DVA
// is created/upserted at `status='reconciled', isReconciled=true` so it
// bypasses the state machine (trip already happened).
export const backdatedTripSchema = z.object({
  issueDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .refine((date) => {
      const now = new Date();
      const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      return date.startsWith(currentYM);
    }, 'Trip date must be within the current calendar month')
    .refine((date) => date < localTodayISO(), 'Trip date must be before today'),
  // Q1 merge (2026-07-09) — driver + vehicle are optional so the single-
  // customer "On-Demand" flow can go through this same endpoint without
  // a driver/vehicle. Multi-customer trips still typically supply them
  // (the modal enforces required in the "Multiple customers" mode) but
  // the schema no longer rejects a driver-less single-customer entry.
  driverId: uuid.optional(),
  vehicleId: uuid.optional(),
  orders: z.array(z.object({
    customerId: uuid,
    items: z.array(z.object({
      cylinderTypeId: uuid,
      quantity: z.number().int().min(1),
      emptiesCollected: z.number().int().min(0).default(0).optional(),
    })).min(1),
    poNumber: z.string().max(16, 'PO Number must be at most 16 characters').optional(),
    payment: z.object({
      amount: z.number().positive(),
      paymentMethod: z.enum(['cash', 'upi', 'cheque', 'neft', 'rtgs', 'other']),
      referenceNumber: z.string().optional(),
    }).optional(),
    // 2026-07-17: per-customer notes on the backdated batch entry card,
    // mirroring the regular order form's specialInstructions field.
    // Optional; if provided it wins over the trip-level specialInstructions
    // in the service so each customer entry can carry its own note. Max
    // 500 chars matches Order.specialInstructions constraint.
    specialInstructions: z.string().max(500).optional(),
  })).min(1, 'At least one order is required').max(50, 'Cannot create more than 50 orders in one trip'),
  specialInstructions: z.string().max(500).optional(),
  // Q2 (2026-07-09) — inventory auto-apply. When true, the service will
  // run the same stock-adjustment step the operator would otherwise do
  // manually on the On-Demand Adjustments tab (writes InventoryEvents,
  // updates CustomerInventoryBalance, cascades summary recalc from the
  // trip date forward). Default false in the API so old clients don't
  // suddenly start writing stock without opting in — the web modal
  // defaults it ON via the checkbox.
  applyInventoryAdjustment: z.boolean().optional(),
}).refine(
  (data) => !(data.vehicleId && !data.driverId),
  { message: 'Driver is required when a vehicle is provided', path: ['driverId'] },
);

export type BackdatedTripInput = z.infer<typeof backdatedTripSchema>;

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
  // Proof-of-collection Phase 1 (2026-07-15) — all optional; when the
  // customer has requireDeliveryVerification=true the driver client uses
  // the separate POST /orders/:id/delivery-proof endpoint to upsert the
  // proof BEFORE calling /confirm-delivery (plan §R1 mitigation:
  // decouples proof idempotency from delivery idempotency). These fields
  // exist as an optional echo channel for backward-compat if any client
  // sends them inline — server-side treats them as advisory metadata,
  // never as the primary write path. Business validation (which fields
  // pair together for a valid proof) lives in the service, not Zod.
  proofType: z.enum(['signature', 'photo', 'otp']).optional(),
  proofS3Key: z.string().max(200).optional(),
  proofSigningPartyPhone: z.string().min(10).max(15).optional(),
  otpCode: z.string().length(6).optional(),
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
  // Optional free-text note for the whole payment (2026-07-14).
  // Persists to payment_transactions.notes — column existed already;
  // creation path now exposes it. Bulk payments: single note covers
  // every invoice touched by this payment (per-allocation notes are
  // not supported).
  notes: z.string().max(500).optional(),
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
  // Mini-Operator (2026-07-16): account type discriminator. Defaults to
  // `distributor` (full-featured) when the caller omits it, preserving
  // existing behaviour for every caller not yet updated. Super Admin
  // sets `mini_operator` from the Distributors page. Downstream service
  // rejects mini_operator + gstMode transitions to sandbox/live.
  accountType: z.nativeEnum(AccountType).default(AccountType.DISTRIBUTOR).optional(),
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
  // Phase 3 (2026-06-12): bank + UPI payment details rendered on invoice
  // and customer-ledger PDFs. All optional. IFSC + UPI format-checked only
  // when non-empty (legacy data + the Settings "leave blank" path stay
  // valid). The IFSC field is auto-uppercased client-side; this regex
  // matches what the user actually submits after that transform.
  bankName: z.string().max(100).optional().or(z.literal('')),
  bankAccountNumber: z.string().max(30).optional().or(z.literal('')),
  bankBranchName: z.string().max(100).optional().or(z.literal('')),
  ifscCode: z.string().regex(IFSC_REGEX, 'Invalid IFSC code format (expected 11 characters, e.g. HDFC0001234)').optional().or(z.literal('')),
  upiId: z.string().regex(UPI_REGEX, 'Invalid UPI ID format (expected e.g. gasagency@hdfc)').optional().or(z.literal('')),
});

// Group A Step 6: gstMode is intentionally absent from updateDistributorSchema.
// The ONLY way to change gst_mode after Group A is the dedicated activation
// flow at POST /api/admin/distributors/:id/gst/{activate,disable}. The
// distributor PUT route silently strips gstMode if a client sends it (legacy
// callers stay functional but the field is ignored).
export const updateDistributorSchema = createDistributorSchema.partial().extend({
  status: z.enum(['active', 'suspended', 'inactive']).optional(),
  subscriptionPlan: z.enum(['starter', 'growth', 'business', 'enterprise', 'ultra']).nullable().optional(),
  billingTier: z.enum(['tier_1', 'tier_2', 'tier_3', 'tier_4']).nullable().optional(),
  gaslinkBillingEnabled: z.boolean().optional(),
  // Group L5 (2026-06-11): super-admin toggle for sandbox-allowlist
  // status. Set this to `true` to allow the distributor to use GST
  // sandbox mode (Group A activation flow). For real distributors leave
  // it false — they go disabled → live directly. The route handler
  // strips this field when the caller is NOT super_admin so an
  // escalating distributor_admin cannot self-allowlist.
  isTestTenant: z.boolean().optional(),
  // Phase F (2026-06-12): super-admin sets the distributor's Razorpay
  // credentials for the customer-portal "Pay Now" flow. The route
  // handler strips these fields when the caller is NOT super_admin
  // (a distributor_admin self-configuring their own Razorpay would
  // bypass the per-tenant onboarding review). Format checks are
  // light — Razorpay key id starts with rzp_ but we don't bind to
  // test/live here, leaving that as a deployment-time decision.
  razorpayEnabled: z.boolean().optional(),
  razorpayKeyId: z.string().max(100).optional().or(z.literal('')),
  razorpayKeySecret: z.string().max(200).optional().or(z.literal('')),
  razorpayWebhookSecret: z.string().max(200).optional().or(z.literal('')),
});

// ─── Filter/Query Schemas ────────────────────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(25),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const dateRangeSchema = z.object({
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
});

// `status` accepts either a real OrderStatus enum value OR one of the
// pseudo-status filters `godown_pickup` / `on_demand`. The service layer
// translates the pseudo values to `isGodownPickup: true` / `isBackdated: true`
// filters against `orders`. Same dropdown, two more choices — no new query param.
export const orderFilterSchema = paginationSchema.merge(dateRangeSchema).extend({
  status: z.union([
    z.nativeEnum(OrderStatus),
    z.literal('godown_pickup'),
    z.literal('on_demand'),
  ]).optional(),
  customerId: uuid.optional(),
  driverId: uuid.optional(),
  search: z.string().optional(),
});

// WI-PENDING-PAYMENTS post-smoke FIX-A: `status` accepts EITHER a single
// InvoiceStatus enum value (existing single-status callers — admin
// invoice list filter) OR a comma-separated string that transforms
// into an array of values (e.g. ?status=issued,partially_paid,overdue
// used by the approval modal's open-invoices picker). The service layer
// applies `{ in: [...] }` when an array arrives and `{ equals: ... }`
// when a single value arrives. Matches the existing
// `paymentFilterSchema.allocationStatus` transform pattern at line 570.
export const invoiceFilterSchema = paginationSchema.merge(dateRangeSchema).extend({
  status: z.union([
    z.nativeEnum(InvoiceStatus),
    z.string().transform((val) =>
      val.split(',').map((s) => s.trim()).filter(Boolean),
    ),
  ]).optional(),
  customerId: uuid.optional(),
  irnStatus: z.string().optional(),
  // Free-text search across invoiceNumber, customerName, poNumber.
  // Trimmed + length-bounded so a 4MB query string can't pivot into a
  // pathological ILIKE.
  search: z.string().max(120).optional(),
});

export const paymentFilterSchema = paginationSchema.merge(dateRangeSchema).extend({
  customerId: uuid.optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  // 2026-07-17: entry-date filter — stacks with dateFrom/dateTo (which are
  // on transactionDate = business date). entryDateFrom/entryDateTo filter
  // on PaymentTransaction.createdAt (the DB insert timestamp) so ops can
  // reconcile "what got entered today" separately from "what payments are
  // attributed to today's business date". Both optional; both provided
  // stacks (AND) with the payment-date range.
  entryDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
  entryDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
  // Comma-separated for "in" semantics, e.g. ?allocationStatus=unallocated,partially_allocated
  allocationStatus: z.string().optional().transform((v) =>
    v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  ),
  sortBy: z.enum(['createdAt', 'amount', 'transactionDate']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  // Free-text: customerName, referenceNumber. If parseable as a positive
  // number, also exact-match on amount.
  search: z.string().max(120).optional(),
});

export const customerFilterSchema = paginationSchema.extend({
  status: z.nativeEnum(CustomerStatus).optional(),
  customerType: z.enum(['B2B', 'B2C']).optional(),
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

// ─── Mini-Operator (2026-07-16) — Source Distributors + Purchase Entries ─────

// Source distributor = free-text supplier the mini-operator buys stock from.
// Just a name; no address/GSTIN/phone in v1 — the mini-operator writes the
// name into a purchase-entry dropdown, that's it. Unique per tenant enforced
// at the DB layer; the service layer surfaces the 409 as a user-friendly
// "already exists" error.
export const createSourceDistributorSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
});
export const updateSourceDistributorSchema = createSourceDistributorSchema.partial();

// Purchase entry — stock IN to the mini-operator's godown. Records one batch
// received from a source distributor on a given date. Each item may have
// non-zero `fullsReceived`, non-zero `emptiesGivenOut`, or both; the service
// layer rejects an entry where every item is zero (no-op guard).
export const createPurchaseEntrySchema = z.object({
  sourceDistributorId: uuid.optional(),
  // purchaseDate is a YYYY-MM-DD string (local calendar date, no time).
  // Matches the `PurchaseEntry.purchaseDate String` column — see the model
  // docstring for the rationale; using string here (not DateTime) avoids
  // TZ drift for the single-user mini-operator workflow.
  purchaseDate: dateString,
  notes: z.string().max(500).optional(),
  items: z
    .array(
      z.object({
        cylinderTypeId: uuid,
        fullsReceived: z.number().int().min(0),
        emptiesGivenOut: z.number().int().min(0),
        // Money per full received (INR, GST-inclusive). 0 = movement-only
        // entry (e.g. an empties swap where nothing was paid). Per-line
        // total = fullsReceived * unitPrice, computed at read time.
        unitPrice: z.number().min(0).default(0),
      }),
    )
    .min(1, 'At least one cylinder type entry is required'),
});

// Update reuses the same payload shape as create. Service delete-and-recreate
// the items so InventoryEvent rows stay consistent — see updatePurchaseEntry.
export const updatePurchaseEntrySchema = createPurchaseEntrySchema;

export type CreateSourceDistributorInput = z.infer<typeof createSourceDistributorSchema>;
export type UpdateSourceDistributorInput = z.infer<typeof updateSourceDistributorSchema>;
export type CreatePurchaseEntryInput = z.infer<typeof createPurchaseEntrySchema>;
export type UpdatePurchaseEntryInput = z.infer<typeof updatePurchaseEntrySchema>;

// ─── FLOAT-001 — Vehicle Load Manifest + Driver walk-in order ────────────────

// Admin enters per-cylinder-type totals BEFORE preflight dispatch. `totalLoaded`
// is the count physically loaded onto the vehicle (ordered + float). Server
// computes `orderedQty` from pending_dispatch orders and stores the row;
// floatQty = totalLoaded - orderedQty. Allows an empty `items` array — useful
// for clearing a previously-entered manifest before dispatch starts; the
// service-side guard validates at least one cylinderType is referenced.
export const createManifestSchema = z.object({
  dvaId: uuid,
  items: z.array(z.object({
    cylinderTypeId: uuid,
    totalLoaded: z.number().int().min(0),
  })).min(1, 'At least one cylinder type entry is required'),
});
export type CreateManifestInput = z.infer<typeof createManifestSchema>;

// Driver mobile walk-in order. deliveryDate MUST equal today (server-side check
// in routes/driversVehicles.ts). One cylinder type per call; multiple types
// require multiple submissions (keeps the mobile flow simple).
export const driverCreateOrderSchema = z.object({
  customerId: uuid,
  cylinderTypeId: uuid,
  quantity: z.number().int().min(1),
  deliveryDate: dateString,
});
export type DriverCreateOrderInput = z.infer<typeof driverCreateOrderSchema>;
