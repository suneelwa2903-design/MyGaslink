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
import { decimalsToNumbers } from './decimal.js';

// Generic helper: rename `id` → `entityId` and recursively map known nested arrays
function renameId<T extends Record<string, any>>(obj: T, idField: string): any {
  if (!obj) return obj;
  const { id, ...rest } = obj as any;
  return decimalsToNumbers({ [idField]: id, ...rest });
}

// ─── Customer ────────────────────────────────────────────────────────────────

export function mapCustomer(c: any): any {
  if (!c) return c;
  const mapped = renameId(c, 'customerId');
  if (mapped.contacts) {
    mapped.contacts = mapped.contacts.map((ct: any) => renameId(ct, 'contactId'));
  }
  if (mapped.cylinderDiscounts) {
    mapped.cylinderDiscounts = mapped.cylinderDiscounts.map((d: any) => {
      const m = renameId(d, 'discountId');
      if (m.cylinderType) m.cylinderTypeName = m.cylinderType.typeName;
      return m;
    });
  }
  if (mapped.inventoryBalances) {
    mapped.inventoryBalances = mapped.inventoryBalances.map((b: any) => {
      const m = renameId(b, 'balanceId');
      if (m.cylinderType) m.cylinderTypeName = m.cylinderType.typeName;
      return m;
    });
  }
  return mapped;
}

export function mapCustomers(list: any[]): any[] {
  return list.map(mapCustomer);
}

// ─── Order ───────────────────────────────────────────────────────────────────

export function mapOrder(o: any): any {
  if (!o) return o;
  const mapped = renameId(o, 'orderId');
  if (mapped.items) {
    mapped.items = mapped.items.map((item: any) => {
      const m = renameId(item, 'orderItemId');
      if (m.cylinderType) m.cylinderTypeName = m.cylinderType.typeName;
      return m;
    });
  }
  if (mapped.customer) mapped.customer = mapCustomer(mapped.customer);
  // Flat customerName for the orders list table. Order.customerId is
  // nullable and a customer can be soft-deleted, so either the relation
  // or the join can come back null — fall back to a label instead of a
  // blank cell.
  mapped.customerName = mapped.customer?.customerName ?? 'Deleted Customer';
  if (mapped.driver) mapped.driver = mapDriver(mapped.driver);
  // Flat driverName for the orders list table. assignDriver() does set
  // order.driverId + status correctly, but the table reads order.driverName
  // (flat) — without this it always rendered "Unassigned" even after a
  // driver was assigned. null when genuinely unassigned.
  mapped.driverName = mapped.driver?.driverName ?? null;
  if (mapped.vehicle) mapped.vehicle = mapVehicle(mapped.vehicle);
  // WI-065: flat vehicleNumber alias, mirroring the driverName flat
  // alias above. The shared Order type declares vehicleNumber at the
  // root; the OrdersPage View modal reads `order.vehicleNumber` (line
  // 626) directly. Without this the modal rendered '—' for every order
  // even when the underlying vehicle relation was correctly populated
  // — pure mapper omission, no DB or service-layer issue.
  mapped.vehicleNumber = mapped.vehicle?.vehicleNumber ?? null;
  if (mapped.invoice) mapped.invoice = mapInvoice(mapped.invoice);
  if (mapped.statusLogs) {
    mapped.statusLogs = mapped.statusLogs.map((l: any) => renameId(l, 'logId'));
  }
  return mapped;
}

export function mapOrders(list: any[]): any[] {
  return list.map(mapOrder);
}

// ─── Invoice ─────────────────────────────────────────────────────────────────

export function mapInvoice(inv: any): any {
  if (!inv) return inv;
  const mapped = renameId(inv, 'invoiceId');
  if (mapped.items) {
    mapped.items = mapped.items.map((item: any) => {
      const m = renameId(item, 'invoiceItemId');
      if (m.cylinderType) m.cylinderTypeName = m.cylinderType.typeName;
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
  if (mapped.customer) mapped.customer = mapCustomer(mapped.customer);
  // WI-126: flat orderStatus for the customer app's PDF-download gate. Captured
  // from the raw relation before mapOrder rewrites the nested object.
  mapped.orderStatus = inv.order?.status ?? null;
  if (mapped.order) mapped.order = mapOrder(mapped.order);
  if (mapped.paymentAllocations) {
    mapped.paymentAllocations = mapped.paymentAllocations.map((a: any) => renameId(a, 'allocationId'));
  }
  if (mapped.creditNotes) {
    mapped.creditNotes = mapped.creditNotes.map((n: any) => renameId(n, 'creditNoteId'));
  }
  if (mapped.debitNotes) {
    mapped.debitNotes = mapped.debitNotes.map((n: any) => renameId(n, 'debitNoteId'));
  }
  // WI-056: list responses use Prisma's `_count` aggregator; surface the
  // counts as flat numeric fields so the web can drop CN/DN pills onto
  // each row without iterating the (now-absent) full arrays.
  if (mapped._count) {
    mapped.creditNotesCount = mapped._count.creditNotes ?? 0;
    mapped.debitNotesCount = mapped._count.debitNotes ?? 0;
    delete mapped._count;
  }
  return mapped;
}

export function mapInvoices(list: any[]): any[] {
  return list.map(mapInvoice);
}

// ─── Payment ─────────────────────────────────────────────────────────────────

export function mapPayment(p: any): any {
  if (!p) return p;
  const mapped = renameId(p, 'paymentId');
  if (mapped.customer) {
    mapped.customerName = mapped.customer.customerName ?? 'Deleted Customer';
    mapped.customer = mapCustomer(mapped.customer);
  }
  if (mapped.allocations) {
    mapped.allocations = mapped.allocations.map((a: any) => {
      const m = renameId(a, 'allocationId');
      // Flat invoiceNumber for the Payment Allocations modal. The frontend
      // reads alloc.invoiceNumber directly; without this it falls back to
      // alloc.invoice.invoiceNumber, which is undefined unless the consumer
      // explicitly navigates the nested object.
      if (a.invoice) {
        m.invoiceNumber = a.invoice.invoiceNumber;
      }
      if (m.invoice) m.invoice = mapInvoice(m.invoice);
      return m;
    });
  }
  return mapped;
}

export function mapPayments(list: any[]): any[] {
  return list.map(mapPayment);
}

// ─── Driver ──────────────────────────────────────────────────────────────────

export function mapDriver(d: any): any {
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

export function mapDrivers(list: any[]): any[] {
  return list.map(mapDriver);
}

// ─── Vehicle ─────────────────────────────────────────────────────────────────

export function mapVehicle(v: any): any {
  if (!v) return v;
  return renameId(v, 'vehicleId');
}

export function mapVehicles(list: any[]): any[] {
  return list.map(mapVehicle);
}

// ─── CylinderType ────────────────────────────────────────────────────────────

export function mapCylinderType(ct: any): any {
  if (!ct) return ct;
  const mapped = renameId(ct, 'cylinderTypeId');
  if (mapped.prices) {
    mapped.prices = mapped.prices.map((p: any) => renameId(p, 'priceId'));
  }
  return mapped;
}

export function mapCylinderTypes(list: any[]): any[] {
  return list.map(mapCylinderType);
}

// ─── User ────────────────────────────────────────────────────────────────────

export function mapUser(u: any): any {
  if (!u) return u;
  return renameId(u, 'userId');
}

export function mapUsers(list: any[]): any[] {
  return list.map(mapUser);
}

// ─── Distributor ─────────────────────────────────────────────────────────────

export function mapDistributor(d: any): any {
  if (!d) return d;
  return renameId(d, 'distributorId');
}

export function mapDistributors(list: any[]): any[] {
  return list.map(mapDistributor);
}

// ─── Assignment ──────────────────────────────────────────────────────────────

export function mapAssignment(a: any): any {
  if (!a) return a;
  const mapped = renameId(a, 'assignmentId');
  if (mapped.driver) mapped.driver = mapDriver(mapped.driver);
  if (mapped.vehicle) mapped.vehicle = mapVehicle(mapped.vehicle);
  return mapped;
}

export function mapAssignments(list: any[]): any[] {
  return list.map(mapAssignment);
}

// ─── Inventory Event ─────────────────────────────────────────────────────────

export function mapInventoryEvent(e: any): any {
  if (!e) return e;
  const mapped = renameId(e, 'eventId');
  if (mapped.cylinderType) mapped.cylinderTypeName = mapped.cylinderType.typeName;
  if (mapped.vehicle) mapped.vehicleNumber = mapped.vehicle.vehicleNumber;
  if (mapped.driver) mapped.driverName = mapped.driver.driverName;
  // Derive quantity from fullsChange / emptiesChange for the frontend
  if (mapped.quantity === undefined) {
    mapped.quantity = Math.abs(mapped.fullsChange || 0) || Math.abs(mapped.emptiesChange || 0);
  }
  return mapped;
}

export function mapInventoryEvents(list: any[]): any[] {
  return list.map(mapInventoryEvent);
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

export function mapCreditNote(n: any): any {
  if (!n) return n;
  const mapped = renameId(n, 'creditNoteId');
  mapped.status = normalizeNoteStatus(mapped.status, '_cn');
  return mapped;
}

export function mapDebitNote(n: any): any {
  if (!n) return n;
  const mapped = renameId(n, 'debitNoteId');
  mapped.status = normalizeNoteStatus(mapped.status, '_dn');
  return mapped;
}

// ─── Accountability Log ─────────────────────────────────────────────────────

export function mapAccountabilityLog(l: any): any {
  if (!l) return l;
  const mapped = renameId(l, 'logId');
  if (mapped.customer) mapped.customer = mapCustomer(mapped.customer);
  if (mapped.driver) mapped.driver = mapDriver(mapped.driver);
  return mapped;
}

export function mapAccountabilityLogs(list: any[]): any[] {
  return list.map(mapAccountabilityLog);
}

// ─── Billing ─────────────────────────────────────────────────────────────────

export function mapBillingCycle(b: any): any {
  if (!b) return b;
  const mapped = renameId(b, 'cycleId');
  if (mapped.items) {
    mapped.items = mapped.items.map((i: any) => renameId(i, 'itemId'));
  }
  return mapped;
}

export function mapBillingCycles(list: any[]): any[] {
  return list.map(mapBillingCycle);
}

// ─── Pending Action ──────────────────────────────────────────────────────────

export function mapPendingAction(a: any): any {
  if (!a) return a;
  return renameId(a, 'actionId');
}

export function mapPendingActions(list: any[]): any[] {
  return list.map(mapPendingAction);
}

// ─── Inventory Summary ──────────────────────────────────────────────────────

export function mapInventorySummary(s: any): any {
  if (!s) return s;
  const mapped = renameId(s, 'summaryId');
  if (mapped.cylinderType) mapped.cylinderTypeName = mapped.cylinderType.typeName;
  return mapped;
}

export function mapInventorySummaries(list: any[]): any[] {
  return list.map(mapInventorySummary);
}
