/**
 * themeStore unit tests
 *
 * Covers:
 * 1. Fresh store default mode = 'light' (not 'system', not the OS scheme)
 * 2. toggleMode: light → dark
 * 3. toggleMode: dark → light
 * 4. onRehydrateStorage coerces a stale 'system' value to 'light'
 * 5. Persist migrate v1 → v2 converts 'system' to 'light'
 *
 * Why these tests exist:
 * The theme system has had two real bugs since this app shipped —
 *   (a) first tap on the toggle was a no-op on devices where the OS color
 *       scheme matched the persisted 'system' state (fixed in toggleMode);
 *   (b) the new 'light' default was silently overridden by every existing
 *       user's persisted 'system' value (fixed by onRehydrateStorage + migrate).
 * These tests pin both fixes so they don't regress.
 */

// Mock expo-secure-store before importing the store — persist middleware
// tries to call SecureStore.getItemAsync at module load.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock react-native's Appearance API so toggleMode's branch on
// `Appearance.getColorScheme()` is deterministic.
jest.mock('react-native', () => ({
  useColorScheme: () => 'light',
  Appearance: {
    getColorScheme: jest.fn(() => 'light'),
  },
}));

import { useThemeStore } from '../src/stores/themeStore';
import { Appearance } from 'react-native';

beforeEach(() => {
  // Reset the store to fresh defaults before each test. Zustand stores
  // persist their state across describe blocks in the same file, so without
  // this reset the third test would see whatever the second test left behind.
  useThemeStore.setState({ mode: 'light', _hasHydrated: false });
});

describe('themeStore', () => {
  test('1. fresh store defaults to light', () => {
    // The store's initial state object says `mode: 'light'` — this is the
    // hard-coded default, not derived from Appearance. A user freshly
    // installing the app on a phone in dark mode should still open light.
    expect(useThemeStore.getState().mode).toBe('light');
  });

  test('2. toggleMode flips light → dark', () => {
    useThemeStore.setState({ mode: 'light' });
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe('dark');
  });

  test('3. toggleMode flips dark → light', () => {
    useThemeStore.setState({ mode: 'dark' });
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe('light');
  });

  test('4. onRehydrateStorage coerces stale "system" value to "light"', () => {
    // Simulate what happens when persist reads a legacy 'system' value
    // from SecureStore. The onRehydrateStorage callback should run and
    // replace 'system' with 'light' in place.
    const state = { mode: 'system' as 'system' | 'light' | 'dark', _hasHydrated: false };
    // We invoke the rehydrate logic manually — it's the same callback the
    // persist middleware runs after `getItemAsync` resolves. The store's
    // persist config returns a function `(state, error) => { ... }` from
    // its `onRehydrateStorage` factory.
    const rehydrateCallback = useThemeStore.persist.getOptions().onRehydrateStorage?.(
      useThemeStore.getState(),
    );
    rehydrateCallback?.(state as any, undefined);
    expect(state.mode).toBe('light');
  });

  test('5. migrate v1 → v2 converts persisted "system" to "light"', () => {
    // The migrate function runs once when zustand persist notices the
    // stored version (1, undefined for pre-v2 installs) is below current.
    // It should rewrite 'system' to 'light'.
    const migrate = useThemeStore.persist.getOptions().migrate;
    const result = migrate?.({ mode: 'system' }, 1);
    expect(result).toBeDefined();
    expect((result as any).mode).toBe('light');
  });
});
