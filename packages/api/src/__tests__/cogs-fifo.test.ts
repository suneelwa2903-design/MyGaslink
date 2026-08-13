/**
 * Cost-Layer FIFO COGS tests — docs/COST-LAYER-COGS-DESIGN.md.
 *
 * Every test builds a DEDICATED throwaway tenant (unique distributorId) so the
 * FIFO replay is fully deterministic and never touches shared dev-DB state
 * (anti-patterns #7 / #8). All fixtures are torn down in afterAll.
 *
 * Covers: the 31-Aug/1-Sep price scenario (down + up), multi-layer draw, the
 * same-day ordering policy, CN-lowers-a-layer, value-based CN split on a
 * mixed-GST invoice, backdated-invoice replay, cancelled-order exclusion,
 * stockout flagging, opening layers, GST-strip, and cross-tenant isolation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { buildCostLayers, computeFifoCogs, computeStockValuation } from '../services/cogsService.js';

const PREFIX = 'dist-cogs-test-';
const createdTenants: string[] = [];
let seq = 0;

interface Tenant {
  distributorId: string;
  cylA: string; // primary cyl type
  cylB: string; // secondary cyl type (mixed-invoice tests)
  customerId: string;
  sourceId: string;
  addLoad: (opts: {
    date: string; ref?: string;
    lines: Array<{ cyl: 'A' | 'B'; qty: number; rate: number; gstRate?: number }>;
    freight?: number;
  }) => Promise<string>; // returns purchaseEntryId
  addCn: (opts: { date: string; number: string; allocations: Array<{ purchaseEntryId: string; amount: number }> }) => Promise<void>;
  deliver: (opts: { date: string; lines: Array<{ cyl: 'A' | 'B'; qty: number; salePerCyl: number }>; status?: 'delivered' | 'modified_delivered' | 'cancelled' }) => Promise<void>;
}

async function makeTenant(gstMode: 'live' | 'sandbox' | 'disabled' = 'disabled'): Promise<Tenant> {
  seq += 1;
  const distributorId = `${PREFIX}${seq}`;
  createdTenants.push(distributorId);
  await prisma.distributor.create({
    data: { id: distributorId, businessName: `COGS Test ${seq}`, legalName: `COGS Test ${seq}`, gstMode, isTestTenant: true },
  });
  const cylA = (await prisma.cylinderType.create({ data: { distributorId, typeName: '19 KG', capacity: 19 } })).id;
  const cylB = (await prisma.cylinderType.create({ data: { distributorId, typeName: '5 KG', capacity: 5 } })).id;
  const customerId = (await prisma.customer.create({ data: { distributorId, customerName: 'Test Cust', phone: '9999999999' } })).id;
  const sourceId = (await prisma.sourceDistributor.create({ data: { distributorId, name: 'IOCL Test' } })).id;
  const cylOf = (c: 'A' | 'B') => (c === 'A' ? cylA : cylB);
  let pn = 0, on = 0;

  const addLoad: Tenant['addLoad'] = async ({ date, ref, lines, freight }) => {
    pn += 1;
    const entry = await prisma.purchaseEntry.create({
      data: {
        purchaseNumber: `${distributorId}-PE-${pn}`,
        distributorId,
        sourceDistributorId: sourceId,
        purchaseDate: date,
        supplierDocumentNumber: ref ?? `LOAD-${pn}`,
        documentType: 'invoice',
        createdBy: 'test',
        items: { create: lines.map((l) => ({ cylinderTypeId: cylOf(l.cyl), fullsReceived: l.qty, unitPrice: l.rate, gstRate: l.gstRate ?? 0 })) },
        ...(freight ? { charges: { create: [{ chargeType: 'freight', amount: freight }] } } : {}),
      },
    });
    return entry.id;
  };

  const addCn: Tenant['addCn'] = async ({ date, number, allocations }) => {
    const total = allocations.reduce((s, a) => s + a.amount, 0);
    await prisma.purchaseCreditNote.create({
      data: {
        distributorId, sourceDistributorId: sourceId, creditNoteNumber: number,
        creditNoteDate: date, receivedDate: date, totalAmount: total, createdBy: 'test',
        allocations: { create: allocations.map((a) => ({ purchaseEntryId: a.purchaseEntryId, amount: a.amount })) },
      },
    });
  };

  const deliver: Tenant['deliver'] = async ({ date, lines, status }) => {
    on += 1;
    await prisma.order.create({
      data: {
        orderNumber: `${distributorId}-ORD-${on}`,
        distributorId, customerId,
        orderDate: new Date(date), deliveryDate: new Date(date),
        status: status ?? 'delivered',
        items: { create: lines.map((l) => ({ cylinderTypeId: cylOf(l.cyl), quantity: l.qty, deliveredQuantity: l.qty, unitPrice: l.salePerCyl, totalPrice: l.salePerCyl * l.qty })) },
      },
    });
  };

  return { distributorId, cylA, cylB, customerId, sourceId, addLoad, addCn, deliver };
}

afterAll(async () => {
  for (const d of createdTenants) {
    await prisma.purchaseCreditNoteAllocation.deleteMany({ where: { purchaseCreditNote: { distributorId: d } } });
    await prisma.purchaseCreditNote.deleteMany({ where: { distributorId: d } });
    await prisma.purchaseEntryCharge.deleteMany({ where: { purchaseEntry: { distributorId: d } } });
    await prisma.purchaseEntryItem.deleteMany({ where: { purchaseEntry: { distributorId: d } } });
    await prisma.purchaseEntry.deleteMany({ where: { distributorId: d } });
    await prisma.orderItem.deleteMany({ where: { order: { distributorId: d } } });
    await prisma.order.deleteMany({ where: { distributorId: d } });
    await prisma.sourceDistributor.deleteMany({ where: { distributorId: d } });
    await prisma.customer.deleteMany({ where: { distributorId: d } });
    await prisma.cylinderType.deleteMany({ where: { distributorId: d } });
    await prisma.distributor.deleteMany({ where: { id: d } });
  }
});

describe('FIFO COGS — the 31-Aug/1-Sep carryover scenario', () => {
  it('price DROPS on Sep 1: carried Aug stock is still costed at the OLD (higher) rate (FIFO oldest-first)', async () => {
    const t = await makeTenant('disabled');
    await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 200, rate: 2700 }] });
    await t.addLoad({ date: '2026-09-01', lines: [{ cyl: 'A', qty: 100, rate: 2550 }] });
    await t.deliver({ date: '2026-08-15', lines: [{ cyl: 'A', qty: 100, salePerCyl: 3000 }] });
    await t.deliver({ date: '2026-09-02', lines: [{ cyl: 'A', qty: 100, salePerCyl: 2800 }] });

    const r = await computeFifoCogs(t.distributorId);
    // Both deliveries draw from the Aug layer (200 @ 2700). The cheaper Sep
    // layer is NOT touched — FIFO consumes oldest first.
    expect(r.totals.qtyDelivered).toBe(200);
    expect(r.totals.cogs).toBe(540000); // 200 × 2700
    const sep = r.byMonth.find((m) => m.month === '2026-09')!;
    expect(sep.cogs).toBe(270000); // Sep sold old 2700 stock, not 2550
    expect(sep.margin).toBe(10000); // 280000 sale − 270000 cost = thin margin (the squeeze)

    // The Sep layer stays fully open in valuation.
    const v = await computeStockValuation(t.distributorId);
    const sepLayer = v.openLayers.find((l) => l.date === '2026-09-01')!;
    expect(sepLayer.qtyRemaining).toBe(100);
    expect(sepLayer.landedRate).toBe(2550);
  });

  it('price RISES on Sep 1: carried Aug stock still costed at the old (lower) rate', async () => {
    const t = await makeTenant('disabled');
    await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 200, rate: 2700 }] });
    await t.addLoad({ date: '2026-09-01', lines: [{ cyl: 'A', qty: 100, rate: 2850 }] });
    await t.deliver({ date: '2026-09-02', lines: [{ cyl: 'A', qty: 100, salePerCyl: 3100 }] });

    const r = await computeFifoCogs(t.distributorId);
    expect(r.totals.cogs).toBe(270000); // drew from the 2700 Aug layer, not 2850
  });
});

describe('FIFO mechanics', () => {
  it('draws across multiple layers when one is exhausted', async () => {
    const t = await makeTenant('disabled');
    await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 60, rate: 2000 }] });
    await t.addLoad({ date: '2026-08-05', lines: [{ cyl: 'A', qty: 60, rate: 2200 }] });
    await t.deliver({ date: '2026-08-10', lines: [{ cyl: 'A', qty: 100, salePerCyl: 3000 }] });

    const r = await computeFifoCogs(t.distributorId);
    // 60 @ 2000 + 40 @ 2200 = 120000 + 88000 = 208000
    expect(r.totals.cogs).toBe(208000);
    expect(r.consumptions[0].draws).toHaveLength(2);
  });

  it('ordering policy: a same-day load is available to a same-day delivery', async () => {
    const t = await makeTenant('disabled');
    await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 50, rate: 2000 }] });
    await t.deliver({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 50, salePerCyl: 3000 }] });
    const r = await computeFifoCogs(t.distributorId);
    expect(r.totals.cogs).toBe(100000); // 50 × 2000 — same-day receipt consumed
    expect(r.totals.uncostedQty).toBe(0);
  });
});

describe('Credit note lowers a specific batch', () => {
  it('a CN allocated to a load reduces THAT layer landed rate + COGS', async () => {
    const t = await makeTenant('disabled');
    const load = await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 100, rate: 1000 }] });
    await t.addCn({ date: '2026-08-05', number: 'CN-1', allocations: [{ purchaseEntryId: load, amount: 12500 }] });
    await t.deliver({ date: '2026-08-10', lines: [{ cyl: 'A', qty: 100, salePerCyl: 1500 }] });

    const layers = await buildCostLayers(t.distributorId);
    const layer = layers.get(t.cylA)![0];
    expect(layer.grossRate).toBe(1000);
    expect(layer.cnPerCyl).toBe(125); // 12500 / 100
    expect(layer.landedRate).toBe(875); // 1000 − 125

    const r = await computeFifoCogs(t.distributorId);
    expect(r.totals.cogs).toBe(87500); // 100 × 875, not 100000
  });

  it('value-based split: on a mixed-rate invoice the CN follows line VALUE, not cylinder count', async () => {
    const t = await makeTenant('disabled');
    // One invoice: 100 × A @ ₹1000 (value 100000) + 100 × B @ ₹200 (value 20000).
    // CN ₹12000. Value split → A absorbs 100000/120000 = 10000, B absorbs 2000.
    // (A count-based split would wrongly give each ₹6000.)
    const load = await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 100, rate: 1000 }, { cyl: 'B', qty: 100, rate: 200 }] });
    await t.addCn({ date: '2026-08-02', number: 'CN-2', allocations: [{ purchaseEntryId: load, amount: 12000 }] });

    const layers = await buildCostLayers(t.distributorId);
    const a = layers.get(t.cylA)![0];
    const b = layers.get(t.cylB)![0];
    expect(a.cnPerCyl).toBe(100); // 10000 / 100
    expect(b.cnPerCyl).toBe(20); // 2000 / 100
  });
});

describe('Backdating + cancellation + stockout (replay correctness)', () => {
  it('a backdated load inserted before existing deliveries re-costs them on next replay', async () => {
    const t = await makeTenant('disabled');
    await t.addLoad({ date: '2026-08-10', lines: [{ cyl: 'A', qty: 100, rate: 2000 }] });
    await t.deliver({ date: '2026-08-15', lines: [{ cyl: 'A', qty: 100, salePerCyl: 3000 }] });
    const before = await computeFifoCogs(t.distributorId);
    expect(before.totals.cogs).toBe(200000);

    // Backdated cheaper load dated BEFORE the delivery → FIFO now draws from it.
    await t.addLoad({ date: '2026-08-05', lines: [{ cyl: 'A', qty: 100, rate: 1500 }] });
    const after = await computeFifoCogs(t.distributorId);
    expect(after.totals.cogs).toBe(150000); // recomputed for free, no migration
  });

  it('a cancelled delivered order is excluded from consumption', async () => {
    const t = await makeTenant('disabled');
    await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 100, rate: 2000 }] });
    await t.deliver({ date: '2026-08-10', lines: [{ cyl: 'A', qty: 40, salePerCyl: 3000 }] });
    await t.deliver({ date: '2026-08-11', lines: [{ cyl: 'A', qty: 30, salePerCyl: 3000 }], status: 'cancelled' });

    const r = await computeFifoCogs(t.distributorId);
    expect(r.totals.qtyDelivered).toBe(40); // cancelled 30 not counted
    expect(r.totals.cogs).toBe(80000); // 40 × 2000
  });

  it('stockout: deliveries with no purchase layer are flagged uncosted, never silently zero', async () => {
    const t = await makeTenant('disabled');
    await t.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 30, rate: 2000 }] });
    await t.deliver({ date: '2026-08-10', lines: [{ cyl: 'A', qty: 50, salePerCyl: 3000 }] });
    const r = await computeFifoCogs(t.distributorId);
    expect(r.totals.cogs).toBe(60000); // only the 30 costed
    expect(r.totals.uncostedQty).toBe(20); // 20 with no layer
  });

  it('opening layers cost pre-purchase stock', async () => {
    const t = await makeTenant('disabled');
    await t.deliver({ date: '2026-08-10', lines: [{ cyl: 'A', qty: 40, salePerCyl: 3000 }] });
    const opening = [{ cylinderTypeId: t.cylA, date: '2026-01-01', ref: 'OPENING', qty: 100, ratePerCyl: 2100 }];
    const r = await computeFifoCogs(t.distributorId, { opening });
    expect(r.totals.cogs).toBe(84000); // 40 × 2100
    expect(r.totals.uncostedQty).toBe(0);
  });
});

describe('GST mode + tenant isolation', () => {
  it('GST tenant strips ITC from the landed rate; disabled tenant keeps it inclusive', async () => {
    const gst = await makeTenant('sandbox');
    await gst.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 100, rate: 1180, gstRate: 18 }] });
    const gstLayers = await buildCostLayers(gst.distributorId);
    expect(gstLayers.get(gst.cylA)![0].landedRate).toBe(1000); // 1180 / 1.18

    const noGst = await makeTenant('disabled');
    await noGst.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 100, rate: 1180, gstRate: 18 }] });
    const noGstLayers = await buildCostLayers(noGst.distributorId);
    expect(noGstLayers.get(noGst.cylA)![0].landedRate).toBe(1180); // tax is real cost
  });

  it('cross-tenant isolation: one tenant layers never feed another tenant deliveries', async () => {
    const t1 = await makeTenant('disabled');
    const t2 = await makeTenant('disabled');
    await t1.addLoad({ date: '2026-08-01', lines: [{ cyl: 'A', qty: 100, rate: 2000 }] });
    // t2 has a delivery but NO loads of its own.
    await t2.deliver({ date: '2026-08-10', lines: [{ cyl: 'A', qty: 50, salePerCyl: 3000 }] });

    const r2 = await computeFifoCogs(t2.distributorId);
    expect(r2.totals.cogs).toBe(0); // cannot borrow t1's layer
    expect(r2.totals.uncostedQty).toBe(50);
  });
});
