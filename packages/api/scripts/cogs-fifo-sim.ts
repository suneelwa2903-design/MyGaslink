/**
 * READ-ONLY simulation — compares current blended-average COGS vs a prototype
 * FIFO cost-layer COGS on real distributor data. Writes NOTHING. Prototype
 * only, for the pre-build numbers preview (docs/COST-LAYER-COGS-DESIGN.md §5).
 *
 * Run: pnpm --filter @gaslink/api exec tsx scripts/cogs-fifo-sim.ts [distributorId]
 */
import { prisma } from '../src/lib/prisma.js';

const DIST = process.argv[2] || 'dist-vijaya';

const n = (v: unknown) => (v == null ? 0 : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const inr = (v: number) => '₹' + r2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthKey = (d: string) => d.slice(0, 7);

interface Layer { date: string; ref: string; cylTypeId: string; qtyRemaining: number; ratePerCyl: number; grossRate: number; cnPerCyl: number; }

async function main() {
  const dist = await prisma.distributor.findUnique({ where: { id: DIST }, select: { businessName: true, gstMode: true } });
  if (!dist) { console.log(`No distributor ${DIST}`); return; }
  const excludeGst = dist.gstMode === 'live' || dist.gstMode === 'sandbox';
  console.log(`\n=== COGS SIMULATION — ${dist.businessName} (${DIST}) · gstMode=${dist.gstMode} · ITC-strip=${excludeGst} ===\n`);

  const cylTypes = await prisma.cylinderType.findMany({ where: { distributorId: DIST }, select: { id: true, typeName: true } });
  const typeName = new Map(cylTypes.map((c) => [c.id, c.typeName]));

  // ── Build cost layers from purchase invoices (mirror landedCostService rate math) ──
  const entries = await prisma.purchaseEntry.findMany({
    where: { distributorId: DIST, deletedAt: null, documentType: 'invoice' },
    select: {
      purchaseDate: true, purchaseNumber: true, supplierDocumentNumber: true,
      items: { select: { cylinderTypeId: true, fullsReceived: true, unitPrice: true, gstRate: true } },
      charges: { select: { chargeType: true, amount: true } },
      cnAllocations: { where: { purchaseCreditNote: { deletedAt: null } }, select: { amount: true } },
      dnAllocations: { where: { purchaseDebitNote: { deletedAt: null } }, select: { amount: true } },
    },
  });

  const layersByType = new Map<string, Layer[]>();
  for (const e of entries) {
    const totalCyls = e.items.reduce((s, it) => s + it.fullsReceived, 0);
    if (totalCyls === 0) continue;
    const freight = e.charges.filter((c) => c.chargeType === 'freight').reduce((s, c) => s + n(c.amount), 0);
    const cn = e.cnAllocations.reduce((s, a) => s + n(a.amount), 0);
    const dn = e.dnAllocations.reduce((s, a) => s + n(a.amount), 0);
    for (const it of e.items) {
      if (it.fullsReceived === 0) continue;
      const gstRate = n(it.gstRate);
      const gross = n(it.unitPrice) * it.fullsReceived;
      const line = excludeGst && gstRate > 0 ? gross / (1 + gstRate / 100) : gross;
      const ratio = it.fullsReceived / totalCyls;
      const cnShare = cn * ratio, dnShare = dn * ratio, frShare = freight * ratio;
      const landedTotal = line + frShare + dnShare - cnShare;
      const list = layersByType.get(it.cylinderTypeId) ?? [];
      list.push({
        date: e.purchaseDate, ref: e.supplierDocumentNumber || e.purchaseNumber, cylTypeId: it.cylinderTypeId,
        qtyRemaining: it.fullsReceived, ratePerCyl: r2(landedTotal / it.fullsReceived),
        grossRate: r2((excludeGst && gstRate > 0 ? line : gross) / it.fullsReceived),
        cnPerCyl: r2(cnShare / it.fullsReceived),
      });
      layersByType.set(it.cylinderTypeId, list);
    }
  }
  // FIFO order: purchaseDate then ref
  for (const list of layersByType.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));

  // ── Deliveries (the consumption set): delivered/modified_delivered orders ──
  const orders = await prisma.order.findMany({
    where: { distributorId: DIST, status: { in: ['delivered', 'modified_delivered'] } },
    select: { deliveryDate: true, orderNumber: true, items: { select: { cylinderTypeId: true, deliveredQuantity: true, quantity: true, totalPrice: true } } },
  });
  // Flatten to per-(date,type) consumption, ordered by deliveryDate then orderNumber
  interface Cons { date: string; ord: string; cylTypeId: string; qty: number; saleValue: number; }
  const cons: Cons[] = [];
  for (const o of orders) {
    const d = o.deliveryDate ? new Date(o.deliveryDate).toISOString().slice(0, 10) : '';
    for (const it of o.items) {
      const q = it.deliveredQuantity ?? it.quantity;
      if (q > 0) cons.push({ date: d, ord: o.orderNumber, cylTypeId: it.cylinderTypeId, qty: q, saleValue: n(it.totalPrice) });
    }
  }
  cons.sort((a, b) => a.date.localeCompare(b.date) || a.ord.localeCompare(b.ord));

  // ── FIFO consume ──
  const cursor = new Map<string, number>(); // cylTypeId -> index into its layer list
  let fifoCogsTotal = 0, saleTotal = 0, deliveredTotal = 0, stockoutQty = 0;
  const fifoByMonth = new Map<string, { cogs: number; sale: number; qty: number }>();
  for (const c of cons) {
    saleTotal += c.saleValue; deliveredTotal += c.qty;
    const mk = monthKey(c.date);
    const mb = fifoByMonth.get(mk) ?? { cogs: 0, sale: 0, qty: 0 };
    mb.sale += c.saleValue; mb.qty += c.qty;
    let need = c.qty;
    const layers = layersByType.get(c.cylTypeId) ?? [];
    let idx = cursor.get(c.cylTypeId) ?? 0;
    let lineCogs = 0;
    while (need > 0 && idx < layers.length) {
      const L = layers[idx];
      // Ordering policy: a same-day receipt is available to a same-day delivery
      if (L.date > c.date) break; // future layer — not yet received
      if (L.qtyRemaining <= 0) { idx++; continue; }
      const take = Math.min(need, L.qtyRemaining);
      lineCogs += take * L.ratePerCyl;
      L.qtyRemaining -= take; need -= take;
      if (L.qtyRemaining === 0) idx++;
    }
    cursor.set(c.cylTypeId, idx);
    if (need > 0) { stockoutQty += need; } // uncosted — user must enter opening/rate
    mb.cogs += lineCogs; fifoCogsTotal += lineCogs;
    fifoByMonth.set(mk, mb);
  }

  // ── Current blended method (trailing-30d-from-today avg × delivered) ──
  // Reproduce computeAverageLandedCost over ALL invoice layers (whole history proxy
  // since Vijaya is <30d old this equals the trailing window).
  let allLandedTotal = 0, allCyls = 0;
  for (const list of layersByType.values()) for (const L of list) { /* pre-consume snapshot */ }
  for (const e of entries) {
    const totalCyls = e.items.reduce((s, it) => s + it.fullsReceived, 0);
    if (!totalCyls) continue;
    const freight = e.charges.filter((c) => c.chargeType === 'freight').reduce((s, c) => s + n(c.amount), 0);
    const cn = e.cnAllocations.reduce((s, a) => s + n(a.amount), 0);
    const dn = e.dnAllocations.reduce((s, a) => s + n(a.amount), 0);
    for (const it of e.items) {
      if (!it.fullsReceived) continue;
      const gstRate = n(it.gstRate);
      const gross = n(it.unitPrice) * it.fullsReceived;
      const line = excludeGst && gstRate > 0 ? gross / (1 + gstRate / 100) : gross;
      const ratio = it.fullsReceived / totalCyls;
      allLandedTotal += line + freight * ratio + dn * ratio - cn * ratio;
      allCyls += it.fullsReceived;
    }
  }
  const blendedAvg = allCyls > 0 ? allLandedTotal / allCyls : 0;
  const blendedCogs = deliveredTotal * blendedAvg;

  // ── Report ──
  console.log('LAYERS (loads) per cylinder type — FIFO order, with CN impact:');
  for (const [ctId, list] of layersByType) {
    console.log(`\n  ${typeName.get(ctId) ?? ctId}:`);
    for (const L of list) {
      const cnNote = L.cnPerCyl > 0 ? `  (gross ${inr(L.grossRate)} − CN ${inr(L.cnPerCyl)} = ${inr(L.ratePerCyl)})` : '';
      console.log(`    ${L.date} ${L.ref.padEnd(16)} landed ${inr(L.ratePerCyl)}/cyl${cnNote}`);
    }
  }

  console.log('\n\nPER-MONTH COMPARISON (FIFO):');
  console.log('  month     delivered   FIFO COGS        sale value      margin      margin%');
  for (const [mk, mb] of [...fifoByMonth].sort()) {
    const marg = mb.sale - mb.cogs; const pct = mb.sale > 0 ? (marg / mb.sale) * 100 : 0;
    console.log(`  ${mk}   ${String(mb.qty).padStart(6)}   ${inr(mb.cogs).padStart(15)}   ${inr(mb.sale).padStart(15)}   ${inr(marg).padStart(12)}   ${pct.toFixed(1)}%`);
  }

  const fifoMargin = saleTotal - fifoCogsTotal;
  const blendedMargin = saleTotal - blendedCogs;
  console.log('\n\nHEADLINE — FIFO vs current blended-average:');
  console.log(`  Fulls delivered (consumption set):  ${deliveredTotal}`);
  console.log(`  Sale value of delivered fulls:      ${inr(saleTotal)}`);
  console.log(`  ─`);
  console.log(`  CURRENT  blended avg ${inr(blendedAvg)}/cyl → COGS ${inr(blendedCogs)}  → margin ${inr(blendedMargin)}  (${saleTotal>0?((blendedMargin/saleTotal)*100).toFixed(1):0}%)`);
  console.log(`  FIFO     layer-matched            → COGS ${inr(fifoCogsTotal)}  → margin ${inr(fifoMargin)}  (${saleTotal>0?((fifoMargin/saleTotal)*100).toFixed(1):0}%)`);
  console.log(`  ─`);
  console.log(`  DELTA (FIFO − blended): COGS ${inr(fifoCogsTotal - blendedCogs)}   margin ${inr(fifoMargin - blendedMargin)}`);
  if (stockoutQty > 0) console.log(`\n  ⚠️  ${stockoutQty} delivered cyls had NO purchase layer to draw from (uncosted — would need an opening layer / rate entered per your process).`);
  console.log('');

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
