import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserProfile, UserRole } from '@gaslink/shared';

interface AuthState {
  // Persisted state
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

  // Actions
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: UserProfile) => void;
  setSelectedDistributorId: (id: string | null) => void;
  setHasHydrated: (v: boolean) => void;
  logout: () => void;
}

// ─── Selectors ──────────────────────────────────────────────────────────────
// Don't define these as getters on the store — Zustand's setState spreads
// state to merge updates, which invokes getters and rewrites them as data
// properties. After the first rehydration / setState the getters are gone
// and you're left with stale frozen values. Selectors keep the derivation
// reactive without that footgun.

export const selectRole = (s: AuthState): UserRole | null =>
  (s.user?.role as UserRole | undefined) ?? null;

export const selectIsSuperAdmin = (s: AuthState): boolean =>
  s.user?.role === 'super_admin';

export const selectIsCustomer = (s: AuthState): boolean =>
  s.user?.role === 'customer';

export const selectIsDriver = (s: AuthState): boolean => s.user?.role === 'driver';

export const selectDistributorId = (s: AuthState): string | null => {
  if (s.user?.role === 'super_admin') return s.selectedDistributorId;
  return s.user?.distributorId ?? null;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      selectedDistributorId: null,
      isAuthenticated: false,
      _hasHydrated: false,

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
      // Flip _hasHydrated after rehydration so route guards can wait
      // for storage to load before deciding to redirect.
      onRehydrateStorage: () => () => {
        useAuthStore.setState({ _hasHydrated: true });
      },
    },
  ),
);

// Belt-and-braces: trigger rehydrate explicitly and then flip the flag
// after it resolves. Covers the case where the inline onRehydrateStorage
// callback misfires (e.g. HMR module duplication during dev).
void useAuthStore.persist?.rehydrate?.()?.then?.(() => {
  useAuthStore.setState({ _hasHydrated: true });
});
