/**
 * Corp. Loads — the 6 "Add Entry" modals (2026-08-13, Suneel).
 *
 * Mobile counterpart of the web CorpEntryModals + the Inventory Incoming/
 * Outgoing modals, so a regular distributor_admin can record every corp
 * transaction from the phone with the SAME fields the web uses:
 *
 *   • IncomingFullsModal   — POST /inventory/incoming-fulls   (single line)
 *   • OutgoingEmptiesModal — POST /inventory/outgoing-empties (single line)
 *   • PaymentModal         — POST /purchase-payments
 *   • CreditNoteModal      — POST /purchase-credit-notes
 *   • DebitNoteModal       — POST /purchase-debit-notes
 *   • DepositModal         — POST /purchase-entries (documentType=deposit_invoice)
 *
 * Modal hygiene (anti-pattern #25): every modal uses a shared FormModal shell
 * that honours useSafeAreaInsets().bottom on Android nav bars, wraps the body
 * in KeyboardAvoidingView + a ScrollView with keyboardShouldPersistTaps=
 * "handled", and passes onRequestClose for the hardware back button.
 */
import { useMemo, useState } from 'react';
import {
  View, Text, TextInput, Modal, ScrollView, TouchableOpacity,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../hooks/useApi';
import { Button, DateInput, SelectField, todayLocalIso, type SelectOption } from '../ui';
import { useIsDark } from '../../stores/themeStore';

export interface CorpContext {
  sourceDistributorId: string;
  name: string;
}

export type CorpEntryKind =
  | 'incoming_fulls'
  | 'outgoing_empties'
  | 'payment'
  | 'credit_note'
  | 'debit_note'
  | 'deposit';

// ─── Theme + primitives ─────────────────────────────────────────────────────

function useColors() {
  const dark = useIsDark();
  return {
    dark,
    bg: dark ? '#0f172a' : '#f8fafc',
    cardBg: dark ? '#1e293b' : '#ffffff',
    text: dark ? '#f1f5f9' : '#0f172a',
    muted: dark ? '#94a3b8' : '#64748b',
    border: dark ? '#334155' : '#e5e7eb',
    inputBg: dark ? '#0f172a' : '#ffffff',
    accent: '#dc2626',
  };
}

const toNum = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Shared modal chrome: slide-up full screen, safe-area, keyboard-safe body,
 *  sticky footer with Cancel + submit. */
function FormModal({
  title, subtitle, onClose, children, submitLabel, onSubmit, submitting, submitDisabled,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  submitting?: boolean;
  submitDisabled?: boolean;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={['top', 'left', 'right']}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 16, paddingVertical: 12,
          borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.cardBg,
        }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text }} numberOfLines={1}>{title}</Text>
            {subtitle ? <Text style={{ fontSize: 12, color: c.muted, marginTop: 2 }} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={26} color={c.muted} />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>

          {/* Sticky footer — honours Android nav-bar inset */}
          <View style={{
            flexDirection: 'row', gap: 10,
            paddingHorizontal: 16, paddingTop: 10,
            paddingBottom: Math.max(insets.bottom + 8, 16),
            borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.cardBg,
          }}>
            <View style={{ flex: 1 }}>
              <Button title="Cancel" variant="secondary" onPress={onClose} />
            </View>
            <View style={{ flex: 2 }}>
              <Button title={submitLabel} onPress={onSubmit} loading={submitting} disabled={submitDisabled} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

/** Labeled text/number input matching the app's field look. */
function Field({
  label, value, onChangeText, placeholder, keyboardType, required, autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad';
  required?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'characters';
}) {
  const c = useColors();
  return (
    <View>
      <Text style={{ fontSize: 13, fontWeight: '600', color: c.muted, marginBottom: 6 }}>
        {label}{required ? <Text style={{ color: c.accent }}> *</Text> : null}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={{
          borderWidth: 1, borderColor: c.border, borderRadius: 8,
          paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
          color: c.text, backgroundColor: c.inputBg,
        }}
      />
    </View>
  );
}

function LabeledDate({ label, value, onChange, required }: {
  label: string; value: string; onChange: (iso: string) => void; required?: boolean;
}) {
  const c = useColors();
  return (
    <View>
      <Text style={{ fontSize: 13, fontWeight: '600', color: c.muted, marginBottom: 6 }}>
        {label}{required ? <Text style={{ color: c.accent }}> *</Text> : null}
      </Text>
      <DateInput value={value} onChange={onChange} />
    </View>
  );
}

// ─── Shared data hooks ──────────────────────────────────────────────────────

interface CylinderType { cylinderTypeId: string; typeName: string; isActive?: boolean }
interface VehicleRow { vehicleId: string; vehicleNumber: string }
interface DriverRow { driverName: string }
interface OutstandingEntry {
  purchaseEntryId: string;
  purchaseDate: string;
  outstanding: number;
  amountRemaining?: number;
  supplierDocumentNumber?: string | null;
}

function useCylinderTypes(): SelectOption[] {
  const { data } = useApiQuery<{ cylinderTypes: CylinderType[] }>(['cylinder-types'], '/cylinder-types');
  return useMemo(
    () => (data?.cylinderTypes ?? []).filter((t) => t.isActive !== false)
      .map((t) => ({ value: t.cylinderTypeId, label: t.typeName })),
    [data],
  );
}
function useVehicleOptions(): SelectOption[] {
  const { data } = useApiQuery<{ vehicles: VehicleRow[] }>(['vehicles-list'], '/vehicles');
  return useMemo(
    () => [{ value: '', label: 'No vehicle' }, ...(data?.vehicles ?? []).map((v) => ({ value: v.vehicleId, label: v.vehicleNumber }))],
    [data],
  );
}
function useDriverOptions(): SelectOption[] {
  const { data } = useApiQuery<{ drivers: DriverRow[] }>(['drivers-list'], '/drivers', { status: 'active' });
  return useMemo(
    () => [{ value: '', label: 'No driver' }, ...(data?.drivers ?? []).map((d) => ({ value: d.driverName, label: d.driverName }))],
    [data],
  );
}

const INVALIDATE_ALL = [
  ['corp-ledger'], ['supplier-balances'], ['cost-layers'],
  ['corp-avg-landed'], ['purchase-entries'], ['inventory'], ['source-distributors'],
];

// ─── 1. Incoming Fulls ──────────────────────────────────────────────────────

const CHARGE_TYPES: SelectOption[] = [
  { value: 'freight', label: 'Freight' },
  { value: 'handling', label: 'Handling' },
  { value: 'testing', label: 'Testing' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'other', label: 'Other' },
];

export function IncomingFullsModal({ corp, onClose, onSaved }: {
  corp: CorpContext; onClose: () => void; onSaved: () => void;
}) {
  const c = useColors();
  const cylOpts = useCylinderTypes();
  const vehicleOpts = useVehicleOptions();
  const driverOpts = useDriverOptions();

  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [documentType, setDocumentType] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentDate, setDocumentDate] = useState(todayLocalIso());
  const [vehicleId, setVehicleId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [rate, setRate] = useState('');
  const [amount, setAmount] = useState('');
  const [charges, setCharges] = useState<Array<{ chargeType: string; amount: string }>>([]);
  const [notes, setNotes] = useState('');

  // Rate ↔ Amount: editing rate recomputes amount (rate × qty); editing amount
  // recomputes rate (amount ÷ qty). Matches the web modal.
  const qtyNum = toNum(quantity);
  const onRateChange = (v: string) => {
    setRate(v);
    const r = toNum(v);
    if (qtyNum > 0 && r > 0) setAmount((r * qtyNum).toFixed(2));
  };
  const onAmountChange = (v: string) => {
    setAmount(v);
    const a = toNum(v);
    if (qtyNum > 0 && a > 0) setRate((a / qtyNum).toFixed(4));
  };

  const vehicleNumber = useMemo(
    () => vehicleOpts.find((o) => o.value === vehicleId)?.label ?? '',
    [vehicleOpts, vehicleId],
  );

  const mutation = useApiMutation<unknown, Record<string, unknown>>('post', '/inventory/incoming-fulls', {
    successMessage: 'Incoming fulls recorded',
    invalidateKeys: INVALIDATE_ALL,
    onSuccess: onSaved,
  });

  const submit = () => {
    if (!cylinderTypeId || qtyNum <= 0 || !documentType.trim() || !documentNumber.trim() || !documentDate) return;
    mutation.mutate({
      sourceDistributorId: corp.sourceDistributorId,
      cylinderTypeId,
      quantity: Math.trunc(qtyNum),
      documentType: documentType.trim(),
      documentNumber: documentNumber.trim(),
      documentDate,
      vehicleId: vehicleId || undefined,
      vehicleNumber: vehicleNumber || undefined,
      driverName: driverName || undefined,
      unitPrice: rate ? toNum(rate) : undefined,
      amount: amount ? toNum(amount) : undefined,
      charges: charges.filter((ch) => toNum(ch.amount) > 0).map((ch) => ({ chargeType: ch.chargeType, amount: toNum(ch.amount) })),
      notes: notes.trim() || undefined,
    });
  };

  const disabled = !cylinderTypeId || qtyNum <= 0 || !documentType.trim() || !documentNumber.trim();

  return (
    <FormModal
      title={`Incoming Fulls — ${corp.name}`}
      subtitle="Gas cylinders received from Bottling / Refill Plant to Godown"
      onClose={onClose}
      submitLabel="Record Incoming"
      onSubmit={submit}
      submitting={mutation.isPending}
      submitDisabled={disabled}
    >
      <SelectField label="Cylinder Type *" value={cylinderTypeId} onChange={setCylinderTypeId} options={cylOpts} />
      <Field label="Quantity" value={quantity} onChangeText={setQuantity} keyboardType="numeric" required />
      <Field label="Supply Type" value={documentType} onChangeText={setDocumentType} placeholder="e.g. Delivery Challan" required />
      <Field label="Supply Reference No." value={documentNumber} onChangeText={setDocumentNumber} placeholder="OMC document no." required />
      <LabeledDate label="Supply Date" value={documentDate} onChange={setDocumentDate} required />
      <SelectField label="Vehicle (optional)" value={vehicleId} onChange={setVehicleId} options={vehicleOpts} />
      <SelectField label="Driver (optional)" value={driverName} onChange={setDriverName} options={driverOpts} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="Rate / cyl (₹)" value={rate} onChangeText={onRateChange} keyboardType="decimal-pad" placeholder="GST-incl" /></View>
        <View style={{ flex: 1 }}><Field label="Amount (₹)" value={amount} onChangeText={onAmountChange} keyboardType="decimal-pad" placeholder="Line total" /></View>
      </View>

      {/* Charges */}
      <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: c.muted }}>Charges (freight etc.)</Text>
          <TouchableOpacity onPress={() => setCharges((cs) => [...cs, { chargeType: 'freight', amount: '' }])}>
            <Text style={{ color: c.accent, fontWeight: '600', fontSize: 13 }}>+ Add charge</Text>
          </TouchableOpacity>
        </View>
        {charges.map((ch, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
            <View style={{ flex: 1.4 }}>
              <SelectField label="" value={ch.chargeType} onChange={(v) => setCharges((cs) => cs.map((x, j) => j === i ? { ...x, chargeType: v } : x))} options={CHARGE_TYPES} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="" value={ch.amount} onChangeText={(v) => setCharges((cs) => cs.map((x, j) => j === i ? { ...x, amount: v } : x))} keyboardType="decimal-pad" placeholder="₹" />
            </View>
            <TouchableOpacity onPress={() => setCharges((cs) => cs.filter((_, j) => j !== i))} style={{ paddingBottom: 10 }}>
              <Ionicons name="trash-outline" size={20} color={c.accent} />
            </TouchableOpacity>
          </View>
        ))}
      </View>

      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />
    </FormModal>
  );
}

// ─── 2. Outgoing Empties ────────────────────────────────────────────────────

const CONDITION_OPTS: SelectOption[] = [
  { value: '', label: 'Not specified' },
  { value: 'good', label: 'Good' },
  { value: 'defective', label: 'Defective' },
];

export function OutgoingEmptiesModal({ corp, onClose, onSaved }: {
  corp: CorpContext; onClose: () => void; onSaved: () => void;
}) {
  const cylOpts = useCylinderTypes();
  const vehicleOpts = useVehicleOptions();
  const driverOpts = useDriverOptions();

  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [documentType, setDocumentType] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentDate, setDocumentDate] = useState(todayLocalIso());
  const [vehicleId, setVehicleId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [authorizationRef, setAuthorizationRef] = useState('');
  const [amount, setAmount] = useState('');
  const [condition, setCondition] = useState('');
  const [notes, setNotes] = useState('');

  const vehicleNumber = useMemo(
    () => vehicleOpts.find((o) => o.value === vehicleId)?.label ?? '',
    [vehicleOpts, vehicleId],
  );

  const mutation = useApiMutation<unknown, Record<string, unknown>>('post', '/inventory/outgoing-empties', {
    successMessage: 'Outgoing empties recorded',
    invalidateKeys: INVALIDATE_ALL,
    onSuccess: onSaved,
  });

  const qtyNum = toNum(quantity);
  const submit = () => {
    if (!cylinderTypeId || qtyNum <= 0 || !documentType.trim() || !documentNumber.trim() || !documentDate) return;
    mutation.mutate({
      cylinderTypeId,
      quantity: Math.trunc(qtyNum),
      documentType: documentType.trim(),
      documentNumber: documentNumber.trim(),
      documentDate,
      vehicleId: vehicleId || undefined,
      vehicleNumber: vehicleNumber || undefined,
      driverName: driverName || undefined,
      authorizationRef: authorizationRef.trim() || undefined,
      amount: amount ? toNum(amount) : undefined,
      condition: condition || undefined,
      notes: notes.trim() || undefined,
    });
  };

  const disabled = !cylinderTypeId || qtyNum <= 0 || !documentType.trim() || !documentNumber.trim();

  return (
    <FormModal
      title={`Outgoing Empties — ${corp.name}`}
      subtitle="Empty cylinders sent from Godown to Bottling / Refill Plant"
      onClose={onClose}
      submitLabel="Record Outgoing"
      onSubmit={submit}
      submitting={mutation.isPending}
      submitDisabled={disabled}
    >
      <SelectField label="Cylinder Type *" value={cylinderTypeId} onChange={setCylinderTypeId} options={cylOpts} />
      <Field label="Quantity" value={quantity} onChangeText={setQuantity} keyboardType="numeric" required />
      <Field label="Challan Type" value={documentType} onChangeText={setDocumentType} placeholder="e.g. Return Challan" required />
      <Field label="Challan No." value={documentNumber} onChangeText={setDocumentNumber} required />
      <LabeledDate label="Challan Date" value={documentDate} onChange={setDocumentDate} required />
      <SelectField label="Vehicle (optional)" value={vehicleId} onChange={setVehicleId} options={vehicleOpts} />
      <SelectField label="Driver (optional)" value={driverName} onChange={setDriverName} options={driverOpts} />
      <Field label="Authorization Ref. (optional)" value={authorizationRef} onChangeText={setAuthorizationRef} />
      <Field label="Amount (₹, optional)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Value of empties returned" />
      <SelectField label="Condition (optional)" value={condition} onChange={setCondition} options={CONDITION_OPTS} />
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />
    </FormModal>
  );
}

// ─── 3. Payment ─────────────────────────────────────────────────────────────

const PAYMENT_METHODS: SelectOption[] = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online / Card' },
];

export function PaymentModal({ corp, onClose, onSaved }: {
  corp: CorpContext; onClose: () => void; onSaved: () => void;
}) {
  const [transactionDate, setTransactionDate] = useState(todayLocalIso());
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('bank_transfer');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');

  const mutation = useApiMutation<unknown, Record<string, unknown>>('post', '/purchase-payments', {
    successMessage: 'Payment recorded',
    invalidateKeys: INVALIDATE_ALL,
    onSuccess: onSaved,
  });

  const submit = () => {
    if (toNum(amount) <= 0 || !transactionDate) return;
    mutation.mutate({
      sourceDistributorId: corp.sourceDistributorId,
      transactionDate,
      amount: toNum(amount),
      paymentMethod,
      referenceNumber: referenceNumber.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <FormModal
      title={`Payment — ${corp.name}`}
      subtitle="Money you paid the OMC"
      onClose={onClose}
      submitLabel="Record Payment"
      onSubmit={submit}
      submitting={mutation.isPending}
      submitDisabled={toNum(amount) <= 0}
    >
      <LabeledDate label="Payment Date" value={transactionDate} onChange={setTransactionDate} required />
      <Field label="Amount (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" required />
      <SelectField label="Method" value={paymentMethod} onChange={setPaymentMethod} options={PAYMENT_METHODS} />
      <Field label="Reference No (optional)" value={referenceNumber} onChangeText={setReferenceNumber} placeholder="Bank txn / cheque #" />
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />
    </FormModal>
  );
}

// ─── 4 & 5. Credit / Debit Note (shared shell w/ allocation) ────────────────

const CN_REASONS: SelectOption[] = [
  { value: 'volume_incentive', label: 'Volume Incentive' },
  { value: 'quality_incentive', label: 'Quality Incentive' },
  { value: 'scheme_incentive', label: 'Scheme Incentive' },
  { value: 'rate_differential', label: 'Rate Differential' },
  { value: 'freight_reimbursement', label: 'Freight Reimbursement' },
  { value: 'other', label: 'Other' },
];
const DN_REASONS: SelectOption[] = [
  { value: 'short_supply', label: 'Short Supply' },
  { value: 'damaged_at_plant', label: 'Damaged At Plant' },
  { value: 'late_payment_interest', label: 'Late Payment Interest' },
  { value: 'rate_differential', label: 'Rate Differential' },
  { value: 'other', label: 'Other' },
];

function NoteModal({
  corp, onClose, onSaved, variant,
}: {
  corp: CorpContext; onClose: () => void; onSaved: () => void; variant: 'credit' | 'debit';
}) {
  const c = useColors();
  const isCredit = variant === 'credit';
  const endpoint = isCredit ? '/purchase-credit-notes' : '/purchase-debit-notes';
  const reasons = isCredit ? CN_REASONS : DN_REASONS;

  const [noteNumber, setNoteNumber] = useState('');
  const [reason, setReason] = useState(isCredit ? 'volume_incentive' : 'short_supply');
  const [noteDate, setNoteDate] = useState(todayLocalIso());
  const [receivedDate, setReceivedDate] = useState(todayLocalIso());
  const [totalAmount, setTotalAmount] = useState('');
  const [notes, setNotes] = useState('');
  // Allocations keyed by purchaseEntryId → amount string.
  const [alloc, setAlloc] = useState<Record<string, string>>({});

  const { data: outstandingResp } = useApiQuery<{ entries: OutstandingEntry[] }>(
    ['purchase-outstanding', corp.sourceDistributorId],
    `/purchase-payments/outstanding/${corp.sourceDistributorId}`,
  );
  const outstanding = outstandingResp?.entries ?? [];

  const mutation = useApiMutation<unknown, Record<string, unknown>>('post', endpoint, {
    successMessage: isCredit ? 'Credit note recorded' : 'Debit note recorded',
    invalidateKeys: INVALIDATE_ALL,
    onSuccess: onSaved,
  });

  const allocSum = Object.values(alloc).reduce((s, v) => s + toNum(v), 0);

  const submit = () => {
    if (!noteNumber.trim() || toNum(totalAmount) <= 0) return;
    const allocations = Object.entries(alloc)
      .filter(([, v]) => toNum(v) > 0)
      .map(([purchaseEntryId, v]) => ({ purchaseEntryId, amount: toNum(v) }));
    const base = {
      sourceDistributorId: corp.sourceDistributorId,
      reason,
      receivedDate,
      totalAmount: toNum(totalAmount),
      notes: notes.trim() || undefined,
      allocations,
    };
    mutation.mutate(isCredit
      ? { ...base, creditNoteNumber: noteNumber.trim(), creditNoteDate: noteDate }
      : { ...base, debitNoteNumber: noteNumber.trim(), debitNoteDate: noteDate });
  };

  return (
    <FormModal
      title={`${isCredit ? 'Credit' : 'Debit'} Note — ${corp.name}`}
      subtitle={isCredit ? 'OMC issued you a CN (incentive)' : 'OMC billed you extra (short supply, damage)'}
      onClose={onClose}
      submitLabel={isCredit ? 'Record Credit Note' : 'Record Debit Note'}
      onSubmit={submit}
      submitting={mutation.isPending}
      submitDisabled={!noteNumber.trim() || toNum(totalAmount) <= 0}
    >
      <Field label={isCredit ? 'OMC CN No' : 'OMC DN No'} value={noteNumber} onChangeText={setNoteNumber} placeholder="Number from OMC's document" required />
      <SelectField label="Reason" value={reason} onChange={setReason} options={reasons} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><LabeledDate label={isCredit ? 'CN Date (OMC)' : 'DN Date (OMC)'} value={noteDate} onChange={setNoteDate} required /></View>
        <View style={{ flex: 1 }}><LabeledDate label="Received On" value={receivedDate} onChange={setReceivedDate} required /></View>
      </View>
      <Field label="Total Amount (₹)" value={totalAmount} onChangeText={setTotalAmount} keyboardType="decimal-pad" required />
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />

      {/* Allocation to outstanding invoices */}
      <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: c.muted }}>Allocate to invoices</Text>
          <Text style={{ fontSize: 12, color: c.muted }}>Allocated: <Text style={{ fontWeight: '700', color: c.text }}>₹{allocSum.toFixed(2)}</Text></Text>
        </View>
        {outstanding.length === 0 ? (
          <Text style={{
            fontSize: 12, color: c.dark ? '#fcd34d' : '#92400e',
            backgroundColor: c.dark ? 'rgba(180,83,9,0.15)' : '#fffbeb',
            padding: 10, borderRadius: 8,
          }}>
            No outstanding invoices for this corporation. Record an Incoming Fulls entry first.
          </Text>
        ) : outstanding.map((row) => {
          const remaining = row.amountRemaining ?? row.outstanding;
          const on = alloc[row.purchaseEntryId] != null;
          return (
            <View key={row.purchaseEntryId} style={{
              flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8,
              borderBottomWidth: 1, borderBottomColor: c.border,
            }}>
              <TouchableOpacity
                onPress={() => setAlloc((a) => {
                  const next = { ...a };
                  if (on) delete next[row.purchaseEntryId];
                  else next[row.purchaseEntryId] = String(remaining);
                  return next;
                })}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? c.accent : c.muted} />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: c.text }} numberOfLines={1}>{row.supplierDocumentNumber ?? '—'}</Text>
                <Text style={{ fontSize: 11, color: c.muted }}>{row.purchaseDate} · outstanding ₹{remaining.toFixed(2)}</Text>
              </View>
              {on && (
                <TextInput
                  value={alloc[row.purchaseEntryId]}
                  onChangeText={(v) => setAlloc((a) => ({ ...a, [row.purchaseEntryId]: v }))}
                  keyboardType="decimal-pad"
                  style={{
                    width: 90, borderWidth: 1, borderColor: c.border, borderRadius: 6,
                    paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, textAlign: 'right',
                    color: c.text, backgroundColor: c.inputBg,
                  }}
                />
              )}
            </View>
          );
        })}
      </View>
    </FormModal>
  );
}

export function CreditNoteModal(props: { corp: CorpContext; onClose: () => void; onSaved: () => void }) {
  return <NoteModal {...props} variant="credit" />;
}
export function DebitNoteModal(props: { corp: CorpContext; onClose: () => void; onSaved: () => void }) {
  return <NoteModal {...props} variant="debit" />;
}

// ─── 6. Deposit (multi-line, documentType=deposit_invoice) ──────────────────

export function DepositModal({ corp, onClose, onSaved }: {
  corp: CorpContext; onClose: () => void; onSaved: () => void;
}) {
  const c = useColors();
  const cylOpts = useCylinderTypes();

  const [supplierDocumentNumber, setSupplierDocumentNumber] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayLocalIso());
  const [plantName, setPlantName] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ cylinderTypeId: string; qty: string; depositPerCyl: string }>>([
    { cylinderTypeId: '', qty: '', depositPerCyl: '' },
  ]);

  const total = lines.reduce((s, l) => s + toNum(l.qty) * toNum(l.depositPerCyl), 0);

  const mutation = useApiMutation<unknown, Record<string, unknown>>('post', '/purchase-entries', {
    successMessage: 'Deposit invoice recorded',
    invalidateKeys: INVALIDATE_ALL,
    onSuccess: onSaved,
  });

  const submit = () => {
    const items = lines
      .filter((l) => l.cylinderTypeId && toNum(l.qty) > 0)
      .map((l) => ({
        cylinderTypeId: l.cylinderTypeId,
        fullsReceived: Math.trunc(toNum(l.qty)),
        emptiesGivenOut: 0,
        unitPrice: toNum(l.depositPerCyl),
        gstRate: 0,
      }));
    if (items.length === 0 || !purchaseDate) return;
    mutation.mutate({
      sourceDistributorId: corp.sourceDistributorId,
      purchaseDate,
      documentType: 'deposit_invoice',
      supplierDocumentNumber: supplierDocumentNumber.trim() || undefined,
      plantName: plantName.trim() || undefined,
      items,
      charges: [],
      notes: notes.trim() || undefined,
    });
  };

  const validLines = lines.some((l) => l.cylinderTypeId && toNum(l.qty) > 0);

  return (
    <FormModal
      title={`Cylinder Deposit — ${corp.name}`}
      subtitle="Nil-GST refundable — separate from gas outstanding"
      onClose={onClose}
      submitLabel="Record Deposit"
      onSubmit={submit}
      submitting={mutation.isPending}
      submitDisabled={!validLines}
    >
      <Field label="OMC Deposit Invoice No" value={supplierDocumentNumber} onChangeText={setSupplierDocumentNumber} placeholder="e.g. LI026S-00290" />
      <LabeledDate label="Invoice Date" value={purchaseDate} onChange={setPurchaseDate} required />
      <Field label="Plant (optional)" value={plantName} onChangeText={setPlantName} placeholder="e.g. Sanaswadi" />

      <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: c.muted }}>Cylinders added to pool</Text>
          <TouchableOpacity onPress={() => setLines((ls) => [...ls, { cylinderTypeId: '', qty: '', depositPerCyl: '' }])}>
            <Text style={{ color: c.accent, fontWeight: '600', fontSize: 13 }}>+ Add line</Text>
          </TouchableOpacity>
        </View>
        {lines.map((l, i) => (
          <View key={i} style={{ gap: 8, marginBottom: 12, borderBottomWidth: lines.length > 1 ? 1 : 0, borderBottomColor: c.border, paddingBottom: lines.length > 1 ? 12 : 0 }}>
            <SelectField label="" value={l.cylinderTypeId} onChange={(v) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, cylinderTypeId: v } : x))} options={cylOpts} />
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}><Field label="Qty" value={l.qty} onChangeText={(v) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, qty: v } : x))} keyboardType="numeric" /></View>
              <View style={{ flex: 1.2 }}><Field label="Deposit / cyl ₹" value={l.depositPerCyl} onChangeText={(v) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, depositPerCyl: v } : x))} keyboardType="decimal-pad" /></View>
              {lines.length > 1 && (
                <TouchableOpacity onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} style={{ paddingBottom: 10 }}>
                  <Ionicons name="trash-outline" size={20} color={c.accent} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        ))}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: c.dark ? '#0f172a' : '#f1f5f9', padding: 12, borderRadius: 8 }}>
          <Text style={{ fontSize: 13, color: c.muted }}>Total deposit</Text>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>₹{total.toFixed(2)}</Text>
        </View>
      </View>

      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />
    </FormModal>
  );
}

// ─── Add-Entry menu (bottom sheet) ──────────────────────────────────────────

const ENTRY_MENU: Array<{ kind: CorpEntryKind; label: string; hint: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { kind: 'incoming_fulls', label: 'Incoming Fulls', hint: 'Fulls received from plant to godown', icon: 'arrow-down-circle-outline' },
  { kind: 'outgoing_empties', label: 'Outgoing Empties', hint: 'Empties sent from godown to plant', icon: 'arrow-up-circle-outline' },
  { kind: 'payment', label: 'Payment', hint: 'Money you paid the OMC', icon: 'cash-outline' },
  { kind: 'credit_note', label: 'Credit Note', hint: 'OMC issued you a CN (incentive)', icon: 'add-circle-outline' },
  { kind: 'debit_note', label: 'Debit Note', hint: 'OMC billed you extra', icon: 'remove-circle-outline' },
  { kind: 'deposit', label: 'Deposit', hint: 'Cylinder deposit invoice (Nil GST)', icon: 'archive-outline' },
];

export function AddEntryMenu({ onPick, onClose }: { onPick: (k: CorpEntryKind) => void; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => { /* swallow */ }} style={{
          backgroundColor: c.cardBg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          paddingTop: 8, paddingBottom: Math.max(insets.bottom + 8, 20),
        }}>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: c.border }} />
          </View>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, paddingHorizontal: 20, paddingVertical: 8 }}>Add Entry</Text>
          {ENTRY_MENU.map((m) => (
            <TouchableOpacity
              key={m.kind}
              onPress={() => onPick(m.kind)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 }}
            >
              <Ionicons name={m.icon} size={24} color={c.accent} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }}>{m.label}</Text>
                <Text style={{ fontSize: 12, color: c.muted, marginTop: 1 }}>{m.hint}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={c.muted} />
            </TouchableOpacity>
          ))}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

/** Dispatch helper — renders the right modal for a chosen kind. */
export function CorpEntryModalHost({ kind, corp, onClose, onSaved }: {
  kind: CorpEntryKind; corp: CorpContext; onClose: () => void; onSaved: () => void;
}) {
  const props = { corp, onClose, onSaved };
  switch (kind) {
    case 'incoming_fulls': return <IncomingFullsModal {...props} />;
    case 'outgoing_empties': return <OutgoingEmptiesModal {...props} />;
    case 'payment': return <PaymentModal {...props} />;
    case 'credit_note': return <CreditNoteModal {...props} />;
    case 'debit_note': return <DebitNoteModal {...props} />;
    case 'deposit': return <DepositModal {...props} />;
  }
}
