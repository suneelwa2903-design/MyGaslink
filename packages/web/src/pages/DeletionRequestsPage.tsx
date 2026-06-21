import { useQuery } from '@tanstack/react-query';
import { HiOutlineArrowPath } from 'react-icons/hi2';
import { apiGet } from '@/lib/api';
import { Badge, Loader, EmptyState, Button } from '@/components/ui';
import type { DeletionRequestSummary } from '@gaslink/shared';

/**
 * M14 v1.0 — super-admin read-only monitor for account deletion requests.
 * Backed by GET /api/super-admin/deletion-requests. Auto-refreshes once a
 * minute. Mutations (cancel, force-execute) ship in v1.1 alongside the
 * background anonymization worker (IOS-ACCOUNT-DELETION-SPEC §8).
 */
const STATUS_VARIANTS = {
  pending: 'warning',
  overdue: 'danger',
  executed: 'neutral',
  cancelled: 'success',
} as const;

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function DeletionRequestsPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['super-admin-deletion-requests'],
    queryFn: () => apiGet<DeletionRequestSummary[]>('/super-admin/deletion-requests'),
    refetchInterval: 60_000,
    retry: 1,
  });

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-surface-900 dark:text-white">
            Account Deletion Requests
          </h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            Users who have requested account deletion. Auto-refreshes every minute.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <HiOutlineArrowPath className={`h-4 w-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader />
        </div>
      ) : error ? (
        <div className="card p-6">
          <p className="text-sm text-rose-600 dark:text-rose-400">Failed to load deletion requests.</p>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No deletion requests"
          description="Users who request account deletion will appear here."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-50 dark:bg-surface-800 text-surface-500 dark:text-surface-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left font-medium">User</th>
                <th className="px-4 py-3 text-left font-medium">Role</th>
                <th className="px-4 py-3 text-left font-medium">Distributor</th>
                <th className="px-4 py-3 text-left font-medium">Requested</th>
                <th className="px-4 py-3 text-left font-medium">Scheduled</th>
                <th className="px-4 py-3 text-right font-medium">Days Left</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-200 dark:divide-surface-700">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-surface-50/50 dark:hover:bg-surface-800/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-surface-900 dark:text-white">{r.userName || '—'}</div>
                    <div className="text-xs text-surface-500 dark:text-surface-400">{r.userEmail}</div>
                  </td>
                  <td className="px-4 py-3 text-surface-700 dark:text-surface-300">{r.userRole.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-surface-700 dark:text-surface-300">{r.distributorName ?? '—'}</td>
                  <td className="px-4 py-3 text-surface-600 dark:text-surface-400 text-xs">{formatDate(r.requestedAt)}</td>
                  <td className="px-4 py-3 text-surface-600 dark:text-surface-400 text-xs">{formatDate(r.scheduledAt)}</td>
                  <td className="px-4 py-3 text-right font-medium text-surface-900 dark:text-white">{r.daysRemaining}</td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANTS[r.status]}>{r.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-surface-500 dark:text-surface-400 text-center">
        Account execution and admin cancellation actions ship in v1.1 alongside the background
        anonymization worker. Users can cancel their own requests from the mobile profile screen
        within the 30-day grace period.
      </p>
    </div>
  );
}
