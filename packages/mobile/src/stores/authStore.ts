import { create } from 'zustand';
import type { UserProfile, UserRole } from '@gaslink/shared';
import { tokenStorage, apiGet } from '../lib/api';

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
    // Flip auth state FIRST so the RoleGuard redirect to /(auth)/login fires
    // instantly. Previously we awaited two serial SecureStore deletes BEFORE
    // clearing state, so the screen froze on the current tab during that
    // native round-trip (most visible on the customer Account screen). The
    // in-memory session is already gone, so no authed request can fire; the
    // token wipe just completes in the background.
    set({ user: null, isAuthenticated: false, selectedDistributorId: null });
    await tokenStorage.clearTokens();
  },

  hydrate: async () => {
    try {
      const token = await tokenStorage.getAccessToken();
      if (!token) {
        set({ isLoading: false });
        return;
      }
      // Token exists - try to fetch profile.
      // apiGet is imported statically at the top: lib/api has no dependency on
      // this store (no circular import), so there's no reason to defer it via a
      // dynamic import — and the dynamic import previously defeated test mocking.
      const user = await apiGet<UserProfile>('/auth/me');
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      await tokenStorage.clearTokens();
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
