// ─── User & Auth ─────────────────────────────────────────────────────────────

export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  DISTRIBUTOR_ADMIN = 'distributor_admin',
  FINANCE = 'finance',
  INVENTORY = 'inventory',
  DRIVER = 'driver',
  CUSTOMER = 'customer',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

export enum ProvisioningStatus {
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  PROVISIONING = 'provisioning',
  ACTIVE = 'active',
  FAILED = 'failed',
}

// ─── Distributor ─────────────────────────────────────────────────────────────

export enum DistributorStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  INACTIVE = 'inactive',
}

export enum SubscriptionPlan {
  STARTER = 'starter',
  GROWTH = 'growth',
  BUSINESS = 'business',
  ENTERPRISE = 'enterprise',
}

export enum GstMode {
  DISABLED = 'disabled',
  SANDBOX = 'sandbox',
  LIVE = 'live',
}

// ─── Customer ────────────────────────────────────────────────────────────────

export enum CustomerStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  INACTIVE = 'inactive',
}

export enum ModificationType {
  UPDATE_INFO = 'update_info',
  CREDIT_LIMIT_CHANGE = 'credit_limit_change',
  STOP_SUPPLY = 'stop_supply',
  RESUME_SUPPLY = 'resume_supply',
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export enum OrderStatus {
  PENDING_DRIVER_ASSIGNMENT = 'pending_driver_assignment',
  PENDING_DISPATCH = 'pending_dispatch',
  PENDING_DELIVERY = 'pending_delivery',
  DELIVERED = 'delivered',
  MODIFIED_DELIVERED = 'modified_delivered',
  CANCELLED = 'cancelled',
  RETURNS_ONLY = 'returns_only',
}

export enum OrderType {
  DELIVERY = 'delivery',
  RETURNS_ONLY = 'returns_only',
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export enum InvoiceStatus {
  DRAFT = 'draft',
  ISSUED = 'issued',
  PARTIALLY_PAID = 'partially_paid',
  PAID = 'paid',
  OVERDUE = 'overdue',
  CANCELLED = 'cancelled',
}

// ─── GST / E-Invoice ────────────────────────────────────────────────────────

export enum IrnStatus {
  NOT_ATTEMPTED = 'not_attempted',
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum EwbStatus {
  NOT_ATTEMPTED = 'not_attempted',
  PENDING = 'pending',
  ACTIVE = 'active',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum GstDocType {
  INVOICE = 'INV',
  CREDIT_NOTE = 'CRN',
  DEBIT_NOTE = 'DBN',
}

// ─── Drivers & Vehicles ─────────────────────────────────────────────────────

export enum DriverStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum VehicleStatus {
  IDLE = 'idle',
  DISPATCHED = 'dispatched',
  RETURNED = 'returned',
  INACTIVE = 'inactive',
}

export enum AssignmentStatus {
  DISPATCH_READY = 'dispatch_ready',
  LOADED_AND_DISPATCHED = 'loaded_and_dispatched',
  RETURNED_INVENTORY = 'returned_inventory',
  RECONCILED = 'reconciled',
  CANCELLED = 'cancelled',
}

// ─── Inventory ───────────────────────────────────────────────────────────────

export enum AdjustmentStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum CancelledStockStatus {
  PENDING = 'pending',
  ON_VEHICLE = 'on_vehicle',
  RETURNED_TO_DEPOT = 'returned_to_depot',
  RECONCILED = 'reconciled',
  WRITTEN_OFF = 'written_off',
}

export enum InventoryEventType {
  INCOMING_FULLS = 'incoming_fulls',
  OUTGOING_EMPTIES = 'outgoing_empties',
  DELIVERY = 'delivery',
  COLLECTION = 'collection',
  MANUAL_ADJUSTMENT = 'manual_adjustment',
  CANCELLATION = 'cancellation',
  CANCELLATION_RETURN = 'cancellation_return',
  INITIAL_BALANCE = 'initial_balance',
  WRITE_OFF = 'write_off',
  RETURNS_COLLECTION = 'returns_collection',
}

export enum ReplenishmentStatus {
  PENDING = 'pending',
  IN_TRANSIT = 'in_transit',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
}

// ─── Payments ────────────────────────────────────────────────────────────────

export enum PaymentMethod {
  CASH = 'cash',
  CHEQUE = 'cheque',
  ONLINE = 'online',
  UPI = 'upi',
  BANK_TRANSFER = 'bank_transfer',
  CREDIT = 'credit',
}

export enum PaymentAllocationStatus {
  UNALLOCATED = 'unallocated',
  PARTIALLY_ALLOCATED = 'partially_allocated',
  FULLY_ALLOCATED = 'fully_allocated',
}

// ─── Credit / Debit Notes ────────────────────────────────────────────────────

export enum CreditNoteStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  ISSUED = 'issued',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

export enum DebitNoteStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  ISSUED = 'issued',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

// ─── GasLink SaaS Billing ────────────────────────────────────────────────────

export enum BillingPeriodType {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  HALF_YEARLY = 'half_yearly',
  YEARLY = 'yearly',
}

export enum BillingStatus {
  PENDING_GENERATION = 'pending_generation',
  INVOICE_GENERATED = 'invoice_generated',
  PENDING_PAYMENT = 'pending_payment',
  PAID = 'paid',
  OVERDUE = 'overdue',
  SUSPENDED = 'suspended',
}

export enum BillingTier {
  TIER_1 = 'tier_1',
  TIER_2 = 'tier_2',
  TIER_3 = 'tier_3',
  TIER_4 = 'tier_4',
}

export enum BillingItemType {
  BASE_SUBSCRIPTION = 'base_subscription',
  DRIVER_LOGIN = 'driver_login',
  OTHER_LOGIN = 'other_login',
  CUSTOMER_PORTAL = 'customer_portal',
  GST_API_OVERAGE = 'gst_api_overage',
  EXTRA_SEAT = 'extra_seat',
  CUSTOM_ADDON = 'custom_addon',
  DISCOUNT = 'discount',
  PERIOD_DISCOUNT = 'period_discount',
}

// ─── Pending Actions ─────────────────────────────────────────────────────────

export enum PendingActionModule {
  INVENTORY = 'inventory',
  INVOICE = 'invoice',
  GST_COMPLIANCE = 'gst_compliance',
  PAYMENT = 'payment',
  CUSTOMER = 'customer',
  ORDER = 'order',
  DRIVER = 'driver',
}

export enum PendingActionStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export enum PendingActionSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// ─── Accountability ──────────────────────────────────────────────────────────

export enum AccountabilityType {
  LOST_CYLINDER = 'lost_cylinder',
  DAMAGED_CYLINDER = 'damaged_cylinder',
  MISSING_CYLINDER = 'missing_cylinder',
  DELIVERY_SHORTAGE = 'delivery_shortage',
  CUSTOMER_DISPUTE = 'customer_dispute',
}

export enum AccountabilityStatus {
  OPEN = 'open',
  INVESTIGATING = 'investigating',
  RESOLVED_RECOVERED = 'resolved_recovered',
  RESOLVED_WRITTEN_OFF = 'resolved_written_off',
  RESOLVED_CHARGED = 'resolved_charged',
  CLOSED = 'closed',
}

export enum SeatRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

// ─── Licenses ────────────────────────────────────────────────────────────────

export enum LicenseType {
  PESO = 'peso',
  GST = 'gst',
  DATE_OF_INCORPORATION = 'date_of_incorporation',
  PARTNERSHIP_DEED = 'partnership_deed',
  PAN = 'pan',
  BANK_ACCOUNT_DETAILS = 'bank_account_details',
  CANCELLATION_CHEQUE = 'cancellation_cheque',
  CUSTOM = 'custom',
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

export enum LedgerEntryType {
  INVOICE = 'invoice',
  CREDIT_NOTE = 'credit_note',
  DEBIT_NOTE = 'debit_note',
  PAYMENT = 'payment',
  ADJUSTMENT = 'adjustment',
}

// ─── Approval Workflow ───────────────────────────────────────────────────────

export enum ApprovalAction {
  INVENTORY_ADJUSTMENT = 'inventory_adjustment',
  CREDIT_NOTE = 'credit_note',
  DEBIT_NOTE = 'debit_note',
  CUSTOMER_MODIFICATION = 'customer_modification',
  STOCK_REPLENISHMENT = 'stock_replenishment',
  PRICE_CHANGE = 'price_change',
  WRITE_OFF = 'write_off',
}
