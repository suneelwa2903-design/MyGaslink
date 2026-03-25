import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import { useColorScheme } from 'react-native';

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
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

// ─── Store ─────────────────────────────────────────────────────────────────

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',

      setMode: (mode) => set({ mode }),

      toggleMode: () => {
        const { mode } = get();
        // Cycle: system -> light -> dark -> system
        // But for a simple toggle button, just flip light/dark based on current resolved value
        // If system, switch to the opposite of what system currently shows
        // For simplicity: if currently resolving to dark, go light; if light, go dark.
        // We set explicit light/dark (not back to system) since user is actively toggling.
        set({ mode: mode === 'dark' ? 'light' : 'dark' });
      },
    }),
    {
      name: 'gaslink-theme',
      storage: createJSONStorage(() => secureStoreAdapter),
      partialize: (state) => ({ mode: state.mode }),
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
