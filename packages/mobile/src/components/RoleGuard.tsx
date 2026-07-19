/**
 * RoleGuard (2026-07-19 SECURITY) — bounces any authenticated user
 * whose role isn't in the allowed set back through the root
 * auth-router at `/`. index.tsx then redirects them to whatever
 * surface their role IS entitled to.
 *
 * Every mobile role route group's _layout.tsx MUST wrap its content in
 * this guard. Without it, any authenticated session can deep-link into
 * a foreign route group and see UI they shouldn't (e.g. a customer_hq
 * user landing on the distributor-admin tabs after a role-router bug).
 * Priya-Sharma incident 2026-07-19 was exactly this class of bug.
 *
 * Contract: while the auth store is still hydrating (`user === null`)
 * we render null — the root layout already shows an ActivityIndicator
 * in that window. Once hydration finishes, we either render children
 * or Redirect; there's no third state.
 *
 * Usage:
 *   export default function AdminLayout() {
 *     return (
 *       <RoleGuard allowed={['distributor_admin', 'mini_operator_admin']}>
 *         <Tabs>...</Tabs>
 *       </RoleGuard>
 *     );
 *   }
 */
import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { useAuthStore } from '../stores/authStore';

interface Props {
  allowed: readonly string[];
  children: ReactNode;
}

export function RoleGuard({ allowed, children }: Props) {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // Not authenticated yet — bounce to auth-router. This handles the
  // deep-link-while-logged-out case.
  if (!isAuthenticated || !user) {
    return <Redirect href="/(auth)/login" />;
  }
  // Authenticated but wrong role — bounce to root so index.tsx sends
  // them to their real home surface.
  if (!allowed.includes(user.role)) {
    return <Redirect href="/" />;
  }
  return <>{children}</>;
}
