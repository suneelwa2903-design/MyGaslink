/**
 * Notifications Service — v1.0 Stub (push deferred to v1.1)
 *
 * The expo-notifications plugin was removed from app.config in 6df8856 so
 * iOS submission isn't rejected for declaring push entitlements without a
 * working handler. v1.0 has no background push by design — SSE
 * (services/sseService.ts) covers driver foreground updates.
 *
 * These no-op stubs are kept so the v1.1 push sprint can re-add the plugin
 * and swap the bodies for real expo-notifications calls without re-wiring
 * scaffolding or updating call sites elsewhere. The v1.1 work item is
 * tracked under CLAUDE.md "v1.1 Post-iOS-submission backlog (Sprint 1)".
 *
 * If you are reading this in a v1.1 task: replace the bodies, re-add the
 * expo-notifications plugin to app.json, and unskip the two real-flow
 * tests in __tests__/notifications.test.ts.
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
