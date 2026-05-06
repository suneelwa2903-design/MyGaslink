import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowLeft,
  HiOutlineUsers,
  HiOutlineServerStack,
  HiOutlineCurrencyRupee,
  HiOutlineChartBarSquare,
  HiOutlineDocumentArrowDown,
  HiOutlinePlus,
} from 'react-icons/hi2';
import type { Distributor, BillingCycle } from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { api } from '@/lib/api';
import { Badge, Button, Loader, Modal, Select } from '@/components/ui';

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

interface SeatLimits {
  plan: string;
  limits: Record<string, { allowed: number; used: number; extraPrice: number }> | null;
  gstApi: { included: number; overagePrice: number };
  customerPortalPrice: number;
}

interface GstUsage {
  month: number;
  year: number;
  irnCallCount: number;
  ewbCallCount: number;
  totalCalls: number;
  allocatedCalls: number;
  overageCount: number;
}

interface GstUsageHistory {
  month: number;
  year: number;
  totalCalls: number;
  allocatedCalls: number;
  irnCallCount: number;
  ewbCallCount: number;
}

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PROVIDER_COLORS: Record<string, string> = {
  IOCL: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  HPCL: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  BPCL: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  GOGAS: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  SUPERGAS: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  TOTALGAS: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  OTHERS: 'bg-surface-100 text-surface-700 dark:bg-surface-700 dark:text-surface-300',
};

export default function DistributorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [generateOpen, setGenerateOpen] = useState(false);

  const { data: distributor, isLoading: distLoading } = useQuery({
    queryKey: ['distributor', id],
    queryFn: () => apiGet<Distributor>(`/distributors/${id}`),
    enabled: !!id,
  });

  // Super_admin viewing another distributor's detail page: pass the URL :id
  // through the X-Distributor-Id header for these per-request fetches so the
  // backend resolves to the right tenant. (The auth-store selectedDistributorId
  // may differ from the URL id when navigating between distributors.)
  const overrideForId = id ? { distributorIdOverride: id } : undefined;

  const { data: seatData } = useQuery({
    queryKey: ['seat-limits', id],
    queryFn: () => apiGet<SeatLimits>(`/pricing/seat-limits`, undefined, overrideForId),
    enabled: !!id,
  });

  const { data: gstUsageData } = useQuery({
    queryKey: ['gst-usage', id],
    queryFn: () => apiGet<{ usage: GstUsage }>(`/pricing/gst-usage`, undefined, overrideForId),
    select: (d) => d.usage,
    enabled: !!id,
  });

  const { data: gstHistory } = useQuery({
    queryKey: ['gst-history', id],
    queryFn: () => apiGet<{ history: GstUsageHistory[] }>(`/pricing/gst-usage/history`, undefined, overrideForId),
    select: (d) => d.history,
    enabled: !!id,
  });

  const { data: billingCycles } = useQuery({
    queryKey: ['billing-cycles-dist', id],
    queryFn: () => apiGet<{ cycles: BillingCycle[] }>('/billing/cycles', undefined, overrideForId),
    select: (d) => d.cycles,
    enabled: !!id,
  });

  const handleDownloadInvoice = async (cycleId: string) => {
    try {
      const res = await api.get(`/pricing/billing-invoice/${cycleId}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `gaslink-invoice-${cycleId.slice(-6)}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download invoice');
    }
  };

  if (distLoading) {
    return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
  }

  if (!distributor) {
    return <div className="text-center py-20 text-surface-500">Distributor not found</div>;
  }

  const seatLimits = seatData?.limits || {};
  const totalPaid = billingCycles?.filter(c => c.billingStatus === 'paid').reduce((s, c) => s + c.totalAmountInclGst, 0) || 0;
  const totalPending = billingCycles?.filter(c => c.billingStatus !== 'paid').reduce((s, c) => s + c.totalAmountInclGst, 0) || 0;
  const totalUsers = Object.values(seatLimits).reduce((s, l) => s + l.used, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button onClick={() => navigate('/app/distributors')} className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700">
          <HiOutlineArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">{distributor.businessName}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-surface-500 dark:text-surface-400">{distributor.legalName} &middot; GSTIN: {distributor.gstin || 'N/A'}</span>
            {(distributor.providerCodes || []).map(code => (
              <span key={code} className={`text-xs px-2 py-0.5 rounded-full font-medium ${PROVIDER_COLORS[code] || PROVIDER_COLORS.OTHERS}`}>{code}</span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={distributor.status === 'active' ? 'success' : 'danger'}>{distributor.status}</Badge>
          {distributor.subscriptionPlan && <Badge variant="info">{distributor.subscriptionPlan}</Badge>}
          <Button onClick={() => setGenerateOpen(true)}>
            <HiOutlinePlus className="h-4 w-4" /> Generate Invoice
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard icon={HiOutlineUsers} label="Active Users" value={String(totalUsers)} color="brand" />
        <SummaryCard icon={HiOutlineServerStack} label="GST API Calls" value={`${gstUsageData?.totalCalls || 0} / ${gstUsageData?.allocatedCalls || 0}`} color="accent" />
        <SummaryCard icon={HiOutlineCurrencyRupee} label="Total Paid" value={formatCurrency(totalPaid)} color="green" />
        <SummaryCard icon={HiOutlineCurrencyRupee} label="Pending Amount" value={formatCurrency(totalPending)} color={totalPending > 0 ? 'red' : 'green'} />
      </div>

      {/* Seat Usage */}
      {Object.keys(seatLimits).length > 0 && (
        <div className="card p-5">
          <h2 className="text-lg font-semibold text-surface-900 dark:text-white mb-4 flex items-center gap-2">
            <HiOutlineUsers className="h-5 w-5 text-brand-500" /> Seat Usage
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Object.entries(seatLimits).map(([role, data]) => (
              <div key={role} className="rounded-lg border border-surface-200 dark:border-surface-700 p-4">
                <p className="text-xs text-surface-500 capitalize">{role.replace('_', ' ')}</p>
                <div className="flex items-end gap-1 mt-1">
                  <span className="text-2xl font-bold text-surface-900 dark:text-white">{data.used}</span>
                  <span className="text-sm text-surface-400 mb-0.5">/ {data.allowed}</span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${data.used >= data.allowed ? 'bg-red-500' : data.used >= data.allowed * 0.8 ? 'bg-amber-500' : 'bg-brand-500'}`}
                    style={{ width: `${Math.min(100, data.allowed > 0 ? (data.used / data.allowed) * 100 : 0)}%` }}
                  />
                </div>
                <p className="text-xs text-surface-400 mt-1">Extra: {formatCurrency(data.extraPrice)}/seat/mo</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* GST API Usage */}
      <div className="card p-5">
        <h2 className="text-lg font-semibold text-surface-900 dark:text-white mb-4 flex items-center gap-2">
          <HiOutlineChartBarSquare className="h-5 w-5 text-accent-500" /> GST API Usage
        </h2>
        {gstUsageData ? (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
            <div><p className="text-xs text-surface-500">IRN Calls</p><p className="text-xl font-bold text-surface-900 dark:text-white">{gstUsageData.irnCallCount}</p></div>
            <div><p className="text-xs text-surface-500">EWB Calls</p><p className="text-xl font-bold text-surface-900 dark:text-white">{gstUsageData.ewbCallCount}</p></div>
            <div><p className="text-xs text-surface-500">Total Calls</p><p className="text-xl font-bold text-surface-900 dark:text-white">{gstUsageData.totalCalls}</p></div>
            <div><p className="text-xs text-surface-500">Allocated</p><p className="text-xl font-bold text-surface-900 dark:text-white">{gstUsageData.allocatedCalls}</p></div>
            <div><p className="text-xs text-surface-500">Overage</p><p className={`text-xl font-bold ${gstUsageData.overageCount > 0 ? 'text-red-500' : 'text-green-500'}`}>{gstUsageData.overageCount}</p></div>
          </div>
        ) : (
          <p className="text-sm text-surface-500">No usage data yet.</p>
        )}
        {gstHistory && gstHistory.length > 0 && (
          <div>
            <p className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">Monthly History</p>
            <div className="flex items-end gap-1 h-24">
              {[...gstHistory].reverse().map((h) => {
                const pct = h.allocatedCalls > 0 ? Math.min(100, (h.totalCalls / h.allocatedCalls) * 100) : 0;
                return (
                  <div key={`${h.year}-${h.month}`} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full relative" style={{ height: '80px' }}>
                      <div
                        className={`absolute bottom-0 w-full rounded-t ${pct > 100 ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-brand-500'}`}
                        style={{ height: `${Math.max(4, pct * 0.8)}px` }}
                        title={`${h.totalCalls}/${h.allocatedCalls}`}
                      />
                    </div>
                    <span className="text-[10px] text-surface-400">{MONTH_NAMES[h.month]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Billing History */}
      <div className="card p-5">
        <h2 className="text-lg font-semibold text-surface-900 dark:text-white mb-4 flex items-center gap-2">
          <HiOutlineCurrencyRupee className="h-5 w-5 text-green-500" /> Billing History
        </h2>
        {!billingCycles?.length ? (
          <p className="text-sm text-surface-500">No billing cycles yet. Click "Generate Invoice" to create the first billing cycle.</p>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Period</th><th>Start</th><th>End</th><th>Excl GST</th><th>GST</th><th>Total</th><th>Due</th><th>Status</th><th>Invoice</th></tr></thead>
              <tbody>
                {billingCycles.map((cycle) => (
                  <tr key={cycle.cycleId}>
                    <td><Badge variant="neutral">{cycle.periodType}</Badge></td>
                    <td>{new Date(cycle.periodStartDate).toLocaleDateString('en-IN')}</td>
                    <td>{new Date(cycle.periodEndDate).toLocaleDateString('en-IN')}</td>
                    <td>{formatCurrency(cycle.totalAmountExclGst)}</td>
                    <td>{formatCurrency(cycle.totalGstAmount)}</td>
                    <td className="font-medium">{formatCurrency(cycle.totalAmountInclGst)}</td>
                    <td>{cycle.dueDate ? new Date(cycle.dueDate).toLocaleDateString('en-IN') : '-'}</td>
                    <td><Badge variant={cycle.billingStatus === 'paid' ? 'success' : cycle.billingStatus === 'overdue' ? 'danger' : 'warning'}>{cycle.billingStatus.replace(/_/g, ' ')}</Badge></td>
                    <td>
                      <button onClick={() => handleDownloadInvoice(cycle.cycleId)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500" title="Download Invoice PDF">
                        <HiOutlineDocumentArrowDown className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Distributor Info */}
      <div className="card p-5">
        <h2 className="text-lg font-semibold text-surface-900 dark:text-white mb-4">Distributor Details</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <InfoRow label="Business Name" value={distributor.businessName} />
          <InfoRow label="Legal Name" value={distributor.legalName} />
          <InfoRow label="GSTIN" value={distributor.gstin || 'N/A'} />
          <InfoRow label="City" value={`${distributor.city || ''}, ${distributor.state || ''}`} />
          <InfoRow label="Phone" value={distributor.phone || 'N/A'} />
          <InfoRow label="Email" value={distributor.email || 'N/A'} />
          <InfoRow label="GST Mode" value={distributor.gstMode} />
          <InfoRow label="Billing Tier" value={distributor.billingTier || 'N/A'} />
          <InfoRow label="Plan" value={distributor.subscriptionPlan || 'N/A'} />
          <InfoRow label="Billing Enabled" value={distributor.gaslinkBillingEnabled ? 'Yes' : 'No'} />
          <InfoRow label="Suspended" value={distributor.billingSuspended ? 'Yes' : 'No'} />
          <InfoRow label="Providers" value={(distributor.providerCodes || []).join(', ') || 'None'} />
        </div>
      </div>

      {/* Generate Invoice Modal */}
      {generateOpen && (
        <GenerateInvoiceModal
          distributorId={id!}
          distributor={distributor}
          lastCycleEndDate={billingCycles?.[0]?.periodEndDate}
          onClose={() => setGenerateOpen(false)}
          onSuccess={() => {
            setGenerateOpen(false);
            queryClient.invalidateQueries({ queryKey: ['billing-cycles-dist', id] });
          }}
        />
      )}
    </div>
  );
}

interface PricingTier {
  id: string;
  plan: string;
  monthlyPrice: number;
  quarterlyDiscount: number;
  halfYearlyDiscount: number;
  yearlyDiscount: number;
  adminSeats: number;
  financeSeats: number;
  inventorySeats: number;
  driverSeats: number;
  gstApiCallsIncluded: number;
  extraSeatPriceAdmin: number;
  extraSeatPriceDriver: number;
  customerPortalPrice: number;
  gstApiOveragePrice: number;
}

interface AddOn {
  type: string;
  label: string;
  unitPrice: number;
  quantity: number;
}

function GenerateInvoiceModal({ distributorId, distributor, lastCycleEndDate, onClose, onSuccess }: {
  distributorId: string;
  distributor: Distributor;
  lastCycleEndDate?: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'configure' | 'review'>('configure');
  const [plan, setPlan] = useState(distributor.subscriptionPlan || 'starter');
  const [periodType, setPeriodType] = useState('monthly');
  const [startDate, setStartDate] = useState(() => {
    if (lastCycleEndDate) {
      // Day after last billing period ends
      const d = new Date(lastCycleEndDate);
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    }
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split('T')[0];
  });
  const [addOns, setAddOns] = useState<AddOn[]>([]);

  // Fetch pricing tiers
  const { data: tiersData } = useQuery({
    queryKey: ['pricing-tiers'],
    queryFn: () => apiGet<{ tiers: PricingTier[] }>('/pricing/tiers'),
  });

  // Fetch current seat usage (kept warm in the cache for quick render in
  // future revisions of this page; not consumed in render right now).
  useQuery({
    queryKey: ['seat-limits', distributorId],
    queryFn: () => apiGet<SeatLimits>(`/pricing/seat-limits`, { distributorId }),
  });

  const tiers = tiersData?.tiers || [];
  const selectedTier = tiers.find(t => t.plan === plan);

  // Auto-calculate end date based on period type and start date
  const endDate = (() => {
    const d = new Date(startDate);
    const multiplierMap: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
    d.setMonth(d.getMonth() + (multiplierMap[periodType] || 1));
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  // Calculate cost preview
  const costPreview = (() => {
    if (!selectedTier) return null;
    const multiplierMap: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
    const multiplier = multiplierMap[periodType] || 1;
    const discountMap: Record<string, number> = {
      quarterly: selectedTier.quarterlyDiscount,
      half_yearly: selectedTier.halfYearlyDiscount,
      yearly: selectedTier.yearlyDiscount,
    };
    const discount = discountMap[periodType] || 0;

    const baseCost = selectedTier.monthlyPrice * multiplier;
    const addOnsCost = addOns.reduce((sum, a) => sum + a.unitPrice * a.quantity * multiplier, 0);
    const subtotal = baseCost + addOnsCost;
    const discountAmount = subtotal * discount / 100;
    const afterDiscount = subtotal - discountAmount;
    const gst = afterDiscount * 0.18;
    const total = afterDiscount + gst;

    return { baseCost, addOnsCost, subtotal, discount, discountAmount, afterDiscount, gst, total, multiplier };
  })();

  // Update plan on distributor before generating
  const updatePlanMutation = useMutation({
    mutationFn: () => api.put(`/distributors/${distributorId}`, {
      subscriptionPlan: plan,
      gaslinkBillingEnabled: true,
    }),
  });

  const generateMutation = useMutation({
    mutationFn: () => apiPost('/billing/generate', {
      distributorId,
      periodType,
      periodStartDate: startDate,
      periodEndDate: endDate,
    }),
    onSuccess: () => {
      toast.success('Invoice generated successfully');
      queryClient.invalidateQueries({ queryKey: ['billing-cycles-dist', distributorId] });
      queryClient.invalidateQueries({ queryKey: ['distributor', distributorId] });
      onSuccess();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  async function handleGenerate() {
    // First update the plan if changed
    if (plan !== distributor.subscriptionPlan) {
      await updatePlanMutation.mutateAsync();
    }
    generateMutation.mutate();
  }

  function addAddOn(type: string, label: string, unitPrice: number) {
    if (addOns.find(a => a.type === type)) return;
    setAddOns(prev => [...prev, { type, label, unitPrice, quantity: 1 }]);
  }

  function updateAddOnQty(type: string, qty: number) {
    if (qty <= 0) {
      setAddOns(prev => prev.filter(a => a.type !== type));
    } else {
      setAddOns(prev => prev.map(a => a.type === type ? { ...a, quantity: qty } : a));
    }
  }

  const isLoading = generateMutation.isPending || updatePlanMutation.isPending;

  return (
    <Modal open onClose={onClose} title="Generate Billing Invoice" size="lg">
      {step === 'configure' ? (
        <div className="space-y-5">
          {/* Plan Selection */}
          <div>
            <label className="block text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">Subscription Plan</label>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {tiers.map(tier => (
                <button
                  key={tier.plan}
                  onClick={() => setPlan(tier.plan)}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    plan === tier.plan
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 ring-1 ring-brand-500'
                      : 'border-surface-200 dark:border-surface-700 hover:border-surface-300'
                  }`}
                >
                  <p className="text-sm font-semibold capitalize text-surface-900 dark:text-white">{tier.plan}</p>
                  <p className="text-lg font-bold text-brand-600 dark:text-brand-400">{formatCurrency(tier.monthlyPrice)}<span className="text-xs text-surface-400">/mo</span></p>
                  <div className="text-[10px] text-surface-500 mt-1 space-y-0.5">
                    <p>{tier.adminSeats} admin, {tier.financeSeats} fin, {tier.inventorySeats} inv</p>
                    <p>{tier.driverSeats} drivers, {tier.gstApiCallsIncluded.toLocaleString()} API calls</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Period & Dates */}
          <div className="grid grid-cols-3 gap-4">
            <Select label="Billing Period" value={periodType} onChange={(e) => setPeriodType(e.target.value)}
              options={[
                { value: 'monthly', label: 'Monthly' },
                { value: 'quarterly', label: 'Quarterly (5% off)' },
                { value: 'half_yearly', label: 'Half Yearly (10% off)' },
                { value: 'yearly', label: 'Yearly (15% off)' },
              ]}
            />
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">Start Date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">End Date (auto)</label>
              <input type="date" value={endDate} disabled className="input bg-surface-50 dark:bg-surface-800" />
            </div>
          </div>

          {/* Add-Ons */}
          {selectedTier && (
            <div>
              <label className="block text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">Add-Ons (optional)</label>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {[
                  { type: 'extra_admin', label: 'Extra Admin Seat', price: selectedTier.extraSeatPriceAdmin },
                  { type: 'extra_finance', label: 'Extra Finance Seat', price: selectedTier.extraSeatPriceAdmin },
                  { type: 'extra_inventory', label: 'Extra Inventory Seat', price: selectedTier.extraSeatPriceAdmin },
                  { type: 'extra_driver_single', label: 'Extra Driver (1)', price: selectedTier.extraSeatPriceDriver },
                  { type: 'extra_driver', label: 'Extra Driver Pack (5)', price: selectedTier.extraSeatPriceDriver * 5 },
                ].map(ao => {
                  const existing = addOns.find(a => a.type === ao.type);
                  return (
                    <div key={ao.type} className={`p-3 rounded-lg border ${existing ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-surface-200 dark:border-surface-700'}`}>
                      <p className="text-xs font-medium text-surface-700 dark:text-surface-300">{ao.label}</p>
                      <p className="text-sm font-bold text-surface-900 dark:text-white">{formatCurrency(ao.price)}<span className="text-[10px] text-surface-400">/mo</span></p>
                      {existing ? (
                        <div className="flex items-center gap-2 mt-2">
                          <button onClick={() => updateAddOnQty(ao.type, existing.quantity - 1)} className="w-6 h-6 rounded bg-surface-200 dark:bg-surface-700 text-sm font-bold">−</button>
                          <span className="text-sm font-medium w-4 text-center">{existing.quantity}</span>
                          <button onClick={() => updateAddOnQty(ao.type, existing.quantity + 1)} className="w-6 h-6 rounded bg-surface-200 dark:bg-surface-700 text-sm font-bold">+</button>
                        </div>
                      ) : (
                        <button onClick={() => addAddOn(ao.type, ao.label, ao.price)} className="mt-2 text-xs text-brand-600 dark:text-brand-400 font-medium hover:underline">+ Add</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cost Preview */}
          {costPreview && (
            <div className="rounded-lg bg-surface-50 dark:bg-surface-800 p-4 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-surface-600 dark:text-surface-400">Base ({plan} × {costPreview.multiplier} mo)</span><span className="font-medium">{formatCurrency(costPreview.baseCost)}</span></div>
              {costPreview.addOnsCost > 0 && <div className="flex justify-between"><span className="text-surface-600 dark:text-surface-400">Add-ons</span><span className="font-medium">{formatCurrency(costPreview.addOnsCost)}</span></div>}
              {costPreview.discountAmount > 0 && <div className="flex justify-between text-green-600"><span>Discount ({costPreview.discount}%)</span><span>−{formatCurrency(costPreview.discountAmount)}</span></div>}
              <div className="flex justify-between"><span className="text-surface-600 dark:text-surface-400">GST (18%)</span><span className="font-medium">{formatCurrency(costPreview.gst)}</span></div>
              <div className="flex justify-between pt-2 border-t border-surface-200 dark:border-surface-700 text-base font-bold"><span>Total</span><span className="text-brand-600 dark:text-brand-400">{formatCurrency(costPreview.total)}</span></div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-surface-200 dark:border-surface-700">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => setStep('review')} disabled={!selectedTier}>Review & Confirm</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-4 space-y-3">
            <h3 className="font-semibold text-surface-900 dark:text-white">Confirm Invoice Generation</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-surface-500">Distributor</p><p className="font-medium text-surface-900 dark:text-white">{distributor.businessName}</p></div>
              <div><p className="text-surface-500">Plan</p><p className="font-medium text-surface-900 dark:text-white capitalize">{plan}</p></div>
              <div><p className="text-surface-500">Period</p><p className="font-medium text-surface-900 dark:text-white capitalize">{periodType.replace('_', ' ')}</p></div>
              <div><p className="text-surface-500">Duration</p><p className="font-medium text-surface-900 dark:text-white">{new Date(startDate).toLocaleDateString('en-IN')} — {new Date(endDate).toLocaleDateString('en-IN')}</p></div>
            </div>
            {addOns.length > 0 && (
              <div>
                <p className="text-xs text-surface-500 mb-1">Add-Ons:</p>
                <div className="flex flex-wrap gap-1">
                  {addOns.map(a => <Badge key={a.type} variant="info">{a.label} ×{a.quantity}</Badge>)}
                </div>
              </div>
            )}
            {plan !== distributor.subscriptionPlan && (
              <div className="flex items-center gap-2 p-2 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs">
                ⚠ Plan will be changed from <strong>{distributor.subscriptionPlan || 'none'}</strong> to <strong>{plan}</strong>
              </div>
            )}
          </div>

          {costPreview && (
            <div className="rounded-lg bg-surface-50 dark:bg-surface-800 p-4 text-center">
              <p className="text-sm text-surface-500">Invoice Total</p>
              <p className="text-3xl font-bold text-brand-600 dark:text-brand-400">{formatCurrency(costPreview.total)}</p>
              <p className="text-xs text-surface-400 mt-1">Incl. 18% GST</p>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-surface-200 dark:border-surface-700">
            <Button variant="secondary" onClick={() => setStep('configure')}>Back</Button>
            <Button onClick={handleGenerate} loading={isLoading}>Confirm & Generate Invoice</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SummaryCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    brand: 'text-brand-500 bg-brand-50 dark:bg-brand-900/20',
    accent: 'text-accent-500 bg-accent-50 dark:bg-accent-900/20',
    green: 'text-green-500 bg-green-50 dark:bg-green-900/20',
    red: 'text-red-500 bg-red-50 dark:bg-red-900/20',
  };
  return (
    <div className="card p-4 flex items-start gap-3">
      <div className={`p-2 rounded-lg ${colorMap[color] || colorMap.brand}`}><Icon className="h-5 w-5" /></div>
      <div><p className="text-xs text-surface-500">{label}</p><p className="text-lg font-bold text-surface-900 dark:text-white">{value}</p></div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-surface-500">{label}</p>
      <p className="font-medium text-surface-900 dark:text-white">{value}</p>
    </div>
  );
}
