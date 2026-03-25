import { useIsDark } from './stores/themeStore';

// ─── Design tokens ──────────────────────────────────────────────────────────

export const COLORS = {
  light: {
    bg: '#ffffff',
    cardBg: '#f8fafc',
    cardBorder: '#e2e8f0',
    text: '#0f172a',
    textSecondary: '#64748b',
    textMuted: '#94a3b8',
    divider: '#e2e8f0',
    inputBg: '#f1f5f9',
    inputBorder: '#e2e8f0',
  },
  dark: {
    bg: '#0f172a',
    cardBg: '#1e293b',
    cardBorder: '#334155',
    text: '#f1f5f9',
    textSecondary: '#94a3b8',
    textMuted: '#64748b',
    divider: '#334155',
    inputBg: '#334155',
    inputBorder: '#475569',
  },
} as const;

export const ACCENT = {
  red: '#dc2626',
  navy: '#1e3a5f',
  green: '#10b981',
  orange: '#f59e0b',
  blue: '#3b82f6',
  purple: '#8b5cf6',
} as const;

export const BADGE_COLORS = {
  success: { bg: '#ecfdf5', text: '#059669', bgDark: 'rgba(16, 185, 129, 0.15)', textDark: '#34d399' },
  warning: { bg: '#fffbeb', text: '#d97706', bgDark: 'rgba(245, 158, 11, 0.15)', textDark: '#fbbf24' },
  danger: { bg: '#fef2f2', text: '#dc2626', bgDark: 'rgba(220, 38, 38, 0.15)', textDark: '#f87171' },
  info: { bg: '#eff6ff', text: '#3b82f6', bgDark: 'rgba(59, 130, 246, 0.15)', textDark: '#60a5fa' },
  neutral: { bg: '#f1f5f9', text: '#475569', bgDark: 'rgba(100, 116, 139, 0.15)', textDark: '#94a3b8' },
} as const;

export const SEVERITY_COLORS = {
  critical: { bg: '#fef2f2', text: '#dc2626', bgDark: 'rgba(220, 38, 38, 0.15)', textDark: '#f87171' },
  high: { bg: '#fff7ed', text: '#ea580c', bgDark: 'rgba(234, 88, 12, 0.15)', textDark: '#fb923c' },
  medium: { bg: '#fffbeb', text: '#d97706', bgDark: 'rgba(245, 158, 11, 0.15)', textDark: '#fbbf24' },
  low: { bg: '#eff6ff', text: '#3b82f6', bgDark: 'rgba(59, 130, 246, 0.15)', textDark: '#60a5fa' },
} as const;

// ─── Theme hook ─────────────────────────────────────────────────────────────

export type ThemeColors = typeof COLORS.light;

export function useTheme() {
  const dark = useIsDark();
  const colors = dark ? COLORS.dark : COLORS.light;

  return { dark, colors, accent: ACCENT };
}

// ─── Tab bar config helper ──────────────────────────────────────────────────

export function getTabBarConfig(dark: boolean) {
  const colors = dark ? COLORS.dark : COLORS.light;
  const activeColor = ACCENT.red;
  const inactiveColor = dark ? '#64748b' : '#94a3b8';

  return {
    headerStyle: {
      backgroundColor: dark ? COLORS.dark.cardBg : COLORS.light.bg,
      elevation: 0,
      shadowOpacity: 0,
      borderBottomWidth: 1,
      borderBottomColor: colors.cardBorder,
    },
    headerTitleStyle: {
      fontWeight: '700' as const,
      fontSize: 18,
      color: colors.text,
    },
    tabBarActiveTintColor: activeColor,
    tabBarInactiveTintColor: inactiveColor,
    tabBarStyle: {
      backgroundColor: colors.bg,
      borderTopWidth: 1,
      borderTopColor: colors.cardBorder,
      paddingTop: 6,
      paddingBottom: 8,
      height: 64,
    },
    tabBarLabelStyle: {
      fontSize: 11,
      fontWeight: '600' as const,
    },
    sceneStyle: {
      backgroundColor: colors.bg,
    },
  };
}

// ─── Currency formatter ─────────────────────────────────────────────────────

export function formatINR(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value ?? 0);
}

// ─── Badge helper ───────────────────────────────────────────────────────────

export function getBadgeColors(variant: keyof typeof BADGE_COLORS, dark: boolean) {
  const c = BADGE_COLORS[variant] ?? BADGE_COLORS.neutral;
  return { bg: dark ? c.bgDark : c.bg, text: dark ? c.textDark : c.text };
}

export function getSeverityColors(severity: string, dark: boolean) {
  const c = SEVERITY_COLORS[severity as keyof typeof SEVERITY_COLORS] ?? SEVERITY_COLORS.low;
  return { bg: dark ? c.bgDark : c.bg, text: dark ? c.textDark : c.text };
}
