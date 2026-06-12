/**
 * STAGE-F — Admin mobile Create Customer route.
 *
 * Hidden expo-router screen (href: null in (admin)/_layout.tsx). Reached from
 * More → Customers → FAB. Wraps the shared CustomerForm body
 * (src/screens/CustomerForm.tsx) and submits via POST /customers.
 *
 * Why a route instead of an inline Modal in more.tsx:
 *  - Web mounts the form in a Modal at the page level; mobile can use either.
 *  - The previous STEP-3E inline form lived inside CustomersModal which is
 *    itself a fullScreen Modal. Stacking another fullScreen Modal on top works
 *    on Android but is fragile on iOS (presentation re-mount + keyboard layout
 *    quirks). A real route stays out of that nesting.
 *  - This is hidden from the tab bar via `href: null` in the layout, so it
 *    doesn't conflict with the STAGE-H navigation work that will reshape the
 *    visible tabs.
 *
 * Edit flows reuse the SAME shared form body via CustomerFormModal (see
 * more.tsx EditCustomerInlineModal and customer-detail.tsx EditCustomerModal).
 */
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useApiMutation } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
import { CustomerForm, type CustomerFormSubmit } from '../../src/screens/CustomerForm';
import { ACCENT } from '../../src/theme';
import type { Customer } from '@gaslink/shared';

// Phase 7 (2026-06-12): the server returns `warnings: string[]` on
// successful create/update when the row was accepted but something is
// worth a heads-up — the canonical case is E1 (multi-branch customer
// with the same GSTIN as an existing record). Mobile previously dropped
// these on the floor; web showed them as a soft amber toast.
type CustomerWithWarnings = Customer & { warnings?: string[] };

export default function AdminCustomerCreateScreen() {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const canEditTransport = role === 'super_admin' || role === 'distributor_admin';

  const createMutation = useApiMutation<CustomerWithWarnings, CustomerFormSubmit>('post', '/customers', {
    invalidateKeys: [['customers'], ['customers-list']],
    // Suppress the generic "Customer created" toast — we surface a more
    // informative one below depending on whether warnings came back.
    onSuccess: (data) => {
      const warnings = data?.warnings ?? [];
      if (warnings.length > 0) {
        // Single combined alert so the user explicitly acknowledges the
        // soft warning before being routed back to the list. Web uses an
        // amber toast that auto-dismisses; on mobile a modal alert is
        // more visible against a scrollable form.
        Alert.alert(
          'Customer created — please review',
          warnings.join('\n\n'),
          [{ text: 'OK', onPress: () => router.back() }],
        );
      } else {
        Alert.alert('Success', 'Customer created', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      }
    },
  });

  return (
    <CustomerForm
      mode="create"
      canEditTransport={canEditTransport}
      accent={ACCENT.red}
      submitting={createMutation.isPending}
      onCancel={() => router.back()}
      onSubmit={async (data) => {
        // useApiMutation's default onError already shows an Alert; swallow the
        // rejection here so the form stays open and the user can retry.
        try {
          await createMutation.mutateAsync(data);
        } catch {
          // handled by hook
        }
      }}
    />
  );
}
