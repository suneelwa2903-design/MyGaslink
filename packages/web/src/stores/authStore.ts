import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserProfile, UserRole } from '@gaslink/shared';

interface AuthState {
  // State
  accessToken: string | null;
  refreshToken: string | null;
  user: UserProfile | null;
  selectedDistributorId: string | null;
  isAuthenticated: boolean;

  // Computed
  role: UserRole | null;
  isSuperAdmin: boolean;
  isCustomer: boolean;
  isDriver: boolean;
  distributorId: string | null;

  // Actions
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: UserProfile) => void;
  setSelectedDistributorId: (id: string | null) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      selectedDistributorId: null,
      isAuthenticated: false,

      get role() { return get().user?.role as UserRole ?? null; },
      get isSuperAdmin() { return get().user?.role === 'super_admin'; },
      get isCustomer() { return get().user?.role === 'customer'; },
      get isDriver() { return get().user?.role === 'driver'; },
      get distributorId() {
        const state = get();
        if (state.user?.role === 'super_admin') return state.selectedDistributorId;
        return state.user?.distributorId ?? null;
      },

      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken, isAuthenticated: true }),

      setUser: (user) => set({ user }),

      setSelectedDistributorId: (id) => set({ selectedDistributorId: id }),

      logout: () => set({
        accessToken: null,
        refreshToken: null,
        user: null,
        selectedDistributorId: null,
        isAuthenticated: false,
      }),
    }),
    {
      name: 'gaslink-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        selectedDistributorId: state.selectedDistributorId,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);
