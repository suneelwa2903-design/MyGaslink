/**
 * Feature A (2026-07-15): HQ portal Aging report.
 *
 * Read-only. Renders the outstandingAging report shape as-is
 * (`columns` + `rows`). The rows[] are already scoped to the group's
 * visible customers server-side (customerGroupPortalService.getGroupAging).
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { Loader, EmptyState } from '@/components/ui';

interface AgingResponse {
  columns: Array<{ key: string; label: string; type?: string }>;
  rows: Array<Record<string, unknown>>;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n);
}

function formatCell(value: unknown, type?: string): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' && (type === 'currency' || type === 'number')) {
    return type === 'currency' ? formatCurrency(value) : String(value);
  }
  if (typeof value === 'number') return formatCurrency(value);
  return String(value);
}

export default function HqAgingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['hq-aging'],
    queryFn: () => apiGet<AgingResponse>('/customer-group-portal/aging'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Aging</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          Outstanding balances by age, per property.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : !data || data.rows.length === 0 ? (
        <EmptyState title="No outstanding balances — nothing to age" className="py-16" />
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  {data.columns.map((c) => (
                    <th key={c.key} className={c.type === 'currency' || c.type === 'number' ? 'text-right' : ''}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i}>
                    {data.columns.map((c) => {
                      const isNumeric = c.type === 'currency' || c.type === 'number';
                      return (
                        <td key={c.key} className={isNumeric ? 'text-right' : ''}>
                          <span className="text-sm text-surface-700 dark:text-surface-300">
                            {formatCell(row[c.key], c.type)}
                          </span>
                        </td>
                      );
                    })}
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
