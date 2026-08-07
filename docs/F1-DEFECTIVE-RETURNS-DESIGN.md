# F1 — Defective Cylinder Returns — Implementation Design

**Status:** ✅ SHIPPED (2026-08-06). See "Final shape (post-UX iteration)" at bottom for how the delivered UX diverged from the initial design.
**Date:** 2026-08-06
**Owner:** Suneel spec, code by session
**Sequencing:** F1 done → N01-N04 defective reports next → then F8 supplier ledger.

---

## Final shape (post-UX iteration) — what actually shipped

The original design in this doc landed as the backend spine (36 tests still green throughout). But the frontend went through 18 fix iterations against live testing feedback. Final UX:

### Where office does things

| Task | Entry point | Notes |
|---|---|---|
| Record defective from customer | Inventory > Daily Summary > **Defective Return** button → modal | Sibling to Empties Return / Adjust Stock buttons |
| See past defective returns | Same modal → **History** tab | Amber badge on tab shows pending-CN count |
| See depot's defective inventory | Inventory > Daily Summary → CLOSING > **Defective** column | Same shape as Fulls/Empties closing |
| See defective flow (today's in/out) | Daily Summary → CORPORATION > **Defective Out** + AT CUSTOMER > **Defective In** | Signed (−/+) |
| Ship defective to OMC | Inventory > Daily Summary > **Outgoing Empties** modal → tick "Also include defective fulls" section | Piggybacks on empties challan, ONE combined action |
| See "how many defective went out with challan X" | Inventory > Depot History → **Defective** column | Correlation-based, blank when no piggyback |

### Backend contract (unchanged from initial design)

- 2 new tables: `DefectiveCylinderLedger` + `DefectiveReturnBatch`
- 3 new columns on `InventorySummary`: `defectiveFullsIn` / `defectiveFullsOut` / `closingDefectiveFulls` (WI-106 zone untouched)
- 5-value `DefectiveReturnStatus` enum, 2 new `InventoryEventType` values, 1 new `LedgerEntryType` value
- 'F' prefix in `numberingService` for batch numbers
- 9 endpoints at `/api/defective-returns/*`
- CN raise uses standard `invoiceService.createCreditNote` + `approveCreditNote` (fires NIC CRN IRN for B2B, silent for B2C + gstMode=disabled)

### UX divergences from the initial design

Documented for the record so the pattern can be reused on F8/N01-N04:

1. **Sidebar entry deleted** → moved to a button on Daily Summary. Sidebar was too heavy for a low-frequency operation.
2. **Send-to-Corp separate tab deleted** → merged into Outgoing Empties modal via checkbox section. Defective shipping IS an empties shipment operationally — no need for two flows.
3. **Two-step "capture → check ledger → raise CN"** → one-shot atomic. Suneel: "just do it all and inform me only if ok". Client chains 2 API calls transparently; History page keeps manual Raise CN button as fallback for partial-success.
4. **Corporation FK** on DefectiveReturnBatch is optional now (`sourceDistributorId`), inheriting from Outgoing Empties' documentType field on the piggyback path. F8 corp-purchases can promote it to mandatory without a migration.
5. **Depot History does NOT get its own defective rows** — that was over-engineering. Instead: correlation column on outgoing rows shows piggybacked defective count. Depot History event types stay incoming_fulls + outgoing_empties.
6. **PDF renderer shows `-N` in Del Full column on defective rows** — Suneel's explicit request for "deduction visible from fulls". Del Full subtotal correctly nets defective. Narration format shortened to "Defective: N× 19 KG · CN CSHD…" (fits 20-char column).

### Not built (deferred to N01-N04 next)

- **N01 Defective Returns by Outgoing Load** — group DR rows by `batchId`, join batch header
- **N02 Defective Returns by Customer** — group by `customerId` over date range
- **N03 Defective Returns by Corporation** — group by `batch.corporationName` or `sourceDistributorId`
- **N04 Defective Compensation Aging** — status='cn_issued' or 'sent_to_corporation' rows bucketed by `cnRaisedAt` age

All queries land on the DefectiveCylinderLedger table shipped in F1 — no schema changes needed.

---

## ORIGINAL DESIGN (below, preserved for provenance)


## Contract (locked with Suneel)

Two flows customers experience:

- **Flow A — Pickup only** (customer returns defective, no fresh given). Recorded in a new "Defective Returns" page by office. Two visible steps: capture (physical), then Raise CN (financial). CN goes against a source invoice picked at capture time.
- **Flow B — Exchange** (fresh delivered + defective picked up same visit). Handled via customer education: at the empties-return time office either enters **0 empties** or **empties MINUS defective count**. The defective count is then captured through the same Defective Returns page above.

Both flows converge at a depot bucket → outgoing batch to corporation. Batch modal is a NEW dedicated screen (not an extension of Outgoing Empties), reasoning below.

### Answers locked from Q&A
| Q | Answer |
|---|--------|
| Q1 (exchange handling) | Customer education — no separate exchange mode in v1 |
| Q2 (pending CN visibility) | Sidebar chip on "Defective Returns" menu |
| Q3 (invoice picker window) | 90 days |
| Q4 (source invoice) | One DR = one source invoice (multi-cyl-type OK within one invoice) |
| Q5 (chip location) | Menu item badge only |
| CN semantics on paid invoice | Yes — becomes carry-forward customer credit via `CustomerLedgerEntry.amountDelta` |

## Design decisions from code trace

### Decision 1 — Two-step capture / raise-CN
No existing empties-return pattern to mirror (empties is single-step). Closest reference is backdated `Order.inventoryAdjustedAt` timestamp pattern. Use `DefectiveCylinderLedger.cnRaisedAt` timestamp + status enum to block double-CN.

### Decision 2 — CN service usage
Trace confirmed `invoiceService.createCreditNote` is amount-based (post WI-055 — no items[]). Mirror the `orderService.resolveDispute` pattern at [orderService.ts:2042-2049]:
- `createCreditNote(distributorId, actor, { invoiceId, reason, amount })` → gets a `pending_cn` row + creditNoteNumber
- Immediately `approveCreditNote(cnId, distributorId, actor)` → flips to approved, writes customer ledger, fires CRN IRN (fire-and-forget) if GST-live+B2B

**cnAmount formula:** `sum over items(defectiveQty × invoiceItem.totalPrice / invoiceItem.quantity)`. Uses per-line inclusive amount (post-discount inclusive per anti-pattern #16 refinement), guaranteed to match what the customer actually paid.

**Pre-check for cumulative CN vs invoice total:** since `createCreditNote` doesn't sum prior CNs, my service pre-computes `sum(existing CNs against this invoice) + new CN amount ≤ invoice.totalAmount` and rejects with 400 if exceeded.

### Decision 3 — Outgoing batch is a NEW dedicated modal, NOT extension of Outgoing Empties
Trace surfaced that Outgoing Empties (Path A regular distributor) is single-cyl-type-per-record and has no corporation FK. Extending it to include a multi-line defective section would break its current shape.

Instead: add a new "Send Defectives to Corporation" button + modal + service:
- New route: `POST /api/defective-returns/batches`
- New service: `defectiveReturnService.createBatch(...)`
- Auto-populated from depot bucket (DR rows where status='cn_issued')
- Fires `defective_return_to_corporation` events
- Numbers the batch via `numberingService.allocateNumber(..., 'F', ...)`

**Suneel's "at outgoing-empties time" mental model** is satisfied by a small info banner on the Outgoing Empties modal: "Reminder: N defective fulls pending at depot — send in separate batch [button]".

### Decision 4 — Ledger entries
Two customer ledger writes across the two-step flow:

1. **At capture** — one `CustomerLedgerEntry` per DR row:
   - `entryType='defective_collected'` (new LedgerEntryType value — additive enum migration)
   - `amountDelta=0` (stock-only, matches empties-return pattern)
   - `invoiceId=null` (matches empties-return anti-pattern-#24 rule)
   - `narration='Defective: N× {typeName} from INV-XXXX (pending CN)'`

2. **At Raise CN** — one `CustomerLedgerEntry` per invoice (created by existing `approveCreditNote`):
   - `entryType='credit_note'` (existing)
   - `amountDelta=-cnAmount`
   - `invoiceId=sourceInvoiceId`
   - `narration=`Credit note ${cnNumber}: ${reason}``

### Decision 5 — Inventory events
Simpler than empties-return (which writes 2 event types). Defective flow writes ONE event per cyl-type per capture:

- `defective_return_from_customer` — `fullsChange=-qty` (defective full leaves customer, arrives at depot as defective bucket), `emptiesChange=0`. Aggregator credits `defectiveFullsIn` (per date) and `closingDefectiveFulls` (cumulative), does NOT touch `closingFulls`.
- `defective_return_to_corporation` — `fullsChange=-qty`, `emptiesChange=0`. Aggregator credits `defectiveFullsOut`, decrements `closingDefectiveFulls`.

Rationale for single event (not paired): empties-return uses 2 events (`returns_collection` + `reconciliation_empties_return`) because the depot arrival is a distinct verification step. Defective has no verification step — capture time IS depot-arrival time. One event suffices.

**WI-106 zone protection**: `closingFulls` formula UNTOUCHED. `closingDefectiveFulls` is a parallel bucket.

## Schema changes (Slice 1)

### New enums (additive)
```prisma
enum DefectiveReturnStatus {
  collected                    // Physical captured, CN not yet raised
  cn_issued                    // CN fired, customer credit posted
  sent_to_corporation          // Included in outgoing batch, awaiting corp credit
  corporation_credit_received  // Fully settled
  cancelled                    // Office cancelled the row (before CN)
}

// EXTEND enum InventoryEventType (add 2 values):
+ defective_return_from_customer
+ defective_return_to_corporation

// EXTEND enum LedgerEntryType (add 1 value):
+ defective_collected
```

### New tables
```prisma
model DefectiveCylinderLedger {
  id                    String                @id @default(uuid()) @map("defective_id")
  distributorId         String                @map("distributor_id")
  customerId            String                @map("customer_id")
  cylinderTypeId        String                @map("cylinder_type_id")
  quantity              Int
  sourceInvoiceId       String                @map("source_invoice_id")
  sourceInvoiceItemId   String?               @map("source_invoice_item_id")
  perCylRate            Decimal               @map("per_cyl_rate") @db.Decimal(12, 2)
  cnAmount              Decimal               @map("cn_amount") @db.Decimal(12, 2)
  reason                String?
  notes                 String?
  status                DefectiveReturnStatus @default(collected)
  creditNoteId          String?               @map("credit_note_id")  // many-to-one with CN
  batchId               String?               @map("batch_id")
  collectedAt           DateTime              @default(now()) @map("collected_at")
  collectedDate         DateTime              @map("collected_date") @db.Date
  collectedBy           String                @map("collected_by")
  cnRaisedAt            DateTime?             @map("cn_raised_at")
  cnRaisedBy            String?               @map("cn_raised_by")
  cancelledAt           DateTime?             @map("cancelled_at")
  cancelledBy           String?               @map("cancelled_by")
  cancelReason          String?               @map("cancel_reason")
  createdAt             DateTime              @default(now()) @map("created_at")
  updatedAt             DateTime              @updatedAt @map("updated_at")

  distributor   Distributor           @relation(fields: [distributorId], references: [id])
  customer      Customer              @relation(fields: [customerId], references: [id])
  cylinderType  CylinderType          @relation(fields: [cylinderTypeId], references: [id])
  sourceInvoice Invoice               @relation("DefectiveSource", fields: [sourceInvoiceId], references: [id])
  creditNote    CreditNote?           @relation(fields: [creditNoteId], references: [id])
  batch         DefectiveReturnBatch? @relation(fields: [batchId], references: [id])

  @@index([distributorId, status])
  @@index([distributorId, customerId, collectedAt])
  @@index([distributorId, batchId])
  @@index([distributorId, cylinderTypeId, status])
  @@map("defective_cylinder_ledger")
}

model DefectiveReturnBatch {
  id                    String    @id @default(uuid()) @map("batch_id")
  distributorId         String    @map("distributor_id")
  batchNumber           String    @unique @map("batch_number")
  corporationName       String    @map("corporation_name")
  vehicleId             String?   @map("vehicle_id")
  challanNumber         String?   @map("challan_number")
  challanDate           DateTime? @map("challan_date") @db.Date
  totalQuantity         Int       @default(0) @map("total_quantity")
  status                String    @default("sent")
  corpCreditAmount      Decimal?  @map("corp_credit_amount") @db.Decimal(12, 2)
  corpCreditReceivedAt  DateTime? @map("corp_credit_received_at")
  notes                 String?
  createdBy             String    @map("created_by")
  createdAt             DateTime  @default(now()) @map("created_at")
  updatedAt             DateTime  @updatedAt @map("updated_at")

  distributor Distributor              @relation(fields: [distributorId], references: [id])
  vehicle     Vehicle?                 @relation(fields: [vehicleId], references: [id])
  items       DefectiveCylinderLedger[]

  @@index([distributorId, createdAt])
  @@map("defective_return_batches")
}
```

### Extend InventorySummary (additive columns)
```prisma
defectiveFullsIn      Int @default(0) @map("defective_fulls_in")
defectiveFullsOut     Int @default(0) @map("defective_fulls_out")
closingDefectiveFulls Int @default(0) @map("closing_defective_fulls")
```

### Extend numberingService
```ts
export type DocNumberType = 'I' | 'R' | 'C' | 'D' | 'O' | 'P' | 'V' | 'F';
const VALID_TYPES = new Set([...prev, 'F']);
```

### Migration file
`20260806120000_f1_defective_returns/migration.sql` — pure additive SQL (new enums, new tables, new columns, new enum values via `ALTER TYPE ... ADD VALUE IF NOT EXISTS`).

## Service surface (Slice 2)

`packages/api/src/services/defectiveReturnService.ts`:

```ts
export class DefectiveReturnError extends Error {
  constructor(message: string, public statusCode: number = 400) { super(message); }
}

// ─── Step 0 — Invoice picker (for the UI)
export async function listDefectiveEligibleInvoices(
  distributorId: string,
  customerId: string,
  windowDays = 90,
): Promise<Array<{
  invoiceId: string; invoiceNumber: string; issueDate: string;
  totalAmount: number; paymentStatus: string;
  lines: Array<{
    invoiceItemId: string; cylinderTypeId: string; cylinderTypeName: string;
    perCylRate: number; qty: number; alreadyClaimedQty: number; remainingQty: number;
  }>;
}>>

// ─── Step 1 — Capture
export async function captureDefectiveReturn(
  distributorId: string, actorUserId: string,
  input: {
    customerId: string; sourceInvoiceId: string; collectedDate: string;
    items: Array<{ cylinderTypeId: string; quantity: number }>;
    reason?: string; notes?: string;
  },
): Promise<{ defectiveIds: string[]; cnAmountPreview: number }>

// ─── Step 2 — Raise CN
export async function raiseDefectiveCn(
  distributorId: string, actorUserId: string,
  defectiveIds: string[],
): Promise<{ creditNoteId: string; cnNumber: string; cnAmount: number }>

// ─── Reads
export async function listDefectiveHistory(distributorId: string, filters?: {...}): Promise<...>
export async function getPendingCnCount(distributorId: string): Promise<number>
export async function getDefectiveDepotBucket(distributorId: string): Promise<Array<{
  cylinderTypeId: string; cylinderTypeName: string; qty: number;
}>>

// ─── Cancel (Slice 6 scenario D)
export async function cancelDefectiveReturn(
  distributorId: string, actorUserId: string,
  defectiveId: string, reason: string,
): Promise<void>

// ─── Slice 5 — Outgoing batch
export async function createDefectiveReturnBatch(
  distributorId: string, actorUserId: string,
  input: {
    corporationName: string; vehicleId?: string;
    challanNumber?: string; challanDate?: string;
    defectiveIds: string[];  // must all be status=cn_issued
    notes?: string;
  },
): Promise<{ batchId: string; batchNumber: string }>

// ─── Optional (post-v1): mark corp credit received
export async function markBatchCorpCreditReceived(
  distributorId: string, actorUserId: string,
  batchId: string, corpCreditAmount: number,
): Promise<void>
```

## Routes (Slice 3)

`packages/api/src/routes/defectiveReturns.ts`:

| Route | Roles | Purpose |
|---|---|---|
| GET  /api/defective-returns/eligible-invoices?customerId=X | admin/finance/inventory/mini_op | Populate invoice picker |
| POST /api/defective-returns | admin/finance/inventory/mini_op | Capture defective (Step 1) |
| POST /api/defective-returns/:id/raise-cn | admin/finance/mini_op | Fire CN (Step 2) — inventory role EXCLUDED (matches CN approve gate) |
| GET  /api/defective-returns | admin/finance/inventory/mini_op | List history + filters |
| GET  /api/defective-returns/pending-count | admin/finance/inventory/mini_op | Sidebar chip |
| GET  /api/defective-returns/depot-bucket | admin/finance/inventory/mini_op | Depot bucket per cyl type |
| POST /api/defective-returns/:id/cancel | admin/finance | Cancel a collected row before CN |
| POST /api/defective-returns/batches | admin/finance/inventory/mini_op | Send batch to corp |
| POST /api/defective-returns/batches/:id/corp-credit | admin/finance | Mark corp credit received |

All requires JWT + `resolveDistributor` + `requireDistributor`. All zod-validated.

## Web UI (Slice 4)

- **Sidebar menu item**: New entry under Inventory group — "Defective Returns" with pending-CN badge.
- **`DefectiveReturnsPage.tsx`**: Two tabs — **New Entry** + **History**. New Entry flow:
  1. Customer picker
  2. Invoice picker (90d, all payment states, with per-line remaining qty)
  3. Per-cyl-type quantity entry
  4. Preview: "CN amount will be ₹X against INV-YYY"
  5. Confirm Defectives Collected → server capture
  6. "Check Ledger" link opens customer detail with ledger tab
  7. "Raise Credit Note" button → server raise-cn
  8. Second "Check Ledger" link after CN posted
- **History tab**: Table with columns Customer / Source Invoice / Invoice Amount / Cyl Types / Qty / CN # / CN Amount / Status. Filters: status, date range, customer.
- **Sibling nudge on Outgoing Empties modal**: small info banner "N defective fulls pending at depot" with link.
- **Send-to-Corp modal**: separate route/modal for batch creation, auto-populated from depot bucket.

## Mobile (Slice 4b — optional in v1)

Mirror the web page on `packages/mobile/app/(admin)/defective-returns.tsx` if time permits. Otherwise defer to a follow-up slice — the Suneel spec is office-entered, and office typically works on web.

**Decision: web only for v1.** Mobile can wait for a follow-up.

## Test surface (Slice 6)

7 test files, ~56 test cases. Detailed list in `f1-schema-draft.md` — includes:
- Capture positive/negative (15 cases)
- Raise CN positive/negative + paid invoice + gstMode branches (12 cases)
- List/history/pending-count/role visibility (8 cases)
- Inventory integration (6 cases including WI-106 regression)
- Outgoing batch (6 cases)
- Anti-pattern #24 gates × 5 readers
- 4 end-to-end scenarios: happy path, paid-invoice CN, multi-invoice defective, cancel-before-CN

## Ripple checklist (what else needs touching)

**Shared package** (`packages/shared`):
- Add `defectiveReturnSchema` + `raiseDefectiveCnSchema` + `createDefectiveBatchSchema` to `src/schemas/index.ts`
- Extend `InventoryEventType` enum in `src/enums/index.ts` (+2 values)
- Extend `LedgerEntryType` enum in `src/enums/index.ts` (+1 value)
- Extend `LedgerEntry.kind` union type
- Add types for `DefectiveReturn`, `DefectiveReturnBatch`, `DefectiveEligibleInvoice`, `DefectiveDepotBucketRow`

**API service touch points** (from empties-return trace):
- `paymentService.getCustomerLedger` — add case for `defective_collected` entry type in the reducer
- `customerLedgerPdfService.ts` — 4 spots: Type label (individual), Row (individual), Type label (group), Row (group)
- `reportsService.ts:1701-1710` — extend `isEmptiesReturn` check to also handle `defective_collected` (or create separate branch)
- `inventoryService.ts` aggregator — add defective columns computation in `computeSummaryForDate`
- Depot History filter — add new event types

**Web touch points:**
- `CustomersPage.tsx:1509` — badge map for `defective_collected` LedgerEntryType
- Route registry — new page mounted
- Sidebar config — new menu item + badge

**Mobile touch points:**
- `customer-detail.tsx:629-696` — row renderer branch for `defective_collected` (even if we're not building the office UI on mobile, customers may see it on their portal)

## Slice-by-slice implementation order

1. **Slice 1** — Schema + migration + Prisma types + shared enums/types (~1 hr)
2. **Slice 2** — defectiveReturnService (~2 hrs)
3. **Slice 3** — Routes + zod validation (~1 hr)
4. **Slice 4** — Web DefectiveReturnsPage + sidebar chip + Outgoing Empties nudge banner (~2-3 hrs)
5. **Slice 5** — Send-to-Corp modal + service + numberingService extension (~1.5 hrs)
6. **Slice 6** — Test suite 7 files (~3-4 hrs)
7. **Slice 7** — Green gates + browser verify + V3 doc update + CLAUDE.md anti-pattern note if surfaced (~1 hr)

**Estimated total: ~12-14 hours of focused work.**
