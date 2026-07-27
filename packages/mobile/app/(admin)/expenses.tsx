/**
 * Mini-op #5 (2026-07-27) — Mobile Expenses screen.
 *
 * Hidden route under the (admin) tab group (registered via href: null in
 * the layout below). Reached from More → Expenses OR via router.push.
 *
 * MVP: list + create modal. Edit/delete on web only for v1 — fits the
 * mobile screen budget and keeps this file small.
 */
import { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme } from '../../src/theme';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
  type ExpenseCategoryValue,
  type ExpensePaymentMethod,
  type Expense,
  type ExpenseSummary,
} from '@gaslink/shared';

const CATEGORY_LABELS: Record<string, string> = {
  fuel: 'Fuel',
  vehicle_maintenance: 'Vehicle maintenance',
  salaries_wages: 'Salaries & wages',
  rent: 'Rent',
  utilities: 'Utilities',
  loading_unloading: 'Loading / unloading',
  cylinder_deposits: 'Cylinder deposits',
  office_supplies: 'Office supplies',
  communication: 'Communication',
  insurance: 'Insurance',
  taxes_licenses: 'Taxes & licenses',
  bank_charges: 'Bank charges',
  other: 'Other',
};

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

export default function ExpensesScreen() {
  const { colors } = useTheme();
  const monthStart = todayISO().slice(0, 8) + '01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO());
  const [createOpen, setCreateOpen] = useState(false);

  const { data: list, isLoading, refetch } = useApiQuery<{ expenses: Expense[]; meta: { total: number } }>(
    ['expenses', from, to],
    '/expenses',
    { from, to, page: 1, pageSize: 100 },
  );
  const { data: summary } = useApiQuery<ExpenseSummary>(
    ['expenses-summary', from, to],
    '/expenses/summary',
    { from, to },
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 96 }}>
        {/* Summary tile */}
        <View style={{
          backgroundColor: colors.cardBg,
          borderRadius: 12,
          padding: 16,
          borderWidth: 1,
          borderColor: colors.cardBorder,
          marginBottom: 12,
        }}>
          <Text style={{ fontSize: 12, color: colors.textMuted }}>Total spent · {from} → {to}</Text>
          <Text style={{ fontSize: 26, fontWeight: '800', color: colors.text, marginTop: 4 }}>
            {summary ? inr.format(summary.totalAmount) : '—'}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
            {summary?.count ?? 0} entries
          </Text>
        </View>

        {/* Date range picker (text inputs — matches the rest of the mini-op forms) */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 4 }}>From</Text>
            <TextInput
              value={from}
              onChangeText={setFrom}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              style={{
                borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 8,
                padding: 10, fontSize: 14, color: colors.text, backgroundColor: colors.inputBg,
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 4 }}>To</Text>
            <TextInput
              value={to}
              onChangeText={setTo}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              style={{
                borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 8,
                padding: 10, fontSize: 14, color: colors.text, backgroundColor: colors.inputBg,
              }}
            />
          </View>
        </View>

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
            {list.expenses.map((e, idx) => (
              <View
                key={e.expenseId}
                style={{
                  padding: 12,
                  borderBottomWidth: idx === list.expenses.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }} numberOfLines={1}>
                    {CATEGORY_LABELS[e.category] ?? e.category}
                  </Text>
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
            ))}
          </View>
        )}
      </ScrollView>

      {/* Floating add button */}
      <TouchableOpacity
        onPress={() => setCreateOpen(true)}
        activeOpacity={0.8}
        style={{
          position: 'absolute', bottom: 24, right: 24,
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: '#dc2626',
          alignItems: 'center', justifyContent: 'center',
          elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.25, shadowRadius: 6,
        }}
      >
        <Ionicons name="add" size={28} color="#ffffff" />
      </TouchableOpacity>

      {createOpen && (
        <CreateExpenseModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            refetch();
          }}
        />
      )}
    </SafeAreaView>
  );
}

function CreateExpenseModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { colors } = useTheme();
  const [expenseDate, setExpenseDate] = useState(todayISO());
  const [category, setCategory] = useState<ExpenseCategoryValue>('fuel');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<ExpensePaymentMethod>('cash');
  const [vendorName, setVendorName] = useState('');
  const [notes, setNotes] = useState('');

  const createMut = useApiMutation('post', '/expenses', {
    invalidateKeys: [['expenses'], ['expenses-summary']],
    successMessage: 'Expense recorded',
    onSuccess: onCreated,
  });

  const canSave = amount.trim().length > 0 && description.trim().length > 0 && !createMut.isPending;

  const handleSubmit = () => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      Alert.alert('Validation', 'Enter a positive amount.');
      return;
    }
    createMut.mutate({
      expenseDate,
      category,
      amount: amt,
      description: description.trim(),
      paymentMethod,
      vendorName: vendorName.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
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

        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
          <Field label="Date" colors={colors}>
            <TextInput value={expenseDate} onChangeText={setExpenseDate} placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              style={fieldStyle(colors)} />
          </Field>

          <Field label="Category" colors={colors}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {EXPENSE_CATEGORIES.map((c) => {
                const active = category === c;
                return (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setCategory(c)}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
                      backgroundColor: active ? '#dc2626' : colors.inputBg,
                      borderWidth: 1, borderColor: active ? '#dc2626' : colors.inputBorder,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#ffffff' : colors.text }}>
                      {CATEGORY_LABELS[c] ?? c}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Field>

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

          <Field label="Vendor (optional)" colors={colors}>
            <TextInput value={vendorName} onChangeText={setVendorName} placeholder="e.g. HP Petrol Pump"
              placeholderTextColor={colors.textMuted} style={fieldStyle(colors)} />
          </Field>

          <Field label="Notes (optional)" colors={colors}>
            <TextInput value={notes} onChangeText={setNotes} placeholder="Anything worth remembering"
              placeholderTextColor={colors.textMuted} style={fieldStyle(colors)} multiline
              numberOfLines={2} />
          </Field>
        </ScrollView>
      </SafeAreaView>
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
