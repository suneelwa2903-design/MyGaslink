/**
 * OV-6 — the Flow view for Analytics → Overview: two proportional flows sharing
 * one visual language (uniform boxes, soft gradient depth, consistent type).
 *
 *   • Money P&L  — Revenue → Cost-of-gas + Gross margin → Expenses + Net.
 *   • Cylinders  — one loop: sources → Delivered → (customers) → Empties back.
 *   • Cashflow   — literal cash in vs out, conserved: a balancing node
 *                  (Net kept when positive, Drawn-from-reserves when negative)
 *                  keeps sources == sinks so ribbons never overflow.
 *
 * Every value comes from the same `flow`/`cashflow` payload the cards use.
 * Visual skin (2026-08-15): soft desaturated vertical gradients + hue-matched
 * low-opacity ribbons + wrapped labels; replaces the flat saturated fills.
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

// Soft, desaturated vertical gradients (top lighter → bottom deeper).
const HUES: Record<string, [string, string]> = {
  blue: ['#6ea0e8', '#4d7ccd'],
  slate: ['#94a1b2', '#6f7d8e'],
  teal: ['#4fb5ad', '#349a92'],
  emerald: ['#56bd93', '#369b73'],
  rose: ['#e28a93', '#cf6a76'],
  sky: ['#6fb7e2', '#4f9bce'],
  amber: ['#e3b568', '#cc9646'],
};
const STROKE: Record<string, string> = {
  blue: 'stroke-blue-400', slate: 'stroke-slate-400', teal: 'stroke-teal-400',
  emerald: 'stroke-emerald-400', rose: 'stroke-rose-400', sky: 'stroke-sky-400', amber: 'stroke-amber-400',
};

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

/** Word-wrap a box label to at most 2 lines of ~ maxChars each. */
function wrapLabel(label: string, maxChars = 20): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length <= 2) return lines;
  // collapse overflow into the 2nd line
  return [lines[0], lines.slice(1).join(' ')];
}

function FlowDefs({ shadow }: { shadow: string }) {
  return (
    <defs>
      {Object.entries(HUES).map(([k, [a, b]]) => (
        <linearGradient key={k} id={`g-${k}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
      ))}
      <filter id={shadow} x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#0f172a" floodOpacity="0.12" />
      </filter>
    </defs>
  );
}

function ribbon(x1: number, y1: number, x2: number, y2: number, w: number, hue: string) {
  const mid = (x1 + x2) / 2;
  return (
    <path
      d={`M${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
      fill="none"
      strokeWidth={Math.max(3, Math.min(BOX_H, w))}
      className={STROKE[hue] ?? 'stroke-slate-400'}
      strokeOpacity={0.26}
      strokeLinecap="round"
    />
  );
}

/** A uniform flow box: wrapped label on top, big value on the bottom. */
function FlowBox({
  x, y, hue, label, value, shadow, onClick, w = BOX_W, h = BOX_H,
}: {
  x: number; y: number; hue: string; label: string; value: string;
  shadow: string; onClick?: () => void; w?: number; h?: number;
}) {
  const lines = wrapLabel(label);
  const valY = y + h - 16;
  return (
    <g className={onClick ? 'cursor-pointer' : undefined} onClick={onClick}>
      <rect x={x} y={y} width={w} height={h} rx={RADIUS} fill={`url(#g-${hue})`} filter={`url(#${shadow})`} />
      {lines.map((ln, i) => (
        <text
          key={i}
          x={x + 18}
          y={valY - 22 - (lines.length - 1 - i) * 15}
          className="fill-white text-[12px] font-semibold"
          style={{ opacity: 0.94 }}
        >
          {ln}
        </text>
      ))}
      <text x={x + 18} y={valY} className="fill-white text-[19px] font-extrabold">{value}</text>
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

  // proportional ribbon widths (share of the box they leave), capped at box height
  const s1 = revenue > 0 ? BOX_H / revenue : 0;
  const cogsW = Math.max(4, Math.min(BOX_H, cogs * s1));
  const grossW = Math.max(4, Math.min(BOX_H, Math.max(0, gross) * s1));
  const s2 = gross > 0 ? BOX_H / gross : 0;
  const expW = gross > 0 ? Math.min(BOX_H, expenses * s2) : BOX_H;
  const netW = net > 0 && gross > 0 ? Math.min(BOX_H, net * s2) : 0;

  const c1 = 40, c2 = 398, c3 = 756;
  const revY = 150 - BOX_H / 2;
  const topY = 56, botY = 200;
  const costCy = topY + BOX_H / 2;
  const grossCy = botY + BOX_H / 2;

  return (
    <svg viewBox="0 0 980 300" className="w-full min-w-[720px] h-auto" role="img" aria-label="Profit and loss flow">
      <FlowDefs shadow="mShadow" />
      {ribbon(c1 + BOX_W, revY + cogsW / 2, c2, costCy, cogsW, 'slate')}
      {ribbon(c1 + BOX_W, revY + cogsW + grossW / 2, c2, grossCy, grossW, 'teal')}
      {ribbon(c2 + BOX_W, botY + expW / 2, c3, topY + BOX_H / 2, expW, 'rose')}
      {netW > 0 && ribbon(c2 + BOX_W, botY + expW + netW / 2, c3, botY + BOX_H / 2, netW, 'emerald')}

      <FlowBox x={c1} y={revY} hue="blue" shadow="mShadow" label="Revenue billed" value={inr(revenue)} onClick={() => onOpenReport('daily-sales')} />
      <FlowBox x={c2} y={topY} hue="slate" shadow="mShadow" label="Cost of gas → Corporation" value={`${inr(cogs)} · ${pct(cogs)}%`} onClick={() => onOpenReport('corp-purchase-vs-sale-margin')} />
      <FlowBox x={c2} y={botY} hue="teal" shadow="mShadow" label="Gross margin" value={`${inr(gross)} · ${pct(gross)}%`} />
      <FlowBox x={c3} y={topY} hue="rose" shadow="mShadow" label="Running costs → out" value={`${inr(expenses)} · ${pct(expenses)}%`} onClick={() => onOpenReport('expense-register')} />
      <FlowBox x={c3} y={botY} hue={loss ? 'rose' : 'emerald'} shadow="mShadow" label={loss ? 'Net loss' : 'Net profit kept'} value={`${inr(net)} · ${pct(net)}%`} />
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

  const c1 = 20, c2 = 268, c3 = 545, c4 = 792;
  const yc = 150;
  const dY = yc - BOX_H / 2;
  const topY = 56, botY = 200;
  const recCy = topY + BOX_H / 2;
  const godCy = botY + BOX_H / 2;

  const inTot = c.fullsReceived + fromStock;
  const si = inTot > 0 ? BOX_H / inTot : 0;
  const recW = Math.max(4, Math.min(BOX_H, c.fullsReceived * si));
  const godW = Math.max(4, Math.min(BOX_H, fromStock * si));
  const outTot = c.emptiesReturnedToOmc + heldAtGodown;
  const so = outTot > 0 ? BOX_H / outTot : 0;
  const retW = Math.max(4, Math.min(BOX_H, c.emptiesReturnedToOmc * so));
  const heldW = Math.max(4, Math.min(BOX_H, heldAtGodown * so));
  const turnW = c.fullsDelivered > 0 ? Math.max(6, Math.min(BOX_H, (c.emptiesCollected / c.fullsDelivered) * BOX_H)) : 6;

  return (
    <svg viewBox="0 0 980 300" className="w-full min-w-[900px] h-auto" role="img" aria-label="Cylinder loop from corporation through customers and back">
      <FlowDefs shadow="cShadow" />
      <defs>
        <marker id="cyl-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" className="stroke-teal-600" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      {/* sources → delivered */}
      {ribbon(c1 + BOX_W, recCy, c2, dY + recW / 2, recW, 'sky')}
      {ribbon(c1 + BOX_W, godCy, c2, dY + recW + godW / 2, godW, 'slate')}
      {/* delivered → (customers) → empties back */}
      {ribbon(c2 + BOX_W, yc, c3, yc, turnW, 'teal')}
      <line x1={c2 + BOX_W + 12} y1={yc} x2={c3 - 4} y2={yc} className="stroke-teal-600" strokeWidth={2.5} markerEnd="url(#cyl-arrow)" />
      <text x={(c2 + BOX_W + c3) / 2} y={yc - BOX_H / 2 - 8} textAnchor="middle" className="fill-surface-500 dark:fill-surface-400 text-[11px] font-semibold">used &amp; returned</text>
      <text x={(c2 + BOX_W + c3) / 2} y={yc + BOX_H / 2 + 22} textAnchor="middle" className="fill-amber-600 dark:fill-amber-400 text-[11px] font-bold">{stillWithCustomers} still with customers</text>
      {/* empties → returned / godown */}
      {ribbon(c3 + BOX_W, yc - BOX_H / 2 + retW / 2, c4, recCy, retW, 'sky')}
      {ribbon(c3 + BOX_W, yc - BOX_H / 2 + retW + heldW / 2, c4, godCy, heldW, 'amber')}

      <FlowBox x={c1} y={topY} hue="sky" shadow="cShadow" label="Received from Corporation" value={String(c.fullsReceived)} onClick={() => onOpenReport('inventory-movement')} />
      <FlowBox x={c1} y={botY} hue="slate" shadow="cShadow" label="Drawn from godown" value={String(fromStock)} />
      <FlowBox x={c2} y={dY} hue="teal" shadow="cShadow" label="Delivered to customers" value={`${c.fullsDelivered} fulls`} onClick={() => onOpenReport('inventory-movement')} />
      <FlowBox x={c3} y={dY} hue="emerald" shadow="cShadow" label="Empties back" value={String(c.emptiesCollected)} onClick={() => onOpenReport('cylinder-rotation')} />
      <FlowBox x={c4} y={topY} hue="sky" shadow="cShadow" label="Returned to Corporation" value={String(c.emptiesReturnedToOmc)} onClick={() => onOpenReport('inventory-movement')} />
      <FlowBox x={c4} y={botY} hue="amber" shadow="cShadow" label="Available at godown" value={String(heldAtGodown)} />
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

/** Evenly stack `count` boxes vertically, centred on 165 (viewBox 330). */
function stackY(count: number, i: number): number {
  const top = 14, bottom = 316;
  const span = bottom - top;
  const gap = count > 1 ? (span - count * BOX_H) / (count - 1) : 0;
  return count === 1 ? 165 - BOX_H / 2 : top + i * (BOX_H + Math.max(0, gap));
}

interface FlowNode { label: string; value: number; hue: string; onClick?: () => void }

/** Cashflow lens — literal cash in vs out this period, CONSERVED so ribbons
 *  never overflow: a balancing node (Net kept if positive, Drawn-from-reserves
 *  if the bank shrank) keeps total sources == total sinks. */
export function OverviewCashflowView({ cf, onOpenReport }: { cf: CashflowData; onOpenReport: (s: string) => void }) {
  const net = cf.netCashMovement;
  const drop = net < 0;

  const sources: FlowNode[] = [
    { label: 'Collections (sales)', value: cf.collectionsAgainstSales, hue: 'emerald', onClick: () => onOpenReport('payment-collections') },
    { label: 'Deposits received (refundable)', value: cf.depositsReceived, hue: 'sky' },
    ...(drop ? [{ label: 'Net cash drop (from reserves)', value: Math.abs(net), hue: 'rose' } as FlowNode] : []),
  ].filter((n) => n.value > 0);

  const sinks: FlowNode[] = [
    { label: 'Paid to Corporation', value: cf.paidToCorporation, hue: 'slate', onClick: () => onOpenReport('corp-supplier-payment-aging') },
    { label: 'Expenses paid', value: cf.expenses, hue: 'rose', onClick: () => onOpenReport('expense-register') },
    ...(!drop ? [{ label: 'Net cash kept', value: net, hue: 'emerald' } as FlowNode] : []),
  ].filter((n) => n.value > 0);

  const grand = sources.reduce((s, n) => s + n.value, 0) || 1;
  const scale = BOX_H / grand;

  const c1 = 30, c2 = 396, c3 = 762;
  const cashY = 165 - BOX_H / 2;

  // stack ribbons on the cash box edges so they fill exactly one box height
  let accL = 0;
  const srcRibbons = sources.map((n, i) => {
    const w = Math.min(BOX_H, n.value * scale);
    const el = ribbon(c1 + BOX_W, stackY(sources.length, i) + BOX_H / 2, c2, cashY + accL + w / 2, w, n.hue);
    accL += w;
    return el;
  });
  let accR = 0;
  const sinkRibbons = sinks.map((n, i) => {
    const w = Math.min(BOX_H, n.value * scale);
    const el = ribbon(c2 + BOX_W, cashY + accR + w / 2, c3, stackY(sinks.length, i) + BOX_H / 2, w, n.hue);
    accR += w;
    return el;
  });

  return (
    <div className="card p-5">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-xs font-bold uppercase tracking-widest text-violet-500">Cashflow</span>
        <h3 className="text-base font-bold text-surface-900 dark:text-white">Did the bank actually grow?</h3>
        <span className={`ml-auto text-sm font-extrabold ${drop ? 'text-rose-500' : 'text-emerald-500'}`}>Net {inr(net)}</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox="0 0 980 330" className="w-full min-w-[760px] h-auto" role="img" aria-label="Cash in versus cash out this period">
          <FlowDefs shadow="cfShadow" />
          {srcRibbons}
          {sinkRibbons}
          {sources.map((n, i) => (
            <FlowBox key={`src-${i}`} x={c1} y={stackY(sources.length, i)} hue={n.hue} shadow="cfShadow" label={n.label} value={inr(n.value)} onClick={n.onClick} />
          ))}
          <FlowBox x={c2} y={cashY} hue="blue" shadow="cfShadow" label="Cash in" value={inr(cf.cashIn)} />
          {sinks.map((n, i) => (
            <FlowBox key={`sink-${i}`} x={c3} y={stackY(sinks.length, i)} hue={n.hue} shadow="cfShadow" label={n.label} value={inr(n.value)} onClick={n.onClick} />
          ))}
        </svg>
      </div>
      <p className="mt-1 text-[11px] text-surface-400 dark:text-surface-500 leading-snug">
        Literal cash this period. Deposits are refundable (a liability, not profit) — they lift cash but never P&L.
        Paid to Corporation = loads {inr(cf.loadPayments)} + deposits {inr(cf.depositsPaid)}{cf.omcUnallocated > 0 ? ` + unallocated ${inr(cf.omcUnallocated)}` : ''}.
        {drop ? ' The bank shrank this period — the shortfall was covered from reserves.' : ''}
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
