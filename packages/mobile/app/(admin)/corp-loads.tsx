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
interface AvgLandedCost { avgPerCyl: number; totalCyls: number; windowDays: number }
interface CostLayer {
  cylinderTypeId: string; cylinderTypeName: string; purchaseEntryId: string | null;
  date?: string; grossRate: number | string; landedRate: number | string; qtyRemaining: number;
}
interface CostLayersResponse {
  totalRemainingQty: number; totalValue: number; uncostedQty: number; openLayers: CostLayer[];
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
  const { data: avgLanded } = useApiQuery<AvgLandedCost>(
    ['corp-avg-landed', corpId],
    `/purchase-payments/landed-cost/avg/${corpId}`,
    { days: 30 },
    { enabled: Boolean(corpId) },
  );
  const { data: costLayers, isLoading: costLayersLoading, refetch: refetchCostLayers } =
    useApiQuery<CostLayersResponse>(['cost-layers'], '/purchase-payments/cost-layers');

  const rows = useMemo(() => {
    const all = ledger?.rows ?? [];
    return typeFilter === 'all' ? all : all.filter((r) => r.kind === typeFilter);
  }, [ledger, typeFilter]);

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

        {/* Summary chips */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <SummaryChip label="Outstanding" value={formatINR(toNum(activeBalance?.outstanding))}
            hint={toNum(activeBalance?.outstanding) > 0.005 ? 'You owe' : 'Settled'}
            tone={toNum(activeBalance?.outstanding) > 0.005 ? 'warn' : 'ok'} {...{ cardBg, text, muted, border }} />
          <SummaryChip label="Deposit Balance" value={formatINR(toNum(activeBalance?.totalDeposits))}
            hint="Refundable" tone="neutral" {...{ cardBg, text, muted, border }} />
          <SummaryChip label="Avg Landed / Cyl" value={formatINR(avgLanded?.avgPerCyl ?? 0)}
            hint={`Last ${avgLanded?.windowDays ?? 30}d · ${avgLanded?.totalCyls ?? 0} cyl`} tone="neutral" {...{ cardBg, text, muted, border }} />
          <SummaryChip label="Last Activity" value={activeBalance?.lastPurchaseDate ? formatDate(activeBalance.lastPurchaseDate) : '—'}
            hint="Latest purchase" tone="neutral" {...{ cardBg, text, muted, border }} />
        </View>

        {/* Date filter + type + download */}
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

        {/* Ledger */}
        <Text style={{ fontSize: 13, fontWeight: '700', color: muted, letterSpacing: 0.4, marginTop: 4 }}>LEDGER</Text>
        {ledgerLoading ? (
          <Text style={{ color: muted, paddingVertical: 20, textAlign: 'center' }}>Loading ledger…</Text>
        ) : rows.length === 0 ? (
          <Card style={{ backgroundColor: cardBg }}>
            <Text style={{ color: muted, textAlign: 'center', paddingVertical: 16 }}>
              No entries in this period. Tap + to add one.
            </Text>
          </Card>
        ) : (
          rows.map((r) => {
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
          })
        )}

        {/* Cost Layer Ledger */}
        <Text style={{ fontSize: 13, fontWeight: '700', color: muted, letterSpacing: 0.4, marginTop: 8 }}>COST LAYERS · LANDED COST</Text>
        <Card style={{ backgroundColor: cardBg }}>
          {costLayersLoading && !costLayers ? (
            <Text style={{ color: muted, paddingVertical: 12 }}>Loading valuation…</Text>
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: muted, fontWeight: '600' }}>STOCK VALUE (LANDED)</Text>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: text, marginTop: 2 }}>{formatINR(toNum(costLayers?.totalValue))}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: muted, fontWeight: '600' }}>FULLS IN STOCK</Text>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: text, marginTop: 2 }}>{toNum(costLayers?.totalRemainingQty)}</Text>
                </View>
              </View>
              {toNum(costLayers?.uncostedQty) > 0 && (
                <View style={{
                  marginTop: 10, padding: 10, borderRadius: 8, borderWidth: 1,
                  borderColor: dark ? '#78350f' : '#fcd34d', backgroundColor: dark ? 'rgba(180,83,9,0.15)' : '#fffbeb',
                }}>
                  <Text style={{ color: dark ? '#fcd34d' : '#92400e', fontSize: 12, fontWeight: '600' }}>
                    ⚠ {toNum(costLayers?.uncostedQty)} cyl uncosted — enter opening stock / purchase rate for exact COGS.
                  </Text>
                </View>
              )}
              <View style={{ height: 1, backgroundColor: border, marginVertical: 10 }} />
              {(costLayers?.openLayers ?? []).length === 0 ? (
                <Text style={{ color: muted, fontSize: 13 }}>No open cost layers yet.</Text>
              ) : (
                (costLayers?.openLayers ?? []).map((L, i) => {
                  const gross = toNum(L.grossRate);
                  const landed = toNum(L.landedRate);
                  return (
                    <View key={`${L.purchaseEntryId ?? 'open'}-${L.cylinderTypeId}-${i}`} style={{
                      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
                      paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border,
                    }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: text }}>
                          {L.cylinderTypeName}{L.purchaseEntryId == null ? <Text style={{ fontSize: 11, color: muted, fontWeight: '500' }}>  · opening</Text> : null}
                        </Text>
                        <Text style={{ fontSize: 12, color: muted, marginTop: 2 }}>{L.qtyRemaining} left{L.date ? ` · ${formatDate(L.date)}` : ''}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: text }}>{formatINR(landed)}</Text>
                        <Text style={{ fontSize: 11, color: muted, marginTop: 2 }}>{landed !== gross ? `landed · gross ${formatINR(gross)}` : 'landed /cyl'}</Text>
                      </View>
                    </View>
                  );
                })
              )}
            </>
          )}
        </Card>
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
      {entryOpen && (
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
