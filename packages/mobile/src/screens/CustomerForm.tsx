/**
 * STAGE-F — Shared mobile customer form (create + edit).
 *
 * Mirrors packages/web/src/pages/CustomersPage.tsx → CustomerFormModal
 * (web ref lines 272-551) with React Native primitives. Used by:
 *   - (admin)/customer-create.tsx               (Create flow — pushed from More → Customers)
 *   - (admin)/more.tsx EditCustomerInlineModal  (Edit from the customer list row)
 *   - (admin)/customer-detail.tsx EditCustomerModal (Edit from the detail screen)
 *
 * The body lives here so the three usages can't drift in field list, validation,
 * GSTIN auto-fetch behaviour, or submission shape — same pattern STAGE-E used
 * for ProfileScreen.
 *
 * Form structure (mirrors web, see CustomersPage.tsx:407-547):
 *   1. Basic        — Customer Name, Business Name, Phone, Email
 *   2. GSTIN        — single input + "Fetch Details" button + derived B2B/B2C chip
 *                     (web equivalent: CustomersPage.tsx:418-456)
 *   3. Billing      — addressLine1/2, city, state, pincode
 *   4. Shipping     — same fields, with optional "Same as billing" toggle
 *                     (DEVIATION from web — web has no toggle; web shows both
 *                      sections unconditionally. Mobile adds the toggle as a
 *                      space-saver; when ON, the fields are hidden and copied
 *                      from billing on submit.)
 *   5. Contacts     — list-of-rows: name, phone, email, isPrimary, trash
 *   6. Cylinder Discounts — list-of-rows: cylinder type picker + discount/unit
 *   7. Other        — Credit Period (days), Transport Charge (gated)
 *
 * customerType:
 *   The web has NO B2B/B2C toggle. The server derives customerType from gstin
 *   presence (services/customerService.ts:123 + :235). Mobile mirrors this —
 *   no toggle, just a chip near the GSTIN field showing the derived value.
 *   The previous STEP-3E mobile form sent `customerType: 'B2B' | 'B2C'` in the
 *   body but the shared schema (packages/shared/src/schemas/index.ts:96-117)
 *   does not list it, so Zod's default strip dropped it silently. We omit it
 *   from the submit body now.
 *
 * Transport charge edit is restricted to SUPER_ADMIN | DISTRIBUTOR_ADMIN per
 * the existing canEditTransport convention (CustomersPage.tsx:286).
 */
import { useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Modal,
  FlatList,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiGet, getErrorMessage } from '../lib/api';
import { useApiQuery } from '../hooks/useApi';
import { useAuthStore } from '../stores/authStore';
import { useTheme, type ThemeColors } from '../theme';
import { SelectField } from '../components/ui';
import type { CylinderType, Customer as SharedCustomer } from '@gaslink/shared';
import { INDIAN_STATE_NAMES } from '@gaslink/shared';

// ─── Constants ──────────────────────────────────────────────────────────────

// Same regex as packages/shared/src/constants/index.ts:13 (GSTIN_REGEX) — copied
// here as a hard-coded literal rather than importing because react-native bundle
// size on this screen doesn't warrant pulling the whole constants module.
const GSTIN_REGEX =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const PINCODE_REGEX = /^[0-9]{6}$/;

const DEFAULT_ACCENT = '#e11d1d';

// ─── Public form shape ──────────────────────────────────────────────────────

export interface CustomerContactRow {
  name: string;
  phone: string;
  email: string;
  isPrimary: boolean;
}

export interface CustomerDiscountRow {
  cylinderTypeId: string;
  discountPerUnit: string; // string in form, parsed on submit
}

/**
 * The shape the form holds in state. Strings throughout for TextInput
 * compatibility; numeric fields are parsed on submit.
 */
export interface CustomerFormState {
  customerName: string;
  businessName: string;
  phone: string;
  email: string;
  gstin: string;
  billingAddressLine1: string;
  billingAddressLine2: string;
  billingCity: string;
  billingState: string;
  billingPincode: string;
  shippingSameAsBilling: boolean;
  shippingAddressLine1: string;
  shippingAddressLine2: string;
  shippingCity: string;
  shippingState: string;
  shippingPincode: string;
  contacts: CustomerContactRow[];
  cylinderDiscounts: CustomerDiscountRow[];
  creditPeriodDays: string;
  transportChargePerCylinder: string;
  // GST rate (percent). Stored as a string '5' | '18' for picker
  // consistency with the rest of the form; parsed on submit.
  gstRateOverride: '5' | '18';
}

/**
 * The shape the form emits to the caller on submit. Numeric fields parsed,
 * empty strings normalised to undefined, shipping resolved if "same as
 * billing" was on. customerType is intentionally omitted — server derives it
 * from gstin presence.
 */
export interface CustomerFormSubmit {
  customerName: string;
  businessName?: string;
  phone: string;
  email?: string;
  gstin?: string;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingState?: string;
  billingPincode?: string;
  shippingAddressLine1?: string;
  shippingAddressLine2?: string;
  shippingCity?: string;
  shippingState?: string;
  shippingPincode?: string;
  contacts?: { name: string; phone: string; email?: string; isPrimary: boolean }[];
  cylinderDiscounts?: { cylinderTypeId: string; discountPerUnit: number }[];
  creditPeriodDays: number;
  transportChargePerCylinder?: number;
  // 5 → food-service (commercial-LPG-eligible) customer. 18 → standard.
  // Sent as a number; null when caller passes 18 to keep the platform
  // default semantics (caller code at api layer normalises).
  gstRateOverride: 5 | 18;
  // 2026-07-21 opening-state seed. Universal. Nested on POST /customers
  // for the create path; caller extracts and POSTs to
  // /customers/:id/seed-opening-state separately on the edit path.
  // Absent unless the operator filled at least one axis.
  openingState?: {
    preferredCylinderTypeIds?: string[];
    empties?: { cylinderTypeId: string; qty: number }[];
    openingBalance?: {
      amount: number;
      asOfDate: string;
      notes?: string;
    };
  };
}

export type CustomerFormInitial = Partial<CustomerFormState>;

// ─── GSTIN lookup response ──────────────────────────────────────────────────

interface GstinLookupResponse {
  gstin: string;
  legalName: string;
  tradeName: string;
  address: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  status: string;
}

// ─── Empty state ────────────────────────────────────────────────────────────

function emptyFormState(): CustomerFormState {
  return {
    customerName: '',
    businessName: '',
    phone: '',
    email: '',
    gstin: '',
    billingAddressLine1: '',
    billingAddressLine2: '',
    billingCity: '',
    billingState: '',
    billingPincode: '',
    shippingSameAsBilling: true,
    shippingAddressLine1: '',
    shippingAddressLine2: '',
    shippingCity: '',
    shippingState: '',
    shippingPincode: '',
    contacts: [],
    cylinderDiscounts: [],
    creditPeriodDays: '30',
    transportChargePerCylinder: '0',
    gstRateOverride: '18',
  };
}

function mergeInitial(initial?: CustomerFormInitial): CustomerFormState {
  return { ...emptyFormState(), ...(initial ?? {}) };
}

// STAGE-F: map a SharedCustomer (GET /customers/:id response) into the form's
// CustomerFormInitial shape. Shipping defaults to "Same as billing" when the
// shipping fields are either all-empty or exactly equal to the billing ones —
// otherwise the user gets shipping fields preserved as distinct.
export function customerToFormInitial(c: SharedCustomer): CustomerFormInitial {
  const same = isShippingSameAsBilling(c);
  return {
    customerName: c.customerName,
    businessName: c.businessName ?? '',
    phone: c.phone,
    email: c.email ?? '',
    gstin: c.gstin ?? '',
    billingAddressLine1: c.billingAddressLine1 ?? '',
    billingAddressLine2: c.billingAddressLine2 ?? '',
    billingCity: c.billingCity ?? '',
    billingState: c.billingState ?? '',
    billingPincode: c.billingPincode ?? '',
    shippingSameAsBilling: same,
    shippingAddressLine1: c.shippingAddressLine1 ?? '',
    shippingAddressLine2: c.shippingAddressLine2 ?? '',
    shippingCity: c.shippingCity ?? '',
    shippingState: c.shippingState ?? '',
    shippingPincode: c.shippingPincode ?? '',
    contacts: c.contacts.map((row) => ({
      name: row.name,
      phone: row.phone,
      email: row.email ?? '',
      isPrimary: row.isPrimary,
    })),
    cylinderDiscounts: c.cylinderDiscounts.map((row) => ({
      cylinderTypeId: row.cylinderTypeId,
      discountPerUnit: String(row.discountPerUnit),
    })),
    creditPeriodDays: String(c.creditPeriodDays ?? 30),
    transportChargePerCylinder: String(c.transportChargePerCylinder ?? 0),
    gstRateOverride: c.gstRateOverride === 5 ? '5' : '18',
  };
}

function isShippingSameAsBilling(c: SharedCustomer): boolean {
  const allShippingEmpty =
    !c.shippingAddressLine1 &&
    !c.shippingAddressLine2 &&
    !c.shippingCity &&
    !c.shippingState &&
    !c.shippingPincode;
  if (allShippingEmpty) return true;
  return (
    (c.shippingAddressLine1 ?? '') === (c.billingAddressLine1 ?? '') &&
    (c.shippingAddressLine2 ?? '') === (c.billingAddressLine2 ?? '') &&
    (c.shippingCity ?? '') === (c.billingCity ?? '') &&
    (c.shippingState ?? '') === (c.billingState ?? '') &&
    (c.shippingPincode ?? '') === (c.billingPincode ?? '')
  );
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface CustomerFormProps {
  mode: 'create' | 'edit';
  initial?: CustomerFormInitial;
  onSubmit: (data: CustomerFormSubmit) => Promise<void> | void;
  onCancel: () => void;
  submitting: boolean;
  canEditTransport: boolean;
  accent?: string;
  title?: string;
  // 2026-07-21 opening-state seed: legacy flag kept for backward
  // compatibility with any caller that still passes it. Prefer
  // `initialOpeningState` — when it carries a truthy `seededAt`,
  // the form knows this is an edit-existing-state flow.
  alreadySeeded?: boolean;
  // 2026-07-21 opening-state EDIT: prefill values from the customer's
  // currentOpeningState (from GET /customers/:id). When `seededAt` is
  // set, the panel shows "Edit Opening State" and the parent submits
  // to PUT /opening-state instead of POST /seed-opening-state.
  initialOpeningState?: {
    seededAt?: string | null;
    preferredCylinderTypeIds?: string[];
    empties?: Array<{ cylinderTypeId: string; qty: number }>;
    openingBalance?: {
      amount: number;
      amountPaid?: number;
      notes?: string | null;
    } | null;
  };
}

// ─── Main component ─────────────────────────────────────────────────────────

export function CustomerForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  submitting,
  canEditTransport,
  accent,
  title,
  alreadySeeded,
  initialOpeningState,
}: CustomerFormProps) {
  const { colors } = useTheme();
  const ACCENT = accent ?? DEFAULT_ACCENT;

  const [form, setForm] = useState<CustomerFormState>(() => mergeInitial(initial));
  const [gstinLookupStatus, setGstinLookupStatus] = useState<string | null>(null);
  const [gstinLookupError, setGstinLookupError] = useState<string | null>(null);
  const [gstinLookupLoading, setGstinLookupLoading] = useState(false);

  // 2026-07-21 opening-state seed — MINI-OPERATOR ONLY. Panel visible
  // on Create AND Edit (edit-in-place when already seeded, seed-later
  // when not). Parent handles POST vs PUT routing based on
  // initialOpeningState.seededAt.
  const role = useAuthStore((s) => s.user?.role);
  const isMiniOpAdmin = role === 'mini_operator_admin';
  const showOpeningSetup = isMiniOpAdmin && (mode === 'create' || alreadySeeded !== true);
  const isEditingSeededOpening = !!initialOpeningState?.seededAt;
  const [openingPreferredIds, setOpeningPreferredIds] = useState<Set<string>>(
    () => new Set(initialOpeningState?.preferredCylinderTypeIds ?? []),
  );
  const [openingEmpties, setOpeningEmpties] = useState<Record<string, string>>(
    () => Object.fromEntries(
      (initialOpeningState?.empties ?? []).map((e) => [e.cylinderTypeId, String(e.qty)]),
    ),
  );
  const [openingBalanceAmount, setOpeningBalanceAmount] = useState<string>(
    () => initialOpeningState?.openingBalance ? String(initialOpeningState.openingBalance.amount) : '',
  );
  const [openingBalanceAsOfDate, setOpeningBalanceAsOfDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [openingBalanceNotes, setOpeningBalanceNotes] = useState<string>(
    () => initialOpeningState?.openingBalance?.notes ?? '',
  );
  // 2026-07-21 CRITICAL — the initializers above run ONCE on mount. If the
  // customer detail query resolves after CustomerForm has mounted, the
  // panel stays blank AND an unrelated save (e.g. address change) submits
  // an empty openingState payload, which the service reads as "clear the
  // seeded state" and deletes the OB invoice. openingStateDirty gates the
  // submission — parent only pulls openingState off the payload when the
  // operator actually touched the panel.
  const [openingStateDirty, setOpeningStateDirty] = useState(false);
  const opStateSyncKey = initialOpeningState?.seededAt ?? null;
  const [lastSyncedKey, setLastSyncedKey] = useState<string | null>(null);
  // Sync from initialOpeningState during render (React's "derive state
  // from props" pattern) when the parent's customer detail query
  // resolves. Gated so it fires once per unique sync key.
  if (mode === 'edit' && opStateSyncKey !== lastSyncedKey) {
    setLastSyncedKey(opStateSyncKey);
    const os = initialOpeningState;
    setOpeningPreferredIds(new Set(os?.preferredCylinderTypeIds ?? []));
    setOpeningEmpties(
      Object.fromEntries((os?.empties ?? []).map((e) => [e.cylinderTypeId, String(e.qty)])),
    );
    setOpeningBalanceAmount(os?.openingBalance ? String(os.openingBalance.amount) : '');
    setOpeningBalanceNotes(os?.openingBalance?.notes ?? '');
    setOpeningStateDirty(false);
  }

  // ─── Cylinder Types for discount picker ──────────────────────────────────
  // Same endpoint web uses (CustomersPage.tsx:63-67).
  const { data: cylinderTypesResp } = useApiQuery<{ cylinderTypes: CylinderType[] }>(
    ['cylinder-types'],
    '/cylinder-types',
    undefined,
    { staleTime: 10 * 60 * 1000 },
  );
  const cylinderTypes = useMemo(
    () => cylinderTypesResp?.cylinderTypes ?? [],
    [cylinderTypesResp],
  );

  // ─── Derived ──────────────────────────────────────────────────────────────

  // Server derives B2B/B2C from gstin presence (customerService.ts:123). We
  // mirror that in the chip so admins see the derived value as they type.
  const derivedType: 'B2B' | 'B2C' = form.gstin.trim() ? 'B2B' : 'B2C';

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const set = useCallback(
    <K extends keyof CustomerFormState>(key: K, value: CustomerFormState[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [],
  );

  const updateContact = (index: number, patch: Partial<CustomerContactRow>) => {
    setForm((f) => ({
      ...f,
      contacts: f.contacts.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  };

  const addContact = () => {
    setForm((f) => ({
      ...f,
      contacts: [...f.contacts, { name: '', phone: '', email: '', isPrimary: false }],
    }));
  };

  const removeContact = (index: number) => {
    setForm((f) => ({ ...f, contacts: f.contacts.filter((_, i) => i !== index) }));
  };

  const updateDiscount = (index: number, patch: Partial<CustomerDiscountRow>) => {
    setForm((f) => ({
      ...f,
      cylinderDiscounts: f.cylinderDiscounts.map((d, i) =>
        i === index ? { ...d, ...patch } : d,
      ),
    }));
  };

  const addDiscount = () => {
    setForm((f) => ({
      ...f,
      cylinderDiscounts: [
        ...f.cylinderDiscounts,
        { cylinderTypeId: '', discountPerUnit: '0' },
      ],
    }));
  };

  const removeDiscount = (index: number) => {
    setForm((f) => ({
      ...f,
      cylinderDiscounts: f.cylinderDiscounts.filter((_, i) => i !== index),
    }));
  };

  // ─── GSTIN auto-fetch ─────────────────────────────────────────────────────
  // Mirrors handleFetchGstin on web (CustomersPage.tsx:370-378). Same endpoint
  // path: GET /distributors/gstin-lookup/:gstin (api/src/routes/distributors.ts:20).
  // On success populates business name + billing address; phone is preserved
  // (NIC data is often stale for contact info — web behaviour).
  const handleFetchGstin = async () => {
    const raw = form.gstin.trim().toUpperCase();
    setGstinLookupError(null);
    setGstinLookupStatus(null);
    if (raw.length !== 15) {
      setGstinLookupError('GSTIN must be exactly 15 characters');
      return;
    }
    setGstinLookupLoading(true);
    try {
      const data = await apiGet<GstinLookupResponse>(
        `/distributors/gstin-lookup/${encodeURIComponent(raw)}`,
      );
      setGstinLookupStatus(data.status || 'Active');
      setForm((f) => ({
        ...f,
        gstin: raw,
        businessName: data.tradeName || data.legalName || f.businessName,
        billingAddressLine1: data.address || '',
        billingAddressLine2: '',
        billingCity: data.city || '',
        billingState: data.state || '',
        billingPincode: data.pincode || '',
      }));
    } catch (err) {
      const message = getErrorMessage(err);
      setGstinLookupError(message);
      Alert.alert(
        'Could not fetch GSTIN details',
        `${message}\n\nYou can still fill the address fields manually.`,
      );
    } finally {
      setGstinLookupLoading(false);
    }
  };

  const isActiveGstin = !!gstinLookupStatus && /^active$/i.test(gstinLookupStatus);

  // ─── Validation + submit ──────────────────────────────────────────────────

  const handleSubmit = async () => {
    // Required fields.
    if (!form.customerName.trim()) {
      Alert.alert('Validation', 'Customer name is required.');
      return;
    }
    if (!form.phone.trim()) {
      Alert.alert('Validation', 'Phone is required.');
      return;
    }
    // GSTIN format (optional but if present must match).
    const gstinTrim = form.gstin.trim().toUpperCase();
    if (gstinTrim && !GSTIN_REGEX.test(gstinTrim)) {
      Alert.alert('Validation', 'GSTIN format is invalid.');
      return;
    }
    // Pincode format (optional but if present must be 6 digits).
    if (form.billingPincode.trim() && !PINCODE_REGEX.test(form.billingPincode.trim())) {
      Alert.alert('Validation', 'Billing pincode must be 6 digits.');
      return;
    }
    if (
      !form.shippingSameAsBilling &&
      form.shippingPincode.trim() &&
      !PINCODE_REGEX.test(form.shippingPincode.trim())
    ) {
      Alert.alert('Validation', 'Shipping pincode must be 6 digits.');
      return;
    }
    // Credit period (defaults to 30 if empty).
    const credit =
      form.creditPeriodDays.trim() === ''
        ? 30
        : parseInt(form.creditPeriodDays, 10);
    if (Number.isNaN(credit) || credit < 0 || credit > 365) {
      Alert.alert('Validation', 'Credit period must be between 0 and 365 days.');
      return;
    }
    // Transport charge (only validated when admin shows the field).
    let transport: number | undefined;
    if (canEditTransport) {
      const raw = form.transportChargePerCylinder.trim();
      const parsed = raw === '' ? 0 : parseFloat(raw);
      if (Number.isNaN(parsed) || parsed < 0) {
        Alert.alert('Validation', 'Transport charge must be a non-negative number.');
        return;
      }
      transport = parsed;
    }
    // Contacts — name and phone required for each row.
    for (let i = 0; i < form.contacts.length; i++) {
      const c = form.contacts[i]!;
      if (!c.name.trim()) {
        Alert.alert('Validation', `Contact #${i + 1} requires a name.`);
        return;
      }
      if (!c.phone.trim()) {
        Alert.alert('Validation', `Contact #${i + 1} requires a phone.`);
        return;
      }
    }
    // Cylinder discounts — type id required, discount must parse to a non-neg number.
    for (let i = 0; i < form.cylinderDiscounts.length; i++) {
      const d = form.cylinderDiscounts[i]!;
      if (!d.cylinderTypeId) {
        Alert.alert('Validation', `Discount #${i + 1} requires a cylinder type.`);
        return;
      }
      const n = parseFloat(d.discountPerUnit);
      if (Number.isNaN(n) || n < 0) {
        Alert.alert(
          'Validation',
          `Discount #${i + 1} must be a non-negative number.`,
        );
        return;
      }
    }

    // Resolve shipping = billing when toggle is on.
    const shipping = form.shippingSameAsBilling
      ? {
          shippingAddressLine1: form.billingAddressLine1.trim() || undefined,
          shippingAddressLine2: form.billingAddressLine2.trim() || undefined,
          shippingCity: form.billingCity.trim() || undefined,
          shippingState: form.billingState.trim() || undefined,
          shippingPincode: form.billingPincode.trim() || undefined,
        }
      : {
          shippingAddressLine1: form.shippingAddressLine1.trim() || undefined,
          shippingAddressLine2: form.shippingAddressLine2.trim() || undefined,
          shippingCity: form.shippingCity.trim() || undefined,
          shippingState: form.shippingState.trim() || undefined,
          shippingPincode: form.shippingPincode.trim() || undefined,
        };

    const payload: CustomerFormSubmit = {
      customerName: form.customerName.trim(),
      businessName: form.businessName.trim() || undefined,
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      gstin: gstinTrim || undefined,
      billingAddressLine1: form.billingAddressLine1.trim() || undefined,
      billingAddressLine2: form.billingAddressLine2.trim() || undefined,
      billingCity: form.billingCity.trim() || undefined,
      billingState: form.billingState.trim() || undefined,
      billingPincode: form.billingPincode.trim() || undefined,
      ...shipping,
      creditPeriodDays: credit,
      transportChargePerCylinder: transport,
      gstRateOverride: (form.gstRateOverride === '5' ? 5 : 18) as 5 | 18,
      contacts: form.contacts.length
        ? form.contacts.map((c) => ({
            name: c.name.trim(),
            phone: c.phone.trim(),
            email: c.email.trim() || undefined,
            isPrimary: c.isPrimary,
          }))
        : undefined,
      cylinderDiscounts: form.cylinderDiscounts.length
        ? form.cylinderDiscounts.map((d) => ({
            cylinderTypeId: d.cylinderTypeId,
            discountPerUnit: parseFloat(d.discountPerUnit),
          }))
        : undefined,
    };

    // 2026-07-21: opening state — attach when panel is visible AND (on
    // edit) the operator actually touched the panel. This guards against
    // the "empty modal → save address → nuked OB" regression on edit
    // where the initial useState fired before the customer detail query
    // resolved. On create, no dirty gate — any input counts.
    const shouldAttachOpeningState =
      showOpeningSetup && (mode === 'edit' ? openingStateDirty : true);
    if (shouldAttachOpeningState) {
      const emptiesPayload = Object.entries(openingEmpties)
        .map(([cylinderTypeId, qtyStr]) => ({ cylinderTypeId, qty: parseInt(qtyStr, 10) }))
        .filter((row) => Number.isFinite(row.qty) && row.qty > 0);
      const obAmount = Number(openingBalanceAmount);
      const hasOb = Number.isFinite(obAmount) && obAmount > 0 && !!openingBalanceAsOfDate;
      if (openingPreferredIds.size > 0 || emptiesPayload.length > 0 || hasOb) {
        payload.openingState = {
          preferredCylinderTypeIds: Array.from(openingPreferredIds),
          empties: emptiesPayload,
          openingBalance: hasOb
            ? {
                amount: obAmount,
                asOfDate: openingBalanceAsOfDate,
                notes: openingBalanceNotes.trim() || undefined,
              }
            : undefined,
        };
      }
    }

    await onSubmit(payload);
  };

  const headerTitle = title ?? (mode === 'edit' ? 'Edit Customer' : 'New Customer');

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.divider,
        }}
      >
        <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
          {headerTitle}
        </Text>
        <TouchableOpacity
          onPress={onCancel}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Section 1: Basic */}
          <SectionHeader label="Basic Information" colors={colors} />
          <FieldLabel label="Customer Name *" colors={colors} />
          <Field
            value={form.customerName}
            onChangeText={(t) => set('customerName', t)}
            placeholder="Full name"
            colors={colors}
          />
          <FieldLabel label="Business Name" colors={colors} />
          <Field
            value={form.businessName}
            onChangeText={(t) => set('businessName', t)}
            placeholder="Business name (optional)"
            colors={colors}
          />
          <FieldLabel label="Phone *" colors={colors} />
          <Field
            value={form.phone}
            onChangeText={(t) => set('phone', t)}
            placeholder="10-digit mobile"
            keyboardType="phone-pad"
            colors={colors}
          />
          <FieldLabel label="Email" colors={colors} />
          <Field
            value={form.email}
            onChangeText={(t) => set('email', t)}
            placeholder="Email (optional)"
            keyboardType="email-address"
            autoCapitalize="none"
            colors={colors}
          />

          {/* Section 2: GSTIN + derived type chip + fetch */}
          <SectionHeader label="GSTIN" colors={colors} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 12,
                backgroundColor: derivedType === 'B2B' ? '#3b82f6' + '22' : '#64748b' + '22',
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: derivedType === 'B2B' ? '#3b82f6' : colors.textSecondary,
                }}
              >
                {derivedType}
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: colors.textMuted }}>
              {derivedType === 'B2B'
                ? 'Derived from GSTIN presence'
                : 'No GSTIN — unregistered customer'}
            </Text>
          </View>
          <Field
            value={form.gstin}
            onChangeText={(t) => set('gstin', t.toUpperCase())}
            placeholder="e.g. 29ABCDE1234F1Z5"
            autoCapitalize="characters"
            colors={colors}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 14, flexWrap: 'wrap' }}>
            <TouchableOpacity
              onPress={handleFetchGstin}
              disabled={form.gstin.trim().length !== 15 || gstinLookupLoading}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: colors.inputBg,
                borderWidth: 1,
                borderColor: colors.inputBorder,
                opacity:
                  form.gstin.trim().length !== 15 || gstinLookupLoading ? 0.5 : 1,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {gstinLookupLoading ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Ionicons name="cloud-download-outline" size={14} color={colors.text} />
              )}
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                Fetch Details
              </Text>
            </TouchableOpacity>
            {gstinLookupStatus ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: isActiveGstin ? '#10b981' : '#ef4444',
                  }}
                />
                <Text
                  style={{
                    fontSize: 12,
                    color: isActiveGstin ? '#10b981' : '#ef4444',
                    fontWeight: '600',
                  }}
                >
                  {gstinLookupStatus}
                </Text>
              </View>
            ) : null}
            {gstinLookupError ? (
              <Text style={{ fontSize: 12, color: '#ef4444', flex: 1 }} numberOfLines={2}>
                {gstinLookupError}
              </Text>
            ) : null}
          </View>

          {/* Section 3: Billing Address */}
          <SectionHeader label="Billing Address" colors={colors} />
          <FieldLabel label="Address Line 1" colors={colors} />
          <Field
            value={form.billingAddressLine1}
            onChangeText={(t) => set('billingAddressLine1', t)}
            placeholder="Address line 1"
            colors={colors}
          />
          <FieldLabel label="Address Line 2" colors={colors} />
          <Field
            value={form.billingAddressLine2}
            onChangeText={(t) => set('billingAddressLine2', t)}
            placeholder="Address line 2 (optional)"
            colors={colors}
          />
          <FieldLabel label="City" colors={colors} />
          <Field
            value={form.billingCity}
            onChangeText={(t) => set('billingCity', t)}
            placeholder="City"
            colors={colors}
          />
          <FieldLabel label="State" colors={colors} />
          <StatePickerField
            value={form.billingState}
            onChange={(t) => set('billingState', t)}
            colors={colors}
          />
          <FieldLabel label="Pincode" colors={colors} />
          <Field
            value={form.billingPincode}
            onChangeText={(t) => set('billingPincode', t)}
            placeholder="6-digit pincode"
            keyboardType="numeric"
            colors={colors}
          />

          {/* Section 4: Shipping Address */}
          <SectionHeader label="Shipping Address" colors={colors} />
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <Text style={{ fontSize: 13, color: colors.text, fontWeight: '600' }}>
              Same as billing
            </Text>
            <Switch
              value={form.shippingSameAsBilling}
              onValueChange={(v) => set('shippingSameAsBilling', v)}
              trackColor={{ false: colors.inputBorder, true: ACCENT }}
              thumbColor="#ffffff"
            />
          </View>
          {!form.shippingSameAsBilling && (
            <>
              <FieldLabel label="Address Line 1" colors={colors} />
              <Field
                value={form.shippingAddressLine1}
                onChangeText={(t) => set('shippingAddressLine1', t)}
                placeholder="Address line 1"
                colors={colors}
              />
              <FieldLabel label="Address Line 2" colors={colors} />
              <Field
                value={form.shippingAddressLine2}
                onChangeText={(t) => set('shippingAddressLine2', t)}
                placeholder="Address line 2 (optional)"
                colors={colors}
              />
              <FieldLabel label="City" colors={colors} />
              <Field
                value={form.shippingCity}
                onChangeText={(t) => set('shippingCity', t)}
                placeholder="City"
                colors={colors}
              />
              <FieldLabel label="State" colors={colors} />
              <StatePickerField
                value={form.shippingState}
                onChange={(t) => set('shippingState', t)}
                colors={colors}
              />
              <FieldLabel label="Pincode" colors={colors} />
              <Field
                value={form.shippingPincode}
                onChangeText={(t) => set('shippingPincode', t)}
                placeholder="6-digit pincode"
                keyboardType="numeric"
                colors={colors}
              />
            </>
          )}

          {/* Section 5: Contacts */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 24,
              marginBottom: 12,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>
              Contacts
            </Text>
            <TouchableOpacity
              onPress={addContact}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: ACCENT + '14',
              }}
            >
              <Ionicons name="add" size={14} color={ACCENT} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: ACCENT }}>
                Add Contact
              </Text>
            </TouchableOpacity>
          </View>
          {form.contacts.length === 0 ? (
            <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
              No additional contacts.
            </Text>
          ) : null}
          {form.contacts.map((c, index) => (
            <View
              key={`contact-${index}`}
              style={{
                padding: 12,
                marginBottom: 10,
                borderRadius: 10,
                backgroundColor: colors.cardBg,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                gap: 8,
              }}
            >
              <Field
                value={c.name}
                onChangeText={(t) => updateContact(index, { name: t })}
                placeholder="Name *"
                colors={colors}
              />
              <Field
                value={c.phone}
                onChangeText={(t) => updateContact(index, { phone: t })}
                placeholder="Phone *"
                keyboardType="phone-pad"
                colors={colors}
              />
              <Field
                value={c.email}
                onChangeText={(t) => updateContact(index, { email: t })}
                placeholder="Email (optional)"
                keyboardType="email-address"
                autoCapitalize="none"
                colors={colors}
              />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Switch
                    value={c.isPrimary}
                    onValueChange={(v) => updateContact(index, { isPrimary: v })}
                    trackColor={{ false: colors.inputBorder, true: ACCENT }}
                    thumbColor="#ffffff"
                  />
                  <Text style={{ fontSize: 13, color: colors.text }}>Primary</Text>
                </View>
                <TouchableOpacity
                  onPress={() => removeContact(index)}
                  style={{
                    padding: 6,
                    borderRadius: 6,
                    backgroundColor: '#ef4444' + '14',
                  }}
                >
                  <Ionicons name="trash-outline" size={16} color="#ef4444" />
                </TouchableOpacity>
              </View>
            </View>
          ))}

          {/* 2026-07-21 Opening Setup — universal. Hidden on Edit
                when the customer was already seeded (ledger anchored). */}
          {showOpeningSetup && (
            <View
              style={{
                marginTop: 20,
                marginBottom: 12,
                padding: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: ACCENT + '40',
                backgroundColor: ACCENT + '08',
                gap: 12,
              }}
            >
              <View>
                <Text style={{ fontSize: 14, fontWeight: '700', color: ACCENT }}>
                  {isEditingSeededOpening
                    ? 'Edit Opening State'
                    : mode === 'edit'
                    ? 'Set Opening State (one-time)'
                    : 'Opening Setup'}
                </Text>
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 3 }}>
                  {isEditingSeededOpening
                    ? 'Edit the seeded opening state. Cleared amounts are only allowed when no payments have been recorded.'
                    : 'Seed this customer’s starting state so the ledger reconciles from day one. Every axis is optional.'}
                </Text>
              </View>

              {/* 1. Preferred cylinder types */}
              <View>
                <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                  Cylinder types this customer usually buys
                </Text>
                {cylinderTypes.length === 0 ? (
                  <Text style={{ fontSize: 11, color: colors.textMuted, fontStyle: 'italic' }}>
                    Add cylinder types in Settings first.
                  </Text>
                ) : (
                  <View style={{ gap: 6 }}>
                    {cylinderTypes.map((ct) => {
                      const checked = openingPreferredIds.has(ct.cylinderTypeId);
                      return (
                        <TouchableOpacity
                          key={ct.cylinderTypeId}
                          onPress={() => {
                            setOpeningStateDirty(true);
                            setOpeningPreferredIds((prev) => {
                              const next = new Set(prev);
                              if (checked) next.delete(ct.cylinderTypeId);
                              else next.add(ct.cylinderTypeId);
                              return next;
                            });
                          }}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}
                        >
                          <View
                            style={{
                              width: 18, height: 18, borderRadius: 4,
                              borderWidth: 1.5,
                              borderColor: checked ? ACCENT : colors.cardBorder,
                              backgroundColor: checked ? ACCENT : 'transparent',
                              alignItems: 'center', justifyContent: 'center',
                            }}
                          >
                            {checked && <Ionicons name="checkmark" size={12} color="#fff" />}
                          </View>
                          <Text style={{ fontSize: 13, color: colors.text }}>{ct.typeName}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                  Preferred types float to the top of the order form with a &quot;usual&quot; tag. Nothing is blocked.
                </Text>
              </View>

              {/* 2. Empties currently held */}
              {openingPreferredIds.size > 0 && (
                <View>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                    Empty cylinders currently held
                  </Text>
                  <View style={{ gap: 8 }}>
                    {Array.from(openingPreferredIds).map((typeId) => {
                      const ct = cylinderTypes.find((c) => c.cylinderTypeId === typeId);
                      if (!ct) return null;
                      return (
                        <View key={typeId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <Text style={{ fontSize: 13, color: colors.text, flex: 1 }}>{ct.typeName}</Text>
                          <View style={{ width: 90 }}>
                            <Field
                              value={openingEmpties[typeId] ?? ''}
                              onChangeText={(t) => { setOpeningStateDirty(true); setOpeningEmpties((prev) => ({ ...prev, [typeId]: t })); }}
                              placeholder="0"
                              keyboardType="numeric"
                              colors={colors}
                            />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* 3. Opening balance (₹) */}
              <View>
                <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                  Opening balance (₹ already owed)
                </Text>
                <FieldLabel label="Amount (₹)" colors={colors} />
                <Field
                  value={openingBalanceAmount}
                  onChangeText={(t) => { setOpeningStateDirty(true); setOpeningBalanceAmount(t); }}
                  placeholder="e.g. 8500"
                  keyboardType="numeric"
                  colors={colors}
                />
                <FieldLabel label="As of date (YYYY-MM-DD)" colors={colors} />
                <Field
                  value={openingBalanceAsOfDate}
                  onChangeText={(t) => { setOpeningStateDirty(true); setOpeningBalanceAsOfDate(t); }}
                  placeholder="2026-07-21"
                  colors={colors}
                />
                <FieldLabel label="Notes (optional)" colors={colors} />
                <Field
                  value={openingBalanceNotes}
                  onChangeText={(t) => { setOpeningStateDirty(true); setOpeningBalanceNotes(t); }}
                  placeholder="e.g. from paper ledger"
                  colors={colors}
                />
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                  Ledger will show &quot;Opening Balance b/f&quot; as row 0 with the seeded empties count.
                </Text>
              </View>
            </View>
          )}

          {/* Section 6: Cylinder Discounts */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 16,
              marginBottom: 12,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>
              Cylinder Discounts
            </Text>
            <TouchableOpacity
              onPress={addDiscount}
              disabled={cylinderTypes.length === 0}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: ACCENT + '14',
                opacity: cylinderTypes.length === 0 ? 0.5 : 1,
              }}
            >
              <Ionicons name="add" size={14} color={ACCENT} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: ACCENT }}>
                Add Discount
              </Text>
            </TouchableOpacity>
          </View>
          {form.cylinderDiscounts.length === 0 ? (
            <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
              No per-cylinder-type discounts.
            </Text>
          ) : null}
          {form.cylinderDiscounts.map((d, index) => {
            const options = cylinderTypes.map((ct) => ({
              value: ct.cylinderTypeId,
              label: ct.typeName,
            }));
            return (
              <View
                key={`discount-${index}`}
                style={{
                  padding: 12,
                  marginBottom: 10,
                  borderRadius: 10,
                  backgroundColor: colors.cardBg,
                  borderWidth: 1,
                  borderColor: colors.cardBorder,
                  gap: 8,
                }}
              >
                <SelectField
                  label="Cylinder Type"
                  value={d.cylinderTypeId}
                  options={options}
                  onChange={(v) => updateDiscount(index, { cylinderTypeId: v })}
                  accent={ACCENT}
                />
                <FieldLabel label="Discount per Unit (₹)" colors={colors} />
                <Field
                  value={d.discountPerUnit}
                  onChangeText={(t) => updateDiscount(index, { discountPerUnit: t })}
                  placeholder="0"
                  keyboardType="numeric"
                  colors={colors}
                />
                <TouchableOpacity
                  onPress={() => removeDiscount(index)}
                  style={{
                    alignSelf: 'flex-end',
                    padding: 6,
                    borderRadius: 6,
                    backgroundColor: '#ef4444' + '14',
                  }}
                >
                  <Ionicons name="trash-outline" size={16} color="#ef4444" />
                </TouchableOpacity>
              </View>
            );
          })}

          {/* Section 7: Other */}
          <SectionHeader label="Other" colors={colors} />
          <FieldLabel label="Credit Period (days)" colors={colors} />
          <Field
            value={form.creditPeriodDays}
            onChangeText={(t) => set('creditPeriodDays', t)}
            placeholder="e.g. 30"
            keyboardType="numeric"
            colors={colors}
          />
          {canEditTransport && (
            <>
              <FieldLabel
                label="Transport Charge (₹/cylinder, GST incl.)"
                colors={colors}
              />
              <Field
                value={form.transportChargePerCylinder}
                onChangeText={(t) => set('transportChargePerCylinder', t)}
                placeholder="0"
                keyboardType="numeric"
                colors={colors}
              />
            </>
          )}

          {/* GST Rate — 5% for food-service customers (hotels, restaurants,
              canteens), 18% standard. Drives InvoiceItem.gstRate at issue
              time in invoiceService.createInvoiceFromOrder. */}
          <FieldLabel label="GST Rate" colors={colors} />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
            {(['18', '5'] as const).map((opt) => {
              const selected = form.gstRateOverride === opt;
              return (
                <TouchableOpacity
                  key={opt}
                  onPress={() => set('gstRateOverride', opt)}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: selected ? ACCENT : colors.inputBorder,
                    backgroundColor: selected ? ACCENT + '14' : colors.inputBg,
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '700',
                      color: selected ? ACCENT : colors.text,
                    }}
                  >
                    {opt === '18' ? '18%' : '5%'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 14 }}>
            5% for hotels, restaurants, canteens using LPG for cooking.
          </Text>

          {/* Action row */}
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
            <TouchableOpacity
              onPress={onCancel}
              disabled={submitting}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: colors.cardBg,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textSecondary }}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: ACCENT,
                alignItems: 'center',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                  {mode === 'edit' ? 'Save Changes' : 'Create Customer'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Small fullscreen-Modal wrapper for the form ────────────────────────────
// Used by the two edit entry points (more.tsx + customer-detail.tsx) so they
// don't each re-implement Modal + presentationStyle plumbing. The create entry
// point uses a hidden expo-router route instead — see (admin)/customer-create.tsx.

export interface CustomerFormModalProps extends Omit<CustomerFormProps, 'onCancel'> {
  visible: boolean;
  onClose: () => void;
}

export function CustomerFormModal({
  visible,
  onClose,
  ...rest
}: CustomerFormModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
        <CustomerForm {...rest} onCancel={onClose} />
      </SafeAreaProvider>
    </Modal>
  );
}

// ─── Atoms ──────────────────────────────────────────────────────────────────

function SectionHeader({ label, colors }: { label: string; colors: ThemeColors }) {
  return (
    <Text
      style={{
        fontSize: 14,
        fontWeight: '700',
        color: colors.text,
        marginTop: 20,
        marginBottom: 12,
      }}
    >
      {label}
    </Text>
  );
}

function FieldLabel({ label, colors }: { label: string; colors: ThemeColors }) {
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: '600',
        color: colors.textSecondary,
        marginBottom: 6,
      }}
    >
      {label}
    </Text>
  );
}

function Field({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  colors,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address' | 'numeric';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  colors: ThemeColors;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize ?? 'sentences'}
      style={{
        backgroundColor: colors.inputBg,
        borderWidth: 1,
        borderColor: colors.inputBorder,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 15,
        color: colors.text,
        marginBottom: 12,
      }}
    />
  );
}

// Phase 7 (2026-06-12): state picker for the customer form's billingState
// + shippingState. Replaces the previous free-text TextInput which let
// users type any string (including "Telangaaana" / "TS" / "telegana").
// Web shipped a dropdown for this in commit 61392d8; mobile gets parity.
//
// Implemented as a modal + FlatList rather than a native Picker so we
// don't need to add `@react-native-picker/picker` as a dependency. The
// list also includes a search-as-you-type filter since 37 entries on a
// small touch surface is awkward to scroll.
function StatePickerField({
  value,
  onChange,
  colors,
}: {
  value: string;
  onChange: (state: string) => void;
  colors: ThemeColors;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const filtered = filter
    ? INDIAN_STATE_NAMES.filter((s) => s.toLowerCase().includes(filter.toLowerCase()))
    : INDIAN_STATE_NAMES;

  return (
    <>
      <TouchableOpacity
        onPress={() => { setFilter(''); setOpen(true); }}
        style={{
          backgroundColor: colors.inputBg,
          borderWidth: 1,
          borderColor: colors.inputBorder,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          marginBottom: 12,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
        accessibilityLabel="Pick a state"
      >
        <Text style={{ fontSize: 15, color: value ? colors.text : colors.textMuted }}>
          {value || 'Select state'}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </TouchableOpacity>
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>Pick a state</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>
          <TextInput
            value={filter}
            onChangeText={setFilter}
            placeholder="Search states"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            style={{
              backgroundColor: colors.inputBg,
              borderWidth: 1,
              borderColor: colors.inputBorder,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
              fontSize: 15,
              color: colors.text,
              margin: 12,
            }}
          />
          <FlatList
            data={filtered}
            keyExtractor={(s) => s}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => { onChange(item); setOpen(false); }}
                style={{ paddingHorizontal: 16, paddingVertical: 14, backgroundColor: item === value ? colors.inputBg : 'transparent' }}
              >
                <Text style={{ fontSize: 15, color: colors.text, fontWeight: item === value ? '700' : '400' }}>{item}</Text>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.divider, marginHorizontal: 16 }} />}
            ListEmptyComponent={
              <Text style={{ padding: 24, textAlign: 'center', color: colors.textMuted }}>
                No states match &quot;{filter}&quot;
              </Text>
            }
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}
