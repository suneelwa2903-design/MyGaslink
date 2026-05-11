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
  // True once zustand/persist has finished reading localStorage. Routes
  // must wait for this before deciding to redirect to /login — otherwise
  // the first synchronous render sees the initial (unauthenticated) state
  // and ProtectedRoute bounces the user before persist rehydrates.
  _hasHydrated: boolean;

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
  setHasHydrated: (v: boolean) => void;
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
      _hasHydrated: false,

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

      setHasHydrated: (v) => set({ _hasHydrated: v }),

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
      // Flip _hasHydrated once persist has read localStorage so route
      // guards can wait for it before deciding to redirect. Runs once on
      // app boot, even when localStorage is empty.
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
