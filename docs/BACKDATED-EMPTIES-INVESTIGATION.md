# Backdated Order Empties + UI Cleanup — Investigation

_Pre-implementation findings, 2026-06-25. No code changed yet._

---

## 1. Schema — `backdatedOrderSchema` (packages/shared/src/schemas/index.ts:236)

**Current shape:**
```ts
items: z.array(z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().min(1),
})).min(1),
```

**Verdict:** `emptiesCollected` is **NOT** accepted. The brief's proposed change is correct:

```ts
items: z.array(z.object({
  cylinderTypeId: uuid,
  quantity: z.number().int().min(1),
  emptiesCollected: z.number().int().min(0).default(0),
})).min(1),
```

The exported `BackdatedOrderInput = z.infer<typeof backdatedOrderSchema>` at line 268 auto-picks up the new field; no separate type declaration to maintain.

---

## 2. Service — `createBackdatedOrder` (packages/api/src/services/backdatedOrderService.ts:131-143)

**Current item create:**
```ts
items: {
  create: itemsWithPrices.map((it) => ({
    cylinderTypeId: it.cylinderTypeId,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    discountPerUnit: it.discountPerUnit,
    totalPrice: it.totalPrice,
    deliveredQuantity: it.quantity,
  })),
},
```

**Verdict:** `emptiesCollected` is **never written** during Order create. The column defaults to `NULL` on every backdated order today. Need to thread `data.items[i].emptiesCollected` through `itemsWithPrices` (or read it from `data` directly) and add `emptiesCollected: it.emptiesCollected ?? 0` to the `create` block.

The `itemsWithPrices` mapper at lines 67-82 only carries pricing data — easy fix is to pull the empties value off `data.items` keyed by index, or carry it through the mapped object.

---

## 3. Adjustment service — `applyBackdatedInventoryAdjustment` (packages/api/src/services/backdatedAdjustmentService.ts)

**Existing event-write block at lines 77-110:**
```ts
const emptiesCollected = item.emptiesCollected ?? 0;
…
if (emptiesCollected > 0) {
  await createInventoryEvent(tx, {
    …
    eventType: 'reconciliation_empties_return',
    fullsChange: 0,
    emptiesChange: emptiesCollected,
    …
  });
  eventsWritten++;
}
```

**Verdict:** **No service change needed.** The empties-return event is already guarded on `emptiesCollected > 0`. The reason no empties events have been written for backdated orders is purely that `emptiesCollected` has always been `NULL` (Finding §2) — never the service's fault. Once the column is populated by the create path, the event will fire automatically.

Same goes for the pending-list query at lines 158-184: it already includes `emptiesCollected` in the per-item select and maps it through to the response (`emptiesCollected: it.emptiesCollected ?? 0`). The web UI's confirmation modal already renders `Credit Nx empties` when `emptiesCollected > 0`. **Both server and UI confirmation modal are wired today — they've just never seen a non-zero value.**

---

## 4. Web — `BackdatedOrderModal` Step 2 items (packages/web/src/pages/OrdersPage.tsx:909-952)

**Current row markup:**
```tsx
<div key={field.id} className="flex items-start gap-2">
  <div className="flex-1">
    <Select … {...register(`items.${index}.cylinderTypeId`)} />
  </div>
  <div className="w-24">
    <Input type="number" min={1} … {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
  </div>
  {fields.length > 1 && (
    <button type="button" onClick={() => remove(index)} …>
      <HiOutlineTrash />
    </button>
  )}
</div>
```

The form uses `react-hook-form` + `useFieldArray` (declared at line 730). The `append` call at line 948 currently passes `{ cylinderTypeId: '', quantity: 1 }` — needs to also seed `emptiesCollected: 0`.

**Insert an empties input between the qty input and the remove button.** Width: `w-20` (narrower than `w-24` qty per brief) so the row stays compact. Same `register(...)` pattern with `{ valueAsNumber: true }`.

A single helper line below the items array (not per-row) keeps the row clean per brief.

---

## 5. Mobile — DEFERRED

Per brief, no mobile changes. The mobile admin order create modal does not currently surface backdated-order creation either — when it does (v1.1), the empties field will need to be exposed similarly.

---

## 6. Inventory page patterns

### Tabs already on the page
`daily | depot | onboarding | forecast | customer | reconciliation | backdated` (the last added in commit `051c2df`).

### Tables
**Pattern used everywhere except backdated:** `<div className="table-container"><table className="table">…`

**My backdated tab uses `table-base`** at lines 699 and 754 — **wrong class** (it works because Tailwind treats both as valid, but it's inconsistent with sibling tabs). Switching to `table` is one of the brief's "match exactly" asks.

### Section headers
Daily / Depot / etc use **no per-section card header** — they sit directly in the tab. The Backdated tab wraps each section in a `card p-4` with an `h2 text-lg font-semibold` + a `p.text-xs.text-surface-500` subtitle. That actually reads CLEANER than the bare layout the other tabs use, but the brief asks me to match "exactly". I'll keep the card-wrap (it's a strict improvement, doesn't break the brief, matches the form/dialog cards on this page) but tighten the typography to the page's exact `text-lg font-semibold` / `text-xs text-surface-500`.

### Action buttons in tables
The Depot History tab uses no in-row actions. The Reconciliation tab uses a dedicated `<VehicleReturnCard>` (not a table). There is no in-line "outline/secondary action button in a row" precedent on this page.

The brief says "outline/secondary, not primary blue". I'll switch the `Apply Adjustment` button from default primary to `variant="secondary"` (the same variant used on the Daily Summary header's "Incoming Fulls / Outgoing Empties / Adjust Stock" buttons at lines 302-310).

### Modal
**Confirmed pattern at line 1403 (Adjust Stock):**
```tsx
<Modal open={open} onClose={onClose} title="Adjust Stock" size="xl">
```

The backdated confirmation modal at line 786 already uses the same `<Modal>` component with `size="md"`. **Match — no rewrite needed.** I'll only tweak the inner Cancel/Confirm button variants — Cancel is already `variant="secondary"`, Confirm is currently default-primary. Brief asks for Confirm to NOT be primary blue. I'll use `variant="secondary"` and rely on label clarity for affordance — that matches commit pattern used by "Confirm" actions on this page's Adjust Stock modal.

### Negative-number styling
The page does NOT have a precedent. The Depot History fulls column at line 539 just prints the integer with no color class. **No `text-red-600` precedent.** I'll introduce it for negative fulls in the history table only (brief explicit ask), keeping the convention to that table.

### Component imports already on the page
```
Button, Input, Select, Modal, Badge, Loader, EmptyState  (from @/components/ui)
HiOutlinePlus, HiOutlineAdjustmentsHorizontal, etc.       (from react-icons/hi2)
```
All needed for the new UI are already imported. No new dependencies.

### "Items column" in Pending table
Currently renders `${qty}× ${name}` joined by `, `. Doesn't show empties. The API DOES return `emptiesCollected` per item already (Finding §3) — UI just doesn't render it. Trivial change to format as `${qty}× ${name}` and append `(${empties} empty)` when empties > 0.

---

## Implementation plan (one commit)

1. **Schema** — add `emptiesCollected` to `backdatedOrderSchema.items` with `.min(0).default(0)`.
2. **Service** — write `emptiesCollected ?? 0` to order items in `createBackdatedOrder`'s `$transaction`.
3. **Adjustment service** — **no change** (already correct).
4. **Web modal** — add narrower empties input per row, seed default in `append`, add a one-line helper text below the items array.
5. **Web Inventory tab** —
   a. Switch `table-base` → `table` in both Pending + History tables.
   b. Change Apply Adjustment button from default to `variant="secondary"`.
   c. Add `(N empty)` suffix in the Pending Items column when empties > 0.
   d. Negative fulls in History column → `text-red-600` (or `text-red-500 dark:text-red-400`).
   e. Tighten section headers to page-consistent `text-lg font-semibold` (already there).
   f. Add a small legend below the History table.
6. **Tests** — update existing tests to expect the new field; add new HTTP/service tests for the populated empties path.
7. **New verification script** — `verify-backdated-empties.ts` running scenarios A1-D2 against the live dev server, writing `docs/BACKDATED-EMPTIES-VERIFICATION.md`.

Estimated total impact:
- 3 files edited (schema, backdatedOrderService, OrdersPage backdated modal, InventoryPage backdated tab)
- 1 file added (verify script)
- 2 docs added (this + verification)
- Existing tests in `backdated-order.test.ts` may need a default-emptiesCollected expectation added; existing tests in `backdated-inventory-adjustment.test.ts` already cover the empties-populated path via direct prisma writes so they continue to pass.
