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
  const { isAuthenticated, user, selectedDistributorId } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (
    user.requiresPasswordReset &&
    location.pathname !== '/force-password-reset'
  ) {
    return <Navigate to="/force-password-reset" replace />;
  }

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
