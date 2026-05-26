import type { UserProfile } from '@gaslink/shared';
import { useAuthStore } from '../stores/authStore';
import { tokenStorage as tokenStorageMock, apiGet as apiGetMock } from '../lib/api';

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// Mock the API module
jest.mock('../lib/api', () => ({
  tokenStorage: {
    getAccessToken: jest.fn(),
    getRefreshToken: jest.fn(),
    setTokens: jest.fn(),
    clearTokens: jest.fn(),
  },
  apiGet: jest.fn(),
}));

const tokenStorage = jest.mocked(tokenStorageMock);
const apiGet = jest.mocked(apiGetMock);

describe('authStore', () => {
  beforeEach(() => {
    // Reset store state
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      selectedDistributorId: null,
    });
  });

  it('starts with default state', () => {
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(true);
    expect(state.selectedDistributorId).toBeNull();
  });

  it('setUser sets user and marks authenticated', () => {
    const mockUser = {
      userId: '1',
      email: 'test@test.com',
      firstName: 'Test',
      lastName: 'User',
      phone: null,
      role: 'driver' as const,
      status: 'active' as const,
      distributorId: 'dist-1',
      customerId: null,
      requiresPasswordReset: false,
    };

    useAuthStore.getState().setUser(mockUser);
    const state = useAuthStore.getState();

    expect(state.user).toEqual(mockUser);
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  it('setLoading updates loading state', () => {
    useAuthStore.getState().setLoading(false);
    expect(useAuthStore.getState().isLoading).toBe(false);

    useAuthStore.getState().setLoading(true);
    expect(useAuthStore.getState().isLoading).toBe(true);
  });

  it('logout clears all state', async () => {

    // Set up authenticated state
    useAuthStore.setState({
      user: { userId: '1' } as Partial<UserProfile> as UserProfile,
      isAuthenticated: true,
      selectedDistributorId: 'dist-1',
    });

    await useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.selectedDistributorId).toBeNull();
    expect(tokenStorage.clearTokens).toHaveBeenCalled();
  });

  it('setSelectedDistributorId updates distributor selection', () => {
    useAuthStore.getState().setSelectedDistributorId('dist-123');
    expect(useAuthStore.getState().selectedDistributorId).toBe('dist-123');

    useAuthStore.getState().setSelectedDistributorId(null);
    expect(useAuthStore.getState().selectedDistributorId).toBeNull();
  });

  it('hydrate with no token sets loading false', async () => {
    tokenStorage.getAccessToken.mockResolvedValue(null);

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('hydrate with valid token restores user', async () => {
    const mockUser = {
      userId: '1',
      email: 'test@test.com',
      firstName: 'Test',
      lastName: 'User',
      role: 'driver',
      status: 'active',
    };

    tokenStorage.getAccessToken.mockResolvedValue('valid-token');
    apiGet.mockResolvedValue(mockUser);

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user).toEqual(mockUser);
    expect(state.isLoading).toBe(false);
  });

  it('hydrate with expired token clears state', async () => {

    tokenStorage.getAccessToken.mockResolvedValue('expired-token');
    apiGet.mockRejectedValue(new Error('Unauthorized'));

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(tokenStorage.clearTokens).toHaveBeenCalled();
  });
});
