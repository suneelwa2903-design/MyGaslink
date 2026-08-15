/**
 * Corp. Loads — full corporation ledger for a regular distributor_admin
 * (2026-08-13, Suneel). Mobile counterpart of the web CorporationLedgerPage.
 *
 * Layout (top → bottom):
 *   • Header + OMC picker (when the tenant has >1 corporation)
 *   • Summary chips — Outstanding / Deposit Balance / Avg Landed / Last Activity
 *   • Date-range + type filter + Download Statement (PDF) button
 *   • Ledger — every Incoming / Payment / CN / DN / Deposit / Outgoing (ERV)
 *     interleaved with a running Dr/Cr balance
 *   • Cost Layer Ledger — FIFO open loads + landed cost per cylinder type
 *
 * The "+" FAB opens the Add-Entry menu → the 6 modals in
 * src/components/corp/CorpEntryModals.tsx (same fields the web uses).
 * Distinct from the mini-operator Purchases tab, which stays a separate
 * lighter screen.
 */
import { useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { localDateISO } from '@gaslink/shared';
import { useApiQuery } from '../../src/hooks/useApi';
import { api, getErrorMessage } from '../../src/lib/api';
import { Card, DateInput, SelectField, EmptyState, todayLocalIso, type SelectOption } from '../../src/components/ui';
import { useIsDark } from '../../src/stores/themeStore';
import { formatINR, formatDate } from '../../src/theme';
import {
  AddEntryMenu, CorpEntryModalHost, type CorpEntryKind, type CorpContext,
} from '../../src/components/corp/CorpEntryModals';
import { StockMovementModal } from '../../src/components/inventory/StockMovementModal';

// ─── Types (mirror the API) ─────────────────────────────────────────────────

interface SupplierBalance {
  sourceDistributorId: string;
  name: string;
  outstanding: number | string;
  totalDeposits?: number | string;
  lastPurchaseDate?: string | null;
}
type LedgerKind =
  | 'purchase' | 'payment' | 'credit_note' | 'debit_note'
  | 'deposit' | 'erv_empties' | 'erv_defective';
interface LedgerRow {
  entryDate: string;
  kind: LedgerKind;
  documentId: string;
  documentNumber: string | null;
  supplierDocumentNumber?: string | null;
  narration: string;
  debit: number | string;
  credit: number | string;
  balance: number | string;
}
interface LedgerResponse {
  source: { id: string; name: string };
  rows: LedgerRow[];
  summary: {
    totalPurchased: number; totalPaid: number; totalCreditNotes: number;
    totalDebitNotes: number; totalDeposits: number; netOutstanding: number;
  };
}
interface CostLedgerRow {
  cylinderTypeId: string; cylinderTypeName: string; date: string; ref: string;
  purchaseEntryId: string | null;
  qtyReceived: number; qtyRemaining: number;
  grossRate: number; freightPerCyl: number; cnPerCyl: number; dnPerCyl: number; landedRate: number;
}
interface CostLedgerResponse {
  rows: CostLedgerRow[]; mrpByType: Record<string, number>;
  totalRemainingQty: number; totalValue: number;
}

const toNum = (v: number | string | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const KIND_LABELS: Record<LedgerKind, string> = {
  purchase: 'INCOMING',
  payment: 'PAYMENT',
  credit_note: 'CREDIT NOTE',
  debit_note: 'DEBIT NOTE',
  deposit: 'DEPOSIT',
  erv_empties: 'OUTGOING (EMPTIES)',
  erv_defective: 'OUTGOING (DEFECTIVE)',
};
const drCr = (balance: number): 'Dr' | 'Cr' => (balance > 0.005 ? 'Dr' : 'Cr');

const TYPE_FILTER_OPTS: SelectOption[] = [
  { value: 'all', label: 'All entries' },
  { value: 'purchase', label: 'Incoming (invoice)' },
  { value: 'payment', label: 'Payment' },
  { value: 'credit_note', label: 'Credit Note' },
  { value: 'debit_note', label: 'Debit Note' },
  { value: 'deposit', label: 'Deposit' },
  { value: 'erv_empties', label: 'Outgoing (empties)' },
  { value: 'erv_defective', label: 'Outgoing (defective)' },
];

// ─── Screen ─────────────────────────────────────────────────────────────────

export default function CorpLoadsScreen() {
  const dark = useIsDark();
  const insets = useSafeAreaInsets();
  const bg = dark ? '#0f172a' : '#f8fafc';
  const cardBg = dark ? '#1e293b' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e5e7eb';
  const accent = '#dc2626';

  const [activeCorpId, setActiveCorpId] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return localDateISO(d);
  });
  const [to, setTo] = useState(todayLocalIso());
  const [typeFilter, setTypeFilter] = useState('all');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState<CorpEntryKind | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Top tab — Ledger | MRP vs Landed (mirrors Billing's Invoices/Payments split).
  const [costTab, setCostTab] = useState<'ledger' | 'cost'>('ledger');

  const { data: balancesResp, isLoading: balancesLoading, refetch: refetchBalances } =
    useApiQuery<{ suppliers: SupplierBalance[] }>(['supplier-balances'], '/purchase-payments/supplier-balances');
  const balances = balancesResp?.suppliers ?? [];
  const corpId = activeCorpId || balances[0]?.sourceDistributorId || '';
  const activeBalance = balances.find((b) => b.sourceDistributorId === corpId);

  const { data: ledger, isLoading: ledgerLoading, refetch: refetchLedger } = useApiQuery<LedgerResponse>(
    ['corp-ledger', corpId, from, to],
    `/purchase-payments/supplier-ledger/${corpId}`,
    { from, to },
    { enabled: Boolean(corpId) },
  );
  // 2026-08-15 — the 30-day avg-landed chip was dropped (window meaningless);
  // the Cost Layer section now uses /cost-ledger (all loads + MRP + margin).
  const { data: costLedger, isLoading: costLayersLoading, refetch: refetchCostLayers } =
    useApiQuery<CostLedgerResponse>(['cost-layers'], '/purchase-payments/cost-ledger');

  // Picker data for the shared Incoming/Outgoing modal (same endpoints Godown uses).
  const { data: cylResp } = useApiQuery<{ cylinderTypes: { cylinderTypeId: string; typeName: string; isActive?: boolean }[] }>(
    ['cylinder-types'], '/cylinder-types',
  );
  const cylOptions = useMemo(
    () => (cylResp?.cylinderTypes ?? []).filter((c) => c.isActive !== false).map((c) => ({ id: c.cylinderTypeId, name: c.typeName })),
    [cylResp],
  );
  // 2026-08-15 — independent vehicle/driver pickers (all vehicles, all drivers),
  // matching web. Replaces the daily-mappings combo chips.
  const { data: vehResp } = useApiQuery<{ vehicles: { vehicleId: string; vehicleNumber: string }[] }>(
    ['vehicles-all'], '/vehicles',
  );
  const { data: drvResp } = useApiQuery<{ drivers: { driverName: string }[] }>(
    ['drivers-active'], '/drivers', { status: 'active' },
  );
  const vehiclesList = useMemo(() => vehResp?.vehicles ?? [], [vehResp]);
  const driversList = useMemo(() => drvResp?.drivers ?? [], [drvResp]);

  const rows = useMemo(() => {
    const all = ledger?.rows ?? [];
    return typeFilter === 'all' ? all : all.filter((r) => r.kind === typeFilter);
  }, [ledger, typeFilter]);

  // Cost Layer Ledger — group loads by cyl type → month, with per-type MRP + margin.
  // Mirrors the web CostLayerLedgerPanel grouping exactly.
  const costGroups = useMemo(() => {
    const data = costLedger;
    if (!data) return [];
    const types = new Map<string, { id: string; name: string; mrp: number; months: Map<string, CostLedgerRow[]> }>();
    for (const r of data.rows) {
      let t = types.get(r.cylinderTypeId);
      if (!t) {
        t = { id: r.cylinderTypeId, name: r.cylinderTypeName, mrp: data.mrpByType[r.cylinderTypeId] ?? 0, months: new Map() };
        types.set(r.cylinderTypeId, t);
      }
      const m = (r.date ?? '').slice(0, 7); // YYYY-MM
      const list = t.months.get(m) ?? [];
      list.push(r);
      t.months.set(m, list);
    }
    return [...types.values()].map((t) => {
      const all = [...t.months.values()].flat();
      const recv = all.reduce((s, r) => s + r.qtyReceived, 0);
      const landedVal = all.reduce((s, r) => s + r.landedRate * r.qtyReceived, 0);
      const avgLanded = recv > 0 ? landedVal / recv : 0;
      const rem = all.reduce((s, r) => s + r.qtyRemaining, 0);
      const remVal = all.reduce((s, r) => s + r.qtyRemaining * r.landedRate, 0);
      return { ...t, recv, avgLanded, avgMargin: t.mrp - avgLanded, rem, remVal };
    });
  }, [costLedger]);

  const refetchAll = () => { refetchBalances(); refetchLedger(); refetchCostLayers(); };

  async function downloadStatement() {
    if (!corpId) return;
    setDownloading(true);
    try {
      const res = await api.get(
        `/purchase-payments/supplier-ledger/${corpId}/statement.pdf`,
        { params: { from, to }, responseType: 'arraybuffer' },
      );
      const bytes = new Uint8Array(res.data as ArrayBuffer);
      const file = new File(Paths.cache, `corp-statement-${corpId.slice(0, 8)}-${from}-to-${to}.pdf`);
      try { file.create(); } catch { /* exists */ }
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device cannot share files.');
        return;
      }
      await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: 'Corp Statement', UTI: 'com.adobe.pdf' });
    } catch (err) {
      Alert.alert('Download failed', getErrorMessage(err as Error));
    } finally {
      setDownloading(false);
    }
  }

  if (balancesLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={accent} />
      </View>
    );
  }

  if (balances.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['left', 'right', 'bottom']}>
        <View style={{ padding: 20 }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: text, marginBottom: 12 }}>Corp. Loads</Text>
          <EmptyState
            title="No corporations yet"
            description="A super-admin needs to add your OMC provider codes (IOCL / HPCL / BPCL / GOGAS). They appear here as corporations on first save."
          />
        </View>
      </SafeAreaView>
    );
  }

  const corpOptions: SelectOption[] = balances.map((b) => ({ value: b.sourceDistributorId, label: b.name }));
  const corp: CorpContext = { sourceDistributorId: corpId, name: activeBalance?.name ?? 'Corporation' };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 100 }} showsVerticalScrollIndicator={false}>
        {/* Header + OMC picker */}
        <View>
          <Text style={{ fontSize: 22, fontWeight: '700', color: text }}>Corp. Loads</Text>
          <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>
            Every purchase, payment, CN, DN, deposit & ERV in one ledger.
          </Text>
        </View>
        {balances.length > 1 && (
          <SelectField label="Corporation" value={corpId} onChange={setActiveCorpId} options={corpOptions} />
        )}

        {/* Tab switcher at the very top — Ledger | MRP vs Landed (mirrors
            Billing's Invoices/Payments). The date/type/PDF filters + summary
            chips are ledger-only, so they live INSIDE the Ledger tab; the
            MRP vs Landed tab stays a clean cost-layer view. */}
        <View style={{
          flexDirection: 'row', backgroundColor: cardBg, borderRadius: 10,
          borderWidth: 1, borderColor: border, overflow: 'hidden',
        }}>
          {([['ledger', 'Ledger'], ['cost', 'MRP vs Landed']] as const).map(([key, label]) => {
            const active = costTab === key;
            return (
              <TouchableOpacity
                key={key}
                onPress={() => setCostTab(key)}
                style={{ flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: active ? accent : 'transparent' }}
              >
                <Text style={{ fontSize: 14, fontWeight: active ? '700' : '600', color: active ? '#fff' : muted }}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Tab: Ledger — filters + chips + entries ── */}
        {costTab === 'ledger' && (
          <>
            {/* Date range + entry type + PDF (ledger-only) */}
            <Card style={{ backgroundColor: cardBg }}>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: muted, marginBottom: 6 }}>From</Text>
                  <DateInput value={from} onChange={setFrom} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: muted, marginBottom: 6 }}>To</Text>
                  <DateInput value={to} onChange={setTo} />
                </View>
              </View>
              <View style={{ height: 10 }} />
              <SelectField label="Entry type" value={typeFilter} onChange={setTypeFilter} options={TYPE_FILTER_OPTS} />
              <TouchableOpacity
                onPress={downloadStatement}
                disabled={downloading}
                style={{
                  marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                  borderWidth: 1, borderColor: accent, borderRadius: 8, paddingVertical: 11,
                }}
              >
                {downloading ? <ActivityIndicator size="small" color={accent} /> : <Ionicons name="download-outline" size={18} color={accent} />}
                <Text style={{ color: accent, fontWeight: '700', fontSize: 14 }}>Download Statement (PDF)</Text>
              </TouchableOpacity>
            </Card>

            {/* Summary chips (corp financial + stock snapshot) */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <SummaryChip label="Outstanding" value={formatINR(toNum(activeBalance?.outstanding))}
                hint={toNum(activeBalance?.outstanding) > 0.005 ? 'You owe' : 'Settled'}
                tone={toNum(activeBalance?.outstanding) > 0.005 ? 'warn' : 'ok'} {...{ cardBg, text, muted, border }} />
              <SummaryChip label="Deposit Balance" value={formatINR(toNum(activeBalance?.totalDeposits))}
                hint="Refundable" tone="neutral" {...{ cardBg, text, muted, border }} />
              <SummaryChip label="Stock Value" value={formatINR(toNum(costLedger?.totalValue))}
                hint={`${costLedger?.totalRemainingQty ?? 0} cyl in stock · landed`} tone="neutral" {...{ cardBg, text, muted, border }} />
              <SummaryChip label="Last Activity" value={activeBalance?.lastPurchaseDate ? formatDate(activeBalance.lastPurchaseDate) : '—'}
                hint="Latest purchase" tone="neutral" {...{ cardBg, text, muted, border }} />
            </View>

            {/* Ledger entries */}
            {ledgerLoading ? (
            <Text style={{ color: muted, paddingVertical: 20, textAlign: 'center' }}>Loading ledger…</Text>
          ) : rows.length === 0 ? (
            <Card style={{ backgroundColor: cardBg }}>
              <Text style={{ color: muted, textAlign: 'center', paddingVertical: 16 }}>
                No entries in this period. Tap + to add one.
              </Text>
            </Card>
          ) : (
            <>
              {rows.map((r) => {
                const debit = toNum(r.debit);
                const credit = toNum(r.credit);
                const bal = toNum(r.balance);
                return (
                  <Card key={r.documentId + r.kind} style={{ backgroundColor: cardBg }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{
                        paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                        backgroundColor: dark ? 'rgba(220,38,38,0.12)' : 'rgba(220,38,38,0.06)',
                      }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: accent, letterSpacing: 0.3 }}>{KIND_LABELS[r.kind]}</Text>
                      </View>
                      <Text style={{ fontSize: 12, color: muted }}>{formatDate(r.entryDate)}</Text>
                    </View>
                    <Text style={{ fontSize: 14, color: text, marginTop: 6 }}>{r.narration}</Text>
                    {(r.supplierDocumentNumber ?? r.documentNumber) ? (
                      <Text style={{ fontSize: 11, color: muted, marginTop: 2 }}>Doc: {r.supplierDocumentNumber ?? r.documentNumber}</Text>
                    ) : null}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 8 }}>
                      <Text style={{ fontSize: 13, color: debit > 0 ? accent : (credit > 0 ? '#16a34a' : muted) }}>
                        {debit > 0 ? `Debit ${formatINR(debit)}` : credit > 0 ? `Credit ${formatINR(credit)}` : '—'}
                      </Text>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: text }}>
                        {formatINR(Math.abs(bal))} <Text style={{ fontSize: 12, color: muted }}>{drCr(bal)}</Text>
                      </Text>
                    </View>
                  </Card>
                );
              })}
            </>
            )}
          </>
        )}

        {/* ── Tab: MRP vs Landed (Cost Layer Ledger) — grouped by cyl type → month. ── */}
        {costTab === 'cost' && (
        <Card style={{ backgroundColor: cardBg, padding: 0, overflow: 'hidden' }}>
          {costLayersLoading && !costLedger ? (
            <Text style={{ color: muted, padding: 14 }}>Loading valuation…</Text>
          ) : costGroups.length === 0 ? (
            <Text style={{ color: muted, fontSize: 13, padding: 14 }}>No cost layers yet — record an incoming batch to build them.</Text>
          ) : (
            costGroups.map((t) => {
              const open = !collapsed.has(t.id);
              const marginColor = t.mrp <= 0 ? muted : t.avgMargin >= 0 ? (dark ? '#4ade80' : '#15803d') : (dark ? '#f87171' : '#dc2626');
              return (
                <View key={t.id}>
                  {/* Type header — blue, tappable, shows the roll-up summary. */}
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                      return next;
                    })}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 11,
                      backgroundColor: dark ? 'rgba(37,99,235,0.16)' : '#eff6ff',
                      borderTopWidth: 1, borderTopColor: border,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 15, fontWeight: '800', color: dark ? '#93c5fd' : '#1d4ed8' }}>
                        {open ? '▾' : '▸'}  {t.name}
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: text }}>{formatINR(t.remVal)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6, gap: 14 }}>
                      <Text style={{ fontSize: 11, color: muted }}>Recv <Text style={{ color: text, fontWeight: '600' }}>{t.recv}</Text></Text>
                      <Text style={{ fontSize: 11, color: muted }}>In stock <Text style={{ color: text, fontWeight: '600' }}>{t.rem}</Text></Text>
                      <Text style={{ fontSize: 11, color: muted }}>Avg landed <Text style={{ color: text, fontWeight: '600' }}>{formatINR(t.avgLanded)}</Text></Text>
                      <Text style={{ fontSize: 11, color: muted }}>MRP <Text style={{ color: text, fontWeight: '600' }}>{t.mrp > 0 ? formatINR(t.mrp) : '—'}</Text></Text>
                      <Text style={{ fontSize: 11, color: muted }}>Margin <Text style={{ color: marginColor, fontWeight: '700' }}>{t.mrp > 0 ? formatINR(t.avgMargin) : '—'}</Text></Text>
                    </View>
                  </TouchableOpacity>

                  {open && [...t.months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, loads]) => {
                    const sumRecv = loads.reduce((s, r) => s + r.qtyReceived, 0);
                    const sumLanded = loads.reduce((s, r) => s + r.landedRate * r.qtyReceived, 0);
                    const sumRem = loads.reduce((s, r) => s + r.qtyRemaining, 0);
                    const sumRemVal = loads.reduce((s, r) => s + r.qtyRemaining * r.landedRate, 0);
                    const monthLabel = month ? new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—';
                    return (
                      <View key={`${t.id}-${month}`}>
                        {/* Load rows — white / zebra. */}
                        {loads.map((r, i) => {
                          const gross = toNum(r.grossRate);
                          const landed = toNum(r.landedRate);
                          const adj = toNum(r.freightPerCyl) + toNum(r.dnPerCyl) - toNum(r.cnPerCyl);
                          return (
                            <View key={`${r.purchaseEntryId ?? 'open'}-${i}`} style={{
                              flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
                              paddingHorizontal: 14, paddingVertical: 8,
                              backgroundColor: i % 2 === 0 ? cardBg : (dark ? 'rgba(255,255,255,0.03)' : '#fafafa'),
                            }}>
                              <View style={{ flex: 1 }}>
                                <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>
                                  {r.date ? formatDate(r.date) : '—'}{r.ref ? <Text style={{ color: muted, fontWeight: '400' }}>  {r.ref}</Text> : null}
                                </Text>
                                <Text style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                                  {r.qtyReceived} recv · {r.qtyRemaining} left{adj !== 0 ? ` · gross ${formatINR(gross)}` : ''}
                                </Text>
                              </View>
                              <Text style={{ fontSize: 13, fontWeight: '700', color: text, marginLeft: 8 }}>{formatINR(landed)}</Text>
                            </View>
                          );
                        })}
                        {/* Month subtotal — amber. */}
                        <View style={{
                          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                          paddingHorizontal: 14, paddingVertical: 7,
                          backgroundColor: dark ? 'rgba(180,83,9,0.14)' : '#fffbeb',
                        }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: dark ? '#fcd34d' : '#92400e' }}>
                            {monthLabel} · {sumRecv} recv, {sumRem} left
                          </Text>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: dark ? '#fcd34d' : '#92400e' }}>
                            {formatINR(sumRecv > 0 ? sumLanded / sumRecv : 0)}/cyl · {formatINR(sumRemVal)}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              );
            })
          )}
        </Card>
        )}
      </ScrollView>

      {/* FAB → Add Entry */}
      <TouchableOpacity
        onPress={() => setAddMenuOpen(true)}
        activeOpacity={0.85}
        style={{
          position: 'absolute', right: 20, bottom: Math.max(insets.bottom + 12, 24),
          width: 56, height: 56, borderRadius: 28, backgroundColor: accent,
          alignItems: 'center', justifyContent: 'center',
          shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 5,
        }}
        accessibilityLabel="Add corp entry"
      >
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>

      {addMenuOpen && (
        <AddEntryMenu
          onClose={() => setAddMenuOpen(false)}
          onPick={(k) => { setAddMenuOpen(false); setEntryOpen(k); }}
        />
      )}
      {/* Incoming Fulls / Outgoing Empties → the SAME shared modal Godown uses,
          with the OMC context so incoming loads land on this corp's ledger. */}
      {(entryOpen === 'incoming_fulls' || entryOpen === 'outgoing_empties') && (
        <StockMovementModal
          key={entryOpen}
          visible
          mode={entryOpen === 'incoming_fulls' ? 'incoming' : 'outgoing'}
          onClose={() => setEntryOpen(null)}
          onSaved={() => { setEntryOpen(null); refetchAll(); }}
          cylinderOptions={cylOptions}
          vehicles={vehiclesList}
          drivers={driversList}
          defaultDate={todayLocalIso()}
          invalidateKeys={[['corp-ledger'], ['supplier-balances'], ['cost-layers'], ['corp-avg-landed'], ['inventory']]}
          sourceDistributorId={corpId}
          sourceName={activeBalance?.name}
        />
      )}
      {/* Payment / CN / DN / Deposit → corp-only modals. */}
      {entryOpen && entryOpen !== 'incoming_fulls' && entryOpen !== 'outgoing_empties' && (
        <CorpEntryModalHost
          kind={entryOpen}
          corp={corp}
          onClose={() => setEntryOpen(null)}
          onSaved={() => { setEntryOpen(null); refetchAll(); }}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Summary chip ───────────────────────────────────────────────────────────

function SummaryChip({
  label, value, hint, tone, cardBg, text, muted, border,
}: {
  label: string; value: string; hint: string; tone: 'ok' | 'warn' | 'neutral';
  cardBg: string; text: string; muted: string; border: string;
}) {
  const toneColor = tone === 'warn' ? '#dc2626' : tone === 'ok' ? '#16a34a' : muted;
  return (
    <View style={{
      flexGrow: 1, flexBasis: '46%', backgroundColor: cardBg, borderRadius: 12,
      borderWidth: 1, borderColor: border, padding: 12,
    }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: muted, letterSpacing: 0.3 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontSize: 17, fontWeight: '800', color: text, marginTop: 3 }} numberOfLines={1}>{value}</Text>
      <Text style={{ fontSize: 11, color: toneColor, marginTop: 2 }}>{hint}</Text>
    </View>
  );
}
