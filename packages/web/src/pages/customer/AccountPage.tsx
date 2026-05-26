import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import type { Customer } from '@gaslink/shared';
import { apiGet, apiPut, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Input, Badge, Loader, EmptyState } from '@/components/ui';

export default function CustomerAccountPage() {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  const { data: customer, isLoading } = useQuery({
    queryKey: ['customer-profile'],
    queryFn: () => apiGet<Customer>('/customer-portal/account'),
  });

  const { register, handleSubmit } = useForm({
    values: customer ? {
      email: customer.email || '',
      phone: customer.phone,
      billingAddressLine1: customer.billingAddressLine1 || '',
      billingAddressLine2: customer.billingAddressLine2 || '',
      billingCity: customer.billingCity || '',
      billingState: customer.billingState || '',
      billingPincode: customer.billingPincode || '',
      shippingAddressLine1: customer.shippingAddressLine1 || '',
      shippingAddressLine2: customer.shippingAddressLine2 || '',
      shippingCity: customer.shippingCity || '',
      shippingState: customer.shippingState || '',
      shippingPincode: customer.shippingPincode || '',
    } : undefined,
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiPut('/customer-portal/account', data),
    onSuccess: () => {
      toast.success('Profile updated');
      queryClient.invalidateQueries({ queryKey: ['customer-profile'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
  if (!customer) return <EmptyState title="Unable to load profile" />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">My Account</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">View and update your account details</p>
      </div>

      {/* Account Summary */}
      <div className="card p-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="h-14 w-14 rounded-full bg-brand-100 dark:bg-brand-500/20 flex items-center justify-center text-brand-600 dark:text-brand-400 text-xl font-bold">
            {customer.customerName.charAt(0)}
          </div>
          <div>
            <h2 className="text-lg font-bold text-surface-900 dark:text-white">{customer.customerName}</h2>
            {customer.businessName && <p className="text-sm text-surface-500">{customer.businessName}</p>}
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="neutral">{customer.customerType}</Badge>
              <Badge variant={customer.status === 'active' ? 'success' : 'warning'}>{customer.status}</Badge>
              {customer.stopSupply && <Badge variant="danger">Supply Stopped</Badge>}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div><p className="text-xs text-surface-400">GSTIN</p><p className="font-medium text-surface-900 dark:text-white">{customer.gstin || 'N/A'}</p></div>
          <div><p className="text-xs text-surface-400">Credit Period</p><p className="font-medium">{customer.creditPeriodDays} days</p></div>
          <div><p className="text-xs text-surface-400">Customer Since</p><p className="font-medium">{new Date(customer.createdAt).toLocaleDateString('en-IN')}</p></div>
          <div><p className="text-xs text-surface-400">User Email</p><p className="font-medium">{user?.email}</p></div>
        </div>
      </div>

      {/* Contacts */}
      {customer.contacts.length > 0 && (
        <div className="card p-6">
          <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Contacts</h3>
          <div className="space-y-3">
            {customer.contacts.map((contact) => (
              <div key={contact.contactId} className="flex items-center justify-between p-3 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
                <div>
                  <p className="font-medium text-surface-900 dark:text-white">{contact.name}</p>
                  <p className="text-xs text-surface-500">{contact.phone} {contact.email && `| ${contact.email}`}</p>
                </div>
                {contact.isPrimary && <Badge variant="info">Primary</Badge>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Editable Fields */}
      <div className="card p-6">
        <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Update Information</h3>
        <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Phone" {...register('phone')} />
            <Input label="Email" type="email" {...register('email')} />
          </div>

          <div>
            <h4 className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-3">Billing Address</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Address Line 1" {...register('billingAddressLine1')} />
              <Input label="Address Line 2" {...register('billingAddressLine2')} />
              <Input label="City" {...register('billingCity')} />
              <Input label="State" {...register('billingState')} />
              <Input label="Pincode" {...register('billingPincode')} />
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-3">Shipping Address</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Address Line 1" {...register('shippingAddressLine1')} />
              <Input label="Address Line 2" {...register('shippingAddressLine2')} />
              <Input label="City" {...register('shippingCity')} />
              <Input label="State" {...register('shippingState')} />
              <Input label="Pincode" {...register('shippingPincode')} />
            </div>
          </div>

          <Button type="submit" loading={mutation.isPending}>Update Profile</Button>
        </form>
      </div>

      {/* Cylinder Discounts */}
      {customer.cylinderDiscounts?.length > 0 && (
        <div className="card p-6">
          <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Your Cylinder Discounts</h3>
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Cylinder Type</th><th>Discount per Unit</th></tr></thead>
              <tbody>
                {customer.cylinderDiscounts.map((d) => (
                  <tr key={d.discountId}>
                    <td className="font-medium">{d.cylinderTypeName}</td>
                    <td className="text-accent-600 dark:text-accent-400 font-medium">
                      {new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(d.discountPerUnit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
