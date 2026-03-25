import { NavLink, useNavigate } from 'react-router-dom';
import { type IconType } from 'react-icons';
import {
  HiOutlineHome,
  HiOutlineClipboardDocumentList,
  HiOutlineCube,
  HiOutlineUsers,
  HiOutlineBanknotes,
  HiOutlineTruck,
  HiOutlineChartBar,
  HiOutlineCog6Tooth,
  HiOutlineBuildingOffice,
  HiOutlineHeart,
  HiOutlineArrowRightOnRectangle,
  HiOutlineServerStack,
  HiOutlineDocumentText,
  HiOutlineRectangleStack,
} from 'react-icons/hi2';
import { useAuthStore } from '@/stores/authStore';
import { UserRole } from '@gaslink/shared';
import { cn } from '@/lib/cn';

interface MenuItem {
  label: string;
  path: string;
  icon: IconType;
  roles: UserRole[];
  external?: boolean;
}

const adminMenuItems: MenuItem[] = [
  {
    label: 'Analytics',
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
    path: '/app/customers',
    icon: HiOutlineUsers,
    roles: [UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR_ADMIN],
  },
  {
    label: 'Billing & Payments',
    path: '/app/billing-payments',
    icon: HiOutlineBanknotes,
    roles: [
      UserRole.SUPER_ADMIN,
      UserRole.DISTRIBUTOR_ADMIN,
      UserRole.FINANCE,
    ],
  },
  {
    label: 'Fleet',
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
    path: '/app/settings',
    icon: HiOutlineCog6Tooth,
    roles: [UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR_ADMIN],
  },
  {
    label: 'Distributors',
    path: '/app/distributors',
    icon: HiOutlineBuildingOffice,
    roles: [UserRole.SUPER_ADMIN],
  },
  {
    label: 'Provider Catalog',
    path: '/app/provider-catalog',
    icon: HiOutlineRectangleStack,
    roles: [UserRole.SUPER_ADMIN],
  },
  {
    label: 'Health Monitoring',
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
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

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
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-slate-900 dark:bg-slate-100 border-r border-slate-800 dark:border-slate-200 transition-transform duration-300 ease-in-out lg:static lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand / Logo */}
        <div className="flex h-16 items-center gap-3 px-5 border-b border-slate-800 dark:border-slate-200 shrink-0">
          <img src="/logo.png" alt="MyGasLink" className="h-11 w-11 rounded-xl object-contain" />
          <div>
            <h1 className="text-lg font-bold text-white dark:text-slate-900 leading-tight">
              MyGasLink
            </h1>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-wider font-medium">
              LPG Management
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {visibleItems.map((item) =>
            item.external ? (
              <a
                key={item.path}
                href={item.path === '/api/docs' ? `${import.meta.env.VITE_API_URL || 'http://localhost:5000/api'}/docs?token=${useAuthStore.getState().accessToken || ''}` : item.path}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onClose()}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors text-slate-400 dark:text-slate-600 hover:bg-slate-800 dark:hover:bg-slate-200 hover:text-white dark:hover:text-slate-900"
              >
                <item.icon className="h-5 w-5 shrink-0" />
                <span>{item.label}</span>
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
                  )
                }
              >
                <item.icon className="h-5 w-5 shrink-0" />
                <span>{item.label}</span>
              </NavLink>
            ),
          )}
        </nav>

        {/* User info + Logout */}
        <div className="shrink-0 border-t border-slate-800 dark:border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/20 text-brand-400 dark:text-brand-600 text-sm font-semibold shrink-0">
              {user?.firstName?.charAt(0) ?? ''}
              {user?.lastName?.charAt(0) ?? ''}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white dark:text-slate-900">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="truncate text-xs text-slate-400 dark:text-slate-500">
                {user?.email}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 dark:hover:bg-slate-200 hover:text-red-500 transition-colors"
              title="Log out"
            >
              <HiOutlineArrowRightOnRectangle className="h-5 w-5" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
