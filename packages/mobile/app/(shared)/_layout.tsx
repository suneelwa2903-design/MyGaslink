/**
 * M14 v1.0 — shared route group for screens reachable from multiple roles.
 * Currently hosts the account-deletion flow + pending-deletion screen.
 */
import { Stack } from 'expo-router';

export default function SharedLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
