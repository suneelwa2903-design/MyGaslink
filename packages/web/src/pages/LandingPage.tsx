import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { motion, useInView, AnimatePresence } from 'framer-motion';
import {
  HiOutlineChartBar, HiOutlineCube, HiOutlineDocumentText, HiOutlineTruck,
  HiOutlineUsers, HiOutlineBanknotes, HiOutlineShieldCheck,
  HiOutlineClipboardDocumentList, HiOutlineArrowRight, HiOutlineBars3,
  HiOutlineXMark, HiOutlineCheckCircle,
  HiOutlineLockClosed, HiOutlineCloudArrowUp, HiOutlineDevicePhoneMobile,
  HiOutlineChevronDown, HiOutlineCog6Tooth, HiOutlineSun, HiOutlineMoon,
  HiOutlineCalculator,
} from 'react-icons/hi2';
import { contactFormSchema, type ContactFormInput } from '@gaslink/shared';
import { apiPost, getErrorMessage } from '@/lib/api';
import { useThemeStore } from '@/stores/themeStore';

/* ─── Theme ───────────────────────────────────────────────────────────────── */

function useTheme() {
  const { resolvedTheme, setTheme } = useThemeStore();
  const dark = resolvedTheme === 'dark';
  const toggle = useCallback(() => {
    setTheme(dark ? 'light' : 'dark');
  }, [dark, setTheme]);
  return { dark, toggle };
}

/* Counter component removed — hero stats are now static strings
   (HERO_STATS array below). If any future surface wants animated
   counters again, restore from git history. */

/* ─── Reveal ──────────────────────────────────────────────────────────────── */

function Reveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef(null);
  const v = useInView(ref, { once: true, margin: '-60px' });
  return <motion.div ref={ref} initial={{ opacity: 0, y: 40 }} animate={v ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.6, delay, ease: [.22, 1, .36, 1] }} className={className}>{children}</motion.div>;
}

/* ─── FAQ ──────────────────────────────────────────────────────────────────── */

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-200 dark:border-slate-800">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between py-6 text-left group">
        <span className="text-lg font-semibold text-slate-900 dark:text-white group-hover:text-flame-500 transition-colors pr-4">{q}</span>
        <HiOutlineChevronDown className={`h-5 w-5 text-slate-400 shrink-0 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>{open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }}><p className="pb-6 text-slate-500 dark:text-slate-400 leading-relaxed">{a}</p></motion.div>}</AnimatePresence>
    </div>
  );
}

/* ─── Hero stats (edit these four entries to change the headline numbers) ─── */

const HERO_STATS: { value: string; label: string }[] = [
  { value: '99.9%',   label: 'Uptime' },
  { value: '~10%',    label: 'Ops Cost Reduction' },
  { value: '100%',    label: 'GST & IRN Compliant' },
  { value: '15 min',  label: 'Setup Time' },
];

/* ─── Hero mockups ────────────────────────────────────────────────────────────
   Two device frames flank the hero copy:
     - BrowserMockup (left)  — landscape, for the admin web screenshot
     - PhoneMockup   (right) — portrait,  for the driver mobile screenshot

   To swap in a real screenshot:
     1. Save the image to packages/web/public/screenshots/<name>.png
     2. Pass imageSrc="/screenshots/<name>.png" to the matching call site
   The placeholder grey box disappears as soon as imageSrc is provided.

   Image files currently wired:
     - /screenshots/admin-dashboard.png  (web,    landscape) → left
     - /screenshots/driver-app.png        (mobile, portrait)  → right */

/* Click-to-zoom lightbox. State is lifted to LandingPage and passed
   down via the `onExpand` prop on each device mockup. ESC + click-out
   close the overlay; the inner <img> stops propagation so the user
   can pan their cursor over the image without dismissing. */

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEsc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 cursor-zoom-out"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close image preview"
        className="absolute top-4 right-4 text-white/80 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      >
        <HiOutlineXMark className="h-7 w-7" />
      </button>
      <motion.img
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.85, opacity: 0 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        src={src}
        alt={alt}
        className="max-w-[95vw] max-h-[90vh] rounded-2xl shadow-2xl object-contain cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
    </motion.div>
  );
}

function BrowserMockup({
  label,
  delay = 0,
  compact = false,
  imageSrc,
  onExpand,
}: {
  label: string;
  delay?: number;
  compact?: boolean;
  imageSrc?: string;
  onExpand?: () => void;
}) {
  // Landscape browser frame ~16:10. Image uses object-cover so the
  // dashboard fills the entire screen area (no white letterboxing).
  // Browser scales with breakpoint. Hero row is full-viewport-width so
  // these caps determine how close the frame gets to the viewport edge.
  const widthClass = compact ? 'w-full max-w-[440px]' : 'w-full lg:max-w-[460px] xl:max-w-[600px] 2xl:max-w-[680px]';
  const clickable = !!imageSrc && !!onExpand;
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className={widthClass}
    >
      {/* Browser outer shell — the *screen* panel below carries its own
          aspect (matched to admin-dashboard.png at 1891×927 ≈ 2.04:1)
          so the title bar's fixed height doesn't introduce letterbox.
          Outer frame grows to fit content. */}
      <button
        type="button"
        onClick={clickable ? onExpand : undefined}
        disabled={!clickable}
        aria-label={clickable ? `Expand ${label} preview` : label}
        className={`relative w-full rounded-xl bg-slate-900 dark:bg-slate-950 border border-slate-800 dark:border-slate-700 shadow-2xl overflow-hidden block group ${clickable ? 'cursor-zoom-in hover:shadow-flame-500/20 hover:shadow-2xl transition-shadow' : ''}`}
      >
        {/* Title bar */}
        <div className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 dark:bg-slate-900 border-b border-slate-700">
          <span className="h-2 w-2 rounded-full bg-red-400" />
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="ml-3 flex-1 h-3 rounded bg-slate-700/80 dark:bg-slate-800" />
        </div>
        {/* Screen — own aspect = image aspect, so object-cover has no crop
            and no letterbox. Bg is white to match the dashboard chrome
            in case the screenshot is ever swapped for one with a tiny
            mismatch. */}
        <div className="relative w-full aspect-[1891/927] overflow-hidden bg-white">
          {imageSrc ? (
            <img src={imageSrc} alt={label} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-center px-3">
              <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {label}
              </span>
            </div>
          )}
        </div>
      </button>
    </motion.div>
  );
}

function PhoneMockup({
  label,
  delay = 0,
  compact = false,
  imageSrc,
  onExpand,
}: {
  label: string;
  delay?: number;
  compact?: boolean;
  imageSrc?: string;
  onExpand?: () => void;
}) {
  // Phone aspect ratio ~ 9:19.5 (iPhone-ish). Notch removed (it overlapped
  // top-of-screen content). Image uses object-contain so the whole driver-
  // app screen stays visible; the screen background matches the bezel so
  // any letterboxing blends into the device shell instead of reading as
  // wasted white space.
  const widthClass = compact ? 'w-full max-w-[230px]' : 'w-full max-w-[260px]';
  const clickable = !!imageSrc && !!onExpand;
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className={widthClass}
    >
      {/* Phone outer shell — screen panel uses the actual driver-app.png
          aspect (812×1600 ≈ 9:17.74) so the image fills with no
          letterbox and no crop. Frame grows around it. */}
      <button
        type="button"
        onClick={clickable ? onExpand : undefined}
        disabled={!clickable}
        aria-label={clickable ? `Expand ${label} preview` : label}
        className={`relative w-full rounded-[2.2rem] bg-slate-900 dark:bg-slate-950 border-[5px] border-slate-800 dark:border-slate-700 shadow-2xl p-2 overflow-hidden block ${clickable ? 'cursor-zoom-in hover:shadow-flame-500/20 hover:shadow-2xl transition-shadow' : ''}`}
      >
        <div className="relative w-full aspect-[812/1600] rounded-[1.6rem] overflow-hidden bg-slate-900 dark:bg-slate-950">
          {imageSrc ? (
            <img src={imageSrc} alt={label} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-center px-3">
              <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {label}
              </span>
            </div>
          )}
        </div>
      </button>
    </motion.div>
  );
}

/* ─── Mini Dashboard Mockups for Features ─────────────────────────────────── */

function MockOrders() {
  return (
    <div className="space-y-2.5">
      {[{ id: 'ORD-4821', cust: 'Royal Kitchen', qty: '5 × 19KG', status: 'Delivered', sc: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' },
        { id: 'ORD-4822', cust: 'Spice Garden', qty: '3 × 47.5KG', status: 'In Transit', sc: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400' },
        { id: 'ORD-4823', cust: 'Metro Industries', qty: '10 × 19KG', status: 'Pending', sc: 'bg-flame-100 text-flame-700 dark:bg-flame-500/20 dark:text-flame-400' },
      ].map(o => (
        <div key={o.id} className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
          <div><p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{o.id}</p><p className="text-[10px] text-slate-400">{o.cust} · {o.qty}</p></div>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${o.sc}`}>{o.status}</span>
        </div>
      ))}
    </div>
  );
}

function MockInventory() {
  return (
    <div className="space-y-3">
      {[{ name: '19 KG', full: 142, empty: 58, pct: 71 }, { name: '47.5 KG', full: 34, empty: 22, pct: 61 }, { name: '5 KG', full: 89, empty: 11, pct: 89 }].map(c => (
        <div key={c.name} className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
          <div className="flex justify-between mb-1.5"><span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{c.name}</span><span className="text-[10px] text-slate-400">Full: {c.full} · Empty: {c.empty}</span></div>
          <div className="w-full h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${c.pct}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function MockInvoice() {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-100 dark:border-slate-700 space-y-3">
      <div className="flex justify-between"><span className="text-xs font-semibold text-slate-700 dark:text-slate-200">INV-2026-0347</span><span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400">IRN Generated</span></div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div><p className="text-lg font-bold text-slate-900 dark:text-white">₹9,000</p><p className="text-[10px] text-slate-400">Total</p></div>
        <div><p className="text-lg font-bold text-emerald-500">₹9,000</p><p className="text-[10px] text-slate-400">Paid</p></div>
        <div><p className="text-lg font-bold text-slate-400">₹0</p><p className="text-[10px] text-slate-400">Due</p></div>
      </div>
      <div className="flex items-center gap-2"><div className="h-5 w-5 rounded bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center"><HiOutlineCheckCircle className="h-3 w-3 text-emerald-500" /></div><span className="text-[10px] text-slate-500">e-Way Bill: Active · EWB-7291034</span></div>
    </div>
  );
}

function MockDrivers() {
  return (
    <div className="space-y-2.5">
      {[{ n: 'Raju Kumar', v: 'TS09-AB-1234', s: 'Delivering', c: 'bg-emerald-400' }, { n: 'Suresh Babu', v: 'TS09-CD-5678', s: 'Loading', c: 'bg-flame-400' }, { n: 'Venkat Rao', v: 'KA01-MN-9999', s: 'Returned', c: 'bg-blue-400' }].map(d => (
        <div key={d.n} className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
          <div className="flex items-center gap-2.5"><div className="h-7 w-7 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-500">{d.n.split(' ').map(x => x[0]).join('')}</div><div><p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{d.n}</p><p className="text-[10px] text-slate-400">{d.v}</p></div></div>
          <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className={`h-1.5 w-1.5 rounded-full ${d.c}`} />{d.s}</span>
        </div>
      ))}
    </div>
  );
}

function MockPayments() {
  return (
    <div className="space-y-2.5">
      {[{ c: 'Royal Kitchen', amt: '₹9,000', method: 'UPI', date: '23 Mar' }, { c: 'Spice Garden', amt: '₹12,600', method: 'Cash', date: '22 Mar' }, { c: 'Metro Industries', amt: '₹42,000', method: 'Bank', date: '21 Mar' }].map(p => (
        <div key={p.c} className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
          <div><p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{p.c}</p><p className="text-[10px] text-slate-400">{p.method} · {p.date}</p></div>
          <span className="text-sm font-bold text-emerald-500">{p.amt}</span>
        </div>
      ))}
    </div>
  );
}

function MockAnalytics() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {[{ l: 'Revenue', v: '₹8.4L', c: 'text-slate-900 dark:text-white' }, { l: 'Collected', v: '₹6.2L', c: 'text-emerald-500' }, { l: 'Overdue', v: '₹1.1L', c: 'text-red-500' }, { l: 'Orders', v: '234', c: 'text-slate-900 dark:text-white' }].map(m => (
          <div key={m.l} className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700 text-center"><p className={`text-lg font-bold ${m.c}`}>{m.v}</p><p className="text-[10px] text-slate-400">{m.l}</p></div>
        ))}
      </div>
      <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
        <div className="flex items-end gap-1 h-12">{[40, 55, 45, 70, 60, 80, 75, 65, 85, 70, 90, 78].map((h, i) => <div key={i} className="flex-1 bg-flame-500 rounded-t opacity-70" style={{ height: `${h}%` }} />)}</div>
        <div className="flex justify-between mt-1"><span className="text-[9px] text-slate-400">Apr</span><span className="text-[9px] text-slate-400">Mar</span></div>
      </div>
    </div>
  );
}

function MockAccountability() {
  return (
    <div className="space-y-2.5">
      {[{ type: 'Missing', cyl: '19 KG × 2', driver: 'Raju K.', status: 'Investigating', sc: 'bg-flame-100 text-flame-700 dark:bg-flame-500/20 dark:text-flame-400' },
        { type: 'Damaged', cyl: '47.5 KG × 1', driver: 'Suresh B.', status: 'Resolved', sc: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' },
        { type: 'Disputed', cyl: '19 KG × 3', driver: 'Venkat R.', status: 'Charged', sc: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400' },
      ].map((a, i) => (
        <div key={i} className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
          <div><p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{a.type}: {a.cyl}</p><p className="text-[10px] text-slate-400">Driver: {a.driver}</p></div>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${a.sc}`}>{a.status}</span>
        </div>
      ))}
    </div>
  );
}

function MockPortal() {
  return (
    <div className="space-y-2.5">
      <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-100 dark:border-slate-700 text-center">
        <p className="text-[10px] text-slate-400 mb-1">Outstanding Balance</p>
        <p className="text-2xl font-bold text-slate-900 dark:text-white">₹24,500</p>
        <p className="text-[10px] text-flame-500 mt-1">2 invoices overdue</p>
      </div>
      <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700 flex items-center justify-between">
        <div><p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Place New Order</p><p className="text-[10px] text-slate-400">19 KG × 5, 47.5 KG × 2</p></div>
        <div className="h-7 px-3 rounded bg-flame-500 text-white text-[10px] font-semibold flex items-center">Order</div>
      </div>
    </div>
  );
}

const FEATURE_MOCKS: Record<string, () => React.ReactElement> = {
  'Order Management': MockOrders,
  'Smart Inventory': MockInventory,
  'GST e-Invoicing': MockInvoice,
  'Fleet & Delivery': MockDrivers,
  'Payments & Ledger': MockPayments,
  'Analytics & Reports': MockAnalytics,
  'Accountability': MockAccountability,
  'Customer Portal': MockPortal,
};

/* ─── Savings Calculator ──────────────────────────────────────────────────── */

function SavingsCalculator() {
  const [cylinders, setCylinders] = useState(500);
  const [drivers, setDrivers] = useState(3);
  const [customers, setCustomers] = useState(50);
  const timeSaved = Math.round(cylinders * 0.5 + drivers * 2 + customers * 0.3);
  const moneySaved = Math.round(cylinders * 15 + drivers * 1000 + customers * 200);
  const cylinderLoss = Math.round(cylinders * 0.02);
  const fmt = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 lg:p-10">
      <div className="flex items-center gap-3 mb-8">
        <div className="h-10 w-10 rounded-xl bg-flame-500 flex items-center justify-center"><HiOutlineCalculator className="h-5 w-5 text-white" /></div>
        <div><h3 className="text-xl font-bold text-slate-900 dark:text-white">Your Savings Calculator</h3><p className="text-sm text-slate-500">Enter your numbers. See what you save.</p></div>
      </div>
      <div className="grid lg:grid-cols-2 gap-10">
        <div className="space-y-8">
          {[{ label: 'Monthly Cylinder Sales', value: cylinders, min: 100, max: 5000, step: 50, set: setCylinders },
            { label: 'Number of Drivers', value: drivers, min: 1, max: 20, step: 1, set: setDrivers },
            { label: 'Active Customers', value: customers, min: 10, max: 500, step: 5, set: setCustomers }].map(s => (
            <div key={s.label}>
              <div className="flex justify-between mb-3"><span className="text-sm font-medium text-slate-600 dark:text-slate-300">{s.label}</span><span className="text-sm font-bold text-flame-500 bg-flame-50 dark:bg-flame-500/10 px-3 py-0.5 rounded-full">{s.value.toLocaleString()}</span></div>
              <input type="range" min={s.min} max={s.max} step={s.step} value={s.value} onChange={e => s.set(Number(e.target.value))} className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-flame-500" />
            </div>
          ))}
        </div>
        <div className="flex flex-col justify-center gap-4">
          {[{ l: 'Hours Saved / Month', v: `${timeSaved}h`, c: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-100 dark:border-emerald-500/10' },
            { l: 'Money Saved / Month', v: fmt(moneySaved), c: 'text-flame-500', bg: 'bg-flame-50 dark:bg-flame-500/5 border-flame-100 dark:border-flame-500/10' },
            { l: 'Cylinder Losses Prevented', v: `${cylinderLoss}`, c: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-500/5 border-blue-100 dark:border-blue-500/10' }].map(r => (
            <div key={r.l} className={`${r.bg} border rounded-xl p-5 flex items-center justify-between`}>
              <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{r.l}</span>
              <span className={`text-2xl lg:text-3xl font-extrabold ${r.c}`}>{r.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Contact Form ────────────────────────────────────────────────────────── */

function ContactForm() {
  const { register, handleSubmit, formState: { errors }, reset } = useForm<ContactFormInput>({ resolver: zodResolver(contactFormSchema), defaultValues: { name: '', phone: '', email: '', agency: '', agencyName: '', monthlySale: '' } });
  const mutation = useMutation({ mutationFn: (data: ContactFormInput) => apiPost('/contact', data), onSuccess: () => { toast.success('Thank you! We will contact you soon.'); reset(); }, onError: (error) => toast.error(getErrorMessage(error)) });
  const ic = 'w-full px-4 py-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-flame-500 focus:ring-1 focus:ring-flame-500/20 transition-colors';

  return (
    <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Your Name</label><input placeholder="Full name" className={ic} {...register('name')} />{errors.name && <p className="text-xs text-red-500 mt-1">{errors.name.message}</p>}</div>
        <div><label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Phone</label><input placeholder="+91 XXXXX XXXXX" className={ic} {...register('phone')} />{errors.phone && <p className="text-xs text-red-500 mt-1">{errors.phone.message}</p>}</div>
      </div>
      <div><label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email (Optional)</label><input placeholder="you@example.com" type="email" className={ic} {...register('email')} /></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Agency Type</label><select className={ic} {...register('agency')}><option value="">Select</option><option value="hp">HP Gas</option><option value="bharat">Bharat Gas</option><option value="indane">Indane Gas</option><option value="other">Other</option></select>{errors.agency && <p className="text-xs text-red-500 mt-1">{errors.agency.message}</p>}</div>
        <div><label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Agency Name</label><input placeholder="Your agency name" className={ic} {...register('agencyName')} />{errors.agencyName && <p className="text-xs text-red-500 mt-1">{errors.agencyName.message}</p>}</div>
      </div>
      <div><label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Monthly Sale</label><select className={ic} {...register('monthlySale')}><option value="">Select</option><option value="0-500">0–500</option><option value="500-1000">500–1000</option><option value="1000-3000">1000–3000</option><option value="3000+">3000+</option></select>{errors.monthlySale && <p className="text-xs text-red-500 mt-1">{errors.monthlySale.message}</p>}</div>
      <button type="submit" disabled={mutation.isPending} className="w-full py-3.5 bg-flame-500 hover:bg-flame-600 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50">{mutation.isPending ? 'Submitting...' : <>Get Started Free <HiOutlineArrowRight className="h-4 w-4" /></>}</button>
    </form>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  STACKED BEFORE/AFTER — scroll-driven card swap (like onefinops)          */
/* ═══════════════════════════════════════════════════════════════════════════ */

function StackedBeforeAfter({ cards, dark: _dark }: { cards: { role: string; emoji: string; before: string; after: string }[]; dark: boolean }) {
  const dark = _dark;

  return (
    <section id="before-after" className="px-6 lg:px-12 xl:px-20">
      {/* Section header — normal flow, scrolls with page */}
      <div className="text-center pt-24 pb-8">
        <span className="text-xs font-bold text-flame-500 uppercase tracking-widest">The Transformation</span>
        <h2 className="text-3xl lg:text-5xl font-extrabold mt-2 mb-3">
          Life <span className="text-flame-500">Before</span> vs <span className="text-brand-500">After</span>
        </h2>
        <p className="text-slate-500 dark:text-slate-400 text-base max-w-2xl mx-auto">Real pain points, real solutions.</p>
      </div>

      {/* CSS Sticky Stack: each card sticks 45px below the previous one,
          revealing the emoji + role header of stacked cards behind. */}
      <div className="max-w-3xl mx-auto" style={{ paddingBottom: '10vh' }}>
        {cards.map((c, i) => (
          <div
            key={i}
            style={{
              position: 'sticky',
              top: `${80 + i * 45}px`,
              zIndex: 10 + i,
              marginBottom: i < cards.length - 1 ? '10vh' : '0',
            }}
          >
            <div
              className="rounded-2xl p-5 lg:p-7 border bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700"
              style={{ boxShadow: `0 -4px 12px rgba(0,0,0,${dark ? 0.3 : 0.06}), 0 8px 24px rgba(0,0,0,${dark ? 0.4 : 0.1})` }}
            >
              <div className="flex items-center gap-3 mb-4">
                <span className="text-2xl">{c.emoji}</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white">{c.role}</span>
                <span className="ml-auto text-[10px] font-semibold text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">{i + 1}/{cards.length}</span>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="rounded-xl p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/40">
                  <p className="text-[10px] font-bold text-flame-500 uppercase tracking-widest mb-2">Before</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{c.before}</p>
                </div>
                <div className="rounded-xl p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/40">
                  <p className="text-[10px] font-bold text-brand-500 uppercase tracking-widest mb-2">After</p>
                  <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed font-medium">{c.after}</p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  MAIN PAGE                                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showSplash, setShowSplash] = useState(() => !sessionStorage.getItem('splash-seen'));
  const [logoExpand, setLogoExpand] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const { dark, toggle: toggleTheme } = useTheme();
  const scrollTo = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); setMobileMenuOpen(false); };

  const handleLogoClick = () => {
    setLogoExpand(true);
    setTimeout(() => setLogoExpand(false), 2500);
  };

  useEffect(() => {
    if (showSplash) {
      const timer = setTimeout(() => { setShowSplash(false); sessionStorage.setItem('splash-seen', '1'); }, 4000);
      return () => clearTimeout(timer);
    }
  }, [showSplash]);

  const features = [
    { icon: HiOutlineClipboardDocumentList, title: 'Order Management', desc: 'End-to-end order lifecycle from creation to delivery with real-time tracking.', bullets: ['Auto-assign drivers with smart routing', 'Bulk order processing', 'Returns & cancelled stock tracking', 'Customer delivery confirmations'] },
    { icon: HiOutlineCube, title: 'Smart Inventory', desc: 'Event-sourced cylinder tracking — know where every cylinder is, right now.', bullets: ['Real-time full & empty counts', 'Incoming/outgoing document tracking', 'Low-stock & critical alerts', 'Daily locks & vehicle return'] },
    { icon: HiOutlineDocumentText, title: 'GST e-Invoicing', desc: 'One-click IRN-compliant e-invoices and e-Way Bills via WhiteBooks GSP.', bullets: ['Auto IRN for B2B', 'e-Way Bills for every vehicle', 'Credit & debit notes', 'GSTIN validation'] },
    { icon: HiOutlineTruck, title: 'Fleet & Delivery', desc: 'Driver-vehicle assignments, trip pipelines, and end-of-day vehicle return.', bullets: ['Smart driver-vehicle pairing', 'Trip status pipeline', 'Vehicle inventory tracking', 'Delivery proof & disputes'] },
    { icon: HiOutlineBanknotes, title: 'Payments & Ledger', desc: 'Cash, UPI, cheque, bank transfer — record and auto-allocate to invoices.', bullets: ['Multi-mode payments', 'Auto invoice allocation', 'Customer ledger & balance', 'Collection dashboard'] },
    { icon: HiOutlineChartBar, title: 'Analytics & Reports', desc: 'Revenue trends, collection health, driver performance, customer LTV.', bullets: ['Dashboard KPIs', 'Revenue & collection trends', 'Driver performance', 'Excel/CSV exports'] },
    { icon: HiOutlineShieldCheck, title: 'Accountability', desc: 'Track every missing, damaged, or disputed cylinder with investigation workflows.', bullets: ['Lost/damaged logging', 'Customer disputes', 'Write-off & recovery', 'Full audit trail'] },
    { icon: HiOutlineUsers, title: 'Customer Portal', desc: 'Self-service for B2B customers — orders, invoices, payments, GST documents.', bullets: ['Online order placement', 'Invoice & payment history', 'Account & balance view', 'GST document access'] },
  ];

  const beforeAfter = [
    { role: 'Distributor Owner', emoji: '👨‍💼', before: 'Sleepless nights counting missing cylinders. No idea who owes what.', after: 'Real-time dashboard. Every cylinder tracked. Every rupee accounted for.' },
    { role: 'Delivery Driver', emoji: '🚛', before: 'Paper chits, wrong addresses, daily arguments about quantities.', after: 'Mobile app shows route, quantities, and customers sign digitally.' },
    { role: 'Finance Manager', emoji: '📊', before: '3 days to create GST invoices. CA calls screaming at midnight.', after: 'One-click e-invoices with IRN. CA sends a thank-you card.' },
    { role: 'B2B Customer', emoji: '🏪', before: '"Where is my order?!" — 15 calls to distributor every week.', after: 'Self-service portal: order status, invoices, payments. Zero calls.' },
    { role: 'Inventory Manager', emoji: '📦', before: 'Manual register, physical counting, numbers never match.', after: 'Event-sourced tracking. Auto flows. Mismatch alerts instant.' },
    { role: 'Business Growth', emoji: '📈', before: 'No data. No insights. Flying blind on pricing and expansion.', after: 'Revenue trends, customer LTV, driver performance — all in analytics.' },
  ];

  const navLinks = ['features', 'how-it-works', 'before-after', 'calculator', 'faq', 'contact'];

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-[#1e3a5f] dark:text-white transition-colors duration-300 relative">
      {/* Starry galactic background */}
      {/* Starry galactic background */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden" aria-hidden>
        {/* Light mode stars — visible grey-blue dots */}
        <div className="dark:hidden absolute inset-0 bg-[radial-gradient(2px_2px_at_20px_30px,rgba(80,100,180,0.3),transparent),radial-gradient(1.5px_1.5px_at_60px_90px,rgba(80,100,180,0.25),transparent),radial-gradient(2.5px_2.5px_at_120px_50px,rgba(120,90,180,0.28),transparent),radial-gradient(1.5px_1.5px_at_170px_140px,rgba(80,100,180,0.22),transparent),radial-gradient(2px_2px_at_80px_170px,rgba(100,120,200,0.3),transparent),radial-gradient(3px_3px_at_150px_80px,rgba(130,100,190,0.2),transparent),radial-gradient(1.5px_1.5px_at_30px_130px,rgba(80,100,180,0.25),transparent),radial-gradient(2px_2px_at_190px_20px,rgba(100,110,190,0.28),transparent)] bg-[size:220px_200px]" />
        {/* Dark mode stars — bright white/blue dots */}
        <div className="hidden dark:block absolute inset-0 bg-[radial-gradient(2px_2px_at_20px_30px,rgba(220,230,255,0.6),transparent),radial-gradient(1.5px_1.5px_at_60px_90px,rgba(220,230,255,0.45),transparent),radial-gradient(3px_3px_at_120px_50px,rgba(240,220,255,0.5),transparent),radial-gradient(1.5px_1.5px_at_170px_140px,rgba(220,230,255,0.4),transparent),radial-gradient(2px_2px_at_80px_170px,rgba(220,230,255,0.55),transparent),radial-gradient(4px_4px_at_150px_80px,rgba(200,210,255,0.35),transparent),radial-gradient(1.5px_1.5px_at_30px_130px,rgba(220,230,255,0.45),transparent),radial-gradient(2.5px_2.5px_at_190px_20px,rgba(230,220,255,0.5),transparent)] bg-[size:220px_200px]" />
        {/* Subtle color nebula glow */}
        <div className="absolute top-[10%] left-[10%] w-[500px] h-[500px] rounded-full bg-brand-500/[0.04] dark:bg-brand-500/[0.08] blur-[120px] animate-drift" />
        <div className="absolute top-[60%] right-[10%] w-[400px] h-[400px] rounded-full bg-flame-500/[0.03] dark:bg-flame-500/[0.06] blur-[100px] animate-drift [animation-direction:reverse]" />
      </div>

      {/* ─── Intro Splash Animation ──────────────────────────────────── */}
      <AnimatePresence>
        {showSplash && (
          <motion.div
            key="splash"
            className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950 overflow-hidden"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: 'easeInOut' }}
          >
            {/* Wobbling logo that travels then settles center */}
            <motion.img
              src="/logo.png"
              alt="MyGasLink"
              className="h-28 w-28 sm:h-36 sm:w-36 rounded-2xl object-contain"
              initial={{ opacity: 0, x: -200, y: -150, rotate: -20, scale: 0.4 }}
              animate={{
                opacity: [0, 1, 1, 1, 1],
                x: [-200, 150, -80, 30, 0],
                y: [-150, 100, -50, 20, 0],
                rotate: [-20, 15, -10, 5, 0],
                scale: [0.4, 0.7, 0.9, 1.05, 1],
              }}
              transition={{ duration: 2.2, ease: 'easeInOut', times: [0, 0.25, 0.5, 0.75, 1] }}
            />
            <motion.h1
              className="mt-6 text-5xl sm:text-7xl font-extrabold text-white tracking-tight"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 2.0, duration: 0.5 }}
            >
              MyGas<span className="text-flame-500">Link</span>
            </motion.h1>
            <motion.p
              className="mt-3 text-base sm:text-lg text-slate-400 font-medium tracking-wide"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 2.4, duration: 0.5 }}
            >
              Commercial LPG Gas Distribution — Made Easy
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Logo Expand Animation (on logo click) ───────────────────── */}
      <AnimatePresence>
        {logoExpand && (
          <motion.div
            key="logo-expand"
            className="fixed inset-0 z-[90] flex items-center justify-center bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <motion.img
              src="/logo.png"
              alt="MyGasLink"
              className="rounded-3xl object-contain"
              initial={{ scale: 0.3, rotate: -15, x: -300, y: -200 }}
              animate={{
                scale: [0.3, 0.8, 1.1, 1],
                rotate: [-15, 10, -5, 0],
                x: [-300, 150, -50, 0],
                y: [-200, 100, -30, 0],
              }}
              exit={{ scale: 0.3, opacity: 0 }}
              transition={{ duration: 1.5, ease: 'easeInOut' }}
              style={{ width: '280px', height: '280px' }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Image Lightbox (hero device click-to-zoom) ──────────────── */}
      <AnimatePresence>
        {lightbox && (
          <ImageLightbox
            key="hero-lightbox"
            src={lightbox.src}
            alt={lightbox.alt}
            onClose={() => setLightbox(null)}
          />
        )}
      </AnimatePresence>

      {/* ─── Navbar — contrasts with background ──────────────────────── */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="w-full px-6 lg:px-12 xl:px-20">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <img src="/logo.png" alt="MyGasLink" className="h-11 w-11 rounded-lg object-contain cursor-pointer hover:scale-110 transition-transform" onClick={handleLogoClick} />
              <span className="text-xl font-extrabold tracking-tight text-[#1e3a5f] dark:text-white cursor-pointer" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>MyGas<span className="text-flame-500">Link</span></span>
            </div>
            <div className="hidden lg:flex items-center gap-8">
              {navLinks.map(s => <button key={s} onClick={() => scrollTo(s)} className="text-base font-medium text-slate-600 dark:text-slate-400 hover:text-flame-500 transition-colors capitalize">{s.replace(/-/g, ' ')}</button>)}
              <button onClick={toggleTheme} className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-flame-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">{dark ? <HiOutlineSun className="h-6 w-6" /> : <HiOutlineMoon className="h-6 w-6" />}</button>
              <Link to="/login"><button className="px-6 py-2.5 bg-flame-500 hover:bg-flame-600 text-white text-base font-semibold rounded-lg transition-colors">Sign In</button></Link>
            </div>
            <div className="flex items-center gap-2 lg:hidden">
              <button onClick={toggleTheme} className="p-2 text-slate-600 dark:text-slate-400">{dark ? <HiOutlineSun className="h-5 w-5" /> : <HiOutlineMoon className="h-5 w-5" />}</button>
              <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="p-2 text-slate-600 dark:text-slate-400">{mobileMenuOpen ? <HiOutlineXMark className="h-5 w-5" /> : <HiOutlineBars3 className="h-5 w-5" />}</button>
            </div>
          </div>
        </div>
        {mobileMenuOpen && <div className="lg:hidden bg-white/80 dark:bg-slate-950/80 border-t border-slate-200 dark:border-slate-800 px-6 py-4 space-y-2">{navLinks.map(s => <button key={s} onClick={() => scrollTo(s)} className="block w-full text-left py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-flame-500 capitalize">{s.replace(/-/g, ' ')}</button>)}<Link to="/login" className="block"><button className="w-full mt-2 px-5 py-2.5 bg-flame-500 text-white text-sm font-semibold rounded-lg">Sign In</button></Link></div>}
      </nav>

      {/* ─── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative pt-28 pb-20 lg:pt-36 lg:pb-28 text-[#1e3a5f] dark:text-white">
        {/*
          Hero structure:
            Row 1 — full-VIEWPORT-width 3-column grid (lg+):
                     browser-mockup | headline+CTAs | phone-mockup
                     The outer wrapper intentionally drops `max-w-7xl`
                     so the devices hug the actual viewport edges
                     (no max-w container padding to waste). Center
                     column wraps the copy in its own max-w-2xl so
                     the headline keeps the same visual width as
                     before.
            Row 2 — 4-cell stats grid, kept inside max-w-7xl.
          On <lg the device row is hidden here and re-rendered below
          the stats as a vertically-stacked block (one beneath the
          other) so each screenshot stays readable.
          Click either device → fullscreen lightbox.
        */}
        <div className="grid lg:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_minmax(0,1fr)] gap-4 lg:gap-6 items-center px-4 lg:px-6">
          {/* ─── Left: admin web screenshot (flush with viewport-left edge) ─── */}
          <div className="hidden lg:flex justify-start">
            <BrowserMockup
              label="Admin Dashboard"
              delay={0.4}
              imageSrc="/screenshots/admin-dashboard.png"
              onExpand={() => setLightbox({ src: '/screenshots/admin-dashboard.png', alt: 'Admin Dashboard preview' })}
            />
          </div>

          {/* ─── Center content (headline → tagline; stats moved below) ─── */}
          <div className="text-center max-w-2xl mx-auto px-2">
            <motion.h1 initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .1 }} className="text-5xl sm:text-6xl lg:text-[3.5rem] xl:text-[4rem] font-extrabold leading-[1.1] tracking-tight mb-8 text-[#1e3a5f] dark:text-white">Every Cylinder.<br />Every Invoice.<br /><span className="text-flame-500">Every Rupee. Tracked.</span></motion.h1>
            <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .2 }} className="text-base lg:text-lg text-slate-500 dark:text-slate-400 mb-10 leading-relaxed">Complete operations platform for LPG distributors. Orders, inventory, GST invoicing, fleet management, payments, and analytics — all in one place.</motion.p>
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .3 }} className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-5">
              <button onClick={() => scrollTo('contact')} className="px-8 py-4 bg-flame-500 hover:bg-flame-600 text-white font-semibold rounded-xl transition-colors flex items-center gap-2 text-base">Claim 3 Weeks Free <HiOutlineArrowRight className="h-5 w-5" /></button>
              <button onClick={() => scrollTo('features')} className="px-8 py-4 bg-[#1e3a5f] dark:bg-white/10 hover:bg-[#2a4d7a] dark:hover:bg-white/20 font-semibold rounded-xl transition-colors text-base border border-[#1e3a5f] dark:border-white/20 text-white backdrop-blur-sm">Explore Features</button>
            </motion.div>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .5 }} className="text-sm text-slate-400">No credit card · Cancel anytime</motion.p>
          </div>

          {/* ─── Right: driver mobile screenshot (flush with viewport-right edge) ─── */}
          <div className="hidden lg:flex justify-end">
            <PhoneMockup
              label="Driver App"
              delay={0.5}
              imageSrc="/screenshots/driver-app.png"
              onExpand={() => setLightbox({ src: '/screenshots/driver-app.png', alt: 'Driver App preview' })}
            />
          </div>
        </div>

        {/* ─── Full-width stats row (centered, kept inside max-w-7xl) ─── */}
        <div className="max-w-7xl mx-auto px-6 lg:px-12 xl:px-20">
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .6 }} className="mt-16 grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-100 dark:bg-white/10 rounded-2xl overflow-hidden">
            {HERO_STATS.map((stat) => (
              <div key={stat.label} className="bg-slate-50 dark:bg-white/5 backdrop-blur-sm p-7 text-center">
                <p className="text-3xl lg:text-4xl font-extrabold mb-1">{stat.value}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{stat.label}</p>
              </div>
            ))}
          </motion.div>
        </div>

        {/* ─── Mobile-only stacked column ─────────────────────────────────
           On <lg the devices stack vertically (one beneath the other),
           centered, each at the largest size that still fits cleanly
           on a small viewport. Tap either to open the lightbox. */}
        <div className="lg:hidden mt-14 flex flex-col items-center gap-10 px-4">
          <BrowserMockup
            label="Admin Dashboard"
            delay={0.4}
            compact
            imageSrc="/screenshots/admin-dashboard.png"
            onExpand={() => setLightbox({ src: '/screenshots/admin-dashboard.png', alt: 'Admin Dashboard preview' })}
          />
          <PhoneMockup
            label="Driver App"
            delay={0.5}
            compact
            imageSrc="/screenshots/driver-app.png"
            onExpand={() => setLightbox({ src: '/screenshots/driver-app.png', alt: 'Driver App preview' })}
          />
        </div>
      </section>

      {/* ─── Features with mockups ─────────────────────────────────────── */}
      <section id="features" className="py-24 px-6 lg:px-12 xl:px-20 bg-slate-50/80 dark:bg-slate-900/40">
        <div className="max-w-7xl mx-auto">
          <Reveal><div className="text-center mb-16"><span className="text-xs font-bold text-flame-500 uppercase tracking-widest">Platform</span><h2 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-5">8 Modules. One Platform.</h2><p className="text-slate-500 dark:text-slate-400 text-lg max-w-2xl mx-auto">Everything to run a modern, efficient, and compliant LPG distribution business.</p></div></Reveal>
          <div className="space-y-10">
            {features.map((f, i) => {
              const Mock = FEATURE_MOCKS[f.title];
              const isEven = i % 2 === 0;
              const num = String(i + 1).padStart(2, '0');
              return (
                <Reveal key={i} delay={0.05}>
                  <div className="relative">
                    <div className={`grid lg:grid-cols-2 gap-6 items-start`}>
                      <div className={isEven ? '' : 'lg:order-2'}>
                        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-7 lg:p-8 hover:border-flame-300 dark:hover:border-flame-500/30 transition-colors">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="h-10 w-10 rounded-xl bg-flame-500 flex items-center justify-center"><f.icon className="h-5 w-5 text-white" /></div>
                            <h3 className="text-xl font-bold">{f.title}</h3>
                          </div>
                          <p className="text-slate-500 dark:text-slate-400 mb-5 leading-relaxed">{f.desc}</p>
                          <ul className="space-y-2.5">{f.bullets.map((b, j) => <li key={j} className="flex items-start gap-2.5"><HiOutlineCheckCircle className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" /><span className="text-sm text-slate-600 dark:text-slate-300">{b}</span></li>)}</ul>
                        </div>
                      </div>
                      <div className={isEven ? '' : 'lg:order-1'}>
                        <div className="relative bg-white dark:bg-slate-800/80 rounded-xl p-5 border border-slate-200 dark:border-slate-700/50">
                          <span className="hidden lg:block absolute top-1/2 -translate-y-1/2 text-[9rem] font-extrabold text-flame-500/15 dark:text-slate-400/15 leading-none select-none pointer-events-none" style={{ [isEven ? 'right' : 'left']: '-12rem' }}>{num}</span>
                          {Mock && <Mock />}
                        </div>
                      </div>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ─── How It Works ──────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-24 px-6 lg:px-12 xl:px-20 bg-white/80 dark:bg-slate-950/80">
        <div className="max-w-5xl mx-auto">
          <Reveal><div className="text-center mb-16"><span className="text-xs font-bold text-flame-500 uppercase tracking-widest">Getting Started</span><h2 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-5">Go Live in 15 Minutes</h2><p className="text-slate-500 dark:text-slate-400 text-lg">No training. No setup fees. No IT team.</p></div></Reveal>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[{ s: '01', t: 'Sign Up', d: 'Email and phone. 30 seconds.', e: '🚀' }, { s: '02', t: 'Configure', d: 'Customers, cylinders, drivers, vehicles.', e: '⚙️' }, { s: '03', t: 'Operate', d: 'Create orders, dispatch, invoice.', e: '📦' }, { s: '04', t: 'Grow', d: 'Analytics to optimize and scale.', e: '📈' }].map((item, i) => (
              <Reveal key={i} delay={i * .1}><div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-7 text-center hover:border-flame-300 dark:hover:border-flame-500/30 transition-colors"><span className="text-4xl block mb-4">{item.e}</span><span className="text-xs font-bold text-flame-500 tracking-widest">STEP {item.s}</span><h3 className="font-bold text-lg mt-2 mb-2">{item.t}</h3><p className="text-sm text-slate-500 dark:text-slate-400">{item.d}</p></div></Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Before & After (scroll-driven stacking cards like onefinops) ── */}
      <StackedBeforeAfter cards={beforeAfter} dark={dark} />

      {/* ─── Savings Calculator ─────────────────────────────────────────── */}
      <section id="calculator" className="py-24 px-6 lg:px-12 xl:px-20 bg-white/80 dark:bg-slate-950/80">
        <div className="max-w-5xl mx-auto">
          <Reveal><div className="text-center mb-12"><span className="text-xs font-bold text-flame-500 uppercase tracking-widest">ROI Calculator</span><h2 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-5">Calculate Your Savings</h2><p className="text-slate-500 dark:text-slate-400 text-lg">Enter your numbers. See exactly what you save every month.</p></div></Reveal>
          <Reveal delay={.2}><SavingsCalculator /></Reveal>
        </div>
      </section>

      {/* Testimonials section removed (placeholder quotes not real) —
         restore from git history when real customer quotes are available. */}

      {/* ─── Security ──────────────────────────────────────────────────── */}
      <section className="py-24 px-6 lg:px-12 xl:px-20 bg-white/80 dark:bg-slate-950/80">
        <div className="max-w-5xl mx-auto">
          <Reveal><div className="text-center mb-14"><span className="text-xs font-bold text-flame-500 uppercase tracking-widest">Security</span><h2 className="text-4xl lg:text-5xl font-extrabold mt-3">Enterprise-Grade Security</h2></div></Reveal>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[{ i: HiOutlineLockClosed, t: '256-bit Encryption', d: 'Data encrypted at rest and in transit.' }, { i: HiOutlineCloudArrowUp, t: 'Daily Backups', d: '30-day retention, instant restore.' }, { i: HiOutlineShieldCheck, t: 'Tenant Isolation', d: 'Zero cross-access between distributors.' }, { i: HiOutlineDevicePhoneMobile, t: 'Role-Based Access', d: '6 roles with granular permissions.' }, { i: HiOutlineCog6Tooth, t: 'Audit Trail', d: 'Every action logged.' }, { i: HiOutlineDocumentText, t: 'GST Compliant', d: 'e-Invoice & e-Way Bill.' }].map((s, idx) => (
              <Reveal key={idx} delay={idx * .05}><div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 hover:border-flame-300 dark:hover:border-flame-500/30 transition-colors"><s.i className="h-8 w-8 text-flame-500 mb-4" /><h3 className="font-bold mb-2">{s.t}</h3><p className="text-sm text-slate-500 dark:text-slate-400">{s.d}</p></div></Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Team ──────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 lg:px-12 xl:px-20 bg-slate-50/80 dark:bg-slate-900/40">
        <div className="max-w-4xl mx-auto">
          <Reveal><div className="text-center mb-14"><span className="text-xs font-bold text-flame-500 uppercase tracking-widest">Team</span><h2 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-5">Built by Distributors</h2><p className="text-slate-500 dark:text-slate-400 text-lg">We&apos;ve lived the chaos. That&apos;s why we built the solution.</p></div></Reveal>
          <div className="grid sm:grid-cols-2 gap-8">
            {[{ n: 'Suneel Kumar', r: 'Co-Founder — Product, Technology & Strategy', d: "IIM Lucknow Alumnus · ISB Online Marketing · 10+ years leading strategy and building global enterprise systems. The architect of GasLink's go-to-market strategy. Spent a year in hands-on LPG distribution operations before co-founding GasLink — bringing operational ground truth to every product decision. Designed and built GasLink's core platform — from multi-tenant GST infrastructure to real-time driver operations — turning domain expertise into enterprise-grade software.", img: '/founders/suneel.jpg' }, { n: 'Bhargava Mannava', r: 'Co-Founder — Business & Commercial Officer', d: 'SRM University · HCL Technologies alumnus. A decade of hands-on LPG distribution operations — the commercial DNA behind GasLink. Deep expertise in business development, customer relationships, and enterprise operations. The voice of the customer inside the product, turning distributor and customer insights into the commercial engine that drives the platform.', img: '/founders/bhargava.jpg' }].map((m, i) => (
              <Reveal key={i} delay={i * .1} className="h-full"><div className="h-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center hover:border-flame-300 dark:hover:border-flame-500/30 transition-colors"><img src={m.img} alt={m.n} className="h-24 w-24 rounded-full mx-auto mb-5 object-cover ring-4 ring-white dark:ring-slate-800" /><h3 className="font-extrabold text-xl">{m.n}</h3><p className="text-sm text-flame-500 font-semibold mb-3">{m.r}</p><p className="text-sm text-slate-500 dark:text-slate-400">{m.d}</p></div></Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ─── FAQ ───────────────────────────────────────────────────────── */}
      <section id="faq" className="py-24 px-6 lg:px-12 xl:px-20 bg-white/80 dark:bg-slate-950/80">
        <div className="max-w-3xl mx-auto">
          <Reveal><div className="text-center mb-14"><span className="text-xs font-bold text-flame-500 uppercase tracking-widest">FAQ</span><h2 className="text-4xl lg:text-5xl font-extrabold mt-3">Frequently Asked Questions</h2></div></Reveal>
          {[{ q: 'How quickly can I get started?', a: '15 minutes. Sign up, add customers and cylinder types, go live.' }, { q: 'Do I need software?', a: 'No. Cloud-based, any browser. Mobile apps for drivers and customers.' }, { q: 'Is my data secure?', a: '256-bit encryption, tenant isolation, daily backups, full audit trails.' }, { q: 'How does GST e-invoicing work?', a: 'WhiteBooks GSP integration — one-click IRN e-invoices and e-Way Bills.' }, { q: 'Can customers see orders?', a: 'Yes, B2B self-service portal for orders, invoices, payments, GST docs.' }, { q: 'Free trial?', a: 'First 3 weeks free. No credit card. Cancel anytime.' }, { q: 'Multiple agencies?', a: 'Yes. HP, Bharat, Indane — all from one account.' }, { q: 'Support?', a: 'WhatsApp support, onboarding assistance, training sessions.' }].map((f, i) => <FaqItem key={i} q={f.q} a={f.a} />)}
        </div>
      </section>

      {/* ─── CTA ───────────────────────────────────────────────────────── */}
      <section id="contact" className="py-24 px-6 lg:px-12 xl:px-20 bg-slate-50/80 dark:bg-slate-900/40">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-16 items-start">
            <Reveal><div><span className="text-xs font-bold text-flame-500 uppercase tracking-widest">Get Started</span><h2 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-6 leading-tight">One Platform.<br />Every Workflow.<br /><span className="text-flame-500">Zero Hassle.</span></h2><p className="text-slate-500 dark:text-slate-400 text-lg mb-10 leading-relaxed">Join 500+ distributors. First 3 weeks free.</p><div className="space-y-4">{['No credit card required', 'Setup in 15 minutes', 'Free onboarding & training', 'Dedicated WhatsApp support', 'Cancel anytime'].map((item, i) => <div key={i} className="flex items-center gap-3"><HiOutlineCheckCircle className="h-5 w-5 text-emerald-500 shrink-0" /><span className="text-slate-600 dark:text-slate-300 font-medium">{item}</span></div>)}</div></div></Reveal>
            <Reveal delay={.2}><div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 lg:p-10"><h3 className="text-xl font-bold mb-6">Claim 3 Weeks Free</h3><ContactForm /></div></Reveal>
          </div>
        </div>
      </section>

      {/* ─── Footer ────────────────────────────────────────────────────── */}
      <footer className="py-16 px-6 lg:px-12 xl:px-20 border-t border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-10 mb-12">
            <div className="md:col-span-2"><div className="flex items-center gap-2.5 mb-4"><img src="/logo.png" alt="MyGasLink" className="h-8 w-8 rounded-lg object-contain" /><span className="text-base font-extrabold">MyGas<span className="text-flame-500">Link</span></span></div><p className="text-sm text-slate-500 max-w-sm leading-relaxed">India&apos;s most comprehensive LPG distribution management platform.</p></div>
            <div><h4 className="font-bold mb-4">Product</h4><div className="space-y-3">{['Features', 'Pricing', 'Mobile App', 'API'].map(l => <p key={l} className="text-sm text-slate-500 hover:text-flame-500 cursor-pointer transition-colors">{l}</p>)}</div></div>
            <div><h4 className="font-bold mb-4">Company</h4><div className="space-y-3">{['About', 'Blog', 'Contact'].map(l => <p key={l} className="text-sm text-slate-500 hover:text-flame-500 cursor-pointer transition-colors">{l}</p>)}<Link to="/privacy" className="block text-sm text-slate-500 hover:text-flame-500 transition-colors">Privacy</Link><Link to="/terms" className="block text-sm text-slate-500 hover:text-flame-500 transition-colors">Terms</Link></div></div>
          </div>
          <div className="border-t border-slate-200 dark:border-slate-800 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-slate-400 space-y-1 text-center sm:text-left">
              <p>&copy; {new Date().getFullYear()} GasLink Consulting Solutions</p>
              <p>GSTIN: 36ABCFG7518A1ZQ</p>
              <p>Bachupally, Hyderabad, Telangana – 500090</p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400">
              <Link to="/privacy" className="hover:text-flame-500 transition-colors">Privacy Policy</Link>
              <span aria-hidden="true">·</span>
              <Link to="/terms" className="hover:text-flame-500 transition-colors">Terms of Service</Link>
              <span aria-hidden="true">·</span>
              <a href="mailto:info@mygaslink.com" className="hover:text-flame-500 transition-colors">info@mygaslink.com</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
