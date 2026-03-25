import { create } from 'zustand';
import type { UserProfile, UserRole } from '@gaslink/shared';
import { tokenStorage } from '../lib/api';

interface AuthState {
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  selectedDistributorId: string | null;

  role: UserRole | null;
  isSuperAdmin: boolean;
  isCustomer: boolean;
  isDriver: boolean;
  distributorId: string | null;

  setUser: (user: UserProfile) => void;
  setLoading: (loading: boolean) => void;
  setSelectedDistributorId: (id: string | null) => void;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  selectedDistributorId: null,

  get role() { return get().user?.role as UserRole ?? null; },
  get isSuperAdmin() { return get().user?.role === 'super_admin'; },
  get isCustomer() { return get().user?.role === 'customer'; },
  get isDriver() { return get().user?.role === 'driver'; },
  get distributorId() {
    const s = get();
    return s.user?.role === 'super_admin' ? s.selectedDistributorId : s.user?.distributorId ?? null;
  },

  setUser: (user) => set({ user, isAuthenticated: true, isLoading: false }),

  setLoading: (isLoading) => set({ isLoading }),

  setSelectedDistributorId: (id) => set({ selectedDistributorId: id }),

  logout: async () => {
    await tokenStorage.clearTokens();
    set({ user: null, isAuthenticated: false, selectedDistributorId: null });
  },

  hydrate: async () => {
    try {
      const token = await tokenStorage.getAccessToken();
      if (!token) {
        set({ isLoading: false });
        return;
      }
      // Token exists - try to fetch profile
      const { apiGet } = await import('../lib/api');
      const user = await apiGet<UserProfile>('/auth/me');
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      await tokenStorage.clearTokens();
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
