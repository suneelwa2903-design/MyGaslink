/**
 * Mini-op #5 v2 (2026-07-27 evening) — Mobile Expenses screen.
 *
 * Hidden route under (admin) — reached from More → Expenses.
 * MVP: list + create modal. Edit/delete + category management live on
 * the web. Categories are fetched from GET /api/expense-categories and
 * rendered as chip rows grouped under their header labels.
 */
import { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal, Alert, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
 
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets as _useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme } from '../../src/theme';
import {
  EXPENSE_PAYMENT_METHODS,
  type ExpensePaymentMethod,
  type Expense,
  type ExpenseCategory,
  type ExpenseSummary,
} from '@gaslink/shared';

// 2026-07-29 — minimal category-level colour polish. Categories are
// distributor-defined (fetched from /api/expense-categories) and grouped
// under headers (Vehicle Costs, Staff Costs, Facility Costs, Compliance
// & Finance, Miscellaneous). All leaves under one header share one
// colour so the list scans by group, not by individual leaf. Hash keys
// off the header name so it's deterministic.
const CATEGORY_PALETTE = [
  '#0ea5e9', // sky
  '#f59e0b', // amber
  '#a855f7', // purple
  '#059669', // emerald
  '#f43f5e', // rose
  '#2563eb', // blue
  '#ea580c', // orange
  '#0891b2', // cyan
  '#65a30d', // lime
  '#8b5cf6', // violet
];
function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return CATEGORY_PALETTE[Math.abs(hash) % CATEGORY_PALETTE.length];
}
// Resolve a leaf category's header (parent) name so per-row colouring
// keys off the group, not the leaf. Falls back to the leaf name for
// orphans (no parent). Reads the categories array in scope of the caller.
function headerFor(cats: ExpenseCategory[], categoryId: string): string {
  const c = cats.find((x) => x.categoryId === categoryId);
  if (!c) return '';
  if (c.isHeader) return c.name;
  if (c.parentId) {
    const p = cats.find((x) => x.categoryId === c.parentId);
    if (p) return p.name;
  }
  return c.name; // orphan
}
// Convenience — given a leaf id, return the group's colour.
function categoryColor(cats: ExpenseCategory[], categoryId: string | null | undefined, fallbackName?: string): string {
  const key = categoryId ? headerFor(cats, categoryId) : (fallbackName || '');
  return hashColor(key || '—');
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Cash', cheque: 'Cheque', online: 'Online',
  upi: 'UPI', bank_transfer: 'Bank', credit: 'Credit',
};

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface GroupedOption { headerName: string; leaves: ExpenseCategory[] }

function buildGroupedOptions(categories: ExpenseCategory[]): GroupedOption[] {
  const active = categories.filter((c) => c.isActive);
  const headers = active.filter((c) => c.isHeader).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const leavesByParent = new Map<string, ExpenseCategory[]>();
  const orphans: ExpenseCategory[] = [];
  for (const c of active) {
    if (c.isHeader) continue;
    if (c.parentId) {
      const arr = leavesByParent.get(c.parentId) ?? [];
      arr.push(c);
      leavesByParent.set(c.parentId, arr);
    } else {
      orphans.push(c);
    }
  }
  const groups: GroupedOption[] = headers.map((h) => ({
    headerName: h.name,
    leaves: (leavesByParent.get(h.categoryId) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  })).filter((g) => g.leaves.length > 0);
  if (orphans.length) {
    groups.push({
      headerName: 'Uncategorised',
      leaves: orphans.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    });
  }
  return groups;
}

export default function ExpensesScreen() {
  const { colors } = useTheme();
  const monthStart = todayISO().slice(0, 8) + '01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO());
  const [createOpen, setCreateOpen] = useState(false);
  // 2026-07-29 — list filters. `categoryId` filters to a single leaf
  // (null = all); `paymentMethod` filters to a single method (null = all).
  // Also a free-text `search` on description (300ms debounced) so a user
  // can find "diesel top-up" without remembering the category.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [paymentFilter, setPaymentFilter] = useState<string | null>(null);
  const [searchRaw, setSearchRaw] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchRaw.trim()), 300);
    return () => clearTimeout(t);
  }, [searchRaw]);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [paymentPickerOpen, setPaymentPickerOpen] = useState(false);
  const [categorySearchRaw, setCategorySearchRaw] = useState('');

  const listParams = useMemo(() => {
    const p: Record<string, unknown> = { from, to, page: 1, pageSize: 100 };
    if (categoryFilter) p.categoryId = categoryFilter;
    if (paymentFilter) p.paymentMethod = paymentFilter;
    if (search) p.search = search;
    return p;
  }, [from, to, categoryFilter, paymentFilter, search]);

  const summaryParams = useMemo(() => {
    const p: Record<string, unknown> = { from, to };
    if (categoryFilter) p.categoryId = categoryFilter;
    if (paymentFilter) p.paymentMethod = paymentFilter;
    if (search) p.search = search;
    return p;
  }, [from, to, categoryFilter, paymentFilter, search]);

  const { data: list, isLoading, refetch } = useApiQuery<{ expenses: Expense[]; meta: { total: number } }>(
    ['expenses', from, to, categoryFilter ?? '', paymentFilter ?? '', search],
    '/expenses',
    listParams,
  );
  const { data: summary } = useApiQuery<ExpenseSummary>(
    ['expenses-summary', from, to, categoryFilter ?? '', paymentFilter ?? '', search],
    '/expenses/summary',
    summaryParams,
  );
  const { data: categoriesResp } = useApiQuery<{ categories: ExpenseCategory[] }>(
    ['expense-categories'],
    '/expense-categories',
  );
  const categories = useMemo(() => categoriesResp?.categories ?? [], [categoriesResp]);
  const groups = useMemo(() => buildGroupedOptions(categories), [categories]);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 96 }}>
        {/* 2026-07-29 — top "Total spent" card removed; the filtered-total
            strip below the filter row shows the same figure and updates
            as the user changes date / category / payment / search. */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 4 }}>From</Text>
            <TextInput value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              style={{ borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 8, padding: 10, fontSize: 14, color: colors.text, backgroundColor: colors.inputBg }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 4 }}>To</Text>
            <TextInput value={to} onChangeText={setTo} placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              style={{ borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 8, padding: 10, fontSize: 14, color: colors.text, backgroundColor: colors.inputBg }} />
          </View>
        </View>

        {/* 2026-07-29 — Search input + dropdown filters. Chip rows were
            too tall to scan when there are many categories, and horizontal
            scrolling on a long strip is fiddly on mobile. Search is
            debounced 300ms and matches expense.description (ILIKE) via
            /expenses ?search=. */}
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, textTransform: 'uppercase' }}>
          Search
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, marginBottom: 10 }}>
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            value={searchRaw}
            onChangeText={setSearchRaw}
            placeholder="Description contains…"
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, padding: 10, fontSize: 14, color: colors.text }}
          />
          {searchRaw.length > 0 && (
            <TouchableOpacity onPress={() => setSearchRaw('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* Category + Payment dropdowns side by side */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, textTransform: 'uppercase' }}>
              Category
            </Text>
            <TouchableOpacity
              onPress={() => setCategoryPickerOpen(true)}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
                borderWidth: 1, borderRadius: 8, padding: 10,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                {categoryFilter && (
                  <View style={{
                    width: 8, height: 8, borderRadius: 4,
                    backgroundColor: categoryColor(categories, categoryFilter),
                  }} />
                )}
                <Text style={{ fontSize: 13, color: categoryFilter ? colors.text : colors.textMuted }} numberOfLines={1}>
                  {categoryFilter
                    ? (categories.find((c) => c.categoryId === categoryFilter)?.name ?? 'Unknown')
                    : 'All categories'}
                </Text>
              </View>
              <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, textTransform: 'uppercase' }}>
              Payment
            </Text>
            <TouchableOpacity
              onPress={() => setPaymentPickerOpen(true)}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
                borderWidth: 1, borderRadius: 8, padding: 10,
              }}
            >
              <Text style={{ fontSize: 13, color: paymentFilter ? colors.text : colors.textMuted }} numberOfLines={1}>
                {paymentFilter ? (PAYMENT_LABELS[paymentFilter] ?? paymentFilter) : 'All methods'}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Filtered total strip — sits below the filters and above the list.
            Reflects the summary endpoint, which now honours the same
            category/payment/search filters (backend fix same date). */}
        {summary && (
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            backgroundColor: colors.cardBg, borderColor: colors.cardBorder,
            borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
            marginBottom: 12,
          }}>
            <View>
              <Text style={{ fontSize: 11, color: colors.textMuted, textTransform: 'uppercase' }}>
                Filtered total
              </Text>
              <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text, marginTop: 2 }}>
                {inr.format(summary.totalAmount)}
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: colors.textMuted }}>
              {summary.count} {summary.count === 1 ? 'entry' : 'entries'}
            </Text>
          </View>
        )}

        {isLoading ? (
          <View style={{ alignItems: 'center', paddingVertical: 32 }}>
            <ActivityIndicator size="large" color="#dc2626" />
          </View>
        ) : !list?.expenses.length ? (
          <View style={{ padding: 32, alignItems: 'center' }}>
            <Ionicons name="wallet-outline" size={48} color={colors.textMuted} />
            <Text style={{ fontSize: 14, color: colors.textMuted, marginTop: 12 }}>
              No expenses in this window
            </Text>
          </View>
        ) : (
          <View style={{ backgroundColor: colors.cardBg, borderRadius: 12, borderWidth: 1, borderColor: colors.cardBorder, overflow: 'hidden' }}>
            {list.expenses.map((e, idx) => {
              const catCol = categoryColor(categories, e.categoryId, e.categoryName);
              return (
                <View key={e.expenseId}
                  style={{
                    padding: 12,
                    borderBottomWidth: idx === list.expenses.length - 1 ? 0 : 1,
                    borderBottomColor: colors.divider,
                    // 2026-07-29 — 3-px left band keyed to category. Minimal
                    // colour polish per user direction: category-level only.
                    borderLeftWidth: 3,
                    borderLeftColor: catCol,
                  }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: catCol }} />
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }} numberOfLines={1}>
                        {e.categoryName}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>
                      {inr.format(e.amount)}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 4 }} numberOfLines={2}>
                    {e.description}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>{e.expenseDate}</Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>· {PAYMENT_LABELS[e.paymentMethod] ?? e.paymentMethod}</Text>
                    {e.vehicleNumber && <Text style={{ fontSize: 11, color: colors.textMuted }}>· {e.vehicleNumber}</Text>}
                    {e.driverName && <Text style={{ fontSize: 11, color: colors.textMuted }}>· {e.driverName}</Text>}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      <TouchableOpacity onPress={() => setCreateOpen(true)} activeOpacity={0.8}
        style={{
          position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28,
          backgroundColor: '#dc2626', alignItems: 'center', justifyContent: 'center',
          elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6,
        }}>
        <Ionicons name="add" size={28} color="#ffffff" />
      </TouchableOpacity>

      {createOpen && (
        <CreateExpenseModal
          groups={groups}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); refetch(); }}
        />
      )}

      {/* Category filter picker — full-screen bottom-sheet with search
          input at the top so the user can type to narrow the list. Groups
          leaves under their header (Vehicle Costs → Fuel, etc.). */}
      <CategoryFilterPicker
        visible={categoryPickerOpen}
        onClose={() => setCategoryPickerOpen(false)}
        categories={categories}
        groups={groups}
        selectedId={categoryFilter}
        onSelect={(id) => {
          setCategoryFilter(id);
          setCategoryPickerOpen(false);
        }}
        searchRaw={categorySearchRaw}
        setSearchRaw={setCategorySearchRaw}
        colors={colors}
      />

      {/* Payment-method filter picker — 4 methods so no search input
          needed; static list. */}
      <PaymentFilterPicker
        visible={paymentPickerOpen}
        onClose={() => setPaymentPickerOpen(false)}
        selected={paymentFilter}
        onSelect={(m) => {
          setPaymentFilter(m);
          setPaymentPickerOpen(false);
        }}
        colors={colors}
      />
    </SafeAreaView>
  );
}

// ─── Category filter picker ─────────────────────────────────────────────────
// Full-screen bottom-sheet with search input at top + grouped list.
function CategoryFilterPicker({
  visible, onClose, categories, groups, selectedId, onSelect, searchRaw, setSearchRaw, colors,
}: {
  visible: boolean;
  onClose: () => void;
  categories: ExpenseCategory[];
  groups: GroupedOption[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  searchRaw: string;
  setSearchRaw: (v: string) => void;
  colors: { text: string; textMuted: string; textSecondary: string; inputBg: string; inputBorder: string; cardBg: string; cardBorder: string; bg: string; divider: string };
}) {
  const insets = _useSafeAreaInsets();
  const search = searchRaw.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!search) return groups;
    return groups
      .map((g) => ({ ...g, leaves: g.leaves.filter((l) => l.name.toLowerCase().includes(search)) }))
      .filter((g) => g.leaves.length > 0);
  }, [groups, search]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}
      >
        <View style={{
          backgroundColor: colors.bg,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          maxHeight: '85%',
          paddingBottom: Math.max(insets.bottom, 12),
        }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', padding: 14,
            borderBottomWidth: 1, borderBottomColor: colors.divider,
          }}>
            <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: colors.text }}>Filter by category</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
              borderWidth: 1, borderRadius: 8, paddingHorizontal: 10,
            }}>
              <Ionicons name="search" size={16} color={colors.textMuted} />
              <TextInput
                value={searchRaw}
                onChangeText={setSearchRaw}
                placeholder="Search categories…"
                placeholderTextColor={colors.textMuted}
                autoFocus
                style={{ flex: 1, padding: 10, fontSize: 14, color: colors.text }}
              />
              {searchRaw.length > 0 && (
                <TouchableOpacity onPress={() => setSearchRaw('')}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 14 }} keyboardShouldPersistTaps="handled">
            <TouchableOpacity
              onPress={() => onSelect(null)}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 10,
                paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.divider,
              }}
            >
              <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: selectedId === null ? '#111827' : colors.inputBorder }}>
                {selectedId === null && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#111827' }} />}
              </View>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>All categories</Text>
            </TouchableOpacity>

            {filteredGroups.map((g) => {
              const groupCol = hashColor(g.headerName || '—');
              return (
                <View key={g.headerName} style={{ marginTop: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: groupCol }} />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: groupCol, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {g.headerName}
                    </Text>
                  </View>
                  {g.leaves.map((leaf) => {
                    const active = selectedId === leaf.categoryId;
                    const leafCol = categoryColor(categories, leaf.categoryId, leaf.name);
                    return (
                      <TouchableOpacity
                        key={leaf.categoryId}
                        onPress={() => onSelect(leaf.categoryId)}
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 10,
                          paddingVertical: 10, paddingLeft: 8,
                        }}
                      >
                        <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: active ? leafCol : colors.inputBorder }}>
                          {active && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: leafCol }} />}
                        </View>
                        <Text style={{ fontSize: 14, color: colors.text, flex: 1 }}>{leaf.name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}

            {filteredGroups.length === 0 && (
              <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 }}>
                No categories match &ldquo;{searchRaw}&rdquo;.
              </Text>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Payment-method filter picker ───────────────────────────────────────────
function PaymentFilterPicker({
  visible, onClose, selected, onSelect, colors,
}: {
  visible: boolean;
  onClose: () => void;
  selected: string | null;
  onSelect: (m: string | null) => void;
  colors: { text: string; textMuted: string; inputBorder: string; bg: string; divider: string };
}) {
  const insets = _useSafeAreaInsets();
  const options: (string | null)[] = [null, 'cash', 'upi', 'bank_transfer', 'credit', 'cheque', 'online'];
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <View style={{
          backgroundColor: colors.bg,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingBottom: Math.max(insets.bottom, 12),
        }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', padding: 14,
            borderBottomWidth: 1, borderBottomColor: colors.divider,
          }}>
            <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: colors.text }}>Payment method</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          {options.map((m) => {
            const active = selected === m;
            const label = m === null ? 'All methods' : (PAYMENT_LABELS[m] ?? m);
            return (
              <TouchableOpacity
                key={m ?? 'all'}
                onPress={() => onSelect(m)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  paddingVertical: 14, paddingHorizontal: 20,
                  borderBottomWidth: 1, borderBottomColor: colors.divider,
                }}
              >
                <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: active ? '#2563eb' : colors.inputBorder }}>
                  {active && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#2563eb' }} />}
                </View>
                <Text style={{ fontSize: 15, color: colors.text, flex: 1 }}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}

function CreateExpenseModal({
  groups, onClose, onCreated,
}: {
  groups: GroupedOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { colors } = useTheme();
  const firstLeaf = groups[0]?.leaves[0] ?? null;
  const [expenseDate, setExpenseDate] = useState(todayISO());
  const [categoryId, setCategoryId] = useState<string>(firstLeaf?.categoryId ?? '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<ExpensePaymentMethod>('cash');
  const [vendorName, setVendorName] = useState('');
  const [notes, setNotes] = useState('');

  const selectedLeaf = useMemo(() => {
    for (const g of groups) {
      const found = g.leaves.find((l) => l.categoryId === categoryId);
      if (found) return found;
    }
    return null;
  }, [groups, categoryId]);

  const createMut = useApiMutation('post', '/expenses', {
    invalidateKeys: [['expenses'], ['expenses-summary']],
    successMessage: 'Expense recorded',
    onSuccess: onCreated,
  });

  const canSave = !!categoryId && amount.trim().length > 0 && description.trim().length > 0 && !createMut.isPending;

  const handleSubmit = () => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      Alert.alert('Validation', 'Enter a positive amount.');
      return;
    }
    if (!categoryId) {
      Alert.alert('Validation', 'Pick a category.');
      return;
    }
    createMut.mutate({
      expenseDate,
      categoryId,
      amount: amt,
      description: description.trim(),
      paymentMethod,
      vendorName: vendorName.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      {/* 2026-07-29 iPhone SafeArea fix — Modal on iOS spawns a fresh
          native view hierarchy that does NOT inherit the app-root
          SafeAreaProvider, so SafeAreaView reads 0 insets and the
          header overlaps the status bar / Dynamic Island. Wrapping
          the Modal contents in a scoped SafeAreaProvider restores
          real insets so `edges={['top', ...]}` pushes the header
          below the notch. Same pattern as dashboard.tsx / orders.tsx. */}
      <SafeAreaProvider>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.divider,
        }}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={24} color={colors.textMuted} />
          </TouchableOpacity>
          <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>New expense</Text>
          <TouchableOpacity onPress={handleSubmit} disabled={!canSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={{ fontSize: 16, color: canSave ? '#dc2626' : colors.textMuted, fontWeight: '600' }}>
              {createMut.isPending ? '…' : 'Save'}
            </Text>
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
          <Field label="Date" colors={colors}>
            <TextInput value={expenseDate} onChangeText={setExpenseDate} placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted} style={fieldStyle(colors)} />
          </Field>

          <Field label="Category" colors={colors}>
            {groups.map((g) => {
              // 2026-07-29 — color the group header + chip active-state by
              // a stable hash of the header name so all leaves under
              // "Vehicle Costs" share one colour, all under "Staff Costs"
              // share another, etc. Matches list-card border coloring so
              // "the fuel chip you pick here" reads as "the color it'll be
              // in the list".
              const groupCol = hashColor(g.headerName || '—');
              return (
                <View key={g.headerName} style={{ marginBottom: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: groupCol }} />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: groupCol, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {g.headerName}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {g.leaves.map((leaf) => {
                      const active = categoryId === leaf.categoryId;
                      return (
                        <TouchableOpacity
                          key={leaf.categoryId}
                          onPress={() => setCategoryId(leaf.categoryId)}
                          style={{
                            paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
                            backgroundColor: active ? groupCol : colors.inputBg,
                            borderWidth: 1, borderColor: active ? groupCol : colors.inputBorder,
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#ffffff' : colors.text }}>
                            {leaf.name}
                          </Text>
                        </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
              );
            })}
          </Field>

          {selectedLeaf?.hint && (
            <Text style={{ fontSize: 12, color: colors.textMuted, fontStyle: 'italic' }}>
              {selectedLeaf.hint}
            </Text>
          )}

          <Field label="Amount (₹)" colors={colors}>
            <TextInput value={amount} onChangeText={setAmount} placeholder="e.g. 500"
              keyboardType="decimal-pad" placeholderTextColor={colors.textMuted}
              style={fieldStyle(colors)} />
          </Field>

          <Field label="Description" colors={colors}>
            <TextInput value={description} onChangeText={setDescription} placeholder="e.g. Diesel for TS08X1234"
              placeholderTextColor={colors.textMuted} style={fieldStyle(colors)} />
          </Field>

          <Field label="Payment method" colors={colors}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {EXPENSE_PAYMENT_METHODS.map((m) => {
                const active = paymentMethod === m;
                return (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setPaymentMethod(m)}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
                      backgroundColor: active ? '#dc2626' : colors.inputBg,
                      borderWidth: 1, borderColor: active ? '#dc2626' : colors.inputBorder,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#ffffff' : colors.text }}>
                      {PAYMENT_LABELS[m] ?? m}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Field>

          <Field label={selectedLeaf?.vendorLabel ?? 'Vendor (optional)'} colors={colors}>
            <TextInput value={vendorName} onChangeText={setVendorName}
              placeholder={selectedLeaf?.vendorPlaceholder ?? 'Vendor name'}
              placeholderTextColor={colors.textMuted} style={fieldStyle(colors)} />
          </Field>

          <Field label="Notes (optional)" colors={colors}>
            <TextInput value={notes} onChangeText={setNotes} placeholder="Anything worth remembering"
              placeholderTextColor={colors.textMuted} style={fieldStyle(colors)} multiline
              numberOfLines={2} />
          </Field>
        </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function Field({ label, children, colors }: { label: string; children: React.ReactNode; colors: { text: string; textSecondary: string } }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{label}</Text>
      {children}
    </View>
  );
}

function fieldStyle(colors: { text: string; inputBorder: string; inputBg: string }) {
  return {
    borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 8,
    padding: 12, fontSize: 15, color: colors.text, backgroundColor: colors.inputBg,
  } as const;
}
