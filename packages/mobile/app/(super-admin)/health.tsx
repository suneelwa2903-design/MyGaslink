import { View, Text, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, MetricCard, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, ACCENT } from '../../src/theme';

// ── Types ────────────────────────────────────────────────────────────────────

interface HealthRaw {
  status: string;
  version: string;
  timestamp: string;
  uptime: number;
  database: { status: string; latencyMs: number };
}

interface ServiceStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'down';
  responseTimeMs: number;
  message: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function transformHealth(raw: HealthRaw): { version: string; uptime: string; services: ServiceStatus[] } {
  const services: ServiceStatus[] = [
    {
      service: 'API Server',
      status: raw.status === 'healthy' ? 'healthy' : 'down',
      responseTimeMs: 0,
      message: raw.status === 'healthy' ? 'All systems operational' : `Status: ${raw.status}`,
    },
    {
      service: 'Database',
      status: raw.database?.status === 'connected' ? 'healthy' : 'down',
      responseTimeMs: raw.database?.latencyMs ?? 0,
      message: raw.database?.status === 'connected'
        ? `Latency: ${raw.database.latencyMs}ms`
        : `Status: ${raw.database?.status ?? 'unknown'}`,
    },
  ];

  return {
    version: raw.version,
    uptime: formatUptime(raw.uptime),
    services,
  };
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger'> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
};

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function HealthScreen() {
  const router = useRouter();
  const { dark, colors, accent } = useTheme();

  const { data: raw, isLoading, refetch } = useApiQuery<HealthRaw>(
    ['health'],
    '/health',
    undefined,
    { refetchInterval: 30_000 },
  );

  const health = raw ? transformHealth(raw) : null;
  const healthyCount = health?.services.filter((s) => s.status === 'healthy').length ?? 0;
  const totalCount = health?.services.length ?? 2;

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Back header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Health Monitoring</Text>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >

        {isLoading && !health && (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <ActivityIndicator size="large" color={accent.red} />
            <Text style={{ color: colors.textSecondary, marginTop: 12, fontSize: 14 }}>
              Checking system health...
            </Text>
          </View>
        )}

        {!isLoading && !health && (
          <EmptyState
            title="Unable to reach server"
            description="Could not fetch health status. Pull down to retry."
          />
        )}

        {health && (
          <>
            {/* ── Metrics Row ──────────────────────────────────────────── */}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <MetricCard
                  title="Version"
                  value={health.version}
                  color={accent.blue}
                  icon={<Ionicons name="code-slash-outline" size={22} color={accent.blue} />}
                />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard
                  title="Uptime"
                  value={health.uptime}
                  color={accent.green}
                  icon={<Ionicons name="time-outline" size={22} color={accent.green} />}
                />
              </View>
            </View>

            <MetricCard
              title="Services"
              value={`${healthyCount}/${totalCount} Healthy`}
              color={healthyCount === totalCount ? ACCENT.green : ACCENT.red}
              icon={
                <Ionicons
                  name={healthyCount === totalCount ? 'checkmark-circle' : 'alert-circle'}
                  size={24}
                  color={healthyCount === totalCount ? ACCENT.green : ACCENT.red}
                />
              }
            />

            {/* ── Service Cards ─────────────────────────────────────────── */}
            <Text style={{
              fontSize: 14,
              fontWeight: '600',
              color: colors.textSecondary,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginTop: 4,
            }}>
              Services
            </Text>

            {health.services.map((svc) => {
              const isHealthy = svc.status === 'healthy';
              const variant = STATUS_VARIANT[svc.status] ?? 'danger';

              return (
                <Card
                  key={svc.service}
                  style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    {/* Icon */}
                    <View style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      backgroundColor: isHealthy
                        ? (dark ? 'rgba(16, 185, 129, 0.15)' : '#ecfdf5')
                        : (dark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2'),
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <Ionicons
                        name={isHealthy ? 'checkmark-circle' : 'alert-circle'}
                        size={24}
                        color={isHealthy ? ACCENT.green : ACCENT.red}
                      />
                    </View>

                    {/* Info */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>
                        {svc.service}
                      </Text>
                      <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 1 }}>
                        {svc.message}
                      </Text>
                    </View>

                    {/* Badge */}
                    <Badge label={svc.status.toUpperCase()} variant={variant} />
                  </View>

                  {/* Details row */}
                  {svc.service === 'Database' && (
                    <View style={{
                      flexDirection: 'row',
                      gap: 16,
                      marginTop: 10,
                      paddingTop: 10,
                      borderTopWidth: 1,
                      borderTopColor: colors.divider,
                    }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>Latency</Text>
                        <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }}>
                          {svc.responseTimeMs}ms
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>Status</Text>
                        <Text style={{
                          fontWeight: '600',
                          fontSize: 13,
                          color: isHealthy ? ACCENT.green : ACCENT.red,
                        }}>
                          {isHealthy ? 'Connected' : 'Disconnected'}
                        </Text>
                      </View>
                    </View>
                  )}
                </Card>
              );
            })}

            {/* ── Last checked ──────────────────────────────────────────── */}
            <Text style={{ textAlign: 'center', fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
              Auto-refreshes every 30 seconds
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
