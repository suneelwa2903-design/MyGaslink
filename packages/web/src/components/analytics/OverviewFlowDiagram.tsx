/**
 * OV-6 — the Flow view for Analytics → Overview: two proportional flows sharing
 * one visual language (uniform boxes, soft depth, consistent type).
 *
 *   • Money P&L  — Revenue → Cost-of-gas + Gross margin → Expenses + Net.
 *                  Below it, an "aged as of today" outstanding bar (snapshot —
 *                  kept OUT of the P&L flow because cross-party cash isn't
 *                  conserved in a period).
 *   • Cylinders  — one loop: sources → Delivered → (customers) → Empties back
 *                  → returned / godown. Ribbon width = magnitude.
 *
 * Every value comes from the same `flow` payload the Overview cards use.
 */

export interface OverviewFlow {
  money: {
    purchaseReceived: number;
    paidToOmc: number;
    billed: number;
    collected: number;
    cogs: number;
    expenses: number;
    netProfit: number;
    dueOutstanding: number;
    overdueOutstanding: number;
    payableToOmc: number;
    aging: Array<{ label: string; amount: number; overdue: boolean }>;
  };
  cylinders: {
    fullsReceived: number;
    emptiesReturnedToOmc: number;
    fullsDelivered: number;
    emptiesCollected: number;
    netAddedToMarket: number;
    inMarket: number;
    bySku: Array<{ cylinderType: string; fromGodown: number; received: number; returnedToOmc: number; delivered: number; collected: number }>;
  };
}

// ── shared visual language ──────────────────────────────────────────────
const BOX_W = 188;
const BOX_H = 84;
const RADIUS = 16;

function inr(n: number): string {
  const neg = n < 0;
  const a = Math.abs(n);
  let s: string;
  if (a >= 1e7) s = `₹${(a / 1e7).toFixed(2)}Cr`;
  else if (a >= 1e5) s = `₹${(a / 1e5).toFixed(1)}L`;
  else if (a >= 1e3) s = `₹${(a / 1e3).toFixed(0)}K`;
  else s = `₹${Math.round(a)}`;
  return neg ? `−${s}` : s;
}

function ShadowDef({ id }: { id: string }) {
  return (
    <defs>
      <filter id={id} x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="3" stdDeviation="5" floodColor="#0f172a" floodOpacity="0.16" />
      </filter>
    </defs>
  );
}

function ribbon(x1: number, y1: number, x2: number, y2: number, w: number, cls: string) {
  const mid = (x1 + x2) / 2;
  return (
    <path
      d={`M${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
      fill="none"
      strokeWidth={Math.max(3, w)}
      className={cls}
      strokeOpacity={0.22}
      strokeLinecap="round"
    />
  );
}

/** A uniform flow box: bold label on top, big value below. */
function FlowBox({
  x, y, fill, label, value, shadow, onClick, w = BOX_W, h = BOX_H,
}: {
  x: number; y: number; fill: string; label: string; value: string;
  shadow: string; onClick?: () => void; w?: number; h?: number;
}) {
  return (
    <g className={onClick ? 'cursor-pointer' : undefined} onClick={onClick}>
      <rect x={x} y={y} width={w} height={h} rx={RADIUS} className={fill} filter={`url(#${shadow})`} />
      <text x={x + 18} y={y + h / 2 - 6} className="fill-white text-[12px] font-semibold" style={{ opacity: 0.92 }}>{label}</text>
      <text x={x + 18} y={y + h / 2 + 20} className="fill-white text-[19px] font-extrabold">{value}</text>
    </g>
  );
}

function MoneySankey({ m, onOpenReport }: { m: OverviewFlow['money']; onOpenReport: (s: string) => void }) {
  const revenue = m.billed;
  const cogs = m.cogs;
  const gross = revenue - cogs;
  const expenses = m.expenses;
  const net = m.netProfit;
  const loss = net < 0;
  const pct = (v: number) => (revenue > 0 ? Math.round((v / revenue) * 100) : 0);

  // proportional ribbon widths (share of the box they leave)
  const s1 = revenue > 0 ? BOX_H / revenue : 0;
  const cogsW = Math.max(4, cogs * s1);
  const grossW = Math.max(4, Math.max(0, gross) * s1);
  const s2 = gross > 0 ? BOX_H / gross : 0;
  const expW = gross > 0 ? Math.min(BOX_H, expenses * s2) : BOX_H;
  const netW = net > 0 && gross > 0 ? net * s2 : 0;

  // columns
  const c1 = 40, c2 = 398, c3 = 756;
  const revY = 150 - BOX_H / 2;          // centred
  const topY = 56, botY = 200;           // two-box columns
  const costCy = topY + BOX_H / 2;
  const grossCy = botY + BOX_H / 2;

  return (
    <svg viewBox="0 0 980 300" className="w-full min-w-[720px] h-auto" role="img" aria-label="Profit and loss flow">
      <ShadowDef id="mShadow" />
      {ribbon(c1 + BOX_W, revY + cogsW / 2, c2, costCy, cogsW, 'stroke-slate-400')}
      {ribbon(c1 + BOX_W, revY + cogsW + grossW / 2, c2, grossCy, grossW, 'stroke-teal-500')}
      {ribbon(c2 + BOX_W, botY + expW / 2, c3, topY + BOX_H / 2, expW, 'stroke-rose-400')}
      {netW > 0 && ribbon(c2 + BOX_W, botY + expW + netW / 2, c3, botY + BOX_H / 2, netW, 'stroke-emerald-500')}

      <FlowBox x={c1} y={revY} fill="fill-blue-500" shadow="mShadow" label="Revenue billed" value={inr(revenue)} onClick={() => onOpenReport('daily-sales')} />
      <FlowBox x={c2} y={topY} fill="fill-slate-500" shadow="mShadow" label="Cost of gas → Corporation" value={`${inr(cogs)} · ${pct(cogs)}%`} onClick={() => onOpenReport('corp-purchase-vs-sale-margin')} />
      <FlowBox x={c2} y={botY} fill="fill-teal-500" shadow="mShadow" label="Gross margin" value={`${inr(gross)} · ${pct(gross)}%`} />
      <FlowBox x={c3} y={topY} fill="fill-rose-500" shadow="mShadow" label="Running costs → out" value={`${inr(expenses)} · ${pct(expenses)}%`} onClick={() => onOpenReport('expense-register')} />
      <FlowBox x={c3} y={botY} fill={loss ? 'fill-rose-600' : 'fill-emerald-600'} shadow="mShadow" label={loss ? 'Net loss' : 'Net profit kept'} value={`${inr(net)} · ${pct(net)}%`} />
    </svg>
  );
}

// green (in credit) → deepening red as it ages
const AGING_COLORS = ['bg-emerald-600', 'bg-red-500', 'bg-red-600', 'bg-red-700', 'bg-red-900'];

function OutstandingBar({ m, onOpenReport }: { m: OverviewFlow['money']; onOpenReport: (s: string) => void }) {
  const total = m.aging.reduce((s, b) => s + b.amount, 0) || 1;
  const overdueTotal = m.aging.filter((b) => b.overdue).reduce((s, b) => s + b.amount, 0);
  return (
    <div className="mt-4 border-t border-surface-100 dark:border-surface-800 pt-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400">Customers still owe you · aged as of today</span>
        <span className="text-xs font-semibold text-surface-500 dark:text-surface-400">total {inr(total)} · {inr(overdueTotal)} overdue</span>
      </div>
      <div className="flex h-12 rounded-lg overflow-hidden ring-1 ring-surface-200 dark:ring-surface-700">
        {m.aging.map((b, i) => {
          const p = Math.round((b.amount / total) * 100);
          if (b.amount <= 0) return null;
          return (
            <div
              key={b.label}
              style={{ flexGrow: Math.max(1, b.amount) }}
              onClick={() => onOpenReport('outstanding-aging')}
              className={`${AGING_COLORS[i]} hover:brightness-110 transition flex flex-col items-center justify-center px-2 cursor-pointer min-w-[72px] text-center`}
              title={`${b.label}: ${inr(b.amount)} (${p}%)`}
            >
              <span className="text-white text-[10px] font-semibold leading-none opacity-95">{b.label}</span>
              <span className="text-white text-[12px] font-extrabold leading-tight mt-1 whitespace-nowrap">{inr(b.amount)} · {p}%</span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-[11px] text-surface-500 dark:text-surface-400 text-center">
        <span>Collected this period: <span className="font-bold text-surface-700 dark:text-surface-200">{inr(m.collected)}</span></span>
        <span>You owe the Corporation: <span className="font-bold text-surface-700 dark:text-surface-200">{inr(m.payableToOmc)}</span></span>
        <span className="text-surface-400 dark:text-surface-500">Green = within credit; redder = older. Aging is the current book, not this period.</span>
      </div>
    </div>
  );
}

function CylinderSankey({ c, onOpenReport }: { c: OverviewFlow['cylinders']; onOpenReport: (s: string) => void }) {
  const fromStock = Math.max(0, c.fullsDelivered - c.fullsReceived);
  const heldAtGodown = Math.max(0, c.emptiesCollected - c.emptiesReturnedToOmc);
  const stillWithCustomers = Math.max(0, c.fullsDelivered - c.emptiesCollected);

  // columns: sources | delivered | empties | destinations
  const c1 = 20, c2 = 268, c3 = 545, c4 = 792;
  const yc = 150;
  const dY = yc - BOX_H / 2;              // delivered / empties centred
  const topY = 56, botY = 200;           // stacked columns
  const recCy = topY + BOX_H / 2;
  const godCy = botY + BOX_H / 2;

  // proportional inflow/outflow ribbons
  const inTot = c.fullsReceived + fromStock;
  const si = inTot > 0 ? BOX_H / inTot : 0;
  const recW = Math.max(4, c.fullsReceived * si);
  const godW = Math.max(4, fromStock * si);
  const outTot = c.emptiesReturnedToOmc + heldAtGodown;
  const so = outTot > 0 ? BOX_H / outTot : 0;
  const retW = Math.max(4, c.emptiesReturnedToOmc * so);
  const heldW = Math.max(4, heldAtGodown * so);
  const turnW = c.fullsDelivered > 0 ? Math.max(6, (c.emptiesCollected / c.fullsDelivered) * BOX_H) : 6;

  return (
    <svg viewBox="0 0 980 300" className="w-full min-w-[900px] h-auto" role="img" aria-label="Cylinder loop from corporation through customers and back">
      <defs>
        <filter id="cShadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="3" stdDeviation="5" floodColor="#0f172a" floodOpacity="0.16" />
        </filter>
        <marker id="cyl-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" className="stroke-teal-600" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      {/* sources → delivered */}
      {ribbon(c1 + BOX_W, recCy, c2, dY + recW / 2, recW, 'stroke-sky-500')}
      {ribbon(c1 + BOX_W, godCy, c2, dY + recW + godW / 2, godW, 'stroke-slate-400')}
      {/* delivered → (customers) → empties back */}
      {ribbon(c2 + BOX_W, yc, c3, yc, turnW, 'stroke-teal-500')}
      <line x1={c2 + BOX_W + 12} y1={yc} x2={c3 - 4} y2={yc} className="stroke-teal-600" strokeWidth={2.5} markerEnd="url(#cyl-arrow)" />
      <text x={(c2 + BOX_W + c3) / 2} y={yc - BOX_H / 2 - 8} textAnchor="middle" className="fill-surface-500 dark:fill-surface-400 text-[11px] font-semibold">used &amp; returned</text>
      <text x={(c2 + BOX_W + c3) / 2} y={yc + BOX_H / 2 + 22} textAnchor="middle" className="fill-amber-600 dark:fill-amber-400 text-[11px] font-bold">{stillWithCustomers} still with customers</text>
      {/* empties → returned / godown */}
      {ribbon(c3 + BOX_W, yc - BOX_H / 2 + retW / 2, c4, recCy, retW, 'stroke-sky-500')}
      {ribbon(c3 + BOX_W, yc - BOX_H / 2 + retW + heldW / 2, c4, godCy, heldW, 'stroke-amber-500')}

      <FlowBox x={c1} y={topY} fill="fill-sky-500" shadow="cShadow" label="Received from Corporation" value={String(c.fullsReceived)} onClick={() => onOpenReport('inventory-movement')} />
      <FlowBox x={c1} y={botY} fill="fill-slate-500" shadow="cShadow" label="Drawn from godown" value={String(fromStock)} />
      <FlowBox x={c2} y={dY} fill="fill-teal-500" shadow="cShadow" label="Delivered to customers" value={`${c.fullsDelivered} fulls`} onClick={() => onOpenReport('inventory-movement')} />
      <FlowBox x={c3} y={dY} fill="fill-emerald-600" shadow="cShadow" label="Empties back" value={String(c.emptiesCollected)} onClick={() => onOpenReport('cylinder-rotation')} />
      <FlowBox x={c4} y={topY} fill="fill-sky-500" shadow="cShadow" label="Returned to Corporation" value={String(c.emptiesReturnedToOmc)} onClick={() => onOpenReport('inventory-movement')} />
      <FlowBox x={c4} y={botY} fill="fill-amber-500" shadow="cShadow" label="Available at godown" value={String(heldAtGodown)} />
    </svg>
  );
}

export interface CashflowData {
  cashIn: number;
  depositsReceived: number;
  collectionsAgainstSales: number;
  paidToCorporation: number;
  loadPayments: number;
  depositsPaid: number;
  omcUnallocated: number;
  expenses: number;
  netCashMovement: number;
}

/** Cashflow lens — literal cash in vs cash out this period (conserves:
 *  cash in = paid-to-corp + expenses + net). Distinct from P&L: deposits
 *  and gross OMC payments appear here because real cash moved. */
export function OverviewCashflowView({ cf, onOpenReport }: { cf: CashflowData; onOpenReport: (s: string) => void }) {
  const cashIn = cf.cashIn;
  const net = cf.netCashMovement;
  const loss = net < 0;
  const s = cashIn > 0 ? BOX_H / cashIn : 0;
  // left ribbons (sources → cash in)
  const collW = Math.max(4, cf.collectionsAgainstSales * s);
  const depW = Math.max(4, cf.depositsReceived * s);
  // right ribbons (cash in → sinks)
  const omcW = Math.max(3, cf.paidToCorporation * s);
  const expW = Math.max(3, cf.expenses * s);
  const netW = net > 0 ? net * s : 0;

  const c1 = 30, c2 = 396, c3 = 762;
  const inY = 150 - BOX_H / 2;             // cash-in box centred
  const srcTopY = 92, srcBotY = 92 + BOX_H + 24;   // two source boxes
  const sinkTopY = 30, sinkMidY = 130, sinkBotY = 230; // three sink boxes

  return (
    <div className="card p-5">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-xs font-bold uppercase tracking-widest text-violet-500">Cashflow</span>
        <h3 className="text-base font-bold text-surface-900 dark:text-white">Did the bank actually grow?</h3>
        <span className="ml-auto text-xs text-surface-400 dark:text-surface-500">this period</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox="0 0 980 330" className="w-full min-w-[760px] h-auto" role="img" aria-label="Cash in versus cash out this period">
          <ShadowDef id="cfShadow" />
          {/* sources → cash in */}
          {ribbon(c1 + BOX_W, srcTopY + BOX_H / 2, c2, 150 - collW / 2, collW, 'stroke-emerald-500')}
          {ribbon(c1 + BOX_W, srcBotY + BOX_H / 2, c2, 150 + depW / 2, depW, 'stroke-sky-400')}
          {/* cash in → sinks */}
          {omcW > 0 && ribbon(c2 + BOX_W, 150 - BOX_H / 2 + omcW / 2, c3, sinkTopY + BOX_H / 2, omcW, 'stroke-slate-400')}
          {ribbon(c2 + BOX_W, 150 - BOX_H / 2 + omcW + expW / 2, c3, sinkMidY + BOX_H / 2, expW, 'stroke-rose-400')}
          {netW > 0 && ribbon(c2 + BOX_W, 150 + BOX_H / 2 - netW / 2, c3, sinkBotY + BOX_H / 2, netW, 'stroke-emerald-500')}

          <FlowBox x={c1} y={srcTopY} fill="fill-emerald-500" shadow="cfShadow" label="Collections (sales)" value={inr(cf.collectionsAgainstSales)} onClick={() => onOpenReport('payment-collections')} />
          <FlowBox x={c1} y={srcBotY} fill="fill-sky-500" shadow="cfShadow" label="Deposits received (refundable)" value={inr(cf.depositsReceived)} />
          <FlowBox x={c2} y={inY} fill="fill-blue-600" shadow="cfShadow" label="Cash in" value={inr(cashIn)} />
          <FlowBox x={c3} y={sinkTopY} fill="fill-slate-500" shadow="cfShadow" label="Paid to Corporation" value={inr(cf.paidToCorporation)} onClick={() => onOpenReport('corp-supplier-payment-aging')} />
          <FlowBox x={c3} y={sinkMidY} fill="fill-rose-500" shadow="cfShadow" label="Expenses paid" value={inr(cf.expenses)} onClick={() => onOpenReport('expense-register')} />
          <FlowBox x={c3} y={sinkBotY} fill={loss ? 'fill-rose-600' : 'fill-emerald-600'} shadow="cfShadow" label={loss ? 'Net cash drop' : 'Net cash kept'} value={inr(net)} />
        </svg>
      </div>
      <p className="mt-1 text-[11px] text-surface-400 dark:text-surface-500 leading-snug">
        Literal cash this period. Deposits are refundable (a liability, not profit) — they lift cash but never P&L. Paid to Corporation = loads {inr(cf.loadPayments)} + deposits {inr(cf.depositsPaid)}{cf.omcUnallocated > 0 ? ` + unallocated ${inr(cf.omcUnallocated)}` : ''}.
      </p>
    </div>
  );
}

export function OverviewFlowDiagram({
  flow,
  onOpenReport,
}: {
  flow: OverviewFlow;
  onOpenReport: (slug: string) => void;
}) {
  const sku = flow.cylinders.bySku;
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-baseline gap-3 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-brand-500">Money</span>
          <h3 className="text-base font-bold text-surface-900 dark:text-white">Where every rupee of revenue goes</h3>
          <span className="ml-auto text-xs text-surface-400 dark:text-surface-500">this period</span>
        </div>
        <div className="overflow-x-auto">
          <MoneySankey m={flow.money} onOpenReport={onOpenReport} />
        </div>
        <OutstandingBar m={flow.money} onOpenReport={onOpenReport} />
      </div>

      <div className="card p-5">
        <div className="flex items-baseline gap-3 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-sky-500">Cylinders</span>
          <h3 className="text-base font-bold text-surface-900 dark:text-white">Where your cylinders go</h3>
          <span className="ml-auto text-xs text-surface-400 dark:text-surface-500">this period</span>
        </div>
        <div className="overflow-x-auto">
          <CylinderSankey c={flow.cylinders} onOpenReport={onOpenReport} />
        </div>

        {sku.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-surface-400 dark:text-surface-500 border-b border-surface-200 dark:border-surface-700">
                  <th className="py-1.5 pr-3 font-semibold">Cylinder</th>
                  <th className="py-1.5 px-3 font-semibold text-right">Received</th>
                  <th className="py-1.5 px-3 font-semibold text-right">From godown</th>
                  <th className="py-1.5 px-3 font-semibold text-right">Delivered</th>
                  <th className="py-1.5 px-3 font-semibold text-right">Empties back</th>
                  <th className="py-1.5 pl-3 font-semibold text-right">Returned to Corp.</th>
                </tr>
              </thead>
              <tbody>
                {sku.map((r) => (
                  <tr key={r.cylinderType} className="border-b border-surface-100 dark:border-surface-800 last:border-0">
                    <td className="py-1.5 pr-3 font-medium text-surface-700 dark:text-surface-200">{r.cylinderType}</td>
                    <td className="py-1.5 px-3 text-right text-surface-600 dark:text-surface-300">{r.received}</td>
                    <td className="py-1.5 px-3 text-right text-surface-600 dark:text-surface-300">{r.fromGodown}</td>
                    <td className="py-1.5 px-3 text-right text-surface-600 dark:text-surface-300">{r.delivered}</td>
                    <td className="py-1.5 px-3 text-right text-surface-600 dark:text-surface-300">{r.collected}</td>
                    <td className="py-1.5 pl-3 text-right text-surface-600 dark:text-surface-300">{r.returnedToOmc}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold text-surface-800 dark:text-surface-100">
                  <td className="py-1.5 pr-3">Total</td>
                  <td className="py-1.5 px-3 text-right">{sku.reduce((s, r) => s + r.received, 0)}</td>
                  <td className="py-1.5 px-3 text-right">{sku.reduce((s, r) => s + r.fromGodown, 0)}</td>
                  <td className="py-1.5 px-3 text-right">{sku.reduce((s, r) => s + r.delivered, 0)}</td>
                  <td className="py-1.5 px-3 text-right">{sku.reduce((s, r) => s + r.collected, 0)}</td>
                  <td className="py-1.5 pl-3 text-right">{sku.reduce((s, r) => s + r.returnedToOmc, 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
