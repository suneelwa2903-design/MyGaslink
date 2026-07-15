import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { api } from '../lib/api';

// Stored under SecureStore — not strictly sensitive, but it's the only storage
// available in this project (no AsyncStorage dependency). Keep entries small;
// SecureStore on Android caps each key at ~2KB.
const QUEUE_KEY = 'pending_deliveries';

export type QueuedDeliveryItem = {
  cylinderTypeId: string;
  deliveredQuantity: number;
  emptiesCollected: number;
};

export type QueuedDelivery = {
  orderId: string;
  items: QueuedDeliveryItem[];
  notes?: string;
  deliveryLatitude?: number;
  deliveryLongitude?: number;
  // Proof-of-collection Phase 1 (2026-07-15) — proof METADATA only.
  // Signature PNG bytes are uploaded to S3 BEFORE queuing; only the
  // resulting S3 key (short string) rides here. Raw image data MUST
  // NEVER be queued in this table — SecureStore on Android caps each
  // key at ~2KB and a base64 signature PNG alone exceeds that budget.
  // On replay, /delivery-proof is POSTed first, then /confirm-delivery.
  proofType?: 'signature' | 'photo' | 'otp';
  proofS3Key?: string;
  proofSigningPartyPhone?: string;
  proofCapturedLat?: number;
  proofCapturedLng?: number;
  timestamp: string;
  attemptCount: number;
};

type Listener = (queue: QueuedDelivery[]) => void;

const listeners = new Set<Listener>();

async function readQueue(): Promise<QueuedDelivery[]> {
  try {
    const raw = await SecureStore.getItemAsync(QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedDelivery[];
  } catch {
    return [];
  }
}

async function writeQueue(q: QueuedDelivery[]): Promise<void> {
  if (q.length === 0) {
    await SecureStore.deleteItemAsync(QUEUE_KEY);
  } else {
    await SecureStore.setItemAsync(QUEUE_KEY, JSON.stringify(q));
  }
  for (const l of listeners) l(q);
}

export async function getPendingDeliveries(): Promise<QueuedDelivery[]> {
  return readQueue();
}

export function subscribePendingDeliveries(l: Listener): () => void {
  listeners.add(l);
  readQueue().then(l).catch(() => {});
  return () => { listeners.delete(l); };
}

export async function enqueueDelivery(item: Omit<QueuedDelivery, 'timestamp' | 'attemptCount'>): Promise<void> {
  const q = await readQueue();
  // Replace any prior queued attempt for the same order — driver retries should
  // not pile up duplicate entries.
  const filtered = q.filter((d) => d.orderId !== item.orderId);
  filtered.push({ ...item, timestamp: new Date().toISOString(), attemptCount: 0 });
  await writeQueue(filtered);
}

/**
 * Distinguish a network/transport failure (worth queueing) from a 4xx the
 * server explicitly rejected (don't queue — it'll never succeed).
 */
export function isNetworkError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response) return false;
  return err.code === 'ECONNABORTED' || err.code === 'ERR_NETWORK' || !err.response;
}

/**
 * Try to flush every queued delivery. Called on app foreground and explicit
 * user retry. Idempotency on the server side guarantees that a duplicate
 * confirmation (same quantities) returns 200, not 500.
 */
export async function syncPendingDeliveries(): Promise<{ synced: number; remaining: number }> {
  const q = await readQueue();
  if (q.length === 0) return { synced: 0, remaining: 0 };

  let synced = 0;
  const remaining: QueuedDelivery[] = [];

  for (const item of q) {
    try {
      // Proof-of-collection Phase 1 (2026-07-15): if the queued item
      // carries proof metadata, POST /delivery-proof BEFORE
      // /confirm-delivery so the proof row exists by the time delivery
      // is confirmed. Upsert-by-orderId (server-side) means a duplicate
      // replay is idempotent — same proof metadata, same row.
      if (item.proofType && (item.proofS3Key || item.proofType === 'otp')) {
        await api.post(`/orders/${item.orderId}/delivery-proof`, {
          proofType: item.proofType,
          proofS3Key: item.proofS3Key,
          proofSigningPartyPhone: item.proofSigningPartyPhone,
          capturedLat: item.proofCapturedLat,
          capturedLng: item.proofCapturedLng,
        });
      }
      await api.post(`/orders/${item.orderId}/confirm-delivery`, {
        items: item.items,
        notes: item.notes,
        deliveryLatitude: item.deliveryLatitude,
        deliveryLongitude: item.deliveryLongitude,
      });
      synced += 1;
    } catch (err) {
      if (isNetworkError(err)) {
        // Still offline — keep in queue, bump attempt count
        remaining.push({ ...item, attemptCount: item.attemptCount + 1 });
      } else if (axios.isAxiosError(err) && err.response) {
        const status = err.response.status;
        if (status === 409) {
          // Server says delivery exists with different quantities. Drop from
          // queue — caller (UI) should be told via subscriber to surface this.
          continue;
        }
        if (status >= 400 && status < 500) {
          // 4xx — order cancelled, validation, etc. Won't ever succeed. Drop.
          continue;
        }
        // 5xx — keep and retry next sync
        remaining.push({ ...item, attemptCount: item.attemptCount + 1 });
      } else {
        remaining.push({ ...item, attemptCount: item.attemptCount + 1 });
      }
    }
  }

  await writeQueue(remaining);
  return { synced, remaining: remaining.length };
}

let appStateListener: { remove: () => void } | null = null;

/**
 * Attach an AppState listener that flushes the queue when the app comes to
 * the foreground. Idempotent — safe to call multiple times.
 */
export function attachAutoSync(): void {
  if (appStateListener) return;
  const handler = (state: AppStateStatus) => {
    if (state === 'active') {
      syncPendingDeliveries().catch(() => {});
    }
  };
  appStateListener = AppState.addEventListener('change', handler);
}

/**
 * Subscribe to network-connectivity changes — fires syncPendingDeliveries
 * the moment connectivity is restored. Returns an unsubscribe function so
 * callers (typically the driver layout) can detach on unmount.
 *
 * Tracks the previous connected state so we only sync on the false→true
 * transition, not on every state change.
 */
export function startNetworkListener(): () => void {
  let wasConnected: boolean | null = null;
  const unsub = NetInfo.addEventListener((state: NetInfoState) => {
    const isConnected = !!state.isConnected;
    if (wasConnected === false && isConnected) {
      syncPendingDeliveries().catch(() => {});
    }
    wasConnected = isConnected;
  });
  return unsub;
}
