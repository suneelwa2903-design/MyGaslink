import { useState, useRef, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import {
  HiOutlineBell,
  HiBars3,
  HiOutlineArrowRightOnRectangle,
  HiOutlineUserCircle,
} from 'react-icons/hi2';
import { useAuthStore } from '@/stores/authStore';
import { UserRole } from '@gaslink/shared';
import { cn } from '@/lib/cn';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';
import { DistributorSelector } from './DistributorSelector';

export function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;

  // Close user menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleLogout() {
    setUserMenuOpen(false);
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
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header bar */}
        <header className="flex h-16 items-center justify-between gap-4 border-b border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-4 lg:px-6 shrink-0">
          {/* Left: hamburger + page title area */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-700 dark:hover:text-white transition-colors lg:hidden"
              aria-label="Open sidebar"
            >
              <HiBars3 className="h-5 w-5" />
            </button>

            {/* Distributor selector for super admin */}
            {isSuperAdmin && <DistributorSelector />}
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-2">
            <ThemeToggle />

            {/* Notifications bell */}
            <button
              className="relative rounded-lg p-2 text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-700 dark:hover:text-white transition-colors"
              aria-label="Notifications"
            >
              <HiOutlineBell className="h-5 w-5" />
              {/* Notification dot */}
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
            </button>

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
