import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { UserRole } from '@gaslink/shared';
import { FullPageLoader } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { ProtectedRoute } from './ProtectedRoute';

// ─── Lazy-loaded pages ───────────────────────────────────────────────────────

// Public
const LandingPage = lazy(() => import('@/pages/LandingPage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const ForcePasswordResetPage = lazy(() => import('@/pages/ForcePasswordResetPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

// Admin pages
const OrdersPage = lazy(() => import('@/pages/OrdersPage'));
const InventoryPage = lazy(() => import('@/pages/InventoryPage'));
const CustomersPage = lazy(() => import('@/pages/CustomersPage'));
const BillingPaymentsPage = lazy(() => import('@/pages/BillingPaymentsPage'));
const FleetPage = lazy(() => import('@/pages/FleetPage'));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const CollectionsPage = lazy(() => import('@/pages/CollectionsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const DistributorsPage = lazy(() => import('@/pages/DistributorsPage'));
const DistributorDetailPage = lazy(() => import('@/pages/DistributorDetailPage'));
const BillingSuspendedPage = lazy(() => import('@/pages/BillingSuspendedPage'));
const HealthMonitoringPage = lazy(() => import('@/pages/HealthMonitoringPage'));
const ProviderCatalogPage = lazy(() => import('@/pages/ProviderCatalogPage'));

// Customer pages
const CustomerDashboardPage = lazy(() => import('@/pages/customer/DashboardPage'));
const CustomerOrdersPage = lazy(() => import('@/pages/customer/OrdersPage'));
const CustomerInvoicesPage = lazy(() => import('@/pages/customer/InvoicesPage'));
const CustomerPaymentsPage = lazy(() => import('@/pages/customer/PaymentsPage'));
const CustomerAccountPage = lazy(() => import('@/pages/customer/AccountPage'));

// ─── Auth redirect wrapper ──────────────────────────────────────────────────

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, user } = useAuthStore();

  if (isAuthenticated && user) {
    const isCustomer = user.role === UserRole.CUSTOMER;
    return (
      <Navigate
        to={isCustomer ? '/app/customer/dashboard' : '/app/analytics'}
        replace
      />
    );
  }

  return <>{children}</>;
}

// ─── Route Configuration ────────────────────────────────────────────────────

export function AppRoutes() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Routes>
        {/* Public routes */}
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />
        <Route path="/force-password-reset" element={<ForcePasswordResetPage />} />

        {/* Protected app routes */}
        <Route
          path="/app"
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          {/* Default redirect */}
          <Route index element={<Navigate to="analytics" replace />} />

          {/* Dashboard redirects to Analytics */}
          <Route path="dashboard" element={<Navigate to="/app/analytics" replace />} />

          <Route
            path="orders"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.FINANCE,
                  UserRole.INVENTORY,
                  UserRole.DRIVER,
                ]}
                requireDistributor
              />
            }
          >
            <Route index element={<OrdersPage />} />
          </Route>

          <Route
            path="inventory"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.FINANCE,
                  UserRole.INVENTORY,
                ]}
                requireDistributor
              />
            }
          >
            <Route index element={<InventoryPage />} />
          </Route>

          <Route
            path="customers"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.INVENTORY,
                  UserRole.FINANCE,
                ]}
                requireDistributor
              />
            }
          >
            <Route index element={<CustomersPage />} />
          </Route>

          <Route
            path="billing-payments"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.FINANCE,
                  UserRole.INVENTORY,
                ]}
                requireDistributor
              />
            }
          >
            <Route index element={<BillingPaymentsPage />} />
          </Route>

          {/* Redirects from old routes */}
          <Route path="invoices" element={<Navigate to="/app/billing-payments" replace />} />
          <Route path="payments" element={<Navigate to="/app/billing-payments" replace />} />

          <Route
            path="fleet"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.FINANCE,
                  UserRole.INVENTORY,
                ]}
                requireDistributor
              />
            }
          >
            <Route index element={<FleetPage />} />
          </Route>

          {/* Redirects from old routes */}
          <Route path="drivers-vehicles" element={<Navigate to="/app/fleet" replace />} />
          <Route path="assignments" element={<Navigate to="/app/fleet" replace />} />

          <Route
            path="analytics"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.FINANCE,
                  UserRole.INVENTORY,
                  UserRole.DRIVER,
                ]}
              />
            }
          >
            <Route index element={<AnalyticsPage />} />
          </Route>

          <Route
            path="collections"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.FINANCE,
                  UserRole.INVENTORY,
                ]}
                requireDistributor
              />
            }
          >
            <Route index element={<CollectionsPage />} />
          </Route>

          {/* Pending actions now in Analytics dashboard */}
          <Route path="pending-actions" element={<Navigate to="/app/analytics" replace />} />

          <Route
            path="settings"
            element={
              <ProtectedRoute
                allowedRoles={[
                  UserRole.SUPER_ADMIN,
                  UserRole.DISTRIBUTOR_ADMIN,
                  UserRole.INVENTORY,
                  UserRole.FINANCE,
                ]}
              />
            }
          >
            <Route index element={<SettingsPage />} />
          </Route>

          <Route
            path="distributors"
            element={
              <ProtectedRoute
                allowedRoles={[UserRole.SUPER_ADMIN]}
              />
            }
          >
            <Route index element={<DistributorsPage />} />
            <Route path=":id" element={<DistributorDetailPage />} />
          </Route>

          {/* Billing now in Settings */}
          <Route path="billing" element={<Navigate to="/app/settings" replace />} />

          <Route path="billing/suspended" element={<BillingSuspendedPage />} />

          {/* Reconciliation now in Inventory */}
          <Route path="reconciliation" element={<Navigate to="/app/inventory" replace />} />

          <Route
            path="provider-catalog"
            element={
              <ProtectedRoute
                allowedRoles={[UserRole.SUPER_ADMIN]}
              />
            }
          >
            <Route index element={<ProviderCatalogPage />} />
          </Route>

          <Route
            path="health"
            element={
              <ProtectedRoute
                allowedRoles={[UserRole.SUPER_ADMIN]}
              />
            }
          >
            <Route index element={<HealthMonitoringPage />} />
          </Route>

          {/* Customer portal routes */}
          <Route
            path="customer"
            element={
              <ProtectedRoute allowedRoles={[UserRole.CUSTOMER]} />
            }
          >
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<CustomerDashboardPage />} />
            <Route path="orders" element={<CustomerOrdersPage />} />
            <Route path="invoices" element={<CustomerInvoicesPage />} />
            <Route path="payments" element={<CustomerPaymentsPage />} />
            <Route path="account" element={<CustomerAccountPage />} />
          </Route>
        </Route>

        {/* 404 catch-all */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
