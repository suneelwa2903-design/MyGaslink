import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { HiOutlineEye, HiOutlineEyeSlash, HiOutlineArrowRight } from 'react-icons/hi2';
import { loginSchema, type LoginInput, type LoginResponse, UserRole } from '@gaslink/shared';
import { apiPost, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

/* ─── Card pool: 16 square stat cards in 4 sizes ─────────────────────────── */

type CardSize = 'sm' | 'md' | 'lg' | 'xl';

// Square cards: sm≈112px (3cm), md≈188px (5cm), lg≈264px (7cm), xl≈340px (9cm)
const CARD_PX: Record<CardSize, number> = { sm: 112, md: 188, lg: 264, xl: 340 };
const CARD_CLASSES: Record<CardSize, string> = {
  sm: 'w-[112px] h-[112px]',
  md: 'w-[188px] h-[188px]',
  lg: 'w-[264px] h-[264px]',
  xl: 'w-[340px] h-[340px]',
};

// How many grid cells each size occupies (grid cell = 76px)
const SIZE_SPAN: Record<CardSize, number> = { sm: 2, md: 3, lg: 4, xl: 5 };

const CARD_POOL: { id: number; size: CardSize; el: React.ReactNode }[] = [
  // ── Small cards (112×112) ──
  { id: 1, size: 'sm', el: <><p className="text-[10px] text-slate-500 mb-1">Orders Today</p><p className="text-2xl font-extrabold text-white">47</p><p className="text-[10px] text-emerald-400 mt-1">+12% vs yesterday</p></> },
  { id: 2, size: 'sm', el: <><p className="text-[10px] text-slate-500 mb-1">Active Drivers</p><div className="flex items-center gap-1.5 my-1">{[1,2,3].map(i=><div key={i} className="h-3 w-3 rounded-full bg-emerald-400"/>)}</div><p className="text-lg font-extrabold text-white">3/3</p><p className="text-[9px] text-emerald-400">All dispatched</p></> },
  { id: 3, size: 'sm', el: <><p className="text-[10px] text-slate-500 mb-1">Pending</p><p className="text-2xl font-extrabold text-flame-400">3</p><p className="text-[10px] text-slate-500 mt-1">2 approvals</p></> },
  { id: 4, size: 'sm', el: <><p className="text-[10px] text-slate-500 mb-1">Cylinders Out</p><p className="text-2xl font-extrabold text-white">234</p><p className="text-[10px] text-blue-400 mt-1">18 returned</p></> },

  // ── Medium cards (192×192) ──
  { id: 5, size: 'md', el: <><p className="text-[10px] text-slate-500 mb-1">Revenue (Mar)</p><p className="text-3xl font-extrabold text-white">₹8.4L</p><p className="text-[10px] text-emerald-400 mt-1">Collected: ₹6.2L</p><div className="flex items-end gap-1 h-14 mt-3">{[30,50,40,65,55,75,70].map((h,i)=><div key={i} className="flex-1 bg-emerald-500/40 rounded-t" style={{height:`${h}%`}}/>)}</div></> },
  { id: 6, size: 'md', el: <><p className="text-[10px] text-slate-500 mb-1">Overdue Invoices</p><p className="text-3xl font-extrabold text-flame-400">₹2.1L</p><p className="text-[10px] text-slate-500 mt-1">12 invoices pending</p><div className="flex gap-1.5 mt-3">{[40,70,55].map((w,i)=><div key={i} className="h-2 flex-1 bg-flame-500/30 rounded-full overflow-hidden"><div className="h-full bg-flame-400 rounded-full" style={{width:`${w}%`}}/></div>)}</div><div className="flex justify-between mt-1"><span className="text-[8px] text-slate-600">30+ days</span><span className="text-[8px] text-slate-600">60+ days</span><span className="text-[8px] text-slate-600">90+ days</span></div></> },
  { id: 7, size: 'md', el: <><p className="text-[10px] text-slate-500 mb-1">Top Customer</p><div className="flex items-center gap-2 mt-2"><div className="h-10 w-10 rounded-full bg-flame-500/20 flex items-center justify-center"><span className="text-flame-400 text-base font-bold">RK</span></div><div><p className="text-sm font-bold text-white">Royal Kitchen</p><p className="text-[10px] text-slate-400">₹45K this month</p></div></div><div className="flex items-center gap-1.5 mt-3"><div className="h-5 w-5 rounded-full bg-flame-500/20 flex items-center justify-center"><span className="text-[9px] text-flame-400">★</span></div><span className="text-[10px] text-flame-400 font-medium">Premium Tier</span></div><div className="flex items-end gap-0.5 h-8 mt-2">{[20,35,45,40,60,55,70].map((h,i)=><div key={i} className="flex-1 bg-flame-500/30 rounded-t" style={{height:`${h}%`}}/>)}</div></> },
  { id: 8, size: 'md', el: <><p className="text-[10px] text-slate-500 mb-1">e-Invoice Status</p><div className="space-y-2.5 mt-2">{[{inv:'INV-0347',s:'IRN OK',c:'text-emerald-400',bg:'bg-emerald-500/20'},{inv:'INV-0348',s:'Pending',c:'text-flame-400',bg:'bg-flame-500/20'},{inv:'INV-0349',s:'IRN OK',c:'text-emerald-400',bg:'bg-emerald-500/20'}].map(r=><div key={r.inv} className="flex items-center gap-2"><div className={`h-7 w-7 rounded-lg ${r.bg} flex items-center justify-center`}><span className={`${r.c} text-xs`}>{r.s==='IRN OK'?'✓':'⏳'}</span></div><div><p className="text-[11px] text-white font-medium">{r.inv}</p><p className={`text-[9px] ${r.c}`}>{r.s}</p></div></div>)}</div></> },

  // ── Large cards (256×256) ──
  { id: 9, size: 'lg', el: <><p className="text-[10px] text-slate-500 mb-1">Delivery Rate</p><div className="flex items-center justify-center my-3"><div className="relative h-28 w-28"><svg viewBox="0 0 36 36" className="h-28 w-28 -rotate-90"><circle cx="18" cy="18" r="15.9" fill="none" stroke="#334155" strokeWidth="3"/><circle cx="18" cy="18" r="15.9" fill="none" stroke="#34d399" strokeWidth="3" strokeDasharray="94 100" strokeLinecap="round"/></svg><div className="absolute inset-0 flex flex-col items-center justify-center"><p className="text-3xl font-extrabold text-emerald-400">94%</p><p className="text-[9px] text-slate-500">43/46</p></div></div></div><div className="grid grid-cols-3 gap-2 mt-2">{[{l:'Delivered',v:'43',c:'text-emerald-400'},{l:'In Transit',v:'2',c:'text-blue-400'},{l:'Failed',v:'1',c:'text-red-400'}].map(s=><div key={s.l} className="text-center"><p className={`text-sm font-bold ${s.c}`}>{s.v}</p><p className="text-[8px] text-slate-500">{s.l}</p></div>)}</div></> },
  { id: 10, size: 'lg', el: <><p className="text-[10px] text-slate-500 mb-1">Cylinder Stock</p><div className="space-y-3 mt-3">{[{n:'19 KG',p:72,c:'bg-emerald-400',qty:'180'},{n:'47.5 KG',p:45,c:'bg-blue-400',qty:'64'},{n:'5 KG',p:89,c:'bg-flame-400',qty:'220'},{n:'Commercial',p:35,c:'bg-purple-400',qty:'28'}].map(s=><div key={s.n}><div className="flex justify-between mb-0.5"><span className="text-[10px] text-slate-400">{s.n}</span><span className="text-[10px] text-slate-500">{s.qty} ({s.p}%)</span></div><div className="w-full h-2 bg-slate-700 rounded-full"><div className={`h-full ${s.c} rounded-full transition-all`} style={{width:`${s.p}%`}}/></div></div>)}</div><div className="mt-3 pt-2 border-t border-slate-700/50"><p className="text-[9px] text-slate-500">Total: 492 cylinders</p></div></> },
  { id: 11, size: 'lg', el: <><p className="text-[10px] text-slate-500 mb-1">Today's Collections</p><p className="text-3xl font-extrabold text-emerald-400 mt-1">₹1.8L</p><div className="grid grid-cols-3 gap-2 mt-4">{[{l:'Cash',v:'₹80K',icon:'💵'},{l:'UPI',v:'₹65K',icon:'📱'},{l:'Bank',v:'₹35K',icon:'🏦'}].map(m=><div key={m.l} className="bg-slate-700/50 rounded-lg p-2.5 text-center"><p className="text-base mb-1">{m.icon}</p><p className="text-xs font-bold text-white">{m.v}</p><p className="text-[9px] text-slate-400 mt-0.5">{m.l}</p></div>)}</div><div className="mt-3 pt-2 border-t border-slate-700/50 flex justify-between"><span className="text-[9px] text-slate-500">vs yesterday</span><span className="text-[10px] text-emerald-400 font-medium">+18%</span></div></> },
  { id: 12, size: 'lg', el: <><p className="text-[10px] text-slate-500 mb-1">Weekly Orders</p><div className="flex items-end gap-1.5 h-28 mt-3">{[{d:'Mon',v:35},{d:'Tue',v:52},{d:'Wed',v:48},{d:'Thu',v:65},{d:'Fri',v:42},{d:'Sat',v:78},{d:'Sun',v:20}].map(d=><div key={d.d} className="flex-1 flex flex-col items-center gap-1"><div className="w-full bg-blue-500/40 rounded-t" style={{height:`${d.v}%`}}/><span className="text-[8px] text-slate-500">{d.d}</span></div>)}</div><div className="mt-3 pt-2 border-t border-slate-700/50 flex justify-between"><span className="text-[9px] text-slate-500">Avg: 48/day</span><span className="text-[10px] text-blue-400 font-medium">340 total</span></div></> },

  // ── XLarge cards (320×320) ──
  { id: 13, size: 'xl', el: <><p className="text-[10px] text-slate-500 mb-1">Monthly Overview</p><p className="text-3xl font-extrabold text-white mt-1">₹12.6L</p><p className="text-[10px] text-emerald-400">+22% vs last month</p><div className="grid grid-cols-2 gap-2.5 mt-4">{[{l:'Orders',v:'1,240',c:'text-blue-400',bg:'bg-blue-500/10'},{l:'Customers',v:'186',c:'text-emerald-400',bg:'bg-emerald-500/10'},{l:'Trips',v:'312',c:'text-flame-400',bg:'bg-flame-500/10'},{l:'Returns',v:'48',c:'text-purple-400',bg:'bg-purple-500/10'}].map(s=><div key={s.l} className={`${s.bg} rounded-lg p-2.5`}><p className={`text-lg font-bold ${s.c}`}>{s.v}</p><p className="text-[9px] text-slate-500">{s.l}</p></div>)}</div><div className="flex items-end gap-1 h-12 mt-4">{[25,40,35,55,50,70,65,80,60,75,85,72].map((h,i)=><div key={i} className="flex-1 bg-emerald-500/30 rounded-t" style={{height:`${h}%`}}/>)}</div><p className="text-[8px] text-slate-600 mt-1 text-center">Jan → Dec trend</p></> },
  { id: 14, size: 'xl', el: <><p className="text-[10px] text-slate-500 mb-1">Fleet & Drivers</p><div className="space-y-3 mt-3">{[{name:'Raju K.',vehicle:'KA01-MN-9999',trips:8,status:'Active',sc:'text-emerald-400'},{name:'Mohan S.',vehicle:'KA01-AB-1234',trips:6,status:'Active',sc:'text-emerald-400'},{name:'Venkat R.',vehicle:'KA01-XY-5678',trips:7,status:'En Route',sc:'text-blue-400'}].map(d=><div key={d.name} className="flex items-center gap-3 bg-slate-700/30 rounded-lg p-2.5"><div className="h-9 w-9 rounded-full bg-slate-600/50 flex items-center justify-center"><span className="text-[11px] text-white font-medium">{d.name.split(' ').map(w=>w[0]).join('')}</span></div><div className="flex-1"><div className="flex justify-between"><p className="text-[11px] text-white font-medium">{d.name}</p><span className={`text-[9px] ${d.sc} font-medium`}>{d.status}</span></div><p className="text-[9px] text-slate-500">{d.vehicle}</p><div className="flex items-center gap-1 mt-1"><div className="flex-1 h-1 bg-slate-700 rounded-full"><div className="h-full bg-blue-400 rounded-full" style={{width:`${(d.trips/10)*100}%`}}/></div><span className="text-[8px] text-slate-500">{d.trips} trips</span></div></div></div>)}</div><div className="mt-3 pt-2 border-t border-slate-700/50 flex justify-between items-center"><span className="text-[9px] text-slate-500">Total trips today</span><span className="text-base font-bold text-white">21</span></div></> },
  { id: 15, size: 'xl', el: <><p className="text-[10px] text-slate-500 mb-1">Customer Segments</p><div className="flex justify-center my-3"><div className="relative h-28 w-28"><svg viewBox="0 0 36 36" className="h-28 w-28 -rotate-90"><circle cx="18" cy="18" r="15.9" fill="none" stroke="#334155" strokeWidth="4"/><circle cx="18" cy="18" r="15.9" fill="none" stroke="#f97316" strokeWidth="4" strokeDasharray="45 100" strokeLinecap="round"/><circle cx="18" cy="18" r="15.9" fill="none" stroke="#3b82f6" strokeWidth="4" strokeDasharray="30 100" strokeDashoffset="-45" strokeLinecap="round"/><circle cx="18" cy="18" r="15.9" fill="none" stroke="#8b5cf6" strokeWidth="4" strokeDasharray="25 100" strokeDashoffset="-75" strokeLinecap="round"/></svg><div className="absolute inset-0 flex flex-col items-center justify-center"><p className="text-lg font-bold text-white">186</p><p className="text-[8px] text-slate-500">Total</p></div></div></div><div className="space-y-2 mt-2">{[{l:'Commercial',v:84,c:'bg-flame-400',p:'45%'},{l:'Residential',v:56,c:'bg-blue-400',p:'30%'},{l:'Industrial',v:46,c:'bg-purple-400',p:'25%'}].map(s=><div key={s.l} className="flex items-center gap-2"><div className={`h-2.5 w-2.5 rounded-full ${s.c}`}/><span className="text-[10px] text-slate-400 flex-1">{s.l}</span><span className="text-[10px] text-white font-medium">{s.v}</span><span className="text-[9px] text-slate-500">({s.p})</span></div>)}</div></> },
  { id: 16, size: 'xl', el: <><p className="text-[10px] text-slate-500 mb-1">GST & Compliance</p><div className="grid grid-cols-2 gap-2.5 mt-3">{[{l:'Invoices Filed',v:'342',s:'This month',c:'text-emerald-400'},{l:'e-Way Bills',v:'156',s:'Active',c:'text-blue-400'},{l:'GST Collected',v:'₹1.52L',s:'CGST + SGST',c:'text-flame-400'},{l:'Returns Filed',v:'3/3',s:'Up to date',c:'text-emerald-400'}].map(s=><div key={s.l} className="bg-slate-700/30 rounded-lg p-2.5"><p className={`text-lg font-bold ${s.c}`}>{s.v}</p><p className="text-[10px] text-white mt-0.5">{s.l}</p><p className="text-[8px] text-slate-500">{s.s}</p></div>)}</div><div className="mt-4 bg-emerald-500/10 rounded-lg p-2.5 flex items-center gap-2"><div className="h-7 w-7 rounded-full bg-emerald-500/20 flex items-center justify-center"><span className="text-emerald-400 text-xs">✓</span></div><div><p className="text-[10px] text-emerald-400 font-medium">All compliant</p><p className="text-[8px] text-slate-500">Next filing: Apr 11</p></div></div></> },
];

/*
 * Grid-based non-overlapping placement system.
 * The left panel is conceptually divided into a grid of 112px cells.
 * We maintain a 2D occupancy grid and place cards into free rectangular regions.
 */

const GRID_CELL = 76; // px per cell — smaller grid for better coverage

interface PlacedCard {
  uid: number;
  cardIdx: number;
  x: number; // px
  y: number; // px
  gridRow: number;
  gridCol: number;
  span: number;
}

function RotatingCards() {
  const [visibleCards, setVisibleCards] = useState<PlacedCard[]>([]);
  const uidRef = useRef(0);
  const usedCardIndices = useRef(new Set<number>());
  const containerRef = useRef<HTMLDivElement>(null);

  // Occupancy grid: true = occupied
  const gridRef = useRef<boolean[][]>([]);
  const gridDims = useRef({ rows: 0, cols: 0 });

  // Initialize / resize grid
  const rebuildGrid = (width: number, height: number) => {
    const cols = Math.floor(width / GRID_CELL);
    const rows = Math.floor(height / GRID_CELL);
    gridDims.current = { rows, cols };
    // Create empty grid
    gridRef.current = Array.from({ length: rows }, () => Array(cols).fill(false));
    // Mark currently-visible cards
    visibleCards.forEach(c => {
      markGrid(c.gridRow, c.gridCol, c.span, true);
    });
  };

  const markGrid = (row: number, col: number, span: number, val: boolean) => {
    const g = gridRef.current;
    for (let r = row; r < row + span && r < g.length; r++) {
      for (let c = col; c < col + span && c < (g[0]?.length ?? 0); c++) {
        g[r][c] = val;
      }
    }
  };

  const canPlace = (row: number, col: number, span: number): boolean => {
    const { rows, cols } = gridDims.current;
    if (row + span > rows || col + span > cols) return false;
    const g = gridRef.current;
    for (let r = row; r < row + span; r++) {
      for (let c = col; c < col + span; c++) {
        if (g[r][c]) return false;
      }
    }
    return true;
  };

  const findSlot = (span: number): { row: number; col: number } | null => {
    const { rows, cols } = gridDims.current;
    // Collect all valid positions, then pick one randomly
    const candidates: { row: number; col: number }[] = [];
    for (let r = 0; r <= rows - span; r++) {
      for (let c = 0; c <= cols - span; c++) {
        if (canPlace(r, c, span)) candidates.push({ row: r, col: c });
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const addCard = () => {
      const rect = el.getBoundingClientRect();
      rebuildGrid(rect.width, rect.height);

      // Max 4 visible
      if (visibleCards.length >= 4) return;

      // Pick a random unused card
      let freeCards = CARD_POOL.map((_, i) => i).filter(i => !usedCardIndices.current.has(i));
      if (freeCards.length === 0) {
        usedCardIndices.current.clear();
        // Keep currently visible ones marked
        visibleCards.forEach(c => usedCardIndices.current.add(c.cardIdx));
        freeCards = CARD_POOL.map((_, i) => i).filter(i => !usedCardIndices.current.has(i));
      }
      if (freeCards.length === 0) return;

      // Shuffle and try each card until one fits
      const shuffled = [...freeCards].sort(() => Math.random() - 0.5);
      for (const cardIdx of shuffled) {
        const card = CARD_POOL[cardIdx];
        const span = SIZE_SPAN[card.size];
        const slot = findSlot(span);
        if (!slot) continue;

        const uid = uidRef.current++;
        const cardPx = CARD_PX[card.size];
        const gridPx = span * GRID_CELL;
        const offset = Math.max(0, (gridPx - cardPx) / 2);
        const placed: PlacedCard = {
          uid,
          cardIdx,
          x: slot.col * GRID_CELL + offset,
          y: slot.row * GRID_CELL + offset,
          gridRow: slot.row,
          gridCol: slot.col,
          span,
        };

        markGrid(slot.row, slot.col, span, true);
        usedCardIndices.current.add(cardIdx);
        setVisibleCards(prev => [...prev, placed]);

        // Remove after 4s
        setTimeout(() => {
          setVisibleCards(prev => prev.filter(c => c.uid !== uid));
        }, 4000);
        return;
      }
    };

    const interval = setInterval(addCard, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCards]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden p-6">
      <AnimatePresence>
        {visibleCards.map(c => {
          const card = CARD_POOL[c.cardIdx];
          return (
            <motion.div
              key={c.uid}
              initial={{ opacity: 0, scale: 0.75 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.45, ease: [.22, 1, .36, 1] }}
              className={`absolute ${CARD_CLASSES[card.size]} bg-slate-800/90 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-4 shadow-xl flex flex-col justify-center`}
              style={{ left: c.x, top: c.y }}
            >
              {card.el}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/* ─── Login Page ──────────────────────────────────────────────────────────── */

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setTokens, setUser } = useAuthStore();
  const [showPassword, setShowPassword] = useState(false);
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname;
  const { t } = useTranslation();

  const { register, handleSubmit, formState: { errors } } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const loginMutation = useMutation({
    mutationFn: (data: LoginInput) => apiPost<LoginResponse>('/auth/login', data),
    onSuccess: (data) => {
      setTokens(data.tokens.accessToken, data.tokens.refreshToken);
      setUser(data.user);
      if (data.user.requiresPasswordReset) { navigate('/force-password-reset', { replace: true }); return; }
      toast.success(t('auth.welcomeBackToast', { name: data.user.firstName }));
      if (from) { navigate(from, { replace: true }); return; }
      navigate(data.user.role === UserRole.CUSTOMER ? '/app/customer/dashboard' : '/app/dashboard', { replace: true });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const ic = 'w-full px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-flame-500 focus:ring-1 focus:ring-flame-500/20 transition-colors';

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950">
      {/* Left — animated cards */}
      <div className="hidden lg:block lg:w-[55%] relative bg-slate-900 dark:bg-slate-100">
        <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '20px 20px' }} />
        <RotatingCards />

        {/* Bottom bar */}
        <div className="absolute bottom-8 left-8 right-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/founders/suneel.jpg" alt="Suneel" className="h-9 w-9 rounded-full object-cover ring-2 ring-slate-700" />
            <img src="/founders/bhargava.jpg" alt="Bhargava" className="h-9 w-9 rounded-full object-cover ring-2 ring-slate-700 -ml-2" />
            <p className="text-[11px] text-slate-500 ml-1">Built by distributors</p>
          </div>
          <div className="flex items-center gap-2 opacity-40">
            <img src="/logo.png" alt="MyGasLink" className="h-8 w-8 rounded object-contain" />
            <span className="text-[11px] font-bold text-slate-600">MyGasLink</span>
          </div>
        </div>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex items-center justify-center px-6 py-12 bg-slate-50 dark:bg-slate-900">
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5 }} className="w-full max-w-md">
          <div className="flex items-center gap-3 mb-8">
            <img src="/logo.png" alt="MyGasLink" className="h-14 w-14 rounded-xl object-contain" />
            <span className="text-2xl font-extrabold text-[#1e3a5f] dark:text-white">MyGas<span className="text-flame-500">Link</span></span>
          </div>

          <h1 className="text-3xl font-extrabold text-slate-900 dark:text-white mb-2">{t('auth.welcomeBack')}</h1>
          <p className="text-slate-500 mb-8">{t('auth.dashboardSubtitle')}</p>

          <form onSubmit={handleSubmit(d => loginMutation.mutate(d))} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-600 dark:text-slate-300 mb-1.5">{t('auth.emailLabel')}</label>
              <input type="email" placeholder={t('auth.emailPlaceholder')} autoComplete="email" className={ic} {...register('email')} />
              {errors.email && <p className="text-xs text-red-400 mt-1">{errors.email.message}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 dark:text-slate-300 mb-1.5">{t('auth.passwordLabel')}</label>
              <div className="relative">
                <input type={showPassword ? 'text' : 'password'} placeholder={t('auth.passwordPlaceholder')} autoComplete="current-password" className={`${ic} pr-12`} {...register('password')} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors">
                  {showPassword ? <HiOutlineEyeSlash className="h-5 w-5" /> : <HiOutlineEye className="h-5 w-5" />}
                </button>
              </div>
              {errors.password && <p className="text-xs text-red-400 mt-1">{errors.password.message}</p>}
              <div className="flex justify-end mt-2"><Link to="/forgot-password" className="text-xs text-flame-400 hover:text-flame-300 font-medium">{t('auth.forgotPassword')}</Link></div>
            </div>
            <button type="submit" disabled={loginMutation.isPending} className="w-full py-3.5 bg-flame-500 hover:bg-flame-600 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
              {loginMutation.isPending ? <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> : <>{t('auth.loginButton')} <HiOutlineArrowRight className="h-4 w-4" /></>}
            </button>
          </form>

          <div className="mt-8 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            <p className="text-xs text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">{t('auth.newToApp')}</span> <Link to="/#contact" className="text-flame-400 hover:text-flame-300 font-medium">{t('auth.claim3MonthsFree')}</Link></p>
          </div>
          <p className="mt-6 text-center text-xs text-slate-700">{t('auth.copyright', { year: new Date().getFullYear() })}</p>
        </motion.div>
      </div>
    </div>
  );
}
