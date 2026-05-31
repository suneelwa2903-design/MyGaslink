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
import { useRouter } from 'expo-router';
import { useApiMutation } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
import { CustomerForm, type CustomerFormSubmit } from '../../src/screens/CustomerForm';
import { ACCENT } from '../../src/theme';
import type { Customer } from '@gaslink/shared';

export default function AdminCustomerCreateScreen() {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const canEditTransport = role === 'super_admin' || role === 'distributor_admin';

  const createMutation = useApiMutation<Customer, CustomerFormSubmit>('post', '/customers', {
    invalidateKeys: [['customers'], ['customers-list']],
    successMessage: 'Customer created',
    onSuccess: () => {
      router.back();
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
