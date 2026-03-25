import { useQuery } from '@tanstack/react-query';
import { HiOutlineCheckCircle, HiOutlineExclamationCircle } from 'react-icons/hi2';
import { apiGet } from '@/lib/api';
import { Badge, Loader, EmptyState } from '@/components/ui';

interface HealthStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'down';
  responseTimeMs: number;
  lastChecked: string;
  message?: string;
}

export default function HealthMonitoringPage() {
  const { data: health, isLoading, error } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const raw = await apiGet<{
        status: string;
        version: string;
        timestamp: string;
        uptime: number;
        database: { status: string; latencyMs: number };
      }>('/health');
      // Transform flat API response into the shape the UI expects
      return {
        version: raw?.version ?? 'unknown',
        uptime: raw?.uptime ?? 0,
        services: [
          {
            service: 'API Server',
            status: (raw?.status === 'healthy' ? 'healthy' : 'down') as HealthStatus['status'],
            responseTimeMs: 0,
            lastChecked: raw?.timestamp ?? new Date().toISOString(),
            message: raw?.status === 'healthy' ? 'All systems operational' : 'Service degraded',
          },
          {
            service: 'Database',
            status: (raw?.database?.status === 'connected' ? 'healthy' : 'down') as HealthStatus['status'],
            responseTimeMs: raw?.database?.latencyMs ?? 0,
            lastChecked: raw?.timestamp ?? new Date().toISOString(),
            message: raw?.database ? `Latency: ${raw.database.latencyMs}ms` : 'Unable to check',
          },
        ],
      };
    },
    refetchInterval: 30000,
    retry: 1,
  });

  const statusVariant = (s: string) => s === 'healthy' ? 'success' as const : s === 'degraded' ? 'warning' as const : 'danger' as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Health Monitoring</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">System health and service status</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : error || !health ? (
        <div>
          <EmptyState title="Unable to fetch health status" />
          {error && <p className="text-center text-sm text-red-500 mt-2">Error: {(error as Error).message}</p>}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="metric-card">
              <p className="metric-label">Version</p>
              <p className="metric-value text-xl">{health.version}</p>
            </div>
            <div className="metric-card">
              <p className="metric-label">Uptime</p>
              <p className="metric-value text-xl">{Math.floor(health.uptime / 3600)}h {Math.floor((health.uptime % 3600) / 60)}m</p>
            </div>
            <div className="metric-card">
              <p className="metric-label">Services</p>
              <p className="metric-value text-xl">{health.services.filter((s) => s.status === 'healthy').length}/{health.services.length} Healthy</p>
            </div>
          </div>

          <div className="space-y-3">
            {health.services.map((service) => (
              <div key={service.service} className="card p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {service.status === 'healthy' ? (
                    <HiOutlineCheckCircle className="h-5 w-5 text-accent-500" />
                  ) : (
                    <HiOutlineExclamationCircle className="h-5 w-5 text-red-500" />
                  )}
                  <div>
                    <p className="font-medium text-surface-900 dark:text-white">{service.service}</p>
                    {service.message && <p className="text-xs text-surface-400">{service.message}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-surface-400">{service.responseTimeMs}ms</span>
                  <Badge variant={statusVariant(service.status)}>{service.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
