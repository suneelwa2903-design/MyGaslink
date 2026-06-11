import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import type { Distributor } from '@gaslink/shared';
import { UserRole } from '@gaslink/shared';
import { shouldInvalidateOnDistributorSwitch } from './distributorSwitch';

export function DistributorSelector() {
  const { user, selectedDistributorId, setSelectedDistributorId } = useAuthStore();
  const queryClient = useQueryClient();
  const prevDistributorId = useRef(selectedDistributorId);
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;

  const { data: distributorsData, isLoading } = useQuery({
    queryKey: ['distributors-list'],
    queryFn: () => apiGet<{ distributors: Distributor[] }>('/distributors'),
    staleTime: 5 * 60 * 1000,
  });
  const distributors = distributorsData?.distributors;

  // Auto-select first distributor only for non-super-admin users
  useEffect(() => {
    if (!isSuperAdmin && !selectedDistributorId && distributors && distributors.length > 0) {
      setSelectedDistributorId(distributors[0].distributorId);
    }
  }, [distributors, selectedDistributorId, setSelectedDistributorId, isSuperAdmin]);

  // Invalidate (don't reset) tenant-scoped caches when a super-admin switches
  // distributors. invalidateQueries keeps the previous data on screen until
  // the new fetch lands, avoiding the empty-state flicker that resetQueries
  // produced. The shouldInvalidateOnDistributorSwitch helper centralises the
  // rule — see distributorSwitch.ts for the super-admin-only / null→X logic.
  useEffect(() => {
    if (shouldInvalidateOnDistributorSwitch(prevDistributorId.current, selectedDistributorId, isSuperAdmin)) {
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'distributors-list' });
    }
    prevDistributorId.current = selectedDistributorId;
  }, [selectedDistributorId, isSuperAdmin, queryClient]);

  if (isLoading) {
    return (
      <div className="h-9 w-48 animate-pulse rounded-xl bg-surface-200 dark:bg-surface-700" />
    );
  }

  if (!distributors || distributors.length === 0) {
    return (
      <span className="text-sm text-surface-500 dark:text-surface-400">
        No distributors
      </span>
    );
  }

  return (
    <select
      value={selectedDistributorId ?? ''}
      onChange={(e) => setSelectedDistributorId(e.target.value || null)}
      className="h-9 rounded-xl border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 px-3 pr-8 text-sm text-surface-900 dark:text-white focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors appearance-none cursor-pointer bg-no-repeat bg-[right_0.5rem_center] bg-[length:1rem] bg-[url(&quot;data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%3e%3cpath%20fill='none'%20stroke='%236b7280'%20stroke-linecap='round'%20stroke-linejoin='round'%20stroke-width='2'%20d='m2%205%206%206%206-6'/%3e%3c/svg%3e&quot;)]"
    >
      {isSuperAdmin && (
        <option value="">Select Distributor</option>
      )}
      {distributors.map((d) => (
        <option key={d.distributorId} value={d.distributorId}>
          {d.businessName}
        </option>
      ))}
    </select>
  );
}
