import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type IconType } from 'react-icons';
import {
  HiOutlineHome,
  HiOutlineClipboardDocumentList,
  HiOutlineCube,
  HiOutlineUsers,
  HiOutlineBanknotes,
  HiOutlineCurrencyRupee,
  HiOutlineTruck,
  HiOutlineChartBar,
  HiOutlineCog6Tooth,
  HiOutlineBuildingOffice,
  HiOutlineHeart,
  HiOutlineArrowRightOnRectangle,
  HiOutlineServerStack,
  HiOutlineDocumentText,
  HiOutlineRectangleStack,
  HiChevronDoubleLeft,
  HiChevronDoubleRight,
} from 'react-icons/hi2';
import { useAuthStore } from '@/stores/authStore';
import { UserRole } from '@gaslink/shared';
import { cn } from '@/lib/cn';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

interface MenuItem {
  label: string;
  /** i18n key under nav.* — when present, takes precedence over label. */
  labelKey?: string;
  path: string;
  icon: IconType;
  roles: UserRole[];
  external?: boolean;
}

const adminMenuItems: MenuItem[] = [
  {
    label: 'Analytics',
    labelKey: 'nav.analytics',
    path: '/app/analytics',
    icon: HiOutlineChartBar,
    roles: [
      UserRole.SUPER_ADMIN,
      UserRole.DISTRIBUTOR_ADMIN,
      UserRole.FINANCE,
      UserRole.INVENTORY,
      UserRole.DRIVER,
    ],
  },
  {
    label: 'Orders',
    labelKey: 'nav.orders',
    path: '/app/orders',
    icon: HiOutlineClipboardDocumentList,
    roles: [
      UserRole.SUPER_ADMIN,
      UserRole.DISTRIBUTOR_ADMIN,
      UserRole.INVENTORY,
      UserRole.DRIVER,
    ],
  },
  {
    label: 'Inventory',
    labelKey: 'nav.inventory',
    path: '/app/inventory',
    icon: HiOutlineCube,
    roles: [
      UserRole.SUPER_ADMIN,
      UserRole.DISTRIBUTOR_ADMIN,
      UserRole.INVENTORY,
    ],
  },
  {
    label: 'Customers',
    labelKey: 'nav.customers',
    path: '/app/customers',
    icon: HiOutlineUsers,
    roles: [UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR_ADMIN],
  },
  {
    label: 'Billing & Payments',
    labelKey: 'nav.billing',
    path: '/app/billing-payments',
    icon: HiOutlineBanknotes,
    roles: [
      UserRole.SUPER_ADMIN,
      UserRole.DISTRIBUTOR_ADMIN,
      UserRole.FINANCE,
    ],
  },
  {
    // Collections (who owes money / call list) is a daily workflow for
    // distributor admin + finance. No labelKey yet — labelOf() falls back
    // to `label`, so EN works and i18n can add nav.collections later.
    label: 'Collections',
    path: '/app/collections',
    icon: HiOutlineCurrencyRupee,
    roles: [
      UserRole.SUPER_ADMIN,
      UserRole.DISTRIBUTOR_ADMIN,
      UserRole.FINANCE,
    ],
  },
  {
    label: 'Fleet',
    labelKey: 'nav.fleet',
    path: '/app/fleet',
    icon: HiOutlineTruck,
    roles: [
      UserRole.SUPER_ADMIN,
      UserRole.DISTRIBUTOR_ADMIN,
      UserRole.INVENTORY,
    ],
  },
  {
    label: 'Settings',
    labelKey: 'nav.settings',
    path: '/app/settings',
    icon: HiOutlineCog6Tooth,
    roles: [UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR_ADMIN],
  },
  {
    label: 'Distributors',
    labelKey: 'nav.distributors',
    path: '/app/distributors',
    icon: HiOutlineBuildingOffice,
    roles: [UserRole.SUPER_ADMIN],
  },
  {
    label: 'Provider Catalog',
    labelKey: 'nav.providerCatalog',
    path: '/app/provider-catalog',
    icon: HiOutlineRectangleStack,
    roles: [UserRole.SUPER_ADMIN],
  },
  {
    label: 'Health Monitoring',
    labelKey: 'nav.health',
    path: '/app/health',
    icon: HiOutlineServerStack,
    roles: [UserRole.SUPER_ADMIN],
  },
  {
    label: 'API Docs',
    path: '/api/docs',
    icon: HiOutlineDocumentText,
    roles: [UserRole.SUPER_ADMIN],
    external: true,
  },
];

const customerMenuItems: MenuItem[] = [
  {
    label: 'Dashboard',
    path: '/app/customer/dashboard',
    icon: HiOutlineHome,
    roles: [UserRole.CUSTOMER],
  },
  {
    label: 'Orders',
    path: '/app/customer/orders',
    icon: HiOutlineClipboardDocumentList,
    roles: [UserRole.CUSTOMER],
  },
  {
    label: 'Invoices',
    path: '/app/customer/invoices',
    icon: HiOutlineDocumentText,
    roles: [UserRole.CUSTOMER],
  },
  {
    label: 'Payments',
    path: '/app/customer/payments',
    icon: HiOutlineBanknotes,
    roles: [UserRole.CUSTOMER],
  },
  {
    label: 'Account',
    path: '/app/customer/account',
    icon: HiOutlineHeart,
    roles: [UserRole.CUSTOMER],
  },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ isOpen, onClose, collapsed, onToggleCollapse }: SidebarProps) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // Resolve a menu item's label — prefer the i18n key when present so
  // EN/TE switching works without re-rendering each item explicitly.
  const labelOf = (item: MenuItem) => (item.labelKey ? t(item.labelKey, item.label) : item.label);

  const userRole = user?.role as UserRole | undefined;
  const isCustomer = userRole === UserRole.CUSTOMER;

  const menuItems = isCustomer ? customerMenuItems : adminMenuItems;

  const visibleItems = menuItems.filter((item) => {
    if (!userRole) return false;
    if (userRole === UserRole.SUPER_ADMIN) return true;
    return item.roles.includes(userRole);
  });

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col bg-slate-900 dark:bg-slate-100 border-r border-slate-800 dark:border-slate-200 transition-all duration-300 ease-in-out lg:static lg:translate-x-0',
          collapsed ? 'lg:w-16' : 'w-64',
          // Mobile: always w-64, use translate for show/hide
          'max-lg:w-64',
          isOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand / Logo */}
        <div className="flex h-16 items-center gap-3 px-5 border-b border-slate-800 dark:border-slate-200 shrink-0 overflow-hidden">
          <img
            src="/logo.png"
            alt="MyGasLink"
            className={cn('h-11 w-11 rounded-xl object-contain shrink-0', collapsed && 'lg:h-8 lg:w-8 lg:mx-auto')}
          />
          <div className={cn(collapsed && 'lg:hidden')}>
            <h1 className="text-lg font-bold text-white dark:text-slate-900 leading-tight">
              MyGasLink
            </h1>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-wider font-medium">
              LPG Management
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className={cn('flex-1 overflow-y-auto py-4 space-y-1', collapsed ? 'lg:px-1.5' : 'px-3')}>
          {visibleItems.map((item) =>
            item.external ? (
              <a
                key={item.path}
                href={item.path === '/api/docs' ? `${import.meta.env.VITE_API_URL || 'http://localhost:5000/api'}/docs?token=${useAuthStore.getState().accessToken || ''}` : item.path}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onClose()}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors text-slate-400 dark:text-slate-600 hover:bg-slate-800 dark:hover:bg-slate-200 hover:text-white dark:hover:text-slate-900',
                  collapsed && 'lg:justify-center lg:px-0',
                )}
                title={collapsed ? labelOf(item) : undefined}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                <span className={cn(collapsed && 'lg:hidden')}>{labelOf(item)}</span>
              </a>
            ) : (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => onClose()}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-500/20 text-brand-400 dark:bg-brand-500/15 dark:text-brand-600'
                      : 'text-slate-400 dark:text-slate-600 hover:bg-slate-800 dark:hover:bg-slate-200 hover:text-white dark:hover:text-slate-900',
                    collapsed && 'lg:justify-center lg:px-0',
                  )
                }
                title={collapsed ? labelOf(item) : undefined}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                <span className={cn(collapsed && 'lg:hidden')}>{labelOf(item)}</span>
              </NavLink>
            ),
          )}
        </nav>

        {/* Collapse toggle - desktop only */}
        {onToggleCollapse && (
          <div className="hidden lg:block shrink-0 border-t border-slate-800 dark:border-slate-200 p-2">
            <button
              onClick={onToggleCollapse}
              className={cn(
                'flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium text-slate-400 dark:text-slate-600 hover:bg-slate-800 dark:hover:bg-slate-200 hover:text-white dark:hover:text-slate-900 transition-colors',
                collapsed && 'justify-center px-0',
              )}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <HiChevronDoubleRight className="h-4 w-4 shrink-0" />
              ) : (
                <>
                  <HiChevronDoubleLeft className="h-4 w-4 shrink-0" />
                  <span>Collapse</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* User info + Language switcher + Logout */}
        <div className={cn('shrink-0 border-t border-slate-800 dark:border-slate-200', collapsed ? 'lg:p-2' : 'p-4')}>
          <div className={cn('flex items-center gap-3', collapsed && 'lg:justify-center')}>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/20 text-brand-400 dark:text-brand-600 text-sm font-semibold shrink-0">
              {user?.firstName?.charAt(0) ?? ''}
              {user?.lastName?.charAt(0) ?? ''}
            </div>
            <div className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
              <p className="truncate text-sm font-medium text-white dark:text-slate-900">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="truncate text-xs text-slate-400 dark:text-slate-500">
                {user?.email}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className={cn(
                'rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 dark:hover:bg-slate-200 hover:text-red-500 transition-colors',
                collapsed && 'lg:hidden',
              )}
              title={t('nav.logout', 'Logout')}
            >
              <HiOutlineArrowRightOnRectangle className="h-5 w-5" />
            </button>
          </div>

          {/* Language switcher (hidden when sidebar is collapsed) */}
          <div className={cn('mt-3 flex justify-center', collapsed && 'lg:hidden')}>
            <LanguageSwitcher />
          </div>
        </div>
      </aside>
    </>
  );
}
