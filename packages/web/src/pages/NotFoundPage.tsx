import { Link } from 'react-router-dom';
import { HiOutlineHome, HiOutlineArrowLeft } from 'react-icons/hi2';
import { useAuthStore } from '@/stores/authStore';
import { UserRole } from '@gaslink/shared';
import { Button } from '@/components/ui';

export default function NotFoundPage() {
  const { isAuthenticated, user } = useAuthStore();
  const isCustomer = user?.role === UserRole.CUSTOMER;

  const dashboardPath = isAuthenticated
    ? isCustomer
      ? '/app/customer/dashboard'
      : '/app/dashboard'
    : '/';

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 dark:bg-surface-950 px-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-brand-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-flame-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative text-center max-w-lg">
        <p className="text-8xl font-bold text-brand-500/20 dark:text-brand-500/10">404</p>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white mt-4 mb-2">
          Page Not Found
        </h1>
        <p className="text-surface-500 dark:text-surface-400 mb-8">
          The page you are looking for does not exist or has been moved.
        </p>

        <div className="flex items-center justify-center gap-3">
          <Button variant="secondary" onClick={() => window.history.back()}>
            <HiOutlineArrowLeft className="h-4 w-4" />
            Go Back
          </Button>
          <Link to={dashboardPath}>
            <Button>
              <HiOutlineHome className="h-4 w-4" />
              {isAuthenticated ? 'Dashboard' : 'Home'}
            </Button>
          </Link>
        </div>

        {isAuthenticated && (
          <div className="mt-8 text-sm text-surface-400">
            <p>Quick links:</p>
            <div className="flex flex-wrap items-center justify-center gap-3 mt-2">
              {!isCustomer && (
                <>
                  <Link to="/app/orders" className="text-brand-500 hover:underline">Orders</Link>
                  <Link to="/app/customers" className="text-brand-500 hover:underline">Customers</Link>
                  <Link to="/app/billing-payments" className="text-brand-500 hover:underline">Billing & Payments</Link>
                  <Link to="/app/inventory" className="text-brand-500 hover:underline">Inventory</Link>
                </>
              )}
              {isCustomer && (
                <>
                  <Link to="/app/customer/orders" className="text-brand-500 hover:underline">My Orders</Link>
                  <Link to="/app/customer/invoices" className="text-brand-500 hover:underline">My Invoices</Link>
                  <Link to="/app/customer/account" className="text-brand-500 hover:underline">My Account</Link>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
