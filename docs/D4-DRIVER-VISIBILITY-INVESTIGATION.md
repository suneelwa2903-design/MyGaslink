# D4 — Driver App "−5" Visibility Investigation

**Date:** 2026-07-10
**Trigger:** During live testing, admin Inventory Daily Summary showed `closing_fulls = −5` for 19 KG on Sharma dist-002 for 2026-07-01 (after Option A retro-dated backdated adjustments). Question: why doesn't the driver app show this?

**Verdict: NO BUG. Working as designed.**

---

## What each surface actually shows

| Surface | Metric shown | Data source | Meaning |
|---|---|---|---|
| Admin → Inventory → Daily Summary | `closing_fulls`, `opening_fulls`, `manual_adjustment` | `inventory_summaries` table (aggregated events) | Depot's stock position on that day |
| Driver mobile → Inventory | `fullQuantity` (still to deliver), `deliveredQuantity`, `availableFulls` (walk-in headroom) | `GET /drivers/me/trip-stock` → derived from **orders assigned to this driver today** + DVA manifest | What's PHYSICALLY on the truck right now |
| Driver mobile → Active Trip | Loaded / delivered / empties collected | Same trip-stock endpoint | Same as above |

## Why they don't correlate

`−5` on the admin depot view = **depot's cumulative fulls balance is 5 cyls underwater**. This is a bookkeeping number — it means "we've delivered more than we've received, and until an `incoming_fulls` event closes the gap, the depot is technically overdrawn."

The driver app has zero relationship to depot balance. It's answering a completely different question: *"What's on my truck right now, and how many can I still sell as walk-ins?"* Those answers come from:
- Depot manifest → `getAvailableFullsForDriver` at [dvaManifestService.ts:271](packages/api/src/services/dvaManifestService.ts:271) — sums current DVA's manifest `floatQty` and subtracts walk-in cyls already taken.
- Trip stock → [driversVehicles.ts /me/trip-stock] — sums orders assigned to this driver today by delivery status.

Neither reads `inventory_summaries.closing_fulls`. So even a wildly-negative depot balance is invisible to the driver — because the driver doesn't drive off with depot's ledger; they drive off with a manifest of physical cylinders that were counted in.

## Should the driver see the depot's −5?

**No.** Reasons:

1. **Role separation.** Driver = operational execution. Depot balance = office reconciliation. Mixing them puts a book-keeping abstraction on the road, where nothing about it is actionable to the driver.
2. **The number is a ledger artefact.** `−5` doesn't mean "there are no cylinders in the depot" (the depot has physical cyls). It means "the events chain says we're behind by 5 receipts vs. deliveries." The physical count could be anything.
3. **The dashboard the operator needs already exists.** Admin → Inventory Daily Summary + Depot History surfaces the balance for the person who books incoming stock.
4. **If a walk-in fails because depot is dry** — the driver's walk-in modal already blocks with `INSUFFICIENT_VEHICLE_STOCK` (see [driversVehicles.ts:917](packages/api/src/routes/driversVehicles.ts:917)). That's the layer that matters to the driver.

## What could change if you disagreed

If Sharma wanted the driver to know "depot is underwater — no new mid-trip walk-ins pending an incoming_fulls event", the smallest addition would be:

- A pale banner at the top of the driver Inventory tab if `admin.closing_fulls < 0` for any cyl type on the driver's tenant today.
- Read-only — the driver can't act on it, just aware.

Not implemented. Would be an additive feature, not a bug fix. Flag for a v1.1 UX pass if depot underwater becomes a recurring operational pattern that drivers need to know about.

## Files inspected

- [packages/mobile/app/(driver)/inventory.tsx](packages/mobile/app/(driver)/inventory.tsx)
- [packages/mobile/app/(driver)/orders.tsx](packages/mobile/app/(driver)/orders.tsx)
- [packages/api/src/services/dvaManifestService.ts:271 getAvailableFullsForDriver](packages/api/src/services/dvaManifestService.ts:271)
- [packages/api/src/routes/driversVehicles.ts](packages/api/src/routes/driversVehicles.ts) — `/me/trip-stock`

**No code changed. Investigation only.**
