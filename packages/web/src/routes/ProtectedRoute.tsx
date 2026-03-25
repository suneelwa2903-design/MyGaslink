import { Navigate, Outlet, useLocation } from 'react-router-dom';
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

  // Not logged in -> redirect to login
  if (!isAuthenticated || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Requires password reset -> redirect to force reset page
  if (
    user.requiresPasswordReset &&
    location.pathname !== '/force-password-reset'
  ) {
    return <Navigate to="/force-password-reset" replace />;
  }

  // Role check (super_admin bypasses all role restrictions)
  if (allowedRoles && allowedRoles.length > 0) {
    const userRole = user.role as UserRole;
    if (userRole !== UserRole.SUPER_ADMIN && !allowedRoles.includes(userRole)) {
      // Redirect to appropriate dashboard based on role
      const fallback =
        userRole === UserRole.CUSTOMER
          ? '/app/customer/dashboard'
          : '/app/dashboard';
      return <Navigate to={fallback} replace />;
    }
  }

  // Distributor context check (super_admin needs a selected distributor for some routes)
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
              Please select a distributor first
            </p>
            <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
              Use the distributor selector in the top bar to choose a distributor.
            </p>
          </div>
        </div>
      );
    }
  }

  return children ?? <Outlet />;
}
