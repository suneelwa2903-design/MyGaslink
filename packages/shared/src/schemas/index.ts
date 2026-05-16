import { z } from 'zod';
import {
  UserRole, PaymentMethod, OrderStatus, InvoiceStatus,
  CustomerStatus, GstMode, AccountabilityType,
} from '../enums/index.js';
import { GSTIN_REGEX } from '../constants/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phone = z.string().min(10).max(15).regex(/^[+]?[\d\s-]+$/);
const email = z.string().trim().toLowerCase().email();
const gstin = z.string().regex(GSTIN_REGEX, 'Invalid GSTIN format').optional().or(z.literal(''));
const positiveNumber = z.number().positive();
const nonNegativeNumber = z.number().min(0);

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
});

export const updateUserSchema = createUserSchema.partial().omit({ password: true });

// ─── Customer Schemas ────────────────────────────────────────────────────────

const customerContactSchema = z.object({
  name: z.string().min(1, 'Contact name is required').max(100),
  phone: phone,
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
  billingPincode: z.string().max(10).optional(),
  shippingAddressLine1: z.string().max(500).optional(),
  shippingAddressLine2: z.string().max(500).optional(),
  shippingCity: z.string().max(100).optional(),
  shippingState: z.string().max(100).optional(),
  shippingPincode: z.string().max(10).optional(),
  creditPeriodDays: z.number().int().min(0).max(365).default(30),
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
  items: z.array(z.object({
    cylinderTypeId: uuid,
    deliveredQuantity: z.number().int().min(0),
    emptiesCollected: z.number().int().min(0),
  })).min(1),
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

export const incomingFullsSchema = z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().positive(),
  documentType: z.string().min(1, 'Document type is required').max(50),
  documentNumber: z.string().min(1).max(100),
  documentDate: dateString,
  vehicleNumber: z.string().max(20).optional(),
  driverName: z.string().max(100).optional(),
  vehicleId: uuid.optional(),
  notes: z.string().max(500).optional(),
});

export const outgoingEmptiesSchema = z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().positive(),
  documentType: z.string().min(1, 'Document type is required').max(50),
  documentNumber: z.string().min(1).max(100),
  documentDate: dateString,
  vehicleNumber: z.string().max(20).optional(),
  driverName: z.string().max(100).optional(),
  vehicleId: uuid.optional(),
  notes: z.string().max(500).optional(),
});

export const manualAdjustmentSchema = z.object({
  cylinderTypeId: uuid,
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

export const createDistributorSchema = z.object({
  businessName: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200),
  gstin: gstin,
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: z.string().max(10).optional(),
  phone: phone.optional(),
  email: email.optional(),
  providerCodes: z.array(z.string()).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  // Godown / Warehouse address
  godownAddress: z.string().max(500).optional(),
  godownCity: z.string().max(100).optional(),
  godownState: z.string().max(100).optional(),
  godownPincode: z.string().max(10).optional(),
  godownLatitude: z.number().optional(),
  godownLongitude: z.number().optional(),
  // Office address
  officeAddress: z.string().max(500).optional(),
  officeCity: z.string().max(100).optional(),
  officeState: z.string().max(100).optional(),
  officePincode: z.string().max(10).optional(),
});

export const updateDistributorSchema = createDistributorSchema.partial().extend({
  gstMode: z.enum(['disabled', 'sandbox', 'live']).optional(),
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
});

// ─── Type exports from schemas ───────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type VerifyResetOtpInput = z.infer<typeof verifyResetOtpSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
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
