/**
 * Mini-Operator (2026-07-16) — Purchases mobile screen.
 *
 * Rendered under the (admin) route group but only surfaced as a tab
 * when user.role === 'mini_operator_admin' (see (admin)/_layout.tsx).
 *
 * Screen layout:
 *   • Suppliers panel (2026-07-19) — one row per source distributor
 *     with the "how much do I owe them" chip. Tap → supplier ledger
 *     modal. Tap "Pay" → record-payment sheet.
 *   • List of purchase entries — one Card per entry, with a paid/owed
 *     chip added 2026-07-19.
 *   • Floating "+ New Purchase Entry" button opens the entry modal-form.
 *
 * Payment flow (Mini-Operator 2026-07-19):
 *   • Payment sheet defaults to FIFO auto-allocation. Toggle to Manual
 *     lets the user pick specific purchase entries + per-entry amounts.
 *   • Server backfills PurchaseEntry.amountPaid inside the same tx.
 *   • Ledger modal shows the interleaved debit/credit view with a
 *     running balance — mirrors the customer-side ledger convention.
 */
import { useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Modal, StyleSheet, Alert,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { api } from '../../src/lib/api';
import { Card, EmptyState, DateInput, todayLocalIso, SelectField, type SelectOption } from '../../src/components/ui';
import { useIsDark } from '../../src/stores/themeStore';
import { formatINR } from '../../src/theme';

interface SourceDistributor {
  id: string;
  distributorId: string;
  name: string;
  createdAt: string;
  // 2026-07-23 — opening state returned by GET /source-distributors
  // (listSourceDistributors select). Wires the Edit-OB modal prefill.
  openingBalanceAmount?: number | string;
  openingStateSeededAt?: string | null;
  emptyOpenings?: Array<{
    cylinderTypeId: string;
    openingSeedQty: number;
    cylinderType?: { typeName: string } | null;
  }>;
}

// Decimal columns (unit_price, amount_paid, outstanding, etc.) are
// serialised as STRINGS by Prisma's JSON writer — not numbers. Without
// this coercion, math like `fullsReceived * unitPrice` string-concats
// instead of multiplying, and `formatINR("0")` renders "₹NaN". Every
// numeric field the API returns as a Decimal is typed as `number | string`
// here and read through `toNum` at every use site.
type Decimalish = number | string | null | undefined;
const toNum = (v: Decimalish): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

interface PurchaseEntryItem {
  id: string;
  cylinderTypeId: string;
  fullsReceived: number;
  emptiesGivenOut: number;
  unitPrice?: Decimalish;
  cylinderType?: { id: string; typeName: string } | null;
}

interface PurchaseEntry {
  id: string;
  // Internal auto-number (PSHD…). Kept for keys/drill-through ONLY —
  // never rendered. The OMC's own reference is what users see.
  purchaseNumber: string;
  supplierDocumentNumber: string | null;
  distributorId: string;
  sourceDistributorId: string | null;
  sourceDistributorName: string | null;
  purchaseDate: string;
  notes: string | null;
  createdAt: string;
  items: PurchaseEntryItem[];
  // 2026-07-19: server surfaces the running amountPaid so we can show
  // paid/owed at a glance. Undefined on entries created before the
  // schema addition — treat as 0 in that case.
  amountPaid?: Decimalish;
}

interface SupplierBalance {
  sourceDistributorId: string;
  name: string;
  totalPurchased: Decimalish;
  totalPaid: Decimalish;
  outstanding: Decimalish;
  lastPurchaseDate: string | null;
  lastPaymentDate: string | null;
}
interface SupplierBalancesResponse {
  suppliers: SupplierBalance[];
}

interface OutstandingEntry {
  purchaseEntryId: string;
  purchaseNumber: string; // internal — not rendered
  supplierDocumentNumber: string | null;
  purchaseDate: string;
  total: Decimalish;
  amountPaid: Decimalish;
  outstanding: Decimalish;
}
interface OutstandingEntriesResponse {
  entries: OutstandingEntry[];
}

interface SupplierLedgerRow {
  entryDate: string;
  kind: 'purchase' | 'payment';
  documentId: string;
  documentNumber: string | null;
  narration: string;
  debit: Decimalish;
  credit: Decimalish;
  balance: Decimalish;
}
interface SupplierLedgerResponse {
  source: { id: string; name: string };
  rows: SupplierLedgerRow[];
  summary: { totalPurchased: Decimalish; totalPaid: Decimalish; netOutstanding: Decimalish };
}

interface CylinderType {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  isActive: boolean;
}

interface CylinderTypesListResponse {
  cylinderTypes: CylinderType[];
}

interface PurchaseEntriesListResponse {
  purchaseEntries: PurchaseEntry[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

// Sort key for the entries list. Direction is a boolean per key (true =
// desc for numeric keys / z→a for text; false = asc / a→z). "date" +
// "amount" sort desc by default (newest / largest first); "source" +
// "type" sort asc (a-z).
type SortKey = 'date' | 'source' | 'type' | 'amount';

export default function PurchasesScreen() {
  const dark = useIsDark();
  const [modalOpen, setModalOpen] = useState(false);
  // 2026-07-19 v3: editEntry holds the row being edited when the modal
  // is opened via tap-to-edit on a card. Null = create mode.
  const [editEntry, setEditEntry] = useState<PurchaseEntry | null>(null);
  // 2026-07-19 v3: FAB now opens a chooser sheet — Add purchase OR
  // Record payment. Payment path then asks which supplier to pay
  // (source picker inline in the sheet). Existing per-supplier
  // Record Payment button at the bottom still works for the "pay THIS
  // supplier" case.
  const [fabSheetOpen, setFabSheetOpen] = useState(false);
  // 2026-07-19: payment sheet + ledger modal state. Each holds the
  // source distributor the user is acting on.
  const [payingSource, setPayingSource] = useState<SupplierBalance | null>(null);
  const [ledgerSource, setLedgerSource] = useState<SupplierBalance | null>(null);
  // 2026-07-23 — Edit-OB modal for existing supplier. Holds the picked
  // SourceDistributor from GET /source-distributors (which now returns
  // opening state fields for prefill).
  const [editingOpeningSource, setEditingOpeningSource] = useState<SourceDistributor | null>(null);

  // 2026-07-19 v2 — Filters + sort chips.
  const [filterSourceId, setFilterSourceId] = useState<string>('');
  const [filterCylinderTypeId, setFilterCylinderTypeId] = useState<string>('');
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterTo, setFilterTo] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDesc, setSortDesc] = useState<boolean>(true);

  // pageSize=100 is the server-side max (see listQuerySchema in
  // purchaseEntries.ts). We used to send 200 which failed Zod validation
  // silently → useApiQuery returned undefined → the screen showed the
  // "No purchase entries yet" empty state even though the DB had rows.
  const { data, isLoading, isError, error, refetch } = useApiQuery<PurchaseEntriesListResponse>(
    ['purchase-entries'],
    '/purchase-entries',
    { page: 1, pageSize: 100 },
  );
  const { data: suppliers, refetch: refetchSuppliers } = useApiQuery<SupplierBalancesResponse>(
    ['supplier-balances'],
    '/purchase-payments/supplier-balances',
  );
  const { data: sourceDistList, refetch: refetchSources } = useApiQuery<SourceDistributor[]>(
    ['source-distributors'],
    '/source-distributors',
  );
  const { data: cylinderTypesResp } = useApiQuery<CylinderTypesListResponse>(
    ['cylinder-types'],
    '/cylinder-types',
  );

  const rawRows = useMemo(() => data?.purchaseEntries ?? [], [data]);
  const supplierRows = useMemo(() => suppliers?.suppliers ?? [], [suppliers]);
  const cylinderTypes = useMemo(() => cylinderTypesResp?.cylinderTypes ?? [], [cylinderTypesResp]);
  const bg = dark ? '#0f172a' : '#f8fafc';
  const cardBg = dark ? '#1e293b' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e5e7eb';

  // Helper — compute per-entry outstanding for the chip. Every Decimal-
  // shaped field routes through toNum() because Prisma serialises them
  // as strings and JS's implicit coercion would leave `paid` as "0"
  // rather than 0, breaking every downstream comparison.
  const entryOwed = (e: PurchaseEntry): { total: number; owed: number; paid: number } => {
    const total = e.items.reduce(
      (s, it) => s + toNum(it.fullsReceived) * toNum(it.unitPrice),
      0,
    );
    const paid = toNum(e.amountPaid);
    return { total, paid, owed: Math.max(0, total - paid) };
  };

  // Unique cylinder-type badges per entry (dedup by cylinderTypeId).
  const entryTypeNames = (e: PurchaseEntry): string[] => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const it of e.items) {
      const name = it.cylinderType?.typeName;
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  };

  // Client-side filter — API returns all rows in one page.
  const filteredRows = useMemo(() => {
    return rawRows.filter((r) => {
      if (filterSourceId && r.sourceDistributorId !== filterSourceId) return false;
      if (filterCylinderTypeId
        && !r.items.some((it) => it.cylinderTypeId === filterCylinderTypeId)) return false;
      if (filterFrom && r.purchaseDate < filterFrom) return false;
      if (filterTo && r.purchaseDate > filterTo) return false;
      return true;
    });
  }, [rawRows, filterSourceId, filterCylinderTypeId, filterFrom, filterTo]);

  const sortedRows = useMemo(() => {
    const cmp = (a: PurchaseEntry, b: PurchaseEntry): number => {
      switch (sortKey) {
        case 'date':
          return a.purchaseDate.localeCompare(b.purchaseDate);
        case 'source':
          return (a.sourceDistributorName ?? '').localeCompare(b.sourceDistributorName ?? '');
        case 'type':
          return (entryTypeNames(a).join(',')).localeCompare(entryTypeNames(b).join(','));
        case 'amount':
          return entryOwed(a).total - entryOwed(b).total;
      }
    };
    const arr = [...filteredRows].sort(cmp);
    return sortDesc ? arr.reverse() : arr;
  }, [filteredRows, sortKey, sortDesc]);

  const rows = sortedRows;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      // Sensible defaults: numeric + date default to desc; text asc.
      setSortDesc(key === 'date' || key === 'amount');
    }
  };
  const arrowFor = (key: SortKey): string => {
    if (sortKey !== key) return '';
    return sortDesc ? ' ↓' : ' ↑';
  };

  const sourceFilterOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: 'All suppliers' },
      ...supplierRows.map((s) => ({ value: s.sourceDistributorId, label: s.name })),
    ],
    [supplierRows],
  );
  const cylinderTypeFilterOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: 'All cylinder types' },
      ...cylinderTypes.filter((t) => t.isActive).map((t) => ({ value: t.cylinderTypeId, label: t.typeName })),
    ],
    [cylinderTypes],
  );

  const filtersActive = !!(filterSourceId || filterCylinderTypeId || filterFrom || filterTo);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontSize: 22, fontWeight: '700', color: text }}>Purchases</Text>
            <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>
              Stock received from source distributors.
            </Text>
          </View>
        </View>

        {/* Error banner — surfaces API failures (401, 400 validation,
            5xx) that would otherwise show as an empty "No entries"
            state. Regression fix for the pageSize=200 silent-fail bug
            (2026-07-19): the server capped pageSize at 100 and rejected
            larger values with a 400 that the UI never surfaced. */}
        {isError && (
          <View style={{
            padding: 12, borderRadius: 10, borderWidth: 1,
            borderColor: '#dc2626',
            backgroundColor: dark ? 'rgba(220,38,38,0.12)' : 'rgba(220,38,38,0.06)',
          }}>
            <Text style={{ color: '#dc2626', fontSize: 13, fontWeight: '700', marginBottom: 4 }}>
              Could not load purchase entries
            </Text>
            <Text style={{ color: dark ? '#fca5a5' : '#991b1b', fontSize: 12 }}>
              {error instanceof Error ? error.message : 'Unknown error — pull to refresh or try again.'}
            </Text>
          </View>
        )}

        {/* 2026-07-19 v2 — Filters + sort. Collapsible card so the
            entries list stays scannable when no filter is active. */}
        <Card style={{ backgroundColor: cardBg }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: muted, letterSpacing: 0.4, marginBottom: 8 }}>
            FILTERS
          </Text>
          <SelectField
            label="Supplier"
            value={filterSourceId}
            onChange={setFilterSourceId}
            options={sourceFilterOptions}
          />
          <View style={{ height: 8 }} />
          <SelectField
            label="Cylinder type"
            value={filterCylinderTypeId}
            onChange={setFilterCylinderTypeId}
            options={cylinderTypeFilterOptions}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <View style={{ flex: 1 }}>
              <DateInput label="From" value={filterFrom} onChange={setFilterFrom} />
            </View>
            <View style={{ flex: 1 }}>
              <DateInput label="To" value={filterTo} onChange={setFilterTo} />
            </View>
          </View>
          {filtersActive && (
            <TouchableOpacity
              onPress={() => {
                setFilterSourceId(''); setFilterCylinderTypeId('');
                setFilterFrom(''); setFilterTo('');
              }}
              style={{
                marginTop: 10, alignSelf: 'flex-start',
                paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
                borderWidth: 1, borderColor: border,
              }}
            >
              <Text style={{ color: muted, fontSize: 12, fontWeight: '600' }}>Reset filters</Text>
            </TouchableOpacity>
          )}
        </Card>

        {/* Sort-by chip row. Tapping the active chip toggles the
            direction; tapping another chip switches key and resets to
            its sensible default direction. Arrow reflects current
            direction so the mobile equivalent of "click the column
            header to sort" reads at a glance. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Text style={{ color: muted, fontSize: 12, alignSelf: 'center' }}>Sort by:</Text>
          {(['date', 'source', 'type', 'amount'] as SortKey[]).map((k) => {
            const active = sortKey === k;
            const label = k === 'date' ? 'Date'
              : k === 'source' ? 'Supplier'
              : k === 'type' ? 'Cylinder type'
              : 'Amount';
            return (
              <TouchableOpacity
                key={k}
                onPress={() => toggleSort(k)}
                activeOpacity={0.7}
                style={{
                  paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
                  borderWidth: 1,
                  borderColor: active ? '#dc2626' : border,
                  backgroundColor: active ? (dark ? 'rgba(220,38,38,0.12)' : 'rgba(220,38,38,0.08)') : 'transparent',
                }}
              >
                <Text
                  style={{
                    color: active ? '#dc2626' : text,
                    fontSize: 12, fontWeight: '600',
                  }}
                >
                  {label}{arrowFor(k)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Entries header + count — always visible so the user sees at
            a glance whether the list is populated (fixes the "I don't
            see any entries" confusion when the Suppliers + Filters
            cards push the list below the fold). */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: muted, letterSpacing: 0.4 }}>
            ENTRIES ({rows.length}{filtersActive && rawRows.length !== rows.length ? ` / ${rawRows.length}` : ''})
          </Text>
          {rows.length > 0 && (
            <TouchableOpacity onPress={() => { refetch(); refetchSuppliers(); }}>
              <Text style={{ fontSize: 12, color: '#dc2626', fontWeight: '600' }}>Refresh</Text>
            </TouchableOpacity>
          )}
        </View>

        {isLoading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <Text style={{ color: muted }}>Loading…</Text>
          </View>
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtersActive ? 'No entries match your filters' : 'No purchase entries yet'}
            description={filtersActive ? 'Try clearing filters, or record a new stock-in.' : 'Tap the + button to record your first stock-in.'}
          />
        ) : (
          rows.map((row) => {
            const { total, owed, paid } = entryOwed(row);
            const typeNames = entryTypeNames(row);
            // 2026-07-19 v3 — the whole card is tappable to open edit
            // mode. Small edit affordance in the header hints that the
            // row is interactive (matches the web edit button).
            const openEdit = () => { setEditEntry(row); setModalOpen(true); };
            return (
              <TouchableOpacity
                key={row.id}
                onPress={openEdit}
                activeOpacity={0.75}
                accessibilityLabel={`Edit purchase ${row.supplierDocumentNumber ?? row.purchaseDate}`}
              >
              <Card style={{ backgroundColor: cardBg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 14, fontFamily: 'monospace', color: text }}>
                      {row.supplierDocumentNumber ?? '—'}
                    </Text>
                    <Ionicons name="pencil" size={12} color={muted} />
                  </View>
                  <Text style={{ fontSize: 12, color: muted }}>{row.purchaseDate}</Text>
                </View>
                <Text style={{ marginTop: 6, fontSize: 14, fontWeight: '600', color: text }}>
                  {row.sourceDistributorName ?? '— no source —'}
                </Text>
                {/* 2026-07-19 v2 — cylinder type badges at card top so
                    users can scan types without opening the entry. */}
                {typeNames.length > 0 && (
                  <View style={{ marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {typeNames.map((n) => (
                      <View
                        key={n}
                        style={{
                          paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
                          backgroundColor: dark ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.08)',
                          borderWidth: 1, borderColor: dark ? 'rgba(59,130,246,0.3)' : 'rgba(59,130,246,0.2)',
                        }}
                      >
                        <Text style={{ fontSize: 11, color: '#3b82f6', fontWeight: '600' }}>
                          {n}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
                {row.items.map((it) => (
                  <View key={it.id} style={{ marginTop: 6, flexDirection: 'row', gap: 12 }}>
                    <Text style={{ fontSize: 13, color: text, flex: 1 }}>
                      {it.cylinderType?.typeName ?? 'Cylinder'}
                    </Text>
                    <Text style={{ fontSize: 13, color: text }}>
                      +{it.fullsReceived} fulls
                    </Text>
                    <Text style={{ fontSize: 13, color: text }}>
                      −{it.emptiesGivenOut} empties
                    </Text>
                  </View>
                ))}
                {/* 2026-07-19 paid/owed chip — only visible when there is
                    an amount owed on the entry (unitPrice > 0). */}
                {total > 0 && (
                  <View
                    style={{
                      marginTop: 10,
                      paddingTop: 8,
                      borderTopWidth: 1,
                      borderTopColor: dark ? '#334155' : '#e5e7eb',
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: muted }}>
                      Total {formatINR(total)} · Paid {formatINR(paid)}
                    </Text>
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '700',
                        color: owed > 0 ? '#dc2626' : '#10b981',
                      }}
                    >
                      {owed > 0 ? `${formatINR(owed)} owed` : 'PAID'}
                    </Text>
                  </View>
                )}
                {row.notes && (
                  <Text style={{ marginTop: 8, fontSize: 12, color: muted, fontStyle: 'italic' }}>
                    {row.notes}
                  </Text>
                )}
              </Card>
              </TouchableOpacity>
            );
          })
        )}

      </ScrollView>

      {/* Floating FAB — v3 (2026-07-19): opens a chooser sheet so the
          user can pick between "Add purchase" and "Record payment"
          without scrolling down to the Suppliers panel. */}
      <TouchableOpacity
        onPress={() => setFabSheetOpen(true)}
        activeOpacity={0.8}
        style={[styles.fab, { backgroundColor: '#dc2626' }]}
        accessibilityLabel="New Purchase or Record Payment"
      >
        <Ionicons name="add" size={30} color="#ffffff" />
      </TouchableOpacity>

      {fabSheetOpen && (
        <FabChooserSheet
          suppliers={supplierRows}
          sourceDistList={sourceDistList ?? []}
          onClose={() => setFabSheetOpen(false)}
          onPickPurchase={() => {
            setFabSheetOpen(false);
            setEditEntry(null);
            setModalOpen(true);
          }}
          onPickPayment={(supplier) => {
            setFabSheetOpen(false);
            setPayingSource(supplier);
          }}
          onPickLedger={(supplier) => {
            setFabSheetOpen(false);
            setLedgerSource(supplier);
          }}
          onPickEditOpening={(source) => {
            setFabSheetOpen(false);
            setEditingOpeningSource(source);
          }}
        />
      )}

      {editingOpeningSource && (
        <EditSupplierOpeningModal
          source={editingOpeningSource}
          cylinderTypes={cylinderTypes}
          onClose={() => setEditingOpeningSource(null)}
          onSaved={() => {
            setEditingOpeningSource(null);
            refetch();
            refetchSuppliers();
            refetchSources();
          }}
        />
      )}

      <NewPurchaseModal
        // Forces a fresh remount whenever the target entry changes,
        // so the modal's lazy useState initializers pick up the new
        // subject's values (replaces the deprecated
        // useEffect-with-setState "sync form to prop" pattern).
        key={editEntry?.id ?? 'new'}
        open={modalOpen}
        editEntry={editEntry}
        onClose={() => { setModalOpen(false); setEditEntry(null); }}
        onCreated={() => {
          setModalOpen(false);
          setEditEntry(null);
          refetch();
          refetchSuppliers();
        }}
      />

      {payingSource && (
        <RecordPaymentModal
          source={payingSource}
          onClose={() => setPayingSource(null)}
          onRecorded={() => {
            setPayingSource(null);
            refetch();
            refetchSuppliers();
          }}
        />
      )}

      {ledgerSource && (
        <SupplierLedgerModal
          source={ledgerSource}
          onClose={() => setLedgerSource(null)}
        />
      )}
    </SafeAreaView>
  );
}

function NewPurchaseModal({
  open,
  onClose,
  onCreated,
  editEntry,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  // 2026-07-19: when provided, the modal opens in EDIT mode and PUTs
  // `/purchase-entries/:id` instead of POSTing to /purchase-entries.
  // The mobile modal only supports single-item entries (matches the
  // create path); if the entry has multiple items, we render the first
  // for editing and warn the user in the header.
  editEntry?: PurchaseEntry | null;
}) {
  const dark = useIsDark();
  const isEdit = !!editEntry;
  // 2026-07-19 — form-state initialization via lazy useState initializers
  // reading from editEntry. Parent forces a remount whenever editEntry.id
  // changes by passing `key={editEntry?.id ?? 'new'}`, so these
  // initializers ALWAYS see the correct subject. This replaces the prior
  // useEffect-with-setState "sync form to prop" pattern that tripped the
  // react-hooks/set-state-in-effect rule.
  const editItem = editEntry?.items[0];
  const [purchaseDate, setPurchaseDate] = useState<string>(
    () => editEntry?.purchaseDate ?? todayLocalIso(),
  );
  const [sourceDistributorId, setSourceDistributorId] = useState<string>(
    () => editEntry?.sourceDistributorId ?? '',
  );
  // 2026-07-23 — inline "+ Add Supplier" toggle. Renders the
  // AddSupplierModal that mirrors the web SupplierModal.
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [cylinderTypeId, setCylinderTypeId] = useState<string>(
    () => editItem?.cylinderTypeId ?? '',
  );
  const [fullsReceived, setFullsReceived] = useState<string>(
    () => String(editItem?.fullsReceived ?? 0),
  );
  const [emptiesGivenOut, setEmptiesGivenOut] = useState<string>(
    () => String(editItem?.emptiesGivenOut ?? 0),
  );
  // 2026-07-19: per-unit price the reseller paid, matches web form.
  // Defaults empty → server treats as 0 (movement-only entry).
  const [unitPrice, setUnitPrice] = useState<string>(() => {
    const price = toNum(editItem?.unitPrice);
    return price > 0 ? String(price) : '';
  });
  const [notes, setNotes] = useState<string>(() => editEntry?.notes ?? '');

  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e2e8f0';

  const { data: sources } = useApiQuery<SourceDistributor[]>(
    ['source-distributors'],
    '/source-distributors',
  );
  const { data: typesResponse } = useApiQuery<CylinderTypesListResponse>(
    ['cylinder-types'],
    '/cylinder-types',
  );

  // GET /api/cylinder-types wraps the array as { cylinderTypes: [...] } — the
  // web PurchasesPage hit the same trap. Unwrap here so the filter/map paths
  // see a plain array.
  const activeTypes = useMemo(
    () => (typesResponse?.cylinderTypes ?? []).filter((t) => t.isActive),
    [typesResponse],
  );

  const sourceOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: '— optional —' },
      ...(sources ?? []).map((s) => ({ value: s.id, label: s.name })),
    ],
    [sources],
  );
  const typeOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: 'Select cylinder…' },
      ...activeTypes.map((t) => ({ value: t.cylinderTypeId, label: t.typeName })),
    ],
    [activeTypes],
  );

  // Two-mode mutation — POST when creating, PUT when editing an
  // existing entry. Shared invalidate list so both paths refresh the
  // list + supplier balances + supplier ledgers + outstanding-entries.
  // The ledger + outstanding lists derive from the same server state
  // the mutation writes to (unit_price, source_distributor_id), so
  // dropping them from the invalidate list would show stale numbers
  // in the SupplierLedgerModal / Record-Payment sheet until a manual
  // refresh. CLAUDE.md anti-pattern #18 — same trap as the recording-
  // payment path fixed alongside this one.
  const invalidateKeys: string[][] = [
    ['purchase-entries'],
    ['inventory-summary'],
    ['supplier-balances'],
    // Broad key — TanStack Query invalidates every key that STARTS
    // with this prefix, so any sub-key like ['supplier-ledger',
    // sourceId] gets refreshed regardless of which supplier the
    // edited entry belongs to.
    ['supplier-ledger'],
    ['outstanding-entries'],
  ];
  const createMut = useApiMutation<PurchaseEntry, unknown>('post', '/purchase-entries', {
    invalidateKeys,
    successMessage: 'Purchase entry recorded',
    onSuccess: () => onCreated(),
  });
  const editMut = useApiMutation<PurchaseEntry, unknown>(
    'put',
    () => `/purchase-entries/${editEntry?.id ?? ''}`,
    {
      invalidateKeys,
      successMessage: 'Purchase entry updated',
      onSuccess: () => onCreated(),
    },
  );
  const mutation = isEdit ? editMut : createMut;

  // Live line-total preview so the user sees fullsReceived × unitPrice
  // update as they type — matches the web form's tabular-nums cell.
  const fullsN = Math.max(0, parseInt(fullsReceived, 10) || 0);
  const priceN = Math.max(0, parseFloat(unitPrice) || 0);
  const lineTotal = fullsN * priceN;

  const handleSubmit = () => {
    if (!cylinderTypeId) {
      Alert.alert('Missing cylinder type', 'Please pick a cylinder type.');
      return;
    }
    const emptiesN = Math.max(0, parseInt(emptiesGivenOut, 10) || 0);
    if (fullsN === 0 && emptiesN === 0) {
      Alert.alert('Empty entry', 'Enter at least one non-zero quantity.');
      return;
    }
    mutation.mutate({
      sourceDistributorId: sourceDistributorId || undefined,
      purchaseDate,
      notes: notes.trim() || undefined,
      items: [
        {
          cylinderTypeId,
          fullsReceived: fullsN,
          emptiesGivenOut: emptiesN,
          // Always include unitPrice on edit so the user can also
          // CLEAR a previously-set price back to 0; only omit on
          // create when the user left the field blank so the schema
          // default (0) applies.
          ...(isEdit || priceN > 0 ? { unitPrice: priceN } : {}),
        },
      ],
    });
  };

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['top', 'left', 'right', 'bottom']}>
        <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Cancel">
            <Text style={{ fontSize: 16, color: muted }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 17, fontWeight: '700', color: text }} numberOfLines={1}>
            {isEdit ? `Edit ${editEntry?.supplierDocumentNumber ?? 'Entry'}` : 'New Purchase Entry'}
          </Text>
          <TouchableOpacity onPress={handleSubmit} disabled={mutation.isPending} accessibilityLabel="Save">
            <Text style={{ fontSize: 16, color: mutation.isPending ? muted : '#dc2626', fontWeight: '600' }}>
              {mutation.isPending ? '…' : 'Save'}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          {/* Multi-item edit safety — the mobile modal only edits one
              line. If the entry has more than one item, warn the user
              so they don't lose data by saving through this UI. */}
          {isEdit && (editEntry?.items.length ?? 0) > 1 && (
            <View style={{
              padding: 10, borderRadius: 8,
              borderWidth: 1, borderColor: '#f59e0b',
              backgroundColor: dark ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.06)',
            }}>
              <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '700' }}>
                Multi-line entry — mobile edits only the first line
              </Text>
              <Text style={{ color: dark ? '#fcd34d' : '#92400e', fontSize: 11, marginTop: 2 }}>
                To edit the other lines, use the web app.
              </Text>
            </View>
          )}
          <DateInput label="Purchase Date" value={purchaseDate} onChange={setPurchaseDate} />

          {/* 2026-07-23 — Supplier row with inline "+ Add" so the operator
              can register a new source distributor without leaving the
              purchase-entry modal. Mirrors web PurchasesPage exactly:
              same POST /source-distributors + same shared schema (name-only).
              The + Add button opens AddSupplierModal below; on success
              the new row is selected automatically and the picker
              refreshes via TanStack invalidation of ['source-distributors']. */}
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>Source Distributor</Text>
              <TouchableOpacity
                onPress={() => setShowAddSupplier(true)}
                accessibilityLabel="Add new supplier"
                style={{ paddingVertical: 4, paddingHorizontal: 8 }}
              >
                <Text style={{ fontSize: 13, color: '#dc2626', fontWeight: '600' }}>+ Add</Text>
              </TouchableOpacity>
            </View>
            <SelectField
              label=""
              value={sourceDistributorId}
              onChange={setSourceDistributorId}
              options={sourceOptions}
            />
          </View>

          <SelectField
            label="Cylinder Type"
            value={cylinderTypeId}
            onChange={setCylinderTypeId}
            options={typeOptions}
          />

          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>
                Fulls received
              </Text>
              <TextInput
                value={fullsReceived}
                onChangeText={setFullsReceived}
                keyboardType="number-pad"
                style={{
                  borderWidth: 1,
                  borderColor: border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 16,
                  color: text,
                  backgroundColor: bg,
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>
                Empties given out
              </Text>
              <TextInput
                value={emptiesGivenOut}
                onChangeText={setEmptiesGivenOut}
                keyboardType="number-pad"
                style={{
                  borderWidth: 1,
                  borderColor: border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 16,
                  color: text,
                  backgroundColor: bg,
                }}
              />
            </View>
          </View>

          {/* 2026-07-19 — Unit price + live line total. Matches the web
              form's per-item Unit Price / Line Total columns so the
              reseller records what they paid per full received, and
              downstream (Supplier ledger + amountPaid) can reconcile. */}
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>
                Unit price (₹, optional)
              </Text>
              {lineTotal > 0 && (
                <Text style={{ fontSize: 12, color: muted }}>
                  Line total: {formatINR(lineTotal)}
                </Text>
              )}
            </View>
            <TextInput
              value={unitPrice}
              onChangeText={setUnitPrice}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={muted}
              style={{
                borderWidth: 1,
                borderColor: border,
                borderRadius: 8,
                padding: 12,
                fontSize: 16,
                color: text,
                backgroundColor: bg,
              }}
            />
            <Text style={{ fontSize: 11, color: muted, marginTop: 4, fontStyle: 'italic' }}>
              Leave empty for a movement-only entry (e.g. empties swap).
            </Text>
          </View>

          <View>
            <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>
              Notes (optional)
            </Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="e.g. Delivery from Sharma depot"
              placeholderTextColor={muted}
              multiline
              numberOfLines={3}
              style={{
                borderWidth: 1,
                borderColor: border,
                borderRadius: 8,
                padding: 12,
                fontSize: 15,
                color: text,
                backgroundColor: bg,
                minHeight: 72,
                textAlignVertical: 'top',
              }}
            />
          </View>
        </ScrollView>
      </SafeAreaView>

      {/* 2026-07-23 — nested full-screen supplier-add modal. Rendered
          on top of the parent purchase-entry modal so tapping "+ Add"
          doesn't discard entry-form state. On success the newly-created
          supplier is auto-selected and TanStack invalidation refreshes
          the picker options. */}
      {showAddSupplier && (
        <AddSupplierModal
          onClose={() => setShowAddSupplier(false)}
          onCreated={(id) => {
            setSourceDistributorId(id);
            setShowAddSupplier(false);
          }}
        />
      )}
    </Modal>
  );
}

// 2026-07-23 — full-screen modal for creating a source distributor
// from within the purchase-entry form. Mirrors web SupplierModal:
// name-only (createSourceDistributorSchema in @gaslink/shared). Uses
// the existing POST /source-distributors + invalidates
// ['source-distributors'] so both the create-form and the Suppliers
// panel refresh. Full-screen shape keeps the mobile UI scrollable
// and non-blocking — no clipped-height dropdown that hides keyboard
// or crowds neighbouring fields (see previous CreatePaymentModal fix).
function AddSupplierModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (sourceDistributorId: string) => void;
}) {
  const dark = useIsDark();
  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const border = dark ? '#334155' : '#e2e8f0';
  const muted = dark ? '#94a3b8' : '#64748b';
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 2026-07-23 — Optional opening balance ₹ owed to supplier at the
  // moment the mini-op starts tracking with this app. Follows-up the
  // create with POST /source-distributors/:id/seed-opening-state.
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingDate, setOpeningDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [seeding, setSeeding] = useState(false);
  // 2026-07-23 — Per-cylinder-type opening empties owed to supplier at
  // seed time. Keyed by cylinderTypeId; blank / 0 rows are dropped before
  // send. Same axis as the customer opening-state empties block.
  const [openingEmpties, setOpeningEmpties] = useState<Record<string, string>>({});
  const { data: cylinderTypesResp } = useApiQuery<{ cylinderTypes: { cylinderTypeId: string; typeName: string }[] }>(
    ['cylinder-types'],
    '/cylinder-types',
  );
  const cylinderTypes = cylinderTypesResp?.cylinderTypes ?? [];
  const createMut = useApiMutation<SourceDistributor, { name: string }>(
    'post',
    '/source-distributors',
    {
      // Invalidate broadly so every consumer refreshes: entry-form
      // picker, Suppliers panel, filter dropdown on the list tab.
      invalidateKeys: [['source-distributors'], ['supplier-balances']],
      // Suppress default toast — we surface a combined "supplier added +
      // opening balance seeded" message ourselves after the follow-up
      // seed call (if any) resolves.
      onSuccess: async (res) => {
        if (!res?.id) return;
        const obAmount = parseFloat(openingAmount);
        const hasOb = Number.isFinite(obAmount) && obAmount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(openingDate);
        const emptiesPayload = Object.entries(openingEmpties)
          .map(([cylinderTypeId, qtyStr]) => ({ cylinderTypeId, qty: parseInt(qtyStr, 10) }))
          .filter((row) => Number.isFinite(row.qty) && row.qty > 0);
        const hasEmpties = emptiesPayload.length > 0;
        if (hasOb || hasEmpties) {
          try {
            setSeeding(true);
            await api.post(`/source-distributors/${res.id}/seed-opening-state`, {
              amount: hasOb ? obAmount : 0,
              asOfDate: openingDate,
              empties: hasEmpties ? emptiesPayload : undefined,
            });
          } catch (err) {
            // Supplier was created successfully; the seed follow-up
            // failed. Show a warning but still route the parent picker
            // to the new supplier — the seed can be retried later.
            const msg = err instanceof Error ? err.message : String(err);
            setError(`Supplier saved. Opening balance seed failed: ${msg}`);
            setSeeding(false);
            return;
          }
          setSeeding(false);
        }
        onCreated(res.id);
      },
      onError: (err) => {
        // Duplicate-name 409 comes back as a route error; surface
        // inline instead of a toast so the user can retry with a
        // different name without losing context.
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg || 'Failed to add supplier');
      },
    },
  );
  const canSave = name.trim().length > 0 && !createMut.isPending && !seeding;
  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: bg }}>
          {/* Header */}
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderBottomColor: border,
          }}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={muted} />
            </TouchableOpacity>
            <Text style={{ fontSize: 18, fontWeight: '800', color: text }}>New Supplier</Text>
            <TouchableOpacity
              onPress={() => { setError(null); createMut.mutate({ name: name.trim() }); }}
              disabled={!canSave}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={{
                fontSize: 16,
                color: canSave ? '#dc2626' : muted,
                fontWeight: '600',
              }}>
                {createMut.isPending ? '…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Body — the name input autofocuses so the keyboard opens
              immediately, matching the fast-entry flow the reseller
              expects when they're mid-purchase and need to add a
              supplier "on the go". */}
          <ScrollView
            contentContainerStyle={{ padding: 20, gap: 16 }}
            keyboardShouldPersistTaps="handled"
          >
            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>
                Supplier name <Text style={{ color: '#dc2626' }}>*</Text>
              </Text>
              <TextInput
                value={name}
                onChangeText={(v) => { setName(v); setError(null); }}
                autoFocus
                placeholder="e.g. HPCL Kompally"
                placeholderTextColor={muted}
                style={{
                  borderWidth: 1,
                  borderColor: error ? '#dc2626' : border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 16,
                  color: text,
                  backgroundColor: bg,
                }}
                maxLength={100}
              />
              {error && (
                <Text style={{ fontSize: 12, color: '#dc2626' }}>{error}</Text>
              )}
              <Text style={{ fontSize: 12, color: muted }}>
                Max 100 characters. Unique per your tenant. Add more details
                later from the web app if needed.
              </Text>
            </View>

            {/* Mini-op #4 (2026-07-23) — Opening balance ₹ owed to this
                supplier at the moment you started tracking here. One-shot
                — leave blank if you don't owe them anything to start. */}
            <View style={{ gap: 6, marginTop: 4 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>
                Opening Balance Owed (₹) <Text style={{ color: muted, fontWeight: '400' }}>— optional</Text>
              </Text>
              <TextInput
                value={openingAmount}
                onChangeText={setOpeningAmount}
                placeholder="e.g. 5000"
                placeholderTextColor={muted}
                keyboardType="decimal-pad"
                style={{
                  borderWidth: 1,
                  borderColor: border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 16,
                  color: text,
                  backgroundColor: bg,
                }}
              />
              <Text style={{ fontSize: 13, fontWeight: '600', color: text, marginTop: 8 }}>
                As of (date)
              </Text>
              <TextInput
                value={openingDate}
                onChangeText={setOpeningDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={muted}
                style={{
                  borderWidth: 1,
                  borderColor: border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 16,
                  color: text,
                  backgroundColor: bg,
                }}
              />
              <Text style={{ fontSize: 12, color: muted }}>
                Seeded once as an &quot;Opening Balance b/f&quot; row on the supplier
                ledger so payments reconcile from day one. Skip if this is a
                brand-new supplier.
              </Text>
            </View>

            {/* 2026-07-23 — Opening empties owed to supplier, per cylinder
                type. Same axis as the customer opening-state empties block.
                Zero / blank rows are dropped before send. */}
            {cylinderTypes.length > 0 && (
              <View style={{ gap: 6, marginTop: 4 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>
                  Opening Empties Owed <Text style={{ color: muted, fontWeight: '400' }}>— optional</Text>
                </Text>
                <Text style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
                  How many empties of each type you already owe this supplier at start.
                </Text>
                {cylinderTypes.map((ct) => (
                  <View
                    key={ct.cylinderTypeId}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  >
                    <Text style={{ flex: 1, fontSize: 14, color: text }}>{ct.typeName}</Text>
                    <TextInput
                      value={openingEmpties[ct.cylinderTypeId] ?? ''}
                      onChangeText={(v) =>
                        setOpeningEmpties((prev) => ({ ...prev, [ct.cylinderTypeId]: v.replace(/[^0-9]/g, '') }))
                      }
                      placeholder="0"
                      placeholderTextColor={muted}
                      keyboardType="number-pad"
                      style={{
                        width: 100,
                        borderWidth: 1,
                        borderColor: border,
                        borderRadius: 8,
                        padding: 10,
                        fontSize: 15,
                        color: text,
                        backgroundColor: bg,
                        textAlign: 'right',
                      }}
                    />
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ─── Payment sheet (2026-07-19) ─────────────────────────────────────────
// Two modes:
//   • FIFO auto (default) — server allocates against oldest unpaid entries
//   • Manual override — user picks specific entries + per-entry amounts
// Zero explanation is served in-form; the user sees the FIFO preview
// (from /outstanding/:sourceId) so they can decide whether to override.

function RecordPaymentModal({
  source,
  onClose,
  onRecorded,
}: {
  source: SupplierBalance;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const dark = useIsDark();
  const [amount, setAmount] = useState<string>(toNum(source.outstanding).toFixed(2));
  const [transactionDate, setTransactionDate] = useState<string>(todayLocalIso());
  const [paymentMethod, setPaymentMethod] = useState<string>('cash');
  const [referenceNumber, setReferenceNumber] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [manualMode, setManualMode] = useState<boolean>(false);
  // Manual override state: entryId → amount string (empty = 0).
  const [manualAlloc, setManualAlloc] = useState<Record<string, string>>({});

  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e2e8f0';

  const { data: outstanding } = useApiQuery<OutstandingEntriesResponse>(
    ['outstanding-entries', source.sourceDistributorId],
    `/purchase-payments/outstanding/${source.sourceDistributorId}`,
  );
  const outstandingRows = outstanding?.entries ?? [];

  const methodOptions: SelectOption[] = [
    { value: 'cash', label: 'Cash' },
    { value: 'upi', label: 'UPI' },
    { value: 'bank_transfer', label: 'Bank transfer' },
    { value: 'cheque', label: 'Cheque' },
    { value: 'online', label: 'Online' },
  ];

  const manualSum = useMemo(() => {
    return Object.values(manualAlloc).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  }, [manualAlloc]);

  const create = useApiMutation<unknown, unknown>('post', '/purchase-payments', {
    // 2026-07-19 bugfix — must ALSO invalidate the supplier-ledger cache
    // for THIS supplier so the new payment shows up in the ledger modal
    // immediately. Without this, TanStack Query served the pre-payment
    // ledger and the payment row appeared missing until a hard refresh.
    // Same trap as CLAUDE.md anti-pattern #18 (missing invalidateKeys
    // entry for a query that reads from the same server state the
    // mutation writes to).
    invalidateKeys: [
      ['purchase-entries'],
      ['supplier-balances'],
      ['outstanding-entries', source.sourceDistributorId],
      ['supplier-ledger', source.sourceDistributorId],
    ],
    successMessage: 'Payment recorded',
    onSuccess: onRecorded,
  });

  const handleSubmit = () => {
    const amt = parseFloat(amount);
    if (!(amt > 0)) {
      Alert.alert('Amount required', 'Enter an amount greater than zero.');
      return;
    }
    let allocations: Array<{ purchaseEntryId: string; amount: number }> | undefined;
    if (manualMode) {
      allocations = Object.entries(manualAlloc)
        .map(([id, v]) => ({ purchaseEntryId: id, amount: parseFloat(v) || 0 }))
        .filter((a) => a.amount > 0);
      if (allocations.length === 0) {
        Alert.alert('No allocations', 'Distribute the payment across at least one entry.');
        return;
      }
      if (Math.abs(manualSum - amt) > 0.01) {
        Alert.alert(
          'Mismatch',
          `Allocations sum ${formatINR(manualSum)} does not match amount ${formatINR(amt)}.`,
        );
        return;
      }
    }
    create.mutate({
      sourceDistributorId: source.sourceDistributorId,
      transactionDate,
      amount: amt,
      paymentMethod,
      referenceNumber: referenceNumber.trim() || undefined,
      notes: notes.trim() || undefined,
      allocations,
    });
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['top', 'left', 'right', 'bottom']}>
        <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Cancel">
            <Text style={{ fontSize: 16, color: muted }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 17, fontWeight: '700', color: text }} numberOfLines={1}>
            Pay {source.name}
          </Text>
          <TouchableOpacity onPress={handleSubmit} disabled={create.isPending} accessibilityLabel="Save">
            <Text style={{ fontSize: 16, color: create.isPending ? muted : '#dc2626', fontWeight: '600' }}>
              {create.isPending ? '…' : 'Save'}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <View>
            <Text style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Outstanding to this supplier</Text>
            <Text style={{ fontSize: 22, fontWeight: '700', color: toNum(source.outstanding) > 0 ? '#dc2626' : '#10b981' }}>
              {formatINR(toNum(source.outstanding))}
            </Text>
          </View>

          <View>
            <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>Amount paid</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={muted}
              style={{
                borderWidth: 1, borderColor: border, borderRadius: 8,
                padding: 12, fontSize: 18, color: text, backgroundColor: bg,
              }}
            />
          </View>

          <DateInput label="Payment date" value={transactionDate} onChange={setTransactionDate} />

          <SelectField
            label="Method"
            value={paymentMethod}
            onChange={setPaymentMethod}
            options={methodOptions}
          />

          <View>
            <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>Reference (optional)</Text>
            <TextInput
              value={referenceNumber}
              onChangeText={setReferenceNumber}
              placeholder="Cheque #, UPI txn id…"
              placeholderTextColor={muted}
              style={{
                borderWidth: 1, borderColor: border, borderRadius: 8,
                padding: 12, fontSize: 15, color: text, backgroundColor: bg,
              }}
            />
          </View>

          <View>
            <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>Notes (optional)</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              style={{
                borderWidth: 1, borderColor: border, borderRadius: 8,
                padding: 12, fontSize: 15, color: text, backgroundColor: bg,
                minHeight: 72, textAlignVertical: 'top',
              }}
            />
          </View>

          {/* Allocation section — FIFO preview or manual override */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: text }}>
              {manualMode ? 'Manual allocation' : 'FIFO preview'}
            </Text>
            <TouchableOpacity
              onPress={() => setManualMode((m) => !m)}
              style={{
                paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
                borderWidth: 1, borderColor: border,
              }}
            >
              <Text style={{ fontSize: 12, color: text, fontWeight: '600' }}>
                {manualMode ? 'Use FIFO' : 'Distribute manually'}
              </Text>
            </TouchableOpacity>
          </View>

          {outstandingRows.length === 0 ? (
            <Text style={{ fontSize: 12, color: muted, fontStyle: 'italic' }}>
              No unpaid purchase entries — this payment will sit as an advance.
            </Text>
          ) : (
            outstandingRows.map((e) => {
              // Preview: what FIFO would allocate to this entry given the
              // current amount input. Consumed as we walk down the list.
              const cumulativeBefore = outstandingRows
                .slice(0, outstandingRows.indexOf(e))
                .reduce((s, x) => s + toNum(x.outstanding), 0);
              const amt = parseFloat(amount) || 0;
              const fifoTake = Math.max(0, Math.min(toNum(e.outstanding), amt - cumulativeBefore));
              return (
                <View
                  key={e.purchaseEntryId}
                  style={{
                    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: border,
                    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: text, fontFamily: 'monospace' }} numberOfLines={1}>
                      {e.supplierDocumentNumber ?? '—'}
                    </Text>
                    <Text style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                      {e.purchaseDate} · Owed {formatINR(toNum(e.outstanding))}
                    </Text>
                  </View>
                  {manualMode ? (
                    <TextInput
                      value={manualAlloc[e.purchaseEntryId] ?? ''}
                      onChangeText={(v) => setManualAlloc((m) => ({ ...m, [e.purchaseEntryId]: v }))}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={muted}
                      style={{
                        width: 100, textAlign: 'right',
                        borderWidth: 1, borderColor: border, borderRadius: 6,
                        padding: 8, fontSize: 14, color: text, backgroundColor: bg,
                      }}
                    />
                  ) : (
                    <Text
                      style={{
                        fontSize: 13, fontWeight: '600',
                        color: fifoTake > 0 ? '#10b981' : muted,
                      }}
                    >
                      {formatINR(fifoTake)}
                    </Text>
                  )}
                </View>
              );
            })
          )}

          {manualMode && (
            <View
              style={{
                marginTop: 4, padding: 10, borderRadius: 8,
                backgroundColor: dark ? 'rgba(148,163,184,0.08)' : '#f1f5f9',
                flexDirection: 'row', justifyContent: 'space-between',
              }}
            >
              <Text style={{ fontSize: 12, color: muted }}>Allocated so far</Text>
              <Text
                style={{
                  fontSize: 13, fontWeight: '700',
                  color: Math.abs(manualSum - (parseFloat(amount) || 0)) < 0.01 ? '#10b981' : '#dc2626',
                }}
              >
                {formatINR(manualSum)} / {formatINR(parseFloat(amount) || 0)}
              </Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Supplier ledger modal (2026-07-19) ─────────────────────────────────

function SupplierLedgerModal({
  source,
  onClose,
}: {
  source: SupplierBalance;
  onClose: () => void;
}) {
  const dark = useIsDark();
  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e2e8f0';

  // 2026-07-19 — force refetch on every open. Bhargavi ledger showed
  // the payment MISSING because TanStack Query served the pre-payment
  // response from cache when the modal reopened. `staleTime: 0` +
  // `refetchOnMount: 'always'` guarantees fresh data every time the
  // modal mounts. Companion to the invalidateKeys fix in the Record
  // Payment mutation. Same class as CLAUDE.md anti-pattern #18.
  const { data, isLoading, isFetching, refetch } = useApiQuery<SupplierLedgerResponse>(
    ['supplier-ledger', source.sourceDistributorId],
    `/purchase-payments/supplier-ledger/${source.sourceDistributorId}`,
    undefined,
    { staleTime: 0, refetchOnMount: 'always' },
  );

  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['top', 'left', 'right', 'bottom']}>
        <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close">
            <Text style={{ fontSize: 16, color: muted }}>Close</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 17, fontWeight: '700', color: text }} numberOfLines={1}>
            {source.name}
          </Text>
          <TouchableOpacity
            onPress={() => { void refetch(); }}
            disabled={isFetching}
            accessibilityLabel="Refresh"
            style={{ minWidth: 40, alignItems: 'flex-end' }}
          >
            <Ionicons
              name="refresh"
              size={20}
              color={isFetching ? muted : '#dc2626'}
            />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          {summary && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: dark ? 'rgba(148,163,184,0.08)' : '#f1f5f9' }}>
                <Text style={{ fontSize: 10, color: muted, letterSpacing: 0.4 }}>PURCHASED</Text>
                <Text style={{ fontSize: 14, fontWeight: '700', color: text, marginTop: 2 }} adjustsFontSizeToFit numberOfLines={1}>
                  {formatINR(toNum(summary.totalPurchased))}
                </Text>
              </View>
              <View style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: dark ? 'rgba(148,163,184,0.08)' : '#f1f5f9' }}>
                <Text style={{ fontSize: 10, color: muted, letterSpacing: 0.4 }}>PAID</Text>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#10b981', marginTop: 2 }} adjustsFontSizeToFit numberOfLines={1}>
                  {formatINR(toNum(summary.totalPaid))}
                </Text>
              </View>
              <View style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#dc2626' }}>
                <Text style={{ fontSize: 10, color: '#ffffff', letterSpacing: 0.4 }}>OUTSTANDING</Text>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#ffffff', marginTop: 2 }} adjustsFontSizeToFit numberOfLines={1}>
                  {formatINR(toNum(summary.netOutstanding))}
                </Text>
              </View>
            </View>
          )}

          {isLoading ? (
            <Text style={{ color: muted }}>Loading…</Text>
          ) : rows.length === 0 ? (
            <EmptyState title="No ledger entries" description="No purchases or payments yet." />
          ) : (
            rows.map((r) => (
              <View
                key={r.documentId + r.kind}
                style={{
                  padding: 12, borderRadius: 8, borderWidth: 1, borderColor: border,
                  flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: muted }}>{r.entryDate}</Text>
                  <Text style={{ fontSize: 13, color: text, fontWeight: '600', marginTop: 2 }} numberOfLines={2}>
                    {r.narration}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {r.kind === 'purchase' ? (
                    <Text style={{ color: '#dc2626', fontWeight: '700', fontSize: 13 }}>
                      +{formatINR(toNum(r.debit))}
                    </Text>
                  ) : (
                    <Text style={{ color: '#10b981', fontWeight: '700', fontSize: 13 }}>
                      −{formatINR(toNum(r.credit))}
                    </Text>
                  )}
                  <Text style={{ color: muted, fontSize: 11, marginTop: 2 }}>
                    bal {formatINR(toNum(r.balance))}
                  </Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── FAB chooser sheet (2026-07-19) ─────────────────────────────────────
// Renders a bottom-of-screen sheet with two primary actions and a
// supplier row-list underneath the payment action. Tap "Add purchase"
// → parent opens the create modal. Tap a supplier row under "Record
// payment" → parent opens the RecordPaymentModal for that supplier.
//
// Rationale (Suneel 2026-07-19): the per-supplier "Record Payment"
// button at the bottom of the page requires scrolling past every
// purchase entry, which is painful on a phone. The FAB is always
// visible, so surfacing payment recording from the FAB puts it one
// tap away regardless of scroll position.

// ─── Edit Supplier Opening Modal (mobile) ────────────────────────────
// Mini-op #4 (2026-07-23) — edit an EXISTING supplier's opening ₹ + per-
// cylinder-type empties. Prefill from the SourceDistributor prop (which
// carries openingBalanceAmount + emptyOpenings from the list endpoint).
// Routes to POST /seed-opening-state (first time) or PUT /opening-state
// (already seeded). Empties sent as a full-replace of the existing set.

function EditSupplierOpeningModal({
  source,
  cylinderTypes,
  onClose,
  onSaved,
}: {
  source: SourceDistributor;
  cylinderTypes: Array<{ cylinderTypeId: string; typeName: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dark = useIsDark();
  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const border = dark ? '#334155' : '#e2e8f0';
  const muted = dark ? '#94a3b8' : '#64748b';
  const wasSeeded = !!source.openingStateSeededAt;
  const [amount, setAmount] = useState(String(Number(source.openingBalanceAmount ?? 0)));
  const [asOfDate, setAsOfDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [empties, setEmpties] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (source.emptyOpenings ?? []).map((r) => [r.cylinderTypeId, String(r.openingSeedQty)]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const amt = parseFloat(amount);
      const validAmt = Number.isFinite(amt) && amt >= 0 ? amt : 0;
      const emptiesPayload = Object.entries(empties)
        .map(([cylinderTypeId, qtyStr]) => ({ cylinderTypeId, qty: parseInt(qtyStr, 10) }))
        .filter((row) => Number.isFinite(row.qty) && row.qty > 0);
      const path = wasSeeded
        ? `/source-distributors/${source.id}/opening-state`
        : `/source-distributors/${source.id}/seed-opening-state`;
      const method = wasSeeded ? 'put' : 'post';
      await api[method](path, { amount: validAmt, asOfDate, empties: emptiesPayload });
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: bg }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: border,
          }}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={muted} />
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: '800', color: text }}>
              {wasSeeded ? 'Edit Opening' : 'Seed Opening'} — {source.name}
            </Text>
            <TouchableOpacity onPress={handleSave} disabled={saving} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={{ fontSize: 16, color: saving ? muted : '#dc2626', fontWeight: '600' }}>
                {saving ? '…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>Opening Balance Owed (₹)</Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholder="e.g. 5000"
                placeholderTextColor={muted}
                style={{
                  borderWidth: 1, borderColor: border, borderRadius: 8, padding: 12,
                  fontSize: 16, color: text, backgroundColor: bg,
                }}
              />
            </View>

            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>As of (date)</Text>
              <TextInput
                value={asOfDate}
                onChangeText={setAsOfDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={muted}
                style={{
                  borderWidth: 1, borderColor: border, borderRadius: 8, padding: 12,
                  fontSize: 16, color: text, backgroundColor: bg,
                }}
              />
            </View>

            {cylinderTypes.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: text }}>
                  Opening Empties Owed — per cylinder type
                </Text>
                <Text style={{ fontSize: 12, color: muted }}>
                  Full replace on save — clearing a row sets it to 0.
                </Text>
                {cylinderTypes.map((ct) => (
                  <View key={ct.cylinderTypeId} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Text style={{ flex: 1, fontSize: 14, color: text }}>{ct.typeName}</Text>
                    <TextInput
                      value={empties[ct.cylinderTypeId] ?? ''}
                      onChangeText={(v) =>
                        setEmpties((prev) => ({ ...prev, [ct.cylinderTypeId]: v.replace(/[^0-9]/g, '') }))
                      }
                      placeholder="0"
                      placeholderTextColor={muted}
                      keyboardType="number-pad"
                      style={{
                        width: 100, borderWidth: 1, borderColor: border, borderRadius: 8, padding: 10,
                        fontSize: 15, color: text, backgroundColor: bg, textAlign: 'right',
                      }}
                    />
                  </View>
                ))}
              </View>
            )}

            {error && <Text style={{ fontSize: 12, color: '#dc2626' }}>{error}</Text>}
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function FabChooserSheet({
  suppliers,
  sourceDistList,
  onClose,
  onPickPurchase,
  onPickPayment,
  onPickLedger,
  onPickEditOpening,
}: {
  suppliers: SupplierBalance[];
  sourceDistList: SourceDistributor[];
  onClose: () => void;
  onPickPurchase: () => void;
  onPickPayment: (s: SupplierBalance) => void;
  // 2026-07-19 v4 — suppliers panel was removed from the bottom of the
  // Purchases screen per user feedback ("take out suppliers section
  // below doesn't make sense there"). The ledger action moved into
  // this sheet so nothing is lost: each supplier row now has a Pay
  // button (tap the row / Pay) and a Ledger icon on the right.
  onPickLedger: (s: SupplierBalance) => void;
  // 2026-07-23 — third per-row icon: edit opening balance / empties.
  onPickEditOpening: (source: SourceDistributor) => void;
}) {
  const dark = useIsDark();
  // 2026-07-28 (anti-pattern #25) — FAB action-sheet buttons clip under
  // Samsung 3-button nav without insets padding.
  const insets = useSafeAreaInsets();
  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e5e7eb';

  return (
    <Modal
      visible
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'flex-end',
        }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => { /* swallow taps inside the sheet */ }}
          style={{
            backgroundColor: bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: Math.max(insets.bottom + 8, 24),
            maxHeight: '75%',
          }}
        >
          {/* Grab handle */}
          <View
            style={{
              alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
              backgroundColor: dark ? '#475569' : '#cbd5e1',
              marginBottom: 12,
            }}
          />

          {/* Add purchase — primary action */}
          <TouchableOpacity
            onPress={onPickPurchase}
            activeOpacity={0.75}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 14,
              paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12,
              backgroundColor: '#dc2626',
              marginBottom: 8,
            }}
          >
            <View style={{
              width: 40, height: 40, borderRadius: 20,
              backgroundColor: 'rgba(255,255,255,0.18)',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Ionicons name="cart-outline" size={22} color="#ffffff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '700' }}>
                Add purchase
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>
                Record stock received from a supplier
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#ffffff" />
          </TouchableOpacity>

          {/* Record payment — expandable supplier list */}
          <View style={{
            borderWidth: 1, borderColor: border, borderRadius: 12, overflow: 'hidden',
          }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 14,
              paddingVertical: 12, paddingHorizontal: 12,
              backgroundColor: dark ? '#1e293b' : '#f8fafc',
              borderBottomWidth: 1, borderBottomColor: border,
            }}>
              <View style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: dark ? 'rgba(16,185,129,0.15)' : '#ecfdf5',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons name="cash-outline" size={22} color="#10b981" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: text, fontSize: 15, fontWeight: '700' }}>
                  Suppliers
                </Text>
                <Text style={{ color: muted, fontSize: 12 }}>
                  Tap a row to Pay · Tap the receipt icon for Ledger
                </Text>
              </View>
            </View>

            {suppliers.length === 0 ? (
              <View style={{ padding: 16 }}>
                <Text style={{ color: muted, fontSize: 12, fontStyle: 'italic' }}>
                  No suppliers yet — record a purchase first.
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 340 }} keyboardShouldPersistTaps="handled">
                {suppliers.map((s, idx) => (
                  <View
                    key={s.sourceDistributorId}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 8,
                      paddingVertical: 10, paddingHorizontal: 14,
                      borderBottomWidth: idx === suppliers.length - 1 ? 0 : 1,
                      borderBottomColor: border,
                    }}
                  >
                    {/* Row body — tap to open payment. Same target as
                        the primary "Pay" pill so muscle memory still
                        works from the older 3-button layout. */}
                    {/* 2026-07-19 v5 — CLEAR/OUTSTANDING chip removed
                        per user feedback: it looked tappable but was
                        just a status label, and tapping it took to the
                        payment modal (which was confusing). Owed
                        amount now colour-coded inline instead — green
                        when 0, red when > 0. */}
                    <TouchableOpacity
                      onPress={() => onPickPayment(s)}
                      activeOpacity={0.7}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                          {s.name}
                        </Text>
                        <Text style={{
                          color: toNum(s.outstanding) > 0 ? '#dc2626' : '#10b981',
                          fontSize: 11, marginTop: 2, fontWeight: '600',
                        }}>
                          Owed {formatINR(toNum(s.outstanding))}
                        </Text>
                      </View>
                    </TouchableOpacity>

                    {/* Pay pill — same action as tapping the row but
                        surfaces the action visually so first-time users
                        know it's tappable. */}
                    <TouchableOpacity
                      onPress={() => onPickPayment(s)}
                      activeOpacity={0.75}
                      accessibilityLabel={`Pay ${s.name}`}
                      style={{
                        paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                        backgroundColor: '#dc2626',
                      }}
                    >
                      <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '700' }}>
                        Pay
                      </Text>
                    </TouchableOpacity>

                    {/* Ledger icon — opens the SupplierLedgerModal for
                        this source. Replaces the standalone Ledger
                        button that used to live in the removed
                        Suppliers panel. */}
                    <TouchableOpacity
                      onPress={() => onPickLedger(s)}
                      activeOpacity={0.75}
                      accessibilityLabel={`View ${s.name} ledger`}
                      style={{
                        width: 34, height: 34, borderRadius: 8,
                        borderWidth: 1, borderColor: border,
                        alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="receipt-outline" size={16} color={text} />
                    </TouchableOpacity>

                    {/* 2026-07-23 — Edit-OB icon. Prefill data comes from
                        GET /source-distributors (sourceDistList). We
                        find the matching source row by ID. Falls back to
                        a stub with just id+name if the source list is
                        still loading. */}
                    <TouchableOpacity
                      onPress={() => {
                        const src = sourceDistList.find((sd) => sd.id === s.sourceDistributorId)
                          ?? { id: s.sourceDistributorId, distributorId: '', name: s.name, createdAt: '' } as SourceDistributor;
                        onPickEditOpening(src);
                      }}
                      activeOpacity={0.75}
                      accessibilityLabel={`Edit ${s.name} opening balance`}
                      style={{
                        width: 34, height: 34, borderRadius: 8,
                        borderWidth: 1, borderColor: border,
                        alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="create-outline" size={16} color={text} />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>

          <TouchableOpacity
            onPress={onClose}
            activeOpacity={0.7}
            style={{ paddingVertical: 12, alignItems: 'center', marginTop: 4 }}
          >
            <Text style={{ color: muted, fontSize: 14, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
});
