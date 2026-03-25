import * as Location from 'expo-location';
import { apiPost } from '../lib/api';

export interface LocationCoords {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
}

export async function requestLocationPermission(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

export async function getCurrentLocation(): Promise<LocationCoords | null> {
  try {
    const hasPermission = await requestLocationPermission();
    if (!hasPermission) return null;

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      timestamp: location.timestamp,
    };
  } catch {
    return null;
  }
}

export async function reportDriverLocation(
  driverId: string,
  assignmentId?: string,
): Promise<void> {
  const coords = await getCurrentLocation();
  if (!coords) return;

  try {
    await apiPost('/drivers/location', {
      driverId,
      assignmentId,
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: coords.accuracy,
      timestamp: new Date(coords.timestamp).toISOString(),
    });
  } catch {
    // Silently fail — location reporting is best-effort
  }
}

// Start periodic location reporting for drivers
let locationInterval: ReturnType<typeof setInterval> | null = null;

export function startLocationTracking(
  driverId: string,
  assignmentId?: string,
  intervalMs: number = 60_000,
): void {
  stopLocationTracking();
  // Report immediately
  reportDriverLocation(driverId, assignmentId);
  // Then on interval
  locationInterval = setInterval(() => {
    reportDriverLocation(driverId, assignmentId);
  }, intervalMs);
}

export function stopLocationTracking(): void {
  if (locationInterval) {
    clearInterval(locationInterval);
    locationInterval = null;
  }
}
