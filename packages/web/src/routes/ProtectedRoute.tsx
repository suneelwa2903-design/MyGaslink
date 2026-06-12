import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { UserRole } from '@gaslink/shared';

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

  // CLAUDE.md anti-pattern #22 (2026-06-12): the previous Group L4
  // `PostResetRedirect` wrapper intercepted distributor_admins on
  // /app/analytics and forced them to /app/settings?tab=onboarding
  // whenever the onboarding checklist had any required step pending.
  // That turned a guide into a gate — a months-old distributor with
  // 9/10 required steps complete still got bounced. Removed entirely.
  // Onboarding remains as the OnboardingCard on Settings and the
  // banner on the dashboard; both are nudges, not blockers.
  return (
    <ProtectedRouteInner
      allowedRoles={allowedRoles}
      requireDistributor={requireDistributor}
    >
      {children}
    </ProtectedRouteInner>
  );
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
