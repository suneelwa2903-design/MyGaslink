import type {
  UserRole, UserStatus, ProvisioningStatus, DistributorStatus, GstMode, SubscriptionPlan,
  CustomerStatus, OrderStatus, OrderType, InvoiceStatus, IrnStatus, EwbStatus,
  DriverStatus, VehicleStatus, AssignmentStatus, AdjustmentStatus,
  CancelledStockStatus, PaymentMethod, PaymentAllocationStatus,
  CreditNoteStatus, DebitNoteStatus, BillingPeriodType, BillingStatus,
  BillingTier, BillingItemType, PendingActionModule, PendingActionStatus,
  PendingActionSeverity, AccountabilityType, AccountabilityStatus,
  LedgerEntryType, InventoryEventType, LicenseType, GstDocType,
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
  createdAt: string;
  updatedAt: string;
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
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  status: DistributorStatus;
  gstMode: GstMode;
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
  status: CustomerStatus;
  stopSupply: boolean;
  preferredDriverId: string | null;
  contacts: CustomerContact[];
  cylinderDiscounts: CustomerCylinderDiscount[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomerContact {
  contactId: string;
  name: string;
  phone: string;
  email: string | null;
  isPrimary: boolean;
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
  vehicleId: string | null;
  vehicleNumber: string | null;
  orderDate: string;
  deliveryDate: string;
  status: OrderStatus;
  orderType?: OrderType;
  totalAmount: number;
  specialInstructions: string | null;
  items: OrderItem[];
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
  isGaslinkBilling: boolean;
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
  deliveredQty: number;
  collectedEmpties: number;
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
}

export interface CustomerLedgerResponse {
  rows: CustomerLedgerRow[];
  summary: {
    totalAmount: number;
    receivedAmount: number;
    dueAmount: number;
    overdueAmount: number;
    emptyCylsCost: number;
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
  pendingOrders: number;
  overdueInvoices: number;
  totalOutstanding: number;
  inventoryAlerts: number;
  pendingActions: number;
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
  overduesDays: number;
  missingCylinders: number;
  missingCylinderValue: number;
  excessEmptyCylinders: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  creditPeriodDays: number;
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
