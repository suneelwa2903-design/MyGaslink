import { useState, useRef, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HiOutlineBell,
  HiBars3,
  HiOutlineArrowRightOnRectangle,
  HiOutlineUserCircle,
  HiOutlineSparkles,
} from 'react-icons/hi2';
import { useAuthStore, selectDistributorId } from '@/stores/authStore';
import { apiGet } from '@/lib/api';
import { UserRole } from '@gaslink/shared';
import { cn } from '@/lib/cn';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';
import { DistributorSelector } from './DistributorSelector';

export function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuthStore();
  const distributorId = useAuthStore(selectDistributorId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;

  // Super admin always sees the distributor selector — they need to pick one for any data page
  // Hide only on purely platform-level pages (Distributors list, Provider Catalog, Health)
  const platformOnlyPaths = ['/app/distributors', '/app/provider-catalog', '/app/health'];
  const showDistributorSelector =
    isSuperAdmin &&
    !platformOnlyPaths.some((p) => location.pathname.startsWith(p));

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
  };

  // Fetch pending actions for notification bell — skip when super admin has
  // no distributor selected (server returns empty list, but we avoid the
  // round-trip and any per-tenant noise).
  const { data: pendingActionsData } = useQuery({
    queryKey: ['pending-actions-notif', distributorId],
    queryFn: () => apiGet<{ actions: Array<{ actionId: string; description: string; severity: string; module: string; createdAt: string; actionType: string }> }>('/pending-actions', { status: 'open' }),
    refetchInterval: 60000, // refresh every minute
    enabled: !!distributorId,
  });

  const pendingActions = pendingActionsData?.actions || [];
  const pendingCount = pendingActions.length;

  // Close menus on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleLogout() {
    setUserMenuOpen(false);
    // Wipe ALL cached tenant data before clearing auth — query keys are
    // largely static (['orders'], ['invoices'], ['customers-list'], …) so a
    // same-tab login as a different tenant would otherwise serve the prior
    // tenant's lists from cache until refetch (#31).
    queryClient.clear();
    logout();
    navigate('/login');
  }

  function handleProfile() {
    setUserMenuOpen(false);
    const isCustomer = user?.role === UserRole.CUSTOMER;
    navigate(isCustomer ? '/app/customer/account' : '/app/settings');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface-50 dark:bg-surface-950">
      {/* Sidebar */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header bar */}
        <header className="flex h-16 items-center justify-between gap-4 border-b border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-4 lg:px-6 shrink-0">
          {/* Left: mobile sidebar trigger + page title area */}
          <div className="flex items-center gap-3">
            {/* Hamburger is mobile-only: on desktop the sidebar has its own
                Collapse/Expand button, so showing it there is redundant.
                On mobile the sidebar is an off-screen drawer and this is
                the only way to open it. */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-700 dark:hover:text-white transition-colors lg:hidden"
              aria-label="Open navigation menu"
            >
              <HiBars3 className="h-5 w-5" />
            </button>

            {/* Distributor selector — only for super admin on distributor-scoped pages */}
            {showDistributorSelector && <DistributorSelector />}
            {/* Tenant name label — 9-issues fix (2026-06-12). Replaces the
                Phase 2 sidebar third-line render. Shown only when the
                DistributorSelector isn't already filling this slot (super-
                admin gets the selector; everyone else gets the static
                name). Desktop only — `hidden lg:block` keeps the mobile
                header tight. Truncated so long businessNames don't bleed
                into the right cluster. */}
            {user?.distributorName && !showDistributorSelector && (
              <span
                className="hidden lg:block text-sm font-medium text-surface-700 dark:text-surface-200 truncate max-w-[240px]"
                title={user.distributorName}
              >
                {user.distributorName}
              </span>
            )}
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-2">
            {/* WI-080 FIX2: loud AI Demand Forecast shortcut → inventory Forecast tab */}
            <button
              onClick={() => navigate('/app/inventory?tab=forecast')}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-purple-600 to-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:from-purple-700 hover:to-blue-700 transition-colors"
            >
              <HiOutlineSparkles className="h-4 w-4" />
              AI Demand Forecast
            </button>
            <ThemeToggle />

            {/* Notifications bell */}
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setNotifOpen(!notifOpen)}
                className="relative rounded-lg p-2 text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-700 dark:hover:text-white transition-colors"
                aria-label="Notifications"
              >
                <HiOutlineBell className="h-5 w-5" />
                {pendingCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                    {pendingCount > 9 ? '9+' : pendingCount}
                  </span>
                )}
              </button>
              {notifOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 shadow-xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700">
                    <h3 className="text-sm font-semibold text-surface-900 dark:text-white">Pending Actions ({pendingCount})</h3>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {pendingActions.length === 0 ? (
                      <div className="p-4 text-center text-sm text-surface-400">No pending actions</div>
                    ) : (
                      pendingActions.slice(0, 10).map(action => (
                        <div key={action.actionId} className="px-4 py-3 border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors">
                          <div className="flex items-start gap-2">
                            <span className={`mt-1 h-2 w-2 rounded-full flex-shrink-0 ${
                              action.severity === 'critical' ? 'bg-red-500' : action.severity === 'high' ? 'bg-amber-500' : 'bg-blue-500'
                            }`} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-surface-900 dark:text-white leading-snug">{action.description}</p>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 dark:bg-surface-700 text-surface-500 capitalize">{action.module}</span>
                                <span className="text-[10px] text-surface-400">{new Date(action.createdAt).toLocaleDateString('en-IN')}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {pendingCount > 0 && (
                    <div className="px-4 py-2 border-t border-surface-200 dark:border-surface-700">
                      <button
                        onClick={() => { setNotifOpen(false); navigate('/app/pending-actions'); }}
                        className="text-xs text-brand-600 dark:text-brand-400 font-medium hover:underline"
                      >
                        View all pending actions
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* User avatar dropdown */}
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-500/20 text-brand-600 dark:text-brand-400 text-xs font-semibold">
                  {user?.firstName?.charAt(0) ?? ''}
                  {user?.lastName?.charAt(0) ?? ''}
                </div>
                <span className="hidden text-sm font-medium text-surface-700 dark:text-surface-300 md:block">
                  {user?.firstName}
                </span>
              </button>

              {/* Dropdown */}
              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 shadow-lg py-1 z-50">
                  <div className="px-4 py-3 border-b border-surface-100 dark:border-surface-700">
                    <p className="text-sm font-medium text-surface-900 dark:text-white truncate">
                      {user?.firstName} {user?.lastName}
                    </p>
                    <p className="text-xs text-surface-500 dark:text-surface-400 truncate">
                      {user?.email}
                    </p>
                    <span className="mt-1 inline-block rounded-full bg-brand-100 dark:bg-brand-500/20 px-2 py-0.5 text-[10px] font-medium text-brand-600 dark:text-brand-400 capitalize">
                      {user?.role?.replace('_', ' ')}
                    </span>
                  </div>
                  <button
                    onClick={handleProfile}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2.5 text-sm text-surface-700 dark:text-surface-300',
                      'hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors',
                    )}
                  >
                    <HiOutlineUserCircle className="h-4 w-4" />
                    Profile
                  </button>
                  <button
                    onClick={handleLogout}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-400',
                      'hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors',
                    )}
                  >
                    <HiOutlineArrowRightOnRectangle className="h-4 w-4" />
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
