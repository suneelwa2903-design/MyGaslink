/**
 * Cost-Layer COGS Service (FIFO) — 2026-08-12
 * Design: docs/COST-LAYER-COGS-DESIGN.md
 *
 * Replaces the trailing-30-day BLENDED-average COGS (computeAverageLandedCost)
 * with a batch-wise FIFO cost-layer model:
 *
 *   • A "layer" = one purchase-invoice line (PurchaseEntryItem) = a load of a
 *     specific cylinder type at a specific landed rate. Rate carries this
 *     invoice's own freight + CN + DN, so a credit note allocated to a
 *     specific purchase invoice lowers THAT batch's cost (not a monthly blur).
 *   • Deliveries (delivered / modified_delivered orders, per OrderItem) draw
 *     down the OLDEST open layer first (FIFO). COGS of a delivery = Σ (qty
 *     taken from each layer × that layer's landed rate).
 *   • Everything is computed at READ TIME from source documents — nothing is
 *     persisted. Backdated invoices/deliveries and late credit notes are
 *     handled for free: the next call simply re-derives from current data
 *     (see design doc §0 — there is no stored COGS column anywhere).
 *
 * ORDERING POLICY (design §2c): the event store is date-only, so FIFO needs a
 * deterministic intra-day tie-break. Convention: within a day, all receipts
 * settle before that day's deliveries (a same-day load is available to a
 * same-day delivery). Layers ordered by (purchaseDate, ref); deliveries by
 * (deliveryDate, orderNumber).
 *
 * GST-MODE AWARE (parity with landedCostService): live/sandbox tenants claim
 * ITC → landed rate is GST-EXCLUSIVE; disabled tenants → GST-INCLUSIVE.
 *
 * SPLIT RULE (design §3, the fix vs landedCostService): within one invoice,
 * FREIGHT is split across cyl-type lines by cylinder COUNT (transport scales
 * with count), while CN/DN are split by line VALUE (a price incentive scales
 * with value, not count) — this fixes the mixed-GST misattribution.
 *
 * Tenant-scoped: every query filters distributorId (anti-pattern #13).
 * No new tables, no migration. No Date.now()/Math.random() (deterministic).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function toNum(d: Prisma.Decimal | number | null | undefined): number {
  if (d == null) return 0;
  return typeof d === 'number' ? d : Number(d);
}
function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}
/** Normalise a Date | string delivery date to a yyyy-mm-dd calendar string. */
function toDayString(d: Date | string | null | undefined): string {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  // Local calendar date — avoid UTC shift (anti-pattern #21). Delivery dates
  // are @db.Date so the time component is midnight UTC; use UTC getters here
  // precisely because @db.Date has no meaningful local time.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type GstMode = 'live' | 'sandbox' | 'disabled';

/** One cost layer = a purchase-invoice line for a specific cyl type. */
export interface CostLayer {
  cylinderTypeId: string;
  cylinderTypeName: string;
  /** yyyy-mm-dd receipt date (FIFO ordering key) */
  date: string;
  /** User-facing reference (OMC doc no, never the internal PSHD number) */
  ref: string;
  purchaseEntryId: string | null; // null for injected opening layers
  qtyReceived: number;
  qtyRemaining: number;
  /** Per-cyl breakdown so the UI/PDF can show gross → CN → net (design §6). */
  grossRate: number; // price/cyl before freight/CN/DN (GST-adjusted)
  freightPerCyl: number;
  cnPerCyl: number; // discount from OMC (lowers cost)
  dnPerCyl: number; // extra billed by OMC (raises cost)
  landedRate: number; // grossRate + freightPerCyl + dnPerCyl − cnPerCyl
  isOpening: boolean;
}

/** How one delivery (OrderItem) drew from layers. */
export interface DeliveryConsumption {
  orderNumber: string;
  date: string;
  cylinderTypeId: string;
  qty: number;
  saleValue: number;
  cogs: number;
  uncostedQty: number; // qty with no layer to draw from (design §4 issue 2)
  draws: Array<{ purchaseEntryId: string | null; ref: string; layerDate: string; qty: number; rate: number }>;
}

export interface MonthCogs {
  month: string; // yyyy-mm
  qtyDelivered: number;
  cogs: number;
  saleValue: number;
  margin: number;
  marginPct: number;
  uncostedQty: number;
}

export interface FifoCogsResult {
  gstMode: GstMode;
  filters: { from: string | null; to: string | null };
  totals: {
    qtyDelivered: number;
    cogs: number;
    saleValue: number;
    margin: number;
    marginPct: number;
    uncostedQty: number; // delivered cyls with no purchase layer behind them
  };
  byMonth: MonthCogs[];
  /** Per-delivery drilldown (audit / raw drawer). */
  consumptions: DeliveryConsumption[];
}

/** Optional opening layers (deferred onboarding entry — design §4 issue 3). */
export interface OpeningLayerInput {
  cylinderTypeId: string;
  date: string; // yyyy-mm-dd — dated at/just before go-live
  ref: string; // e.g. 'OPENING'
  qty: number;
  ratePerCyl: number; // landed ₹/cyl the user enters per their process
}

async function getGstMode(distributorId: string): Promise<GstMode> {
  const d = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true },
  });
  return (d?.gstMode ?? 'disabled') as GstMode;
}

async function getCylTypeNames(distributorId: string): Promise<Map<string, string>> {
  const types = await prisma.cylinderType.findMany({
    where: { distributorId },
    select: { id: true, typeName: true },
  });
  return new Map(types.map((t) => [t.id, t.typeName]));
}

/**
 * Build the FIFO cost layers for a tenant, ordered oldest-first per cyl type.
 * Only documentType='invoice' purchase entries (deposit invoices excluded).
 * Optionally prepend caller-supplied opening layers.
 */
export async function buildCostLayers(
  distributorId: string,
  opts: { upToDate?: string; opening?: OpeningLayerInput[] } = {},
): Promise<Map<string, CostLayer[]>> {
  // 2026-08-15 (Suneel) — landed cost is GST-INCLUSIVE everywhere. The dealer
  // margin/discount is settings selling price (incl GST) − landed (incl GST),
  // a consistent cash-margin. GST is NOT stripped even for ITC-claiming
  // (live/sandbox) tenants; payables are incl-GST too, so nothing double-counts.
  // (Was: excludeGst = live/sandbox.) Flip this one flag back if a tenant ever
  // needs strict ITC (GST-exclusive) costing.
  const excludeGst = false;
  const names = await getCylTypeNames(distributorId);

  const entries = await prisma.purchaseEntry.findMany({
    where: {
      distributorId,
      deletedAt: null,
      documentType: 'invoice',
      ...(opts.upToDate ? { purchaseDate: { lte: opts.upToDate } } : {}),
    },
    select: {
      id: true,
      purchaseDate: true,
      supplierDocumentNumber: true,
      plantName: true,
      items: { select: { cylinderTypeId: true, fullsReceived: true, unitPrice: true, gstRate: true } },
      charges: { select: { chargeType: true, amount: true } },
      cnAllocations: { where: { purchaseCreditNote: { deletedAt: null } }, select: { amount: true } },
      dnAllocations: { where: { purchaseDebitNote: { deletedAt: null } }, select: { amount: true } },
    },
  });

  const byType = new Map<string, CostLayer[]>();
  const push = (layer: CostLayer) => {
    const list = byType.get(layer.cylinderTypeId) ?? [];
    list.push(layer);
    byType.set(layer.cylinderTypeId, list);
  };

  // Injected opening layers first (they carry an early date so FIFO consumes
  // them before real purchases).
  for (const o of opts.opening ?? []) {
    push({
      cylinderTypeId: o.cylinderTypeId,
      cylinderTypeName: names.get(o.cylinderTypeId) ?? '—',
      date: o.date,
      ref: o.ref,
      purchaseEntryId: null,
      qtyReceived: o.qty,
      qtyRemaining: o.qty,
      grossRate: round4(o.ratePerCyl),
      freightPerCyl: 0,
      cnPerCyl: 0,
      dnPerCyl: 0,
      landedRate: round4(o.ratePerCyl),
      isOpening: true,
    });
  }

  for (const e of entries) {
    const totalCyls = e.items.reduce((s, it) => s + it.fullsReceived, 0);
    if (totalCyls === 0) continue; // movement-only / all-zero entry
    const freight = e.charges
      .filter((c) => c.chargeType === 'freight')
      .reduce((s, c) => s + toNum(c.amount), 0);
    const cn = e.cnAllocations.reduce((s, a) => s + toNum(a.amount), 0);
    const dn = e.dnAllocations.reduce((s, a) => s + toNum(a.amount), 0);

    // GST-adjusted line value per item + entry total value (for value-based
    // CN/DN split — the fix over landedCostService's count-based split).
    const lineValue = (it: (typeof e.items)[number]): number => {
      const gross = toNum(it.unitPrice) * it.fullsReceived;
      const gstRate = toNum(it.gstRate);
      return excludeGst && gstRate > 0 ? gross / (1 + gstRate / 100) : gross;
    };
    const entryValue = e.items.reduce((s, it) => s + lineValue(it), 0);

    for (const it of e.items) {
      if (it.fullsReceived === 0) continue;
      const line = lineValue(it);
      const qtyRatio = it.fullsReceived / totalCyls; // freight: by count
      const valueRatio = entryValue > 0 ? line / entryValue : qtyRatio; // CN/DN: by value
      const freightShare = freight * qtyRatio;
      const cnShare = cn * valueRatio;
      const dnShare = dn * valueRatio;
      const grossRate = line / it.fullsReceived;
      const landed = (line + freightShare + dnShare - cnShare) / it.fullsReceived;
      push({
        cylinderTypeId: it.cylinderTypeId,
        cylinderTypeName: names.get(it.cylinderTypeId) ?? '—',
        date: e.purchaseDate,
        // NEVER surface the internal purchaseNumber (PSHD…) — only the OMC's
        // own reference or plant is user-facing (repo convention; see
        // no-internal-refs-corp-ledger.test.ts). Internal grouping/sort uses
        // purchaseEntryId, so a missing OMC ref can't collide loads.
        ref: e.supplierDocumentNumber || e.plantName || '(no OMC ref)',
        purchaseEntryId: e.id,
        qtyReceived: it.fullsReceived,
        qtyRemaining: it.fullsReceived,
        grossRate: round4(grossRate),
        freightPerCyl: round4(freightShare / it.fullsReceived),
        cnPerCyl: round4(cnShare / it.fullsReceived),
        dnPerCyl: round4(dnShare / it.fullsReceived),
        landedRate: round4(landed),
        isOpening: false,
      });
    }
  }

  // FIFO order per type: purchaseDate, then purchaseEntryId (stable, unique)
  // so loads with a missing/duplicate OMC ref still order deterministically.
  for (const list of byType.values()) {
    list.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.purchaseEntryId ?? `opening:${a.ref}`).localeCompare(b.purchaseEntryId ?? `opening:${b.ref}`),
    );
  }
  return byType;
}

/**
 * FIFO COGS for delivered cylinders in [from, to]. Consumes off delivered /
 * modified_delivered orders (cancelled orders are naturally excluded — design
 * §4). Returns per-month + per-delivery breakdown + uncosted stockout qty.
 *
 * Layers are always built from the FULL purchase history (not just the window)
 * and consumed by ALL deliveries up to `to`, so that a delivery inside the
 * window draws from the correct remaining layer given everything sold before
 * it. Only deliveries whose date falls in [from, to] are reported.
 */
export async function computeFifoCogs(
  distributorId: string,
  filters: { from?: string; to?: string; opening?: OpeningLayerInput[] } = {},
): Promise<FifoCogsResult> {
  const gstMode = await getGstMode(distributorId);
  const layers = await buildCostLayers(distributorId, {
    upToDate: filters.to,
    opening: filters.opening,
  });

  // All deliveries up to `to`, chronological. We consume every delivery so the
  // layer cursor is correct, but only REPORT those in [from, to].
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      status: { in: ['delivered', 'modified_delivered'] },
      ...(filters.to ? { deliveryDate: { lte: new Date(filters.to) } } : {}),
    },
    select: {
      orderNumber: true,
      deliveryDate: true,
      items: {
        select: { cylinderTypeId: true, deliveredQuantity: true, quantity: true, totalPrice: true },
      },
    },
  });

  interface Cons {
    date: string;
    orderNumber: string;
    cylinderTypeId: string;
    qty: number;
    saleValue: number;
  }
  const cons: Cons[] = [];
  for (const o of orders) {
    const date = toDayString(o.deliveryDate);
    for (const it of o.items) {
      const qty = it.deliveredQuantity ?? it.quantity;
      if (qty > 0) {
        cons.push({
          date,
          orderNumber: o.orderNumber,
          cylinderTypeId: it.cylinderTypeId,
          qty,
          saleValue: toNum(it.totalPrice),
        });
      }
    }
  }
  cons.sort((a, b) => a.date.localeCompare(b.date) || a.orderNumber.localeCompare(b.orderNumber));

  const cursor = new Map<string, number>(); // cylTypeId → next-open-layer index
  const consumptions: DeliveryConsumption[] = [];
  const monthAcc = new Map<string, MonthCogs>();
  const inWindow = (d: string) =>
    (!filters.from || d >= filters.from) && (!filters.to || d <= filters.to);

  let tQty = 0, tCogs = 0, tSale = 0, tUncosted = 0;

  for (const c of cons) {
    const list = layers.get(c.cylinderTypeId) ?? [];
    let idx = cursor.get(c.cylinderTypeId) ?? 0;
    let need = c.qty;
    let cogs = 0;
    const draws: DeliveryConsumption['draws'] = [];
    while (need > 0 && idx < list.length) {
      const L = list[idx];
      if (L.date > c.date) break; // layer not yet received (ordering policy)
      if (L.qtyRemaining <= 0) { idx++; continue; }
      const take = Math.min(need, L.qtyRemaining);
      cogs += take * L.landedRate;
      draws.push({ purchaseEntryId: L.purchaseEntryId, ref: L.ref, layerDate: L.date, qty: take, rate: L.landedRate });
      L.qtyRemaining -= take;
      need -= take;
      if (L.qtyRemaining === 0) idx++;
    }
    cursor.set(c.cylinderTypeId, idx);
    const uncosted = need; // no layer left → user must enter opening/rate

    if (inWindow(c.date)) {
      cogs = round2(cogs);
      consumptions.push({
        orderNumber: c.orderNumber,
        date: c.date,
        cylinderTypeId: c.cylinderTypeId,
        qty: c.qty,
        saleValue: round2(c.saleValue),
        cogs,
        uncostedQty: uncosted,
        draws,
      });
      const mk = monthKey(c.date);
      const m = monthAcc.get(mk) ?? {
        month: mk, qtyDelivered: 0, cogs: 0, saleValue: 0, margin: 0, marginPct: 0, uncostedQty: 0,
      };
      m.qtyDelivered += c.qty;
      m.cogs = round2(m.cogs + cogs);
      m.saleValue = round2(m.saleValue + c.saleValue);
      m.uncostedQty += uncosted;
      monthAcc.set(mk, m);
      tQty += c.qty; tCogs = round2(tCogs + cogs); tSale = round2(tSale + c.saleValue); tUncosted += uncosted;
    }
  }

  const byMonth = [...monthAcc.values()]
    .map((m) => ({ ...m, margin: round2(m.saleValue - m.cogs), marginPct: m.saleValue > 0 ? round2(((m.saleValue - m.cogs) / m.saleValue) * 100) : 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    gstMode,
    filters: { from: filters.from ?? null, to: filters.to ?? null },
    totals: {
      qtyDelivered: tQty,
      cogs: tCogs,
      saleValue: tSale,
      margin: round2(tSale - tCogs),
      marginPct: tSale > 0 ? round2(((tSale - tCogs) / tSale) * 100) : 0,
      uncostedQty: tUncosted,
    },
    byMonth,
    consumptions,
  };
}

/**
 * Current inventory valuation = remaining open layers × their landed rate,
 * as of a date. Balance-sheet-accurate stock value (design §6). Consumes all
 * deliveries up to `asOf` first, then values what's left in each layer.
 */
export async function computeStockValuation(
  distributorId: string,
  opts: { asOf?: string; opening?: OpeningLayerInput[] } = {},
): Promise<{
  gstMode: GstMode;
  asOf: string | null;
  totalRemainingQty: number;
  totalValue: number;
  openLayers: CostLayer[];
  uncostedQty: number;
}> {
  const gstMode = await getGstMode(distributorId);
  // Reuse the FIFO consume to draw layers down to `asOf`, then read remainders.
  const layers = await buildCostLayers(distributorId, { upToDate: opts.asOf, opening: opts.opening });
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      status: { in: ['delivered', 'modified_delivered'] },
      ...(opts.asOf ? { deliveryDate: { lte: new Date(opts.asOf) } } : {}),
    },
    select: { orderNumber: true, deliveryDate: true, items: { select: { cylinderTypeId: true, deliveredQuantity: true, quantity: true } } },
  });
  interface C { date: string; orderNumber: string; cylinderTypeId: string; qty: number; }
  const cons: C[] = [];
  for (const o of orders) {
    const date = toDayString(o.deliveryDate);
    for (const it of o.items) {
      const qty = it.deliveredQuantity ?? it.quantity;
      if (qty > 0) cons.push({ date, orderNumber: o.orderNumber, cylinderTypeId: it.cylinderTypeId, qty });
    }
  }
  cons.sort((a, b) => a.date.localeCompare(b.date) || a.orderNumber.localeCompare(b.orderNumber));
  const cursor = new Map<string, number>();
  let uncosted = 0;
  for (const c of cons) {
    const list = layers.get(c.cylinderTypeId) ?? [];
    let idx = cursor.get(c.cylinderTypeId) ?? 0;
    let need = c.qty;
    while (need > 0 && idx < list.length) {
      const L = list[idx];
      if (L.date > c.date) break;
      if (L.qtyRemaining <= 0) { idx++; continue; }
      const take = Math.min(need, L.qtyRemaining);
      L.qtyRemaining -= take; need -= take;
      if (L.qtyRemaining === 0) idx++;
    }
    cursor.set(c.cylinderTypeId, idx);
    uncosted += need;
  }
  const openLayers: CostLayer[] = [];
  let totalQty = 0, totalValue = 0;
  for (const list of layers.values()) {
    for (const L of list) {
      if (L.qtyRemaining > 0) {
        openLayers.push(L);
        totalQty += L.qtyRemaining;
        totalValue = round2(totalValue + L.qtyRemaining * L.landedRate);
      }
    }
  }
  openLayers.sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName) || a.date.localeCompare(b.date));
  return { gstMode, asOf: opts.asOf ?? null, totalRemainingQty: totalQty, totalValue, openLayers, uncostedQty: uncosted };
}

export interface CostLedgerRow {
  cylinderTypeId: string;
  cylinderTypeName: string;
  date: string;
  ref: string;
  purchaseEntryId: string | null;
  qtyReceived: number;
  qtyRemaining: number;
  grossRate: number;
  freightPerCyl: number;
  cnPerCyl: number;
  dnPerCyl: number;
  landedRate: number;
}

/**
 * Cost Layer Ledger (2026-08-15) — the merged per-load table for the Corp.
 * Loads page. Same FIFO layers as computeStockValuation, but returns ALL loads
 * (open AND fully consumed, remaining=0) so the frontend can group by cyl type
 * → month and show BOTH the monthly average (all purchases) and the open-stock
 * valuation (remaining) in one table. Also returns MRP (latest settings selling
 * price) per cyl type so the UI can render the dealer margin = MRP − landed.
 */
export async function computeCostLedger(
  distributorId: string,
  opts: { asOf?: string } = {},
): Promise<{
  gstMode: GstMode;
  rows: CostLedgerRow[];
  mrpByType: Record<string, number>;
  totalRemainingQty: number;
  totalValue: number;
}> {
  const gstMode = await getGstMode(distributorId);
  const layers = await buildCostLayers(distributorId, { upToDate: opts.asOf });
  // FIFO-consume deliveries to draw down qtyRemaining (identical to
  // computeStockValuation — consumed loads end at remaining 0).
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      status: { in: ['delivered', 'modified_delivered'] },
      ...(opts.asOf ? { deliveryDate: { lte: new Date(opts.asOf) } } : {}),
    },
    select: { orderNumber: true, deliveryDate: true, items: { select: { cylinderTypeId: true, deliveredQuantity: true, quantity: true } } },
  });
  const cons: { date: string; orderNumber: string; cylinderTypeId: string; qty: number }[] = [];
  for (const o of orders) {
    const date = toDayString(o.deliveryDate);
    for (const it of o.items) {
      const qty = it.deliveredQuantity ?? it.quantity;
      if (qty > 0) cons.push({ date, orderNumber: o.orderNumber, cylinderTypeId: it.cylinderTypeId, qty });
    }
  }
  cons.sort((a, b) => a.date.localeCompare(b.date) || a.orderNumber.localeCompare(b.orderNumber));
  const cursor = new Map<string, number>();
  for (const c of cons) {
    const list = layers.get(c.cylinderTypeId) ?? [];
    let idx = cursor.get(c.cylinderTypeId) ?? 0;
    let need = c.qty;
    while (need > 0 && idx < list.length) {
      const L = list[idx];
      if (L.date > c.date) break;
      if (L.qtyRemaining <= 0) { idx++; continue; }
      const take = Math.min(need, L.qtyRemaining);
      L.qtyRemaining -= take; need -= take;
      if (L.qtyRemaining === 0) idx++;
    }
    cursor.set(c.cylinderTypeId, idx);
  }
  const rows: CostLedgerRow[] = [];
  let totalRemainingQty = 0, totalValue = 0;
  for (const list of layers.values()) {
    for (const L of list) {
      rows.push({
        cylinderTypeId: L.cylinderTypeId, cylinderTypeName: L.cylinderTypeName,
        date: L.date, ref: L.ref, purchaseEntryId: L.purchaseEntryId,
        qtyReceived: L.qtyReceived, qtyRemaining: L.qtyRemaining,
        grossRate: round4(L.grossRate), freightPerCyl: round4(L.freightPerCyl),
        cnPerCyl: round4(L.cnPerCyl), dnPerCyl: round4(L.dnPerCyl), landedRate: round4(L.landedRate),
      });
      if (L.qtyRemaining > 0) {
        totalRemainingQty += L.qtyRemaining;
        totalValue = round2(totalValue + L.qtyRemaining * L.landedRate);
      }
    }
  }
  rows.sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName) || a.date.localeCompare(b.date));
  // MRP = latest settings selling price per cyl type (GST-inclusive).
  const prices = await prisma.cylinderPrice.findMany({
    where: { distributorId },
    orderBy: { effectiveDate: 'desc' },
    select: { cylinderTypeId: true, price: true },
  });
  const mrpByType: Record<string, number> = {};
  for (const p of prices) if (!(p.cylinderTypeId in mrpByType)) mrpByType[p.cylinderTypeId] = toNum(p.price);
  return { gstMode, rows, mrpByType, totalRemainingQty, totalValue };
}
