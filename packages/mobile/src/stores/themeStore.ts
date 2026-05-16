import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import { useColorScheme, Appearance } from 'react-native';

// ─── Storage adapter (SecureStore) ─────────────────────────────────────────

const secureStoreAdapter = {
  getItem: async (key: string) => {
    return await SecureStore.getItemAsync(key);
  },
  setItem: async (key: string, value: string) => {
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key: string) => {
    await SecureStore.deleteItemAsync(key);
  },
};

// ─── Store types ───────────────────────────────────────────────────────────

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  _hasHydrated: boolean;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

// ─── Store ─────────────────────────────────────────────────────────────────

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      // Hard-coded LIGHT default. Do NOT use Appearance.getColorScheme() —
      // user expectation is that fresh-install always opens light, then
      // persists whatever they pick.
      mode: 'light',

      _hasHydrated: false,

      setMode: (mode) => set({ mode }),

      toggleMode: () => {
        const { mode } = get();
        // Tapping the toggle must produce a visible change every time.
        // Bug: previous logic flipped mode === 'dark' ? 'light' : 'dark', so
        // first tap on a system-resolved-to-dark device went 'system' → 'dark'
        // which looked identical (still dark). Now: resolve current effective
        // theme first, then flip to its opposite.
        const isCurrentlyDark =
          mode === 'dark' ||
          (mode === 'system' && Appearance.getColorScheme() === 'dark');
        set({ mode: isCurrentlyDark ? 'light' : 'dark' });
      },
    }),
    {
      name: 'gaslink-theme',
      storage: createJSONStorage(() => secureStoreAdapter),
      partialize: (state) => ({ mode: state.mode }),
      // Migration: any user who previously had 'system' (the old default)
      // gets bumped to 'light'. Without this, fresh-install-default of
      // 'light' is overwritten on every cold launch by the persisted value
      // from before this change shipped, and the user sees the same dark
      // theme they had yesterday.
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        if (state.mode !== 'light' && state.mode !== 'dark') {
          state.mode = 'light';
        }
      },
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        const s = (persistedState ?? {}) as Partial<ThemeState>;
        if (version < 2 && s.mode === 'system') {
          return { ...s, mode: 'light' as ThemeMode };
        }
        return s as ThemeState;
      },
    },
  ),
);

// ─── Derived hook ──────────────────────────────────────────────────────────

/**
 * Resolves the persisted theme mode into a boolean.
 * If mode is 'system', falls back to the OS color scheme.
 */
export function useIsDark(): boolean {
  const mode = useThemeStore((s) => s.mode);
  const systemScheme = useColorScheme();

  if (mode === 'light') return false;
  if (mode === 'dark') return true;
  return systemScheme === 'dark'; // mode === 'system'
}

/**
 * True once the persisted theme has been read from SecureStore.
 * Root layout uses this to gate the first render so users don't see
 * a flash of the default theme before their persisted choice loads.
 */
export function useThemeHasHydrated(): boolean {
  // Zustand persist exposes a `hasHydrated()` snapshot and a subscribe hook;
  // we want a reactive value, so subscribe via the store's persist API.
  return useThemeStore((s) => s._hasHydrated);
}

// Set _hasHydrated to true once persist finishes restoring from SecureStore.
useThemeStore.persist.onFinishHydration(() => {
  useThemeStore.setState({ _hasHydrated: true });
});
