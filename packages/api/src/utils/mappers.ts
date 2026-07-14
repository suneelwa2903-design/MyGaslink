/**
 * Maps Prisma model objects to frontend-expected shapes.
 * Prisma uses `id` for all primary keys, but the frontend shared types
 * expect entity-specific IDs like `customerId`, `orderId`, etc.
 *
 * These mappers handle the renaming + nested child mapping. They also
 * convert every Prisma Decimal in the tree to a plain JS number so the
 * web client receives the same shape as before the Float→Decimal
 * migration (WI-006).
 */
import { decimalsToNumbers, toNum } from './decimal.js';

/**
 * The mappers rename `id` → `<entity>Id`, recursively map nested relations,
 * and decorate the result with extra flat fields (e.g. `customerName`,
 * `driverName`, `creditNotesCount`). The output is therefore a dynamically
 * augmented DTO rather than a fixed Prisma model shape, so the working object
 * is an open string-keyed record. This is the API-boundary DTO type, not a
 * blanket `any`.
 */
type MappedRecord = Record<string, unknown>;

/**
 * Each mapper is called from many routes with different Prisma `select` /
 * `include` projections. A rigid full-model input type would reject every
 * narrowed `select`. Instead, each `*Input` type below declares ONLY the
 * fields the mapper actually reads (plus the always-present `id` consumed by
 * `renameId`). All other scalar columns flow through opaquely via the spread
 * in `renameId`, so any projection that is a superset of the read fields is
 * accepted — precise about what's consumed, tolerant of the projection shape.
 *
 * `id` is optional: top-level entities always carry it, but several callers
 * pass partially-`select`ed nested relations (e.g. `{ typeName }`,
 * `{ driverName }`) that omit `id`. `renameId` tolerates a missing `id`
 * (emitting `<entity>Id: undefined`, matching the prior untyped behaviour), so
 * the input types stay assignable to those narrowed projections.
 */
interface HasId {
  id?: string;
}

// A nested cylinderType carries its `typeName` (read by several mappers).
interface WithCylinderType {
  cylinderType?: { typeName: string } | null;
}

// Per-entity input rows. Each declares ONLY the fields its mapper actually
// reads beyond the universal `id` (consumed by renameId). Everything else in
// the Prisma projection flows through opaquely via the renameId spread, so any
// `select`/`include` that is a superset of these fields is accepted.
type VehicleRow = HasId & { vehicleNumber?: string | null };
type VehicleInput = VehicleRow;
type DriverRow = HasId & { driverName?: string | null };
type DriverVehicleAssignmentRow = HasId & { vehicleId?: string | null };
type PaymentRow = HasId;
type PaymentAllocationRow = HasId;
type CylinderTypeRow = HasId & { typeName?: string | null };
type CylinderPriceRow = HasId;
type UserRow = HasId;
type DistributorRow = HasId;
type InventoryEventRow = HasId;
type CreditNoteRow = HasId;
type DebitNoteRow = HasId;
type AccountabilityLogRow = HasId;
type BillingCycleRow = HasId;
type BillingItemRow = HasId;
type PendingActionRow = HasId;
type InventorySummaryRow = HasId;

// Generic helper: rename `id` → `entityId` and recursively convert Decimals.
function renameId<T extends HasId>(obj: T, idField: string): MappedRecord {
  const { id, ...rest } = obj;
  return decimalsToNumbers({ [idField]: id, ...rest }) as MappedRecord;
}

// ─── Customer ────────────────────────────────────────────────────────────────

type ChildWithCylinderType = HasId & WithCylinderType;

interface CustomerInput extends HasId {
  customerName?: string | null;
  // Used both for the nested customer mapping AND for flat aliasing onto
  // mapOrder's output so the web UI can gate B2B-only fields (e.g. PO
  // number input) without traversing the nested relation.
  customerType?: 'B2B' | 'B2C' | string | null;
  contacts?: HasId[];
  cylinderDiscounts?: ChildWithCylinderType[];
  inventoryBalances?: ChildWithCylinderType[];
}

export function mapCustomer(c: CustomerInput | null | undefined): MappedRecord | null | undefined {
  if (!c) return c;
  const mapped = renameId(c, 'customerId');
  if (mapped.transportChargePerCylinder != null) {
    mapped.transportChargePerCylinder = Number(mapped.transportChargePerCylinder);
  }
  if (mapped.contacts) {
    mapped.contacts = (mapped.contacts as HasId[]).map((ct) => renameId(ct, 'contactId'));
  }
  if (mapped.cylinderDiscounts) {
    mapped.cylinderDiscounts = (mapped.cylinderDiscounts as ChildWithCylinderType[]).map((d) => {
      const m = renameId(d, 'discountId');
      if (d.cylinderType) m.cylinderTypeName = d.cylinderType.typeName;
      return m;
    });
  }
  if (mapped.inventoryBalances) {
    mapped.inventoryBalances = (mapped.inventoryBalances as ChildWithCylinderType[]).map((b) => {
      const m = renameId(b, 'balanceId');
      if (b.cylinderType) m.cylinderTypeName = b.cylinderType.typeName;
      return m;
    });
  }
  return mapped;
}

export function mapCustomers(list: CustomerInput[]): MappedRecord[] {
  return list.map((c) => mapCustomer(c) as MappedRecord);
}

// ─── Order ───────────────────────────────────────────────────────────────────

interface OrderInput extends HasId {
  items?: ChildWithCylinderType[];
  customer?: CustomerInput | null;
  driver?: DriverInput | null;
  vehicle?: VehicleInput | null;
  invoice?: InvoiceInput | null;
  statusLogs?: HasId[];
}

export function mapOrder(o: OrderInput | null | undefined): MappedRecord | null | undefined {
  if (!o) return o;
  const mapped = renameId(o, 'orderId');
  if (mapped.items) {
    mapped.items = (mapped.items as ChildWithCylinderType[]).map((item) => {
      const m = renameId(item, 'orderItemId');
      if (item.cylinderType) m.cylinderTypeName = item.cylinderType.typeName;
      return m;
    });
  }
  if (o.customer) mapped.customer = mapCustomer(o.customer);
  // Flat customerName for the orders list table. Order.customerId is
  // nullable and a customer can be soft-deleted, so either the relation
  // or the join can come back null — fall back to a label instead of a
  // blank cell.
  mapped.customerName = o.customer?.customerName ?? 'Deleted Customer';
  // Flat customerType alias — the web edit-order modal needs to know whether
  // to render the B2B-only PO number input. Same pattern as customerName.
  mapped.customerType = o.customer?.customerType ?? null;
  if (o.driver) mapped.driver = mapDriver(o.driver);
  // Flat driverName for the orders list table. assignDriver() does set
  // order.driverId + status correctly, but the table reads order.driverName
  // (flat) — without this it always rendered "Unassigned" even after a
  // driver was assigned. null when genuinely unassigned.
  mapped.driverName = o.driver?.driverName ?? null;
  if (o.vehicle) mapped.vehicle = mapVehicle(o.vehicle);
  // WI-065: flat vehicleNumber alias, mirroring the driverName flat
  // alias above. The shared Order type declares vehicleNumber at the
  // root; the OrdersPage View modal reads `order.vehicleNumber` (line
  // 626) directly. Without this the modal rendered '—' for every order
  // even when the underlying vehicle relation was correctly populated
  // — pure mapper omission, no DB or service-layer issue.
  mapped.vehicleNumber = o.vehicle?.vehicleNumber ?? null;
  if (o.invoice) mapped.invoice = mapInvoice(o.invoice);
  if (mapped.statusLogs) {
    mapped.statusLogs = (mapped.statusLogs as HasId[]).map((l) => renameId(l, 'logId'));
  }
  return mapped;
}

export function mapOrders(list: OrderInput[]): MappedRecord[] {
  return list.map((o) => mapOrder(o) as MappedRecord);
}

// ─── Invoice ─────────────────────────────────────────────────────────────────

interface InvoiceInput extends HasId {
  invoiceNumber?: string | null;
  items?: ChildWithCylinderType[];
  customer?: CustomerInput | null;
  order?: (OrderInput & { status?: unknown; isGodownPickup?: boolean }) | null;
  paymentAllocations?: HasId[];
  creditNotes?: HasId[];
  debitNotes?: HasId[];
  _count?: { creditNotes?: number; debitNotes?: number };
}

export function mapInvoice(inv: InvoiceInput | null | undefined): MappedRecord | null | undefined {
  if (!inv) return inv;
  const mapped = renameId(inv, 'invoiceId');
  if (mapped.items) {
    mapped.items = (mapped.items as ChildWithCylinderType[]).map((item) => {
      const m = renameId(item, 'invoiceItemId');
      if (item.cylinderType) m.cylinderTypeName = item.cylinderType.typeName;
      return m;
    });
  }
  // Flat customerName for invoice list tables. Mirrors mapOrder. Without
  // this the frontend reads inv.customerName as undefined and displays
  // "N/A" for every row.
  //
  // WI-077: also surface customerType so the billing list can render a
  // B2B EWB pill alongside the IRN pill and skip the IRN pill entirely
  // for B2C (URP) rows where no IRN exists.
  if (inv.customer) {
    mapped.customerName = inv.customer.customerName ?? 'Deleted Customer';
    mapped.customerType = inv.customer.customerType ?? null;
  }
  if (inv.customer) mapped.customer = mapCustomer(inv.customer);
  // WI-126: flat orderStatus for the customer app's PDF-download gate. Captured
  // from the raw relation before mapOrder rewrites the nested object.
  mapped.orderStatus = inv.order?.status ?? null;
  // Brief 2: flat isGodownPickup so the billing UI can render a neutral
  // "EWB N/A" chip instead of a misleading red "EWB failed" badge on
  // self-collection invoices. Defaults to false (covers null order,
  // manual invoices, and legacy rows).
  mapped.isGodownPickup = inv.order?.isGodownPickup ?? false;
  if (inv.order) mapped.order = mapOrder(inv.order);
  if (mapped.paymentAllocations) {
    mapped.paymentAllocations = (mapped.paymentAllocations as HasId[]).map((a) => renameId(a, 'allocationId'));
  }
  if (mapped.creditNotes) {
    mapped.creditNotes = (mapped.creditNotes as HasId[]).map((n) => renameId(n, 'creditNoteId'));
  }
  if (mapped.debitNotes) {
    mapped.debitNotes = (mapped.debitNotes as HasId[]).map((n) => renameId(n, 'debitNoteId'));
  }
  // WI-056: list responses use Prisma's `_count` aggregator; surface the
  // counts as flat numeric fields so the web can drop CN/DN pills onto
  // each row without iterating the (now-absent) full arrays.
  if (mapped._count) {
    const count = mapped._count as { creditNotes?: number; debitNotes?: number };
    mapped.creditNotesCount = count.creditNotes ?? 0;
    mapped.debitNotesCount = count.debitNotes ?? 0;
    delete mapped._count;
  }
  return mapped;
}

export function mapInvoices(list: InvoiceInput[]): MappedRecord[] {
  return list.map((inv) => mapInvoice(inv) as MappedRecord);
}

// ─── Customer Portal Invoice Detail ──────────────────────────────────────────
//
// Customer-facing invoice detail response shape, separate from `mapInvoice`
// which serves admin contexts (web + admin/finance mobile). The customer
// mobile UI at packages/mobile/app/(customer)/invoices.tsx expects field
// names that are customer-friendly (`lineTotal`, `cgstAmount`, `subtotal`,
// `payments[]`) rather than the schema-native names (`totalPrice`,
// `cgstValue`, `paymentAllocations[]`). Reshaping happens here at the API
// boundary so the UI's local InvoiceDetail interface is the source of truth
// for what customers see; admin consumers of mapInvoice are unaffected.
//
// Formulas locked in docs/INVOICE-NUMBERS-AUDIT.md (P0-1 cross-view
// consistency audit) after Suneel's Q1-Q3 sign-off:
// - subtotal = totalAmount − cgst − sgst − igst (pure deduction, reconciles
//   exactly to totalAmount; matches PDF "Subtotal" row to sub-rupee
//   rounding; works for mixed GST rates and GST-disabled mode)
// - lineTotal = item.totalPrice directly (post-discount GST-inclusive;
//   matches PDF "Amount" column and admin web "Total" column)
// - displayed unitPrice = totalPrice / quantity, rounded 2dp (variant (a')
//   per Q1 lock; ensures qty × shown = lineTotal always reconciles for
//   customer mental math, no conditional render needed for discount lines)
// - billingAddress = filtered comma-join of the 5 billing address columns,
//   identical to invoicePdfService.ts generateInvoicePdf > address build
// - customerGstin returned as `null` for URP/B2C (Q2 lock); the UI already
//   conditionally renders this row only when truthy.

type CustomerInvoiceItemRow = HasId & WithCylinderType & {
  description?: string | null;
  quantity?: number | null;
  totalPrice?: unknown;
  gstRate?: number | null;
};

type CustomerInvoiceAllocationRow = HasId & {
  amount?: unknown;
  payment?: {
    id?: string;
    transactionDate?: Date | string | null;
    paymentMethod?: string | null;
    referenceNumber?: string | null;
  } | null;
};

interface CustomerInvoiceInput extends HasId {
  invoiceNumber?: string | null;
  items?: CustomerInvoiceItemRow[] | null;
  customer?: {
    customerName?: string | null;
    gstin?: string | null;
    billingAddressLine1?: string | null;
    billingAddressLine2?: string | null;
    billingCity?: string | null;
    billingState?: string | null;
    billingPincode?: string | null;
  } | null;
  order?: { status?: string | null } | null;
  paymentAllocations?: CustomerInvoiceAllocationRow[] | null;
  cgstValue?: unknown;
  sgstValue?: unknown;
  igstValue?: unknown;
  totalAmount?: unknown;
}

export function mapCustomerInvoiceDetail(
  inv: CustomerInvoiceInput | null | undefined,
): MappedRecord | null | undefined {
  if (!inv) return inv;

  // Monetary fields — toNum handles Prisma.Decimal | string | number | null.
  const cgstAmount = toNum(inv.cgstValue);
  const sgstAmount = toNum(inv.sgstValue);
  const igstAmount = toNum(inv.igstValue);
  const totalAmount = toNum(inv.totalAmount);

  // Subtotal — pure deduction. Locked formula per audit.
  const subtotal = Number((totalAmount - cgstAmount - sgstAmount - igstAmount).toFixed(2));

  // Address — comma-join non-empty parts; matches PDF generator's address build.
  const billingAddress = inv.customer
    ? ([
        inv.customer.billingAddressLine1,
        inv.customer.billingAddressLine2,
        inv.customer.billingCity,
        inv.customer.billingState,
        inv.customer.billingPincode,
      ]
        .filter((s) => s != null && String(s).trim() !== '')
        .join(', ') || null)
    : null;

  // Items — rename totalPrice → lineTotal and compute display unitPrice as
  // post-discount inclusive (variant a'). Drop schema-internal fields the
  // customer app doesn't read to keep the response shape tight.
  const items = (inv.items ?? []).map((it) => {
    const m = renameId(it, 'invoiceItemId') as MappedRecord;
    const quantity = Number(it.quantity ?? 0);
    const totalPrice = toNum(it.totalPrice);
    m.cylinderTypeName = it.cylinderType?.typeName ?? it.description ?? '';
    m.quantity = quantity;
    m.lineTotal = totalPrice;
    m.unitPrice = quantity > 0 ? Number((totalPrice / quantity).toFixed(2)) : 0;
    m.gstRate = Number(it.gstRate ?? 0);
    delete m.totalPrice;
    delete m.discountPerUnit;
    delete m.invoiceId;
    delete m.cylinderTypeId;
    delete m.cylinderType;
    delete m.description;
    delete m.hsnCode;
    return m;
  });

  // Payments — flatten allocations and hoist nested payment metadata so the
  // customer UI doesn't have to traverse `allocation.payment.X`.
  const payments = (inv.paymentAllocations ?? []).map((alloc) => ({
    paymentId: alloc.payment?.id ?? alloc.id ?? '',
    amount: toNum(alloc.amount),
    transactionDate: alloc.payment?.transactionDate ?? null,
    paymentMethod: alloc.payment?.paymentMethod ?? '',
    referenceNumber: alloc.payment?.referenceNumber ?? null,
  }));

  // Build the response. renameId handles the id rename + Decimal conversion
  // on all scalar fields that pass through unchanged; we overlay the
  // customer-friendly aliases and strip schema-leaking fields.
  const mapped = renameId(inv, 'invoiceId');
  mapped.customerName = inv.customer?.customerName ?? 'Customer';
  mapped.customerGstin = inv.customer?.gstin ?? null;
  mapped.billingAddress = billingAddress;
  mapped.items = items;
  mapped.subtotal = subtotal;
  mapped.cgstAmount = cgstAmount;
  mapped.sgstAmount = sgstAmount;
  mapped.igstAmount = igstAmount;
  mapped.totalAmount = totalAmount;
  mapped.orderStatus = inv.order?.status ?? null;
  mapped.payments = payments;
  // Strip schema-internal fields the customer app doesn't read. Keeps the
  // response tight and avoids accidental exposure of admin-only fields
  // (e.g. issuedBy, notes, internal IDs) on the customer surface.
  delete mapped.cgstValue;
  delete mapped.sgstValue;
  delete mapped.igstValue;
  delete mapped.customer;
  delete mapped.order;
  delete mapped.paymentAllocations;
  delete mapped.creditNotes;
  delete mapped.debitNotes;
  delete mapped.distributorId;
  delete mapped.customerId;
  delete mapped.orderId;
  delete mapped.issuedBy;
  delete mapped.closedAt;
  delete mapped.notes;
  delete mapped.deletedAt;
  return mapped;
}

// ─── Payment ─────────────────────────────────────────────────────────────────

type PaymentInput = PaymentRow & {
  customer?: CustomerInput | null;
  allocations?: (PaymentAllocationRow & { invoice?: InvoiceInput | null })[];
};

export function mapPayment(p: PaymentInput | null | undefined): MappedRecord | null | undefined {
  if (!p) return p;
  const mapped = renameId(p, 'paymentId');
  // Phase F (2026-06-12): the Razorpay signature is forensic-only and
  // MUST NOT be returned in any API response. The mapper is the
  // single chokepoint that every payment route goes through, so
  // strip it here once instead of remembering at each call site.
  // razorpayOrderId + razorpayPaymentId are safe to surface (public
  // ids the customer already has from their Razorpay receipt).
  if ('razorpaySignature' in mapped) {
    delete mapped.razorpaySignature;
  }
  if (p.customer) {
    mapped.customerName = p.customer.customerName ?? 'Deleted Customer';
    mapped.customer = mapCustomer(p.customer);
  }
  if (mapped.allocations) {
    mapped.allocations = (mapped.allocations as (PaymentAllocationRow & { invoice?: InvoiceInput | null })[]).map((a) => {
      const m = renameId(a, 'allocationId');
      // Flat invoiceNumber for the Payment Allocations modal. The frontend
      // reads alloc.invoiceNumber directly; without this it falls back to
      // alloc.invoice.invoiceNumber, which is undefined unless the consumer
      // explicitly navigates the nested object.
      if (a.invoice) {
        m.invoiceNumber = a.invoice.invoiceNumber;
        // Payments table (2026-07-14) shows invoice issue date next to the
        // number — surface it flat so the row-render doesn't have to walk
        // into the nested invoice object.
        if ((a.invoice as { issueDate?: unknown }).issueDate) {
          m.invoiceIssueDate = (a.invoice as { issueDate?: unknown }).issueDate;
        }
      }
      if (a.invoice) m.invoice = mapInvoice(a.invoice);
      return m;
    });
  }
  // 3-fix bundle Fix 1 (2026-06-12): the customer-portal Payments table
  // renders the "Allocated" column as `formatCurrency(p.allocatedAmount)`,
  // but PaymentTransaction has no such column — only `allocationStatus` and
  // the joined `allocations[]` rows each carrying their per-invoice
  // `allocatedAmount`. The mapper now derives the per-payment aggregate
  // from the joined rows so the column stops showing "₹NaN" and the
  // shared Payment.allocatedAmount/unallocatedAmount contract is honoured.
  // Defensive: when `allocations` is not included, default to 0 — the
  // frontend's `?? 0` belt-and-braces still holds.
  const allocs = (p.allocations ?? []) as { allocatedAmount?: unknown }[];
  const allocatedAmount = allocs.reduce((sum, a) => sum + Number(a.allocatedAmount ?? 0), 0);
  const amount = Number((p as { amount?: unknown }).amount ?? 0);
  mapped.allocatedAmount = allocatedAmount;
  mapped.unallocatedAmount = Math.max(0, amount - allocatedAmount);
  return mapped;
}

export function mapPayments(list: PaymentInput[]): MappedRecord[] {
  return list.map((p) => mapPayment(p) as MappedRecord);
}

// ─── PaymentSubmission ──────────────────────────────────────────────────────
//
// WI-PENDING-PAYMENTS: unverified payment claims. The mapper renames
// `id → submissionId` and surfaces nested `customer` + `submittedByDriver`
// flat fields the way mapPayment does.
//
// Wide input type — same approach as other mappers: declare only the
// fields the mapper actually reads; the rest flow through opaquely via
// the renameId spread.

interface PaymentSubmissionInput extends HasId {
  customer?: { id?: string; customerName?: string | null } | null;
  submittedByDriver?: { id?: string; driverName?: string | null } | null;
  otherPendingCount?: number;
}

export function mapPaymentSubmission(
  s: PaymentSubmissionInput | null | undefined,
): MappedRecord | null | undefined {
  if (!s) return s;
  const mapped = renameId(s, 'submissionId');
  if (s.customer) {
    mapped.customerName = s.customer.customerName ?? 'Deleted Customer';
    mapped.customer = mapCustomer(s.customer);
  }
  if (s.submittedByDriver) {
    mapped.submittedByDriverName = s.submittedByDriver.driverName ?? null;
    mapped.submittedByDriver = mapDriver(s.submittedByDriver);
  }
  return mapped;
}

export function mapPaymentSubmissions(list: PaymentSubmissionInput[]): MappedRecord[] {
  return list.map((s) => mapPaymentSubmission(s) as MappedRecord);
}

// ─── Driver ──────────────────────────────────────────────────────────────────

type DriverInput = DriverRow & {
  vehicleAssignments?: (DriverVehicleAssignmentRow & { vehicle?: VehicleRow | null })[];
};

export function mapDriver(d: DriverInput | null | undefined): MappedRecord | null | undefined {
  if (!d) return d;
  const mapped = renameId(d, 'driverId');
  // WI-079: surface today's confirmed vehicle (from the scoped
  // `vehicleAssignments` include in driverService.listDrivers) as flat
  // `vehicleId` / `vehicleNumber` fields. The shared Driver type has
  // always declared these but the mapper never populated them, so the
  // assign-driver dropdown could neither filter nor label by vehicle.
  const todayAssignment = Array.isArray(d.vehicleAssignments) ? d.vehicleAssignments[0] : null;
  mapped.vehicleId = todayAssignment?.vehicle?.id ?? todayAssignment?.vehicleId ?? null;
  mapped.vehicleNumber = todayAssignment?.vehicle?.vehicleNumber ?? null;
  return mapped;
}

export function mapDrivers(list: DriverInput[]): MappedRecord[] {
  return list.map((d) => mapDriver(d) as MappedRecord);
}

// ─── Vehicle ─────────────────────────────────────────────────────────────────

export function mapVehicle(v: VehicleRow | null | undefined): MappedRecord | null | undefined {
  if (!v) return v;
  const mapped = renameId(v, 'vehicleId');
  // Derive `currentDriverName` from the most recent assignment if the service
  // included one. Used by Incoming Fulls / Outgoing Empties modals to auto-fill
  // the Driver Name field when a vehicle is selected. Strip the raw assignments
  // payload from the response — callers that need it can hit /vehicles/:id.
  const assignments = (v as VehicleRow & { vehicleAssignments?: Array<{ driver?: { driverName?: string | null } | null }> }).vehicleAssignments;
  if (Array.isArray(assignments) && assignments.length > 0) {
    mapped.currentDriverName = assignments[0]?.driver?.driverName ?? null;
  } else {
    mapped.currentDriverName = null;
  }
  delete (mapped as Record<string, unknown>).vehicleAssignments;
  return mapped;
}

export function mapVehicles(list: VehicleRow[]): MappedRecord[] {
  return list.map((v) => mapVehicle(v) as MappedRecord);
}

// ─── CylinderType ────────────────────────────────────────────────────────────

type CylinderTypeInput = CylinderTypeRow & {
  prices?: CylinderPriceRow[];
  // WI-2: empty deposit price is stored in the EmptyCylinderPrice 1:1
  // join. We flatten the most-recent value onto each cylinder-type row as
  // `emptyDepositPrice` so the web/mobile clients no longer need a second
  // round-trip to /empty-prices/list for the deposit-amount column on the
  // Settings page / Report Mismatch unit-amount calc.
  emptyPrices?: Array<{ emptyCylinderPrice: unknown }>;
};

export function mapCylinderType(ct: CylinderTypeInput | null | undefined): MappedRecord | null | undefined {
  if (!ct) return ct;
  const mapped = renameId(ct, 'cylinderTypeId');
  if (mapped.prices) {
    mapped.prices = (mapped.prices as CylinderPriceRow[]).map((p) => renameId(p, 'priceId'));
  }
  // WI-2: flatten the deposit price. Prisma returns Decimal; coerce to
  // number for the wire shape. `null` when no row exists (price not yet
  // configured for this type).
  if (ct.emptyPrices && ct.emptyPrices.length > 0) {
    const v = ct.emptyPrices[0].emptyCylinderPrice;
    mapped.emptyDepositPrice = v == null ? null : Number(v);
  } else {
    mapped.emptyDepositPrice = null;
  }
  return mapped;
}

export function mapCylinderTypes(list: CylinderTypeInput[]): MappedRecord[] {
  return list.map((ct) => mapCylinderType(ct) as MappedRecord);
}

// ─── User ────────────────────────────────────────────────────────────────────

export function mapUser(u: UserRow | null | undefined): MappedRecord | null | undefined {
  if (!u) return u;
  return renameId(u, 'userId');
}

export function mapUsers(list: UserRow[]): MappedRecord[] {
  return list.map((u) => mapUser(u) as MappedRecord);
}

// ─── Distributor ─────────────────────────────────────────────────────────────

export function mapDistributor(d: DistributorRow | null | undefined): MappedRecord | null | undefined {
  if (!d) return d;
  return renameId(d, 'distributorId');
}

export function mapDistributors(list: DistributorRow[]): MappedRecord[] {
  return list.map((d) => mapDistributor(d) as MappedRecord);
}

// ─── Assignment ──────────────────────────────────────────────────────────────

type AssignmentInput = DriverVehicleAssignmentRow & {
  driver?: DriverInput | null;
  vehicle?: VehicleRow | null;
};

export function mapAssignment(a: AssignmentInput | null | undefined): MappedRecord | null | undefined {
  if (!a) return a;
  const mapped = renameId(a, 'assignmentId');
  if (a.driver) mapped.driver = mapDriver(a.driver);
  if (a.vehicle) mapped.vehicle = mapVehicle(a.vehicle);
  return mapped;
}

export function mapAssignments(list: AssignmentInput[]): MappedRecord[] {
  return list.map((a) => mapAssignment(a) as MappedRecord);
}

// ─── Inventory Event ─────────────────────────────────────────────────────────

type InventoryEventInput = InventoryEventRow & {
  cylinderType?: CylinderTypeRow | null;
  vehicle?: VehicleRow | null;
  driver?: DriverRow | null;
};

export function mapInventoryEvent(e: InventoryEventInput | null | undefined): MappedRecord | null | undefined {
  if (!e) return e;
  const mapped = renameId(e, 'eventId');
  if (e.cylinderType) mapped.cylinderTypeName = e.cylinderType.typeName;
  if (e.vehicle) mapped.vehicleNumber = e.vehicle.vehicleNumber;
  if (e.driver) mapped.driverName = e.driver.driverName;
  // Derive quantity from fullsChange / emptiesChange for the frontend
  if (mapped.quantity === undefined) {
    const fulls = (mapped.fullsChange as number) || 0;
    const empties = (mapped.emptiesChange as number) || 0;
    mapped.quantity = Math.abs(fulls) || Math.abs(empties);
  }
  return mapped;
}

export function mapInventoryEvents(list: InventoryEventInput[]): MappedRecord[] {
  return list.map((e) => mapInventoryEvent(e) as MappedRecord);
}

// ─── Credit/Debit Note ──────────────────────────────────────────────────────

/**
 * Prisma surfaces CreditNoteStatus / DebitNoteStatus as the TS-side enum
 * names (`pending_cn`, `approved_cn`, etc.) rather than the @map'd DB
 * values (`pending`, `approved`, …). Strip the `_cn` / `_dn` suffix so
 * the API matches the shared CreditNoteStatus / DebitNoteStatus enum
 * the web client uses for badge colors. Same fix shape as WI-019
 * (BillingStatus enum mismatch).
 */
function normalizeNoteStatus(status: string | null | undefined, suffix: '_cn' | '_dn'): string | null | undefined {
  if (status == null) return status;
  return status.endsWith(suffix) ? status.slice(0, -suffix.length) : status;
}

export function mapCreditNote(n: CreditNoteRow | null | undefined): MappedRecord | null | undefined {
  if (!n) return n;
  const mapped = renameId(n, 'creditNoteId');
  mapped.status = normalizeNoteStatus(mapped.status as string | null | undefined, '_cn');
  return mapped;
}

export function mapDebitNote(n: DebitNoteRow | null | undefined): MappedRecord | null | undefined {
  if (!n) return n;
  const mapped = renameId(n, 'debitNoteId');
  mapped.status = normalizeNoteStatus(mapped.status as string | null | undefined, '_dn');
  return mapped;
}

// ─── Accountability Log ─────────────────────────────────────────────────────

type AccountabilityLogInput = AccountabilityLogRow & {
  customer?: CustomerInput | null;
  driver?: DriverInput | null;
};

export function mapAccountabilityLog(l: AccountabilityLogInput | null | undefined): MappedRecord | null | undefined {
  if (!l) return l;
  const mapped = renameId(l, 'logId');
  if (l.customer) mapped.customer = mapCustomer(l.customer);
  if (l.driver) mapped.driver = mapDriver(l.driver);
  return mapped;
}

export function mapAccountabilityLogs(list: AccountabilityLogInput[]): MappedRecord[] {
  return list.map((l) => mapAccountabilityLog(l) as MappedRecord);
}

// ─── Billing ─────────────────────────────────────────────────────────────────

type BillingCycleInput = BillingCycleRow & {
  items?: BillingItemRow[];
};

export function mapBillingCycle(b: BillingCycleInput | null | undefined): MappedRecord | null | undefined {
  if (!b) return b;
  const mapped = renameId(b, 'cycleId');
  if (mapped.items) {
    mapped.items = (mapped.items as BillingItemRow[]).map((i) => renameId(i, 'itemId'));
  }
  return mapped;
}

export function mapBillingCycles(list: BillingCycleInput[]): MappedRecord[] {
  return list.map((b) => mapBillingCycle(b) as MappedRecord);
}

// ─── Pending Action ──────────────────────────────────────────────────────────

export function mapPendingAction(a: PendingActionRow | null | undefined): MappedRecord | null | undefined {
  if (!a) return a;
  return renameId(a, 'actionId');
}

export function mapPendingActions(list: PendingActionRow[]): MappedRecord[] {
  return list.map((a) => mapPendingAction(a) as MappedRecord);
}

// ─── Inventory Summary ──────────────────────────────────────────────────────

type InventorySummaryInput = InventorySummaryRow & {
  cylinderType?: CylinderTypeRow | null;
};

export function mapInventorySummary(s: InventorySummaryInput | null | undefined): MappedRecord | null | undefined {
  if (!s) return s;
  const mapped = renameId(s, 'summaryId');
  if (s.cylinderType) mapped.cylinderTypeName = s.cylinderType.typeName;
  return mapped;
}

export function mapInventorySummaries(list: InventorySummaryInput[]): MappedRecord[] {
  return list.map((s) => mapInventorySummary(s) as MappedRecord);
}
