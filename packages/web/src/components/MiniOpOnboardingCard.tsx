/**
 * Mini-Operator (2026-07-16) — onboarding checklist card.
 *
 * Rendered on /app/analytics for accountType='mini_operator' tenants who
 * haven't finished setup. Reuses existing endpoints (no new API) — the
 * "steps" are just derived from live counts:
 *
 *   1. Add a cylinder type       → GET /api/cylinder-types
 *   2. Set opening stock         → GET /api/inventory/summary → any row?
 *   3. Add a source distributor  → GET /api/source-distributors
 *
 * When all three are non-zero the card auto-hides. Not a hard gate — the
 * user can navigate freely at any time (anti-pattern #22 discipline: this
 * is a NUDGE, not a bounce). LPG-company selection is deferred to Settings
 * (existing providerCodes field on Distributor) — v1.1 will wrap that in a
 * dedicated first-step modal.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineCheckCircle, HiOutlineArrowRight } from 'react-icons/hi2';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

interface CylinderTypesListResponse {
  cylinderTypes: { cylinderTypeId: string; isActive: boolean }[];
}

interface InventorySummaryRow {
  cylinderTypeId: string;
  openingFulls: number;
  openingEmpties: number;
}

interface SourceDistributor {
  id: string;
}

export function MiniOpOnboardingCard() {
  const role = useAuthStore((s) => s.user?.role);
  const isMiniOperator = role === 'mini_operator_admin';

  const { data: types } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<CylinderTypesListResponse>('/cylinder-types'),
    enabled: isMiniOperator,
  });
  const { data: summary } = useQuery({
    queryKey: ['inventory-summary'],
    queryFn: () => apiGet<InventorySummaryRow[]>('/inventory/summary'),
    enabled: isMiniOperator,
  });
  const { data: sources } = useQuery({
    queryKey: ['source-distributors'],
    queryFn: () => apiGet<SourceDistributor[]>('/source-distributors'),
    enabled: isMiniOperator,
  });

  const activeTypes = useMemo(
    () => (types?.cylinderTypes ?? []).filter((t) => t.isActive),
    [types],
  );
  const hasCylinderType = activeTypes.length > 0;
  const hasOpeningStock = useMemo(
    () => (summary ?? []).some((r) => r.openingFulls > 0 || r.openingEmpties > 0),
    [summary],
  );
  const hasSourceDistributor = (sources ?? []).length > 0;

  const steps = [
    {
      key: 'cylinder',
      title: 'Add your first cylinder type',
      description: 'From Settings → Cylinder Types. Pick the corporation (HPCL / BPCL / IOCL) then the cylinder sizes you handle.',
      done: hasCylinderType,
      href: '/app/settings',
    },
    {
      key: 'stock',
      title: 'Enter opening stock',
      description: 'Record how many fulls and empties are in your depot today so purchases and deliveries roll off the correct base.',
      done: hasOpeningStock,
      href: '/app/inventory',
    },
    {
      key: 'source',
      title: 'Add a source distributor',
      description: 'The LPG distributor you buy stock from. You will pick this on every purchase entry.',
      done: hasSourceDistributor,
      href: '/app/purchases',
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const totalCount = steps.length;
  const isComplete = doneCount === totalCount;

  if (!isMiniOperator || isComplete) return null;

  return (
    <div className="card p-4 border-brand-200 dark:border-brand-800 bg-brand-50/40 dark:bg-brand-900/10">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white">
            Finish setting up Quick Gas
          </h3>
          <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
            {doneCount} of {totalCount} steps done — you can navigate freely; this card just tracks progress.
          </p>
        </div>
        <span className="text-xs font-medium text-brand-600 dark:text-brand-400">
          {Math.round((doneCount / totalCount) * 100)}%
        </span>
      </div>

      <ul className="space-y-2">
        {steps.map((step) => (
          <li key={step.key}>
            <Link
              to={step.href}
              className="group flex items-start gap-3 rounded-lg p-2 -mx-2 hover:bg-brand-100/50 dark:hover:bg-brand-800/20 transition-colors"
            >
              <HiOutlineCheckCircle
                className={`h-5 w-5 mt-0.5 shrink-0 ${
                  step.done ? 'text-emerald-500' : 'text-surface-300 dark:text-surface-600'
                }`}
              />
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-sm font-medium ${
                      step.done
                        ? 'text-surface-500 dark:text-surface-400 line-through'
                        : 'text-surface-900 dark:text-white'
                    }`}
                  >
                    {step.title}
                  </span>
                  {!step.done && (
                    <HiOutlineArrowRight className="h-4 w-4 text-brand-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </div>
                {!step.done && (
                  <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                    {step.description}
                  </p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
