# Batch-wise (FIFO) Cost Layers & Precise COGS — Design Investigation

*Author: Claude Code · Date: 2026-08-12 · Status: **DECISION PENDING** (investigation complete, no code written)*

> **Purpose.** Move cost-of-goods-sold (COGS) and P&L off the current
> *trailing-30-day blended average* onto a **batch-wise FIFO cost-layer** model:
> a running per-cylinder-type counter of loads, each carrying its own landed
> price, drawn down oldest-first as cylinders are delivered. Plus: a
> corporation **credit note applied to a specific purchase invoice must lower
> that batch's landed cost**, so at month-end you can read *"how much did the
> OMC actually discount this stock — cost vs price."* Plus: **backdated
> invoices must recalculate** correctly.
>
> This doc is grounded in a 5-part code trace of the live codebase, not
> assumptions. Every claim below cites the file it came from.

---

## 0. The headline finding (answers your "it's reporting-only, right?" question)

**You were right.** Cost / COGS / landed-cost is **100% computed at read time. Nothing is stored in the database.**

- Grepped the entire Prisma schema for `cogs | landedCost | landed_cost | unitCost | costPrice | purchaseCost | avgCost | weightedCost` → **zero columns.**
- Every consumer (Overview, all 3 corp cost reports) calls `computeLandedCost` / `computeAverageLandedCost` **live** on each request and throws the result away after rendering.
- The sell side (`Order`, `OrderItem`, `Invoice`, `InvoiceItem`) stores **only sale price** — there is no cost field anywhere on a delivered cylinder.

**Why this is the single most important fact for the decision:**

1. **No migration, no backfill, no risk to financial data.** Invoicing, the customer ledger, GST/IRN, and Tally export never read a cost figure — changing how COGS is computed **cannot corrupt a single existing rupee** on the money side.
2. **Backdating becomes cheap.** Because nothing is persisted, a backdated invoice or a late credit note simply changes what the *next* computation produces. There is no stored consumption record to rewrite. Your instinct that "it's reporting only so it won't matter much" is essentially correct — the *risk* is low; the *work* is in building a correct replay.
3. It means we can build FIFO as a **pure read-time replay** and add persistence later only if we want speed or period-locking — not because correctness demands it.

---

## 1. How it works today (and why it mis-figures)

**Landed cost** — `landedCostService.ts:94` `computeLandedCost()`:
```
landedPerCyl(month, cylType) = (Σ line + freight + DN − CN) ÷ Σ cylindersReceived
```
computed per **(purchase-month × cylinder-type)**. Freight/CN/DN are pro-rated across an invoice's cylinder types **by cylinder count** (`:195-197`), GST stripped for GST tenants (`:192`).

**COGS** — `overviewMetricsService.ts:300`:
```
avgPerCyl = landed cost of ALL types blended, over the last 30 days ending TODAY
cogs      = fullsDelivered × avgPerCyl
```
`computeAverageLandedCost` (`landedCostService.ts:262`) anchors its window to **today**, ignores the report's date range, and blends every cylinder type into one number.

**The three ways this mis-figures:**
- **Time smear** — a fixed 30-day-from-today window means the COGS rate applied to a delivery has little to do with what *that* stock actually cost, especially across the 1st-of-month OMC price revision.
- **Type smear** — one blended ₹/cyl is multiplied by *total* fulls delivered, so a day heavy on 5 kg vs 47.5 kg is costed identically.
- **Discount smear** — a credit note on one specific load is averaged across every load of that type in the month (trace #2), and split by cylinder count rather than value, so on a mixed-GST invoice it lands on the wrong type.

---

## 2. The proposed model — FIFO cost layers via read-time replay

### 2a. A "layer" is data we already store
Every **Incoming Fulls** entry already persists, per cylinder type, everything a layer needs (trace #1):

| Layer field | Source (already in DB) |
|---|---|
| cylinder type | `PurchaseEntryItem.cylinderTypeId` |
| quantity received | `PurchaseEntryItem.fullsReceived` |
| unit price (GST-incl) | `PurchaseEntryItem.unitPrice` |
| GST rate | `PurchaseEntryItem.gstRate` |
| freight share | `PurchaseEntryCharge` (freight) |
| **CN / DN adjustment** | `PurchaseCreditNoteAllocation.amount` / `PurchaseDebitNoteAllocation.amount` — **already keyed to the specific `purchaseEntryId`** (trace #2) |
| receipt date (ordering key) | `PurchaseEntry.purchaseDate` |

So a **cost layer = one (purchase invoice × cylinder type) line**, and its landed rate is:
```
layerRate = (lineValue + freightShare + dnShare − cnShare) ÷ fullsReceived   (GST stripped for GST tenants)
```
This is exactly your ask: *a per-cylinder-type running load with its own landed price* — and because the CN allocation is already attached to that specific invoice, **a CN lowers that specific layer's rate**, not a monthly blur.

### 2b. Consumption (drawing down layers)
Deliveries are already tracked per **(order × cylinder type)** as `OrderItem.deliveredQuantity` (trace #4). The replay:
1. For each cylinder type, build its layers from purchase invoices, **ordered by receipt date**.
2. Walk deliveries **in date order**; each delivery draws its quantity from the **oldest open layer(s)**.
3. COGS of that delivery = Σ (qty taken from each layer × that layer's rate).
4. Remaining stock value = Σ (open layer remaining qty × rate) → a true, live inventory valuation.

### 2c. Ordering policy (the one genuine FIFO wrinkle — trace #3)
The event store is **date-only**; backdated events carry a past date but a present insertion time, so there is no reliable *intra-day* physical order. FIFO needs one. The clean, standard convention:

> **Within a single day, all receipts settle before that day's deliveries.**
> Ties broken by (`purchaseDate`, then `purchaseNumber`) for layers and
> (`deliveryDate`, then `orderNumber`) for consumption.

This is deterministic, reproducible, matches how the existing netting model already behaves (it never cared about intra-day order), and avoids adding a monotonic sequence column in v1. Documented and enforced in the replay; a sequence column can be added later only if a customer needs true within-day lot precision.

### 2d. Backdating = free (your "cost-layer version of recalc")
Because COGS is replayed from source documents, a backdated invoice or a backdated delivery **needs no special recompute** — the next replay simply includes it in date order. This is the cost-layer equivalent of `recalculateSummariesFromDate`, except we get it for nothing because we don't persist consumption. (If we later materialise for speed, we reuse the exact `recalculateSummariesFromDate` walk-forward-from-date pattern — trace #3 confirms it transfers cleanly.)

### 2e. Late credit notes = automatically correct
A CN that arrives *after* the cylinders were sold retroactively lowers that layer's rate; the next replay reflects the true, discounted cost. This is precisely the **month-end "cost vs price / how much did the corporation discount this batch"** visibility you want — and it's free under replay. (Trade-off: a closed period's COGS can move when a late CN lands, until we add optional period-locking — see §5.)

---

## 3. What changes in each module

| Module | Change | Risk |
|---|---|---|
| **Cost engine** (`landedCostService.ts` / new `cogsService.ts`) | Add the FIFO layer builder + replay-consume + stockout fallback. This is the bulk of the work. | New code, isolated, read-only |
| **CN/DN attribution** (`landedCostService` split logic) | Change within-invoice CN/DN split from **by-quantity** to **by-line-value** so mixed-GST invoices attribute correctly. Optionally allow explicit per-cylinder-type CN in the modal later. | Small, improves correctness |
| **Overview** (`overviewMetricsService.ts:300`) | Replace `computeAverageLandedCost` blend with FIFO COGS for the period's actual deliveries (by type). | Numbers move (intended) |
| **Corp cost reports** (Purchase-vs-Sale Margin, Landed Cost Trend/Reconciliation) | Offer a FIFO consumption basis; keep "cost of receipts" where that's the report's point. | Numbers move (intended) |
| **Inventory / stock write paths** | **NONE.** No consume-hooks, no new events. Replay reads existing delivery events. | Zero |
| **Invoicing / IRN / customer ledger** | **NONE.** No cost is stamped on the sell side. | Zero |
| **Tally / accounting export** | **NONE.** Carries no COGS figure (trace #5). | Zero |

**Blast radius, ranked by how much numbers move (trace #5):**
1. Overview Profit & Stock / Cashflow — **largest** (headline KPIs: gross margin, net profit).
2. Purchase vs Sale Margin — high (already per-type/month, but cost basis shifts to consumption).
3. Landed Cost Reconciliation — medium.
4. Landed Cost Trend — low (it reports cost of *receipts*, not consumption).
5. Customer Profitability (N18), worst-margin, **Tally export** — **zero** (they carry no COGS today).

---

## 4. The honest issues (and how each is handled)

| # | Issue | Handling |
|---|---|---|
| 1 | **Intra-day order ambiguity** | Fixed convention: receipts-before-deliveries within a day, deterministic tie-breaks (§2c). No sequence column in v1. |
| 2 | **Stockouts** — deliveries exceed recorded receipts (data gaps in early adoption) | Fallback rate: last-known layer rate for that type (or a configurable opening rate). Log the shortfall so it's visible, never silently zero-cost. |
| 3 | **Opening stock at launch** — existing cylinders have no purchase layer | Seed a single **opening cost layer** per type from `initial_balance` events at a chosen opening rate (first real purchase rate, or admin-entered). One-time. |
| 4 | **Late CN moves a closed period's COGS** | Correct by default (true cost includes the discount). Add optional **period-lock snapshot** later if you want frozen months (§5). |
| 5 | **Mixed-GST invoice CN mis-split** | Switch within-invoice split to by-value (§3). |
| 6 | **Performance** — replay on every report | Fine at current scale (hundreds of deliveries/day). If it ever bites, materialise per-day like `InventorySummary` using the same walk-forward pattern. |
| 7 | **Pre-existing bug found:** `cancelOrder` writes reversal events but never calls `recalculateSummariesFromDate` (trace #3) — summaries can go stale. | Not caused by this feature; replay-on-read is actually *immune* to it (it re-derives). Flag separately for a stock-summary fix. |

---

## 5. Two options (my recommendation)

| | **Option A — FIFO cost layers** *(what you described)* | **Option B — Perpetual weighted-average** |
|---|---|---|
| Model | Each load is a layer; deliveries draw oldest-first at that load's rate | One running avg cost per type, re-blended after each receipt |
| P&L precision | Highest — respects price-revision boundaries + shows which stock you hold | High — fixes the month-boundary smear, but no per-load identity |
| "Sitting on expensive stock" signal | **Yes** — open layers show remaining qty × old rate | No |
| Per-batch "cost vs price / discount realized" | **Yes** — native | Partial |
| Build effort | ~4–5 focused days | ~2–3 days |
| Persistence needed | None in v1 (replay) | None in v1 (replay) |

**Recommendation: Option A (FIFO).** It's what you asked for, it's the only one that gives the per-batch discount view and the live stock valuation, and because everything is replay-on-read the extra effort over WAVG is modest and the risk is the same (near-zero — no write paths touched). Option B is the fallback if you later decide per-load identity isn't worth the marginal cost.

---

## 6. What this unlocks (new views worth building on top)

- **Cost Layer Ledger** (Corporation page tab) — a live list of open layers per cylinder type: date, load ref, received qty, remaining qty, landed rate (post-CN). This *is* your "running counter per cylinder type as per the load and its landed price."
- **Batch Cost vs Price / Discount Realized** (month-end report) — per load: what it cost you (post-CN landed) vs what you sold those cylinders for, and how much the OMC discounted via CN. Directly answers your month-end question.
- **True Inventory Valuation** — closing stock valued at actual layer cost (balance-sheet accurate), not an average.

---

## 7. Proposed slices & effort

1. **Layer builder + FIFO replay engine** (new `cogsService.ts`) — layers, ordering policy, consume, stockout fallback, opening layer. *(~1.5 d)*
2. **Value-based CN/DN split** within an invoice. *(~0.5 d)*
3. **Wire Overview + corp margin reports** to the FIFO basis (behind a clean seam so we can compare old vs new). *(~1 d)*
4. **New views** — Cost Layer Ledger + Batch Cost-vs-Price report + stock valuation. *(~1 d)*
5. **Tests** — the 31-Aug/1-Sep scenario as a fixture, backdated-replay, stockout, late-CN retro-adjust, mixed-GST CN split, cross-tenant isolation + green gates. *(~1 d)*
6. *(Deferred)* Period-lock snapshot + performance materialisation — only if/when needed.

**Total: ~4–5 focused days**, zero migration, zero write-path risk.

---

## 8. Decision points for you

1. **Option A (FIFO) or B (perpetual WAVG)?** — I recommend A.
2. **Should late credit notes retro-adjust closed months** (true cost, my default), or do you want months to **freeze at close** (add period-lock in slice 6)?
3. **Opening cost rate** for stock that exists at launch — use the first real purchase rate per type, or enter it manually?
4. **Roll out to all tenants** or start GST-on tenants (Sharma / Vijaya) first, where landed cost matters most?
5. **Keep the old blended number visible side-by-side** during rollout (recommended — lets you sanity-check the new figures before trusting them)?
