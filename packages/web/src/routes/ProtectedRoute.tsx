import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { apiGet } from '@/lib/api';
import { UserRole } from '@gaslink/shared';

// Group L4 (2026-06-11): onboarding progress shape returned by
// GET /api/customers/onboarding/progress (see customerService.ts
// getOnboardingProgress).
type OnboardingProgress = {
  requiredTotal: number;
  requiredDoneCount: number;
  show: boolean;
};

interface ProtectedRouteProps {
  allowedRoles?: UserRole[];
  requireDistributor?: boolean;
  children?: React.ReactNode;
}

export function ProtectedRoute({
  allowedRoles,
  requireDistributor = false,
  children,
}: ProtectedRouteProps) {
  const { isAuthenticated, user } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (
    user.requiresPasswordReset &&
    location.pathname !== '/force-password-reset'
  ) {
    return <Navigate to="/force-password-reset" replace />;
  }

  return <PostResetRedirect>
    <ProtectedRouteInner
      allowedRoles={allowedRoles}
      requireDistributor={requireDistributor}
      children={children}
    />
  </PostResetRedirect>;
}

// Group L4 (2026-06-11): post-force-reset landing redirect. When a
// distributor_admin completes their first password change, the existing
// flow logs them out (ForcePasswordResetPage:32-34) and they land on
// /app/analytics after re-login. For a brand-new tenant that page is
// an empty zero-data dashboard — the Onboarding checklist is the
// productive destination. This wrapper checks role + path + onboarding
// progress and redirects once to /app/settings?tab=onboarding when the
// checklist is incomplete. Only fires for the analytics path so any
// other deliberate navigation (e.g. distributor_admin visits /app/
// settings directly) is left alone.
function PostResetRedirect({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  const location = useLocation();
  const isDistributorAdmin = user?.role === UserRole.DISTRIBUTOR_ADMIN;
  // Trigger ONLY on the default-landing route. Manual navigation to
  // other tabs is respected; nothing else is hijacked.
  const isAnalyticsLanding = location.pathname === '/app/analytics' || location.pathname === '/app/analytics/';
  const shouldCheck = isDistributorAdmin && isAnalyticsLanding;

  const { data: progress, isLoading } = useQuery({
    queryKey: ['onboarding-progress', user?.distributorId],
    queryFn: () => apiGet<OnboardingProgress>('/customers/onboarding/progress'),
    enabled: shouldCheck && !!user?.distributorId,
    staleTime: 30 * 1000,
  });

  if (shouldCheck && !isLoading && progress && progress.requiredDoneCount < progress.requiredTotal) {
    return <Navigate to="/app/settings?tab=onboarding" replace />;
  }
  return <>{children}</>;
}

function ProtectedRouteInner({
  allowedRoles,
  requireDistributor,
  children,
}: ProtectedRouteProps) {
  const { user, selectedDistributorId } = useAuthStore();
  const navigate = useNavigate();

  if (!user) return null;

  if (allowedRoles && allowedRoles.length > 0) {
    const userRole = user.role as UserRole;
    if (userRole !== UserRole.SUPER_ADMIN && !allowedRoles.includes(userRole)) {
      const fallback =
        userRole === UserRole.CUSTOMER
          ? '/app/customer/dashboard'
          : '/app/analytics';
      return <Navigate to={fallback} replace />;
    }
  }

  if (requireDistributor) {
    const userRole = user.role as UserRole;
    const effectiveDistributorId =
      userRole === UserRole.SUPER_ADMIN
        ? selectedDistributorId
        : user.distributorId;

    if (!effectiveDistributorId) {
      return (
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center">
            <p className="text-lg font-medium text-surface-700 dark:text-surface-300">
              Select a distributor to view this page
            </p>
            <p className="mt-1 text-sm text-surface-500 dark:text-surface-400 mb-4">
              Choose a distributor from the selector in the top bar.
            </p>
            {userRole === UserRole.SUPER_ADMIN && (
              <button
                onClick={() => navigate('/app/distributors')}
                className="text-sm text-brand-600 dark:text-brand-400 underline"
              >
                Go to Distributors
              </button>
            )}
          </div>
        </div>
      );
    }
  }

  return children ?? <Outlet />;
}
