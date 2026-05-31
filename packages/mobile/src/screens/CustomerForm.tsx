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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiGet, getErrorMessage } from '../lib/api';
import { useApiQuery } from '../hooks/useApi';
import { useTheme, type ThemeColors } from '../theme';
import { SelectField } from '../components/ui';
import type { CylinderType, Customer as SharedCustomer } from '@gaslink/shared';

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
}: CustomerFormProps) {
  const { colors } = useTheme();
  const ACCENT = accent ?? DEFAULT_ACCENT;

  const [form, setForm] = useState<CustomerFormState>(() => mergeInitial(initial));
  const [gstinLookupStatus, setGstinLookupStatus] = useState<string | null>(null);
  const [gstinLookupError, setGstinLookupError] = useState<string | null>(null);
  const [gstinLookupLoading, setGstinLookupLoading] = useState(false);

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

    await onSubmit(payload);
  };

  const headerTitle = title ?? (mode === 'edit' ? 'Edit Customer' : 'New Customer');

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
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
          <Field
            value={form.billingState}
            onChangeText={(t) => set('billingState', t)}
            placeholder="State"
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
              <Field
                value={form.shippingState}
                onChangeText={(t) => set('shippingState', t)}
                placeholder="State"
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
      <CustomerForm {...rest} onCancel={onClose} />
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
