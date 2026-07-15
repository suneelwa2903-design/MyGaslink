/**
 * Feature A (2026-07-15): HQ portal Profile.
 *
 * Read-only view of the group + distributor + member list. To change
 * group name / add/remove properties / rotate the HQ login, contact
 * your distributor's admin — those actions are on the distributor's
 * Customers > Groups tab.
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Loader, Badge } from '@/components/ui';

interface HqProfile {
  group: { id: string; name: string; createdAt: string };
  distributor: { businessName: string; phone: string | null; email: string | null };
  members: Array<{
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    customerType: string;
  }>;
}

export default function HqProfilePage() {
  const { user } = useAuthStore();
  const { data, isLoading } = useQuery({
    queryKey: ['hq-profile'],
    queryFn: () => apiGet<HqProfile>('/customer-group-portal/profile'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Profile</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          Your HQ account and group details.
        </p>
      </div>

      {isLoading || !data ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-4 space-y-2">
              <h3 className="font-semibold text-surface-900 dark:text-white">Group</h3>
              <div>
                <p className="text-xs text-surface-500 dark:text-surface-400">Name</p>
                <p className="text-base text-surface-900 dark:text-white">{data.group.name}</p>
              </div>
              <div>
                <p className="text-xs text-surface-500 dark:text-surface-400">Created</p>
                <p className="text-sm text-surface-700 dark:text-surface-300">
                  {new Date(data.group.createdAt).toLocaleDateString('en-IN')}
                </p>
              </div>
              <div>
                <p className="text-xs text-surface-500 dark:text-surface-400">Signed in as</p>
                <p className="text-sm text-surface-700 dark:text-surface-300">{user?.email}</p>
              </div>
            </div>

            <div className="card p-4 space-y-2">
              <h3 className="font-semibold text-surface-900 dark:text-white">Distributor</h3>
              <div>
                <p className="text-xs text-surface-500 dark:text-surface-400">Business</p>
                <p className="text-base text-surface-900 dark:text-white">{data.distributor.businessName}</p>
              </div>
              <div>
                <p className="text-xs text-surface-500 dark:text-surface-400">Phone</p>
                <p className="text-sm text-surface-700 dark:text-surface-300">{data.distributor.phone ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-surface-500 dark:text-surface-400">Email</p>
                <p className="text-sm text-surface-700 dark:text-surface-300">{data.distributor.email ?? '—'}</p>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="p-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
              <h3 className="font-semibold text-surface-900 dark:text-white">Properties</h3>
              <span className="text-xs text-surface-500 dark:text-surface-400">
                To add or remove a property, contact your distributor.
              </span>
            </div>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>GSTIN</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m.customerId}>
                      <td>
                        <div>
                          <p className="font-medium text-surface-900 dark:text-white">{m.customerName}</p>
                          {m.businessName && (
                            <p className="text-xs text-surface-500 dark:text-surface-400">{m.businessName}</p>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="text-sm text-surface-600 dark:text-surface-400">{m.gstin ?? '—'}</span>
                      </td>
                      <td>
                        <Badge variant="neutral">{m.customerType}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
