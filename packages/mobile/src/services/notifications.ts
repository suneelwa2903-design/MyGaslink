/**
 * Notifications Service — Stub for Expo Go
 *
 * Push notifications are NOT supported in Expo Go (SDK 53+).
 * This file exports no-op stubs so the app doesn't crash.
 *
 * When building a dev APK (eas build --profile development),
 * replace this with the real implementation that imports expo-notifications.
 */

export async function registerForPushNotifications(): Promise<string | null> {
  // No-op in Expo Go
  return null;
}

export function addNotificationListener(
  _handler: (notification: unknown) => void,
) {
  return { remove: () => {} };
}

export function addNotificationResponseListener(
  _handler: (response: unknown) => void,
) {
  return { remove: () => {} };
}

export async function getBadgeCount(): Promise<number> {
  return 0;
}

export async function setBadgeCount(_count: number): Promise<void> {
  // No-op
}

export async function scheduleLocalNotification(
  _title: string,
  _body: string,
  _data?: Record<string, unknown>,
  _secondsFromNow: number = 0,
) {
  // No-op
}
