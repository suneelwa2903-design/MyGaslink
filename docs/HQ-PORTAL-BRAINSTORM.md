# HQ Portal Brainstorm — Read Surface Design

**Baseline:** `main @ 7e73768` · Monorepo: `packages/api`, `packages/web`, `packages/mobile`, `packages/shared`
**Assumes:** Feature A (schema/auth: `customer_hq` role, `CustomerGroup`/`CustomerGroupMember`, JWT `groupId`, per-request customerId resolution, `/api/customer-group-portal` GET-only router, tenant-isolation double-scope) is already built per [docs/FEATURE-INVESTIGATION.md](FEATURE-INVESTIGATION.md) §A. This document is downstream of that and covers only the read surface.

**Persona:** finance / procurement manager. Three core questions on login:
1. What do I owe across all my properties?
2. Which property is consuming the most?
3. Is everything in order for this month's accounting?

---

## 1. Dashboard summary

### 1a. Total outstanding balance across all group customers

Two candidate sources exist today, and they are **not the same number**:

- **Snapshot sum** — `getCustomerDashboard` sums `Invoice.outstandingAmount` for one customer where `status IN ('issued','partially_paid','overdue')` ([customerPortalService.ts:101-109](../packages/api/src/services/customerPortalService.ts:101)). This is a single `prisma.invoice.aggregate` call per customer.
- **Canonical FIFO-derived overdue** — `computeCustomerOverdue(distributorId, customerId, asOf)` ([paymentService.ts:797-876](../packages/api/src/services/paymentService.ts:797)) is the "single source of truth" per its own doc comment ([paymentService.ts:777-796](../packages/api/src/services/paymentService.ts:777)) and is what `getCustomerDashboard` actually calls for `overdueAmount` ([customerPortalService.ts:111](../packages/api/src/services/customerPortalService.ts:111)). It re-derives from `Order`+`OrderItem`+opening-balance `Invoice` rows+`PaymentTransaction`, not from the stored `Invoice.status` flag.

**For the group dashboard, "what do I owe" is `outstandingAmount` (total AR), not `overdueAmount` (the FIFO-derived subset that's actually late).** Both matter for the persona: total owed (invoice aggregate) answers Q1, overdue (FIFO) answers "is anything actually late."

Prisma shape for a single round-trip across N customer ids:
```ts
prisma.invoice.aggregate({
  where: {
    distributorId,
    customerId: { in: visibleCustomerIds },
    outstandingAmount: { gt: 0 },
    status: { in: ['issued', 'partially_paid', 'overdue'] },
    deletedAt: null,
  },
  _sum: { outstandingAmount: true },
});
```
Trivial generalization of the exact query at `customerPortalService.ts:102-109` — swap `customerId` scalar for `customerId: { in: [...] }`. **(a) already a function, minor param change.**

`computeCustomerOverdue`, however, has **no batch form** — it's hard-coded to one `customerId` ([paymentService.ts:797-801](../packages/api/src/services/paymentService.ts:797)) and does 3 separate queries (`orders.findMany` with `items:true`, opening-balance `invoice.findMany`, `paymentTransaction.findMany`) then an in-memory FIFO walk ([paymentService.ts:809-876](../packages/api/src/services/paymentService.ts:809)). For a 20-50 property group, calling this N times is N × 3 round-trips. **(c) genuinely new** — either (i) call it N times (simplest, correctness-preserving, acceptable at N≤50), or (ii) write a batch version that loads all orders/OB-invoices/payments for `customerId: {in:[...]}` in one shot and buckets the FIFO walk by customerId in-memory (medium effort, ~1 day). Recommend (i) for v1 — 50 × 3 = 150 queries is still sub-second on indexed columns (see §6), and correctness parity with the existing single-customer code is free.

### 1b. Total cylinders delivered this month across all group customers

No existing function does this; `salesSummary` ([reportsService.ts:117-164](../packages/api/src/services/reportsService.ts:117)) computes per-customer breakdown but is a **single-`customerId` filter** in `ReportFilters` ([reportsService.ts:47](../packages/api/src/services/reportsService.ts:47)), not an `in`-list, and it's admin-distributor-wide (no customer scoping in its `where` at all — [reportsService.ts:119-126](../packages/api/src/services/reportsService.ts:119)). The closest reusable shape is the aggregation pattern itself:

```ts
prisma.orderItem.groupBy({
  by: ['cylinderTypeId'],
  _sum: { deliveredQuantity: true },
  where: {
    order: {
      distributorId,
      customerId: { in: visibleCustomerIds },
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: { gte: firstOfMonth, lte: now },
      deletedAt: null,
    },
  },
});
```
**(c) genuinely new** — no existing service does a cylinder-type-level `groupBy` scoped to a customer set; `deliveryPerformance` ([reportsService.ts:323-391](../packages/api/src/services/reportsService.ts:323)) aggregates by driver in JS after a `findMany`, not via `groupBy`. This new query is a clean single round-trip, low risk.

### 1c. Per-property row (name, outstanding, last delivery, last invoice)

**No existing function returns this shape.** It needs 3 independent aggregates joined by `customerId` in application code — a single Prisma query cannot do "max(deliveryDate) per customer" + "max(issueDate) per customer" + "sum(outstanding) per customer" in one round trip because they're different tables. Cleanest shape (3 queries, not N+1):

```ts
const [customers, outstandingByCust, lastOrderByCust, lastInvoiceByCust] = await Promise.all([
  prisma.customer.findMany({ where: { id: { in: visibleCustomerIds } }, select: { id: true, customerName: true } }),
  prisma.invoice.groupBy({ by: ['customerId'], where: { distributorId, customerId: { in: visibleCustomerIds }, outstandingAmount: { gt: 0 }, status: { in: ['issued','partially_paid','overdue'] } }, _sum: { outstandingAmount: true } }),
  prisma.order.groupBy({ by: ['customerId'], where: { distributorId, customerId: { in: visibleCustomerIds }, status: { in: ['delivered','modified_delivered'] } }, _max: { deliveryDate: true } }),
  prisma.invoice.groupBy({ by: ['customerId'], where: { distributorId, customerId: { in: visibleCustomerIds } }, _max: { issueDate: true } }),
]);
```
4 queries total (not N+1), merged by `customerId` in JS. **(b) reuses the `groupBy` pattern already established in `outstandingAging`** ([reportsService.ts:201-206](../packages/api/src/services/reportsService.ts:201), which does exactly `paymentTransaction.groupBy({ by: ['customerId'], _max: { transactionDate } })` for last-payment date) — this is the strongest precedent in the codebase for this exact per-customer-row shape. **(b) copy existing pattern.**

### 1d. Any-overdue flag per property

Two competing definitions exist in the codebase, and they've historically disagreed:

- **Stored flag**: `Invoice.status === 'overdue'` ([schema.prisma:93-100](../packages/api/prisma/schema.prisma:93) enum, [:1261](../packages/api/prisma/schema.prisma:1261)). This is set ONLY by `markOverdueInvoices` ([invoiceService.ts:845](../packages/api/src/services/invoiceService.ts:845)), a cron/manual job ([overdueInvoicesJob.ts:3,25](../packages/api/src/jobs/overdueInvoicesJob.ts:3), invoked via `POST` route at [invoices.ts:173](../packages/api/src/routes/invoices.ts:173)). **Freshness constraint: this is stale until the cron runs** — [docs/INVESTIGATION-JUL09-B.md:547,567](INVESTIGATION-JUL09-B.md:547) documents that it historically also kept reading the frozen `dueDate` snapshot instead of the live `issueDate + creditPeriodDays` derivation, though that was fixed for the *derivation logic* ([reportsService.ts:100-103](../packages/api/src/services/reportsService.ts:100) `invoiceStatus()` helper now takes `issueDate`/`creditPeriodDays`) — the *cron* freshness problem (row doesn't flip until the job runs) remains structural.
- **Live-computed**: `computeCustomerOverdue > 0` ([paymentService.ts:797](../packages/api/src/services/paymentService.ts:797)), or the per-invoice `invoiceStatus()` helper in [reportsService.ts:76-106](../packages/api/src/services/reportsService.ts:76) which derives `Overdue` from `dueDate < today` (or live `issueDate + creditPeriodDays`) **AND** `outstandingAmount > 0`, computed on read, no cron dependency.

**Recommendation: use the live-computed form** (`computeCustomerOverdue(distributorId, customerId) > 0`, or equivalently reuse `invoiceStatus()` per-invoice and OR them) for the per-property flag — it's already the dashboard's source of truth ([customerPortalService.ts:111](../packages/api/src/services/customerPortalService.ts:111)) and avoids the cron-staleness trap that bit the codebase once already. **(a) already a function** (`computeCustomerOverdue`), called once per group member.

### Summary table

| Metric | Status |
|---|---|
| Total outstanding | (a) existing query, trivial `in`-list swap |
| Total overdue (FIFO) | (a) existing function, no batch form — call N times |
| Cylinders delivered this month | (c) new `groupBy`, straightforward |
| Per-property row | (b) copies `outstandingAging`'s `groupBy` pattern |
| Overdue flag | (a) existing function (`computeCustomerOverdue`), avoid the stale `status='overdue'` flag |

---

## 2. Orders view

`getMyOrders` signature ([customerPortalService.ts:162-166](../packages/api/src/services/customerPortalService.ts:162)):
```ts
export async function getMyOrders(
  distributorId: string,
  customerId: string,
  filters: { status?: string; page?: number; pageSize?: number; from?: string; to?: string }
)
```
WHERE clause, verbatim ([customerPortalService.ts:167-183](../packages/api/src/services/customerPortalService.ts:167)):
```ts
const where: Prisma.OrderWhereInput = { customerId, distributorId, deletedAt: null };
if (filters.status) {
  const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean) as $Enums.OrderStatus[];
  where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
}
if (filters.from || filters.to) {
  where.deliveryDate = {};
  if (filters.from) where.deliveryDate.gte = new Date(filters.from);
  if (filters.to) { const toEnd = new Date(filters.to); toEnd.setHours(23,59,59,999); where.deliveryDate.lte = toEnd; }
}
```

**N-calls vs. one `in`-query:**

| | 3 properties (call-N) | 20-50 properties (call-N) | 20-50 (single `in` query) |
|---|---|---|---|
| Round trips | 3 sequential-ish (can `Promise.all`) | 20-50 | 1 |
| DB parse/plan cost | 3× plan cache hits (same query shape) | 20-50× plan hits | 1× plan |
| Mapping overhead | 3× array map | 20-50× array map, then merge-sort in JS | 1× map, DB already sorted |
| **Pagination consistency** | **Broken** — each customer's page 1 of 25 merged client-side gives no correct "page 2 across the group" | Same, worse | **Correct** — one `ORDER BY createdAt DESC LIMIT/OFFSET` gives a real global page |

For 3 properties, call-N with `Promise.all` is tolerable for the dashboard's "recent orders" widget (small, unpaged, e.g. top 5). **For the actual paginated Orders list, a single `customerId: { in: [...] }` query is the only correct option at any N** — the moment pagination needs to be correct across the group, per-customer calls can't produce a valid page boundary without pulling all pages from all customers and merging, which defeats pagination entirely. Recommend: always use one query with `customerId: { in: visibleCustomerIds }`, never N calls, even at N=3.

**HQ-specific filters:**

| Filter | Already accepted by `getMyOrders`? |
|---|---|
| Date range (`from`/`to`) | Yes — `deliveryDate` range ([customerPortalService.ts:176-183](../packages/api/src/services/customerPortalService.ts:176)) |
| Status | Yes — comma-separated list ([customerPortalService.ts:171-174](../packages/api/src/services/customerPortalService.ts:171)) |
| Property (customerId) | **No** — `customerId` is currently a required scalar param, not a filter; needs to become `customerId: { in: visibleCustomerIds }` with an optional narrower `propertyId` filter layered on top |
| Cylinder type | **No** — not in `filters` type at all; would need `items: { some: { cylinderTypeId } }` added to WHERE |

**Response shape reuse:** `mapOrder` already flat-aliases `customerName` ([mappers.ts:151](../packages/api/src/utils/mappers.ts:151): `mapped.customerName = o.customer?.customerName ?? 'Deleted Customer';`) — so "per-order property" is free, no mapper change needed. Extra fields an HQ user would plausibly want that aren't there today:
- **Invoice status per order** — `mapOrder` surfaces the full nested `invoice` object when included ([mappers.ts:175](../packages/api/src/utils/mappers.ts:175): `if (o.invoice) mapped.invoice = mapInvoice(o.invoice);`), so `order.invoice.status` is already reachable if the query's `include` adds `invoice: { select: { status: true, outstandingAmount: true } }`. Not currently included in `getMyOrders`' `include` block ([customerPortalService.ts:191-194](../packages/api/src/services/customerPortalService.ts:191) includes only `items` and `driver`) — this is a one-line `include` addition, not a mapper change.
- **Payment status per order** — same mechanism, via `invoice.status` / `invoice.outstandingAmount`; no separate payment-status field exists on Order itself.

---

## 3. Invoices view

`getMyInvoices` WHERE clause, verbatim ([customerPortalService.ts:488-501](../packages/api/src/services/customerPortalService.ts:488)):
```ts
const where: Prisma.InvoiceWhereInput = {
  customerId, distributorId, deletedAt: null, isGaslinkBilling: false,
  OR: INVOICE_VISIBILITY_OR,
};
if (filters.status) where.status = filters.status as $Enums.InvoiceStatus;
if (filters.from || filters.to) {
  where.issueDate = {};
  if (filters.from) where.issueDate.gte = new Date(filters.from);
  if (filters.to) { const toEnd = new Date(filters.to); toEnd.setHours(23,59,59,999); where.issueDate.lte = toEnd; }
}
```
where `INVOICE_VISIBILITY_OR` ([customerPortalService.ts:478-481](../packages/api/src/services/customerPortalService.ts:478)) hides invoices whose linked order is still in-flight (`pending_driver_assignment`/`pending_dispatch`/`pending_delivery`, [customerPortalService.ts:473-477](../packages/api/src/services/customerPortalService.ts:473)) — **this business rule must be preserved unchanged for the group view**, it's a delivery-integrity guard, not a per-customer artifact.

Includes ([customerPortalService.ts:509-512](../packages/api/src/services/customerPortalService.ts:509)): `items` (with `cylinderType.typeName`), `order: { select: { orderNumber, status } }`.

Same call-N-vs-one-query tradeoff as §2 applies identically — pagination correctness demands `customerId: { in: [...] }` in one query, not N calls.

**ITC reconciliation (GSTR-2A/2B) field audit** — a CA cross-matching needs: buyer GSTIN, seller GSTIN, invoice number, invoice date, taxable value, IGST, CGST, SGST, IRN, place of supply.

| Field | Present today? | Where |
|---|---|---|
| Buyer GSTIN | Yes | `mapCustomerInvoiceDetail` → `mapped.customerGstin = inv.customer?.gstin ?? null` ([mappers.ts:382](../packages/api/src/utils/mappers.ts:382)) |
| Seller GSTIN | **No** — not queried at all in `getMyInvoiceById` ([customerPortalService.ts:535-572](../packages/api/src/services/customerPortalService.ts:535) includes `customer` but never `distributor`) | Gap — needs `distributor: { select: { gstin: true } }` added to the invoice query + a `sellerGstin` field on the mapper |
| Invoice number | Yes | `renameId` spread → `invoiceId`/`invoiceNumber` pass through unchanged ([mappers.ts:380](../packages/api/src/utils/mappers.ts:380)) |
| Invoice date (`issueDate`) | Yes | flows through opaquely via `renameId` spread (not in the strip-list at [mappers.ts:395-409](../packages/api/src/utils/mappers.ts:395)) |
| Taxable value | Yes, as `subtotal` | Computed as `totalAmount − cgst − sgst − igst` ([mappers.ts:330](../packages/api/src/utils/mappers.ts:330)) — this is the *invoice-level* taxable value, matches the audit-locked formula ([mappers.ts:266-280](../packages/api/src/utils/mappers.ts:266)). Schema also carries a canonical `Invoice.taxableValue` column ([schema.prisma:1280](../packages/api/prisma/schema.prisma:1280)) written by `invoiceService.createInvoiceFromOrder` for GSTR-1 — that's the more authoritative source and isn't currently surfaced to the customer mapper at all (opaque pass-through would carry it if selected, but it's not in the query's include today). |
| IGST | Yes | `mapped.igstAmount = toNum(inv.igstValue)` ([mappers.ts:326,387](../packages/api/src/utils/mappers.ts:326)) |
| CGST | Yes | `mapped.cgstAmount` ([mappers.ts:324,386](../packages/api/src/utils/mappers.ts:324)) |
| SGST | Yes | `mapped.sgstAmount` ([mappers.ts:325,388](../packages/api/src/utils/mappers.ts:325)) |
| IRN | Yes (opaquely) | `Invoice.irn` column flows through `renameId` spread — not stripped. But `getMyInvoiceById`'s query doesn't select `irn`/`ackNo` explicitly; since it uses `include:` (not `select:`) at the top level, Prisma returns all scalar Invoice columns by default, so `irn` IS present today. |
| Place of supply | Present in schema (`Invoice.placeOfSupplyCode`, [schema.prisma:1281](../packages/api/prisma/schema.prisma:1281)) and flows through opaquely (not stripped) — reaches the wire today, just undocumented as a customer-facing field. |

**Net finding: the biggest real gap is seller GSTIN** — everything else either already exists or already flows through via the opaque `renameId` spread (it's just not been explicitly documented as customer-facing). Adding seller GSTIN requires including `distributor: { select: { gstin: true } }` in `getMyInvoiceById`/`getMyInvoices`' Prisma query and one line in the mapper. **(c) small, genuinely new addition; everything else is (a)/(b).**

**PO number**: `Order.poNumber` is denormalized onto `Invoice.poNumber` at issue time specifically so historic invoices keep their original PO even if the order is edited later ([schema.prisma:1284-1287](../packages/api/prisma/schema.prisma:1284): "Snapshot of Order.poNumber at invoice creation time... same denormalisation discipline as customerGstinSnapshot"). It is **not explicitly stripped** in `mapCustomerInvoiceDetail`'s delete-list ([mappers.ts:395-409](../packages/api/src/utils/mappers.ts:395)) so it flows through opaquely today — but it's undocumented/unverified as intentionally customer-facing. Confirm with product before relying on it, but the field is there and reachable.

---

## 4. Consolidated ledger

`getCustomerLedger` signature, verbatim ([paymentService.ts:398-402](../packages/api/src/services/paymentService.ts:398)):
```ts
export async function getCustomerLedger(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<CustomerLedgerResponse>
```
Single-customer only. Internally it does a full-history `findMany` on `CustomerLedgerEntry` (not range-filtered at the query level — [paymentService.ts:412-415](../packages/api/src/services/paymentService.ts:412)) specifically so it can compute a correct "Opening Balance b/f" carry-forward figure from *all* pre-range entries ([paymentService.ts:410-415](../packages/api/src/services/paymentService.ts:410), [697-745](../packages/api/src/services/paymentService.ts:697)), then a stateful single pass (`processEntry`, [paymentService.ts:519-695](../packages/api/src/services/paymentService.ts:519)) that mutates a running balance and FIFO-ages unpaid deliveries against the customer's `creditPeriodDays` ([paymentService.ts:480-491](../packages/api/src/services/paymentService.ts:480)).

**Option A (per-property separate ledgers) vs Option B (merged chronological stream with Property column):**

Recommend **Option B (merged, with a Property column) as the primary view, with a property filter/toggle to Option A on demand.** Rationale: the persona is doing month-end close across the whole chain — a merged chronological feed lets them scan "did anything unusual land this week across the group" in one pass, and CSV export of a merged stream is what accountants paste into Excel pivot tables. But **the running-balance semantics from Option A don't compose across properties** — see next point.

**Running balance — must stay per-customer, cannot be aggregated across the group.** `getCustomerLedger`'s `running`/`cumulativeInvoiceAmount`/`cumulativeReceivedAmount` variables ([paymentService.ts:472-474, 708, 737-738](../packages/api/src/services/paymentService.ts:472)) are *this customer's* debtor account balance — it is meaningless to sum "Kinara Hubsiguda's balance after this row" with "Kinara AS Rao Nagar's balance after that row" into one merged running total, because each property carries its own independent credit terms (`creditPeriodDays` is per-`Customer`, [schema.prisma:605](../packages/api/prisma/schema.prisma:605)) and its own FIFO aging clock. **The correct design: query the ledger merged and sorted globally for display, but compute/display running balance per-customer (a column that only makes sense read alongside a Property column), never a single group-wide cumulative total.** A group-level *total outstanding* figure (§1a) is a separate, valid aggregate — but it's a point-in-time sum, not a running ledger balance.

Merged-query shape:
```ts
prisma.customerLedgerEntry.findMany({
  where: { distributorId, customerId: { in: visibleCustomerIds } },
  orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  include: { customer: { select: { customerName: true } } },
});
```
This is **(c) genuinely new** — `getCustomerLedger`'s stateful per-entry processing (`processEntry`, opening-balance folding, FIFO overdue tracking) would need to run **once per customerId bucket**, not once globally, because of the running-balance point above. The cleanest implementation is: group entries by `customerId` in JS after the single merged fetch, then run the *existing* single-customer state machine (extracted, or called once per customer against the already-fetched rows) per bucket, then merge the resulting row arrays back into one chronologically-sorted display list with the Property column attached. This reuses ~90% of the existing logic in [paymentService.ts:519-695](../packages/api/src/services/paymentService.ts:519) but needs it refactored to accept pre-fetched entries instead of doing its own `findMany`, so it can be called N times against one shared fetch instead of N separate DB round trips. **Medium effort — a genuine but scoped refactor, not a rewrite.**

**PDF question.** `generateCustomerLedgerPdf` signature ([customerLedgerPdfService.ts:152-156](../packages/api/src/services/pdf/customerLedgerPdfService.ts:152)):
```ts
export async function generateCustomerLedgerPdf(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<Buffer>
```
Single-customer, calls `getCustomerLedger` internally ([customerLedgerPdfService.ts:180](../packages/api/src/services/pdf/customerLedgerPdfService.ts:180)). The column layout is a **hard-coded, already-tightly-packed 12-column table** for A4 landscape:
```
COLS: Date(64) Type(50) Narration(108) Del F(30) Amount(68) Emp C(34) Pend E(34) Emp Cost(70) Total Amt(84) Received(68) Due Amt(76) Overdue(76)
```
([customerLedgerPdfService.ts:47-60](../packages/api/src/services/pdf/customerLedgerPdfService.ts:47)), summing to exactly `TABLE_WIDTH = 762pt` ([customerLedgerPdfService.ts:62](../packages/api/src/services/pdf/customerLedgerPdfService.ts:62)) — the usable width on a 40pt-margin landscape A4 page. The code comments document that this was **already rebalanced twice** to eliminate ellipsis-truncation ([customerLedgerPdfService.ts:36-46](../packages/api/src/services/pdf/customerLedgerPdfService.ts:36)), so there is **zero spare width** for a new "Property" column without either (a) shrinking other columns further (risking the truncation problems the comments say were just fixed) or (b) dropping to a smaller font/narrower per-column char caps (`COL_CHAR_CAP`, [customerLedgerPdfService.ts:85-101](../packages/api/src/services/pdf/customerLedgerPdfService.ts:85)). **Feasible but not free** — recommend adding an optional `visibleCustomerIds?: string[]` param that, when present, (i) calls the new merged-ledger logic from §4 instead of single-customer `getCustomerLedger`, (ii) shrinks `Narration` back down and reclaims ~40-50pt for a `Property` column, accepting slightly more aggressive truncation on long invoice numbers, or (iii) simpler: ship the group PDF at 8pt smaller body font in a first cut. **Structurally it is per-customer today** (both the data-fetch and the running-balance math), so this is a genuine, scoped extension — not a trivial parameter add.

---

## 5. What we cannot show (data gaps)

| Desired view | Raw data exists? | Gap type |
|---|---|---|
| Cylinder-wise consumption trend (month-over-month, per property) | Yes — `OrderItem.deliveredQuantity` + `Order.deliveryDate` ([schema.prisma:941-942, 847](../packages/api/prisma/schema.prisma:941)) support a `groupBy` on month+cylinderType+customerId. | No rollup table exists (`InventorySummary` is distributor-wide, [schema.prisma:1579-1608](../packages/api/prisma/schema.prisma:1579), not per-customer) — every render would re-scan `OrderItem`/`Order` live. At 20-50 properties × 5 years this is a `groupBy` over tens of thousands of rows — acceptable live for a chart (no pre-agg needed at this scale), but a true multi-year trend chart is a **new query, no existing service** (c). |
| Payment history per property | Yes — `getMyPayments` already exists per-customer ([customerPortalService.ts:577-615](../packages/api/src/services/customerPortalService.ts:577)) | Trivial `in`-list extension, same pattern as §2/§3 — **not a gap**, just needs the multi-customer variant. |
| Outstanding aging buckets (30/60/90) | Yes — `outstandingAging` report already computes 0-30/31-60/60+ buckets **per customer**, distributor-wide ([reportsService.ts:174-243](../packages/api/src/services/reportsService.ts:174)) | This is the **strongest existing precedent for the whole HQ dashboard** — it already returns one row per customer with aging buckets; restricting its `invoiceWhere` to `customerId: { in: visibleCustomerIds } }` (currently distributor-wide, no customer filter at all — [reportsService.ts:177-182](../packages/api/src/services/reportsService.ts:177)) gets 90% of a "per-property aging" view for free. **(b) reuse, near-zero net-new code.** |
| Group-level analytics ("consuming 20% more than last month") | Data exists (Order/OrderItem history) but requires **two time-window aggregates diffed** — no existing function does period-over-period comparison anywhere in `reportsService.ts`. | **(c) genuinely new**, small (two `groupBy` calls + a subtraction), no infra gap, just unwritten. |
| Contract / rate-card comparison across properties | `CustomerCylinderDiscount` ([schema.prisma:670-681](../packages/api/prisma/schema.prisma:670)) is per-customer-per-cylinderType — the raw data for "does property X pay a different net rate than property Y" exists. | Comparison view itself doesn't exist, but is a straightforward `findMany` + join to `getEffectivePrice` ([customerPortalService.ts:41](../packages/api/src/services/customerPortalService.ts:41) calls it per cylinder type) across the group's customer ids. **(c) new, but low complexity** — no schema gap. |
| Delivery-performance / OTD metrics per property | `deliveryPerformance` report exists but is **driver-centric**, not customer-centric ([reportsService.ts:323-391](../packages/api/src/services/reportsService.ts:323) groups by `driverId`, with an *optional* customer drill-down only when a single `driverId` is also given, [reportsService.ts:330-331](../packages/api/src/services/reportsService.ts:330)). There is no "for these N customers, what's their on-time-delivery rate" query — OTD as a concept (promised-date vs actual `deliveredAt`) isn't computed anywhere; `Order` has `deliveryDate` (the target) and `deliveredAt` (actual, [schema.prisma:847,890](../packages/api/prisma/schema.prisma:847)) so the raw fields exist, but no service derives a punctuality metric from them. | **Genuine gap** — needs a new metric definition + new query. Raw fields exist; the derivation doesn't. |

---

## 6. Performance considerations

**Index audit** (from [schema.prisma](../packages/api/prisma/schema.prisma)):

| Model | Indexes | Leading column | Serves `customerId: {in:[...]}` well? |
|---|---|---|---|
| `Customer` | `[distributorId, status]` (:651), `[distributorId, customerName]` (:652), `[gstin]` (:653) | `distributorId` | N/A — HQ dashboard fetches customers by `id: {in:[...]}`, which hits the PK directly regardless of these indexes. |
| `Order` | `[distributorId, status, deliveryDate]` (:931), **`[distributorId, customerId, createdAt(sort:Desc)]`** (:932), `[driverId, deliveryDate]` (:933) | `distributorId` | **Yes** — the second index has `customerId` as its *second* column behind `distributorId`. Since every HQ query is always tenant-scoped (`distributorId` equality, mandatory per Feature A's double-scope), Postgres can use this composite index efficiently for an equality-on-`distributorId` + IN-list-on-`customerId` predicate — this is a textbook-good composite index shape for this exact access pattern, not a gap. |
| `Invoice` | `[distributorId, status, dueDate]` (:1312), **`[distributorId, customerId, createdAt(sort:Desc)]`** (:1313), `[irnStatus]` (:1314) | `distributorId` | **Yes**, same reasoning as Order. |
| `InvoiceItem` | **None** ([schema.prisma:1343-1368](../packages/api/prisma/schema.prisma:1343) — no `@@index` block at all) | — | Not directly queried by `customerId` (it doesn't have that column) — joins are always via `invoiceId`, which is fine on the FK/PK path. Not a group-portal-specific gap. |
| `CustomerLedgerEntry` | **`[distributorId, customerId, entryDate]`** (:750), `[referenceId]` (:751) | `distributorId` | **Yes for filtering**, but a merged-ledger `ORDER BY entryDate ASC` across an IN-list of customers cannot use this index's physical order directly (index is sorted `customerId` then `entryDate`, not `entryDate` globally) — Postgres will index-scan to fetch the rows then perform a separate in-memory Sort. At the row counts in play here (see below) this Sort is cheap and not a concern for v1. |
| `PaymentTransaction` | **`[distributorId, customerId, createdAt(sort:Desc)]`** (:1461), `[distributorId, transactionDate]` (:1462), `[razorpayOrderId]` (:1463) | `distributorId` | **Yes**, same shape as Order/Invoice. |
| `PaymentAllocation` | **None** ([schema.prisma:1467-1478](../packages/api/prisma/schema.prisma:1467) — no `@@index` block; only implicit PK) | — | **Real gap, pre-existing** (not introduced by HQ portal) — [reportsService.ts:399-407, 549-556, 742-750, 993-998](../packages/api/src/services/reportsService.ts:399) all do `paymentAllocation.findMany({ where: { invoiceId: { in: [...] } } })` with no index on `invoiceId`. Worth flagging to the team regardless of HQ scope; becomes marginally more load-bearing once HQ ledger/dashboard queries add more of these lookups per request. |

**Is `(distributorId, customerId)` a composite index anywhere?** Yes — on `Order` (:932), `Invoice` (:1313), `PaymentTransaction` (:1461), and `CustomerLedgerEntry` (:750, plus `entryDate` as a third column). These are exactly the four tables the HQ portal needs to query by `customerId: {in:[...]}`, and all four already have `distributorId` leading with `customerId` as the immediate second column — **this is a favorable existing index shape for the feature**, not a gap requiring new migrations.

**Is `(customerId, status)` present for the outstanding-invoices query?** No — `Invoice`'s composite starts with `distributorId, status, dueDate` (a *different* composite, :1312) and separately `distributorId, customerId, createdAt` (:1313); there's no index with `customerId` as the leading column anywhere on `Invoice`. In practice this doesn't matter for the HQ queries above because `distributorId` is always the equality-bound leading predicate — Postgres uses the `(distributorId, customerId, createdAt)` index for the `customerId IN (...)` filter and then does a residual filter on `status`/`outstandingAmount gt 0` against the already-narrowed row set, which is cheap.

**Row-count sanity check.** 50 customers × 30 orders/customer/month × 12 months × 5 years = 90,000 orders — this is a small table by Postgres standards; any equality/IN-list query on an indexed column returns in single-digit milliseconds even on modest RDS hardware. The ledger table, per the prompt's own 5-10× multiplier, would sit around 450k-900k rows — still comfortably indexed-lookup territory, not a scale where a naive `IN (50 uuids)` query becomes a concern. **On local dev (tiny data) this is trivially fast; on prod RDS at these row counts with the existing `(distributorId, customerId, ...)` composite indexes, it remains fast** — the risk isn't the `IN`-list size (50 is nothing for a B-tree), it's accidental N+1 patterns (call-per-customer instead of one `IN`-query), which is why §2/§3 flag pagination correctness as the reason to insist on single-query design even at N=3.

**Denormalization / materialized view for v1?** **Not warranted.** At 90k orders / <1M ledger rows per distributor, every aggregate in §1 runs live in low tens-of-milliseconds. A rollup table would add write-path complexity (keep it in sync on every order/invoice/payment mutation) for a read-latency problem that doesn't exist yet at this scale. Revisit only if a single distributor's group grows past ~200 properties or multi-year history becomes the default dashboard window (currently it's month-to-date for activity metrics per [customerPortalService.ts:44-53](../packages/api/src/services/customerPortalService.ts:44)).

---

## 7. Mobile vs web

The existing customer portal ships both surfaces, both single-customer:
- Mobile: `packages/mobile/app/(customer)/{dashboard,orders,invoices,payments,account}.tsx`
- Web: `packages/web/src/pages/customer/{DashboardPage,OrdersPage,InvoicesPage,PaymentsPage,AccountPage}.tsx`

**HQ v1 should be web-only.** The stated persona — finance/procurement manager doing month-end close, needing CSV/PDF export, cross-matching PO logs and GSTR reconciliation fields (§3) — is fundamentally a desk workflow with wide tabular data (the ledger PDF alone is a 12-column landscape A4 table, [customerLedgerPdfService.ts:47-60](../packages/api/src/services/pdf/customerLedgerPdfService.ts:47)) and multi-file export. None of that translates to a phone screen without a materially different, cut-down UI — and building that cut-down UI is itself a second design/dev effort, not a byproduct of the web build.

**Post-v1 mobile HQ experience, if built:** a single roll-up dashboard tile (§1's 4 aggregates — total owed, top-consuming property, any-overdue flag, this-month cylinders) is genuinely mobile-appropriate: glanceable, no pagination, no export. A consolidated 500-row ledger or a 50-property paginated orders/invoices list is not — mobile would need drill-down-only navigation (tap a property to see *its* single-customer view, which is the existing mobile customer screens, unmodified) rather than attempting the merged group view on a small screen.

**Recommendation: scope Feature-A-phase-1 to web only** (`packages/web`), reusing the existing customer-portal page shells' data-fetching patterns but pointed at the new `/api/customer-group-portal` router. Defer mobile entirely to a later phase, and when it lands, ship only the roll-up tile (§1) plus links into the existing single-customer mobile screens — not a mobile reimplementation of the merged ledger/orders/invoices tables.
