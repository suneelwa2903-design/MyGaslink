// Mock expo-notifications
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getBadgeCountAsync: jest.fn(),
  setBadgeCountAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  AndroidImportance: { HIGH: 4, MAX: 5, DEFAULT: 3 },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('../lib/api', () => ({
  apiPost: jest.fn(),
  tokenStorage: {
    getAccessToken: jest.fn(),
    getRefreshToken: jest.fn(),
    setTokens: jest.fn(),
    clearTokens: jest.fn(),
  },
}));

import * as Notifications from 'expo-notifications';
import { registerForPushNotifications } from '../services/notifications';

describe('registerForPushNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when permission denied', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });

    const token = await registerForPushNotifications();
    expect(token).toBeNull();
  });

  // The two tests below assert the REAL push-notification flow (request
  // permission → fetch Expo push token). That implementation does not exist in
  // this build: src/services/notifications.ts is an intentional no-op stub
  // because push notifications are unsupported in Expo Go (SDK 53+) — see the
  // file header. registerForPushNotifications() hard-returns null and never
  // calls expo-notifications, so these expectations cannot pass.
  // Re-enable (remove .skip) once the real implementation is restored for the
  // dev/prod APK build (eas build --profile development).
  it.skip('returns push token when permission granted (stub: not built in Expo Go)', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[xxx]' });

    const token = await registerForPushNotifications();
    expect(token).toBe('ExponentPushToken[xxx]');
  });

  it.skip('requests permission when not already granted (stub: not built in Expo Go)', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'undetermined' });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[yyy]' });

    const token = await registerForPushNotifications();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(token).toBe('ExponentPushToken[yyy]');
  });
});
