/**
 * Server-Sent Events connection manager for driver real-time updates.
 *
 * Why SSE here: the driver app previously polled GET /orders and
 * GET /drivers/me/trip-ewbs every 30s regardless of activity. At fleet
 * scale that's two DB hits per driver per 30s with no payload change
 * 99% of the time. SSE pushes a tiny signal ("order_assigned",
 * "order_updated", "trip_updated") and the client refetches on demand.
 *
 * Why not WebSockets: SSE is one-way (server→client), which is exactly
 * what we need, and works over plain HTTP/1.1 through nginx/CloudFront
 * without WebSocket-upgrade config. The client lib is `fetch` — no
 * dependency.
 *
 * Why not Redis pub/sub: single API process today. If we ever scale to
 * multiple Node processes, the in-memory Map needs to become a pub/sub
 * (Redis Streams or NATS) so notifyDriver on box A reaches a connection
 * on box B. Flagged in PENDING_ITEMS.md ("Auth Middleware DB Caching"
 * is the bigger blocker for going multi-process anyway).
 *
 * Connection lifecycle:
 *   - addConnection on GET /api/drivers/me/events
 *   - removeConnection on req 'close' or 'error'
 *   - heartbeat every 25s prevents nginx idle-timeout (default 60s) and
 *     CloudFront idle (60s) from closing the connection
 *
 * The driver map is keyed by driverId, not userId — drivers identify
 * by phone + distributorId (see resolveDriverFromUser in
 * routes/driversVehicles.ts). A driver who logs in on two devices keeps
 * the latest connection; the previous one's res.write() will throw and
 * the request 'close' handler will clean it up.
 */
import type { Response } from 'express';
import { logger } from '../utils/logger.js';

interface SSEEvent {
  type: string;
  payload?: Record<string, unknown>;
}

const connections = new Map<string, Response>();
const HEARTBEAT_MS = 25_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const [driverId, res] of connections) {
      try {
        // Comment lines (`: ...`) are ignored by EventSource but keep the
        // socket warm. We send these instead of empty `data:` so the client
        // parser doesn't dispatch a no-op event.
        res.write(': heartbeat\n\n');
      } catch (err) {
        logger.warn('SSE heartbeat write failed — dropping connection', {
          driverId,
          err: (err as Error).message,
        });
        connections.delete(driverId);
      }
    }
  }, HEARTBEAT_MS);
  // node-cron isn't involved; we use plain setInterval. Don't keep the
  // event loop alive just for the heartbeat — process shutdown should
  // close cleanly even if a connection is open.
  heartbeatTimer.unref?.();
}

function stopHeartbeatIfIdle(): void {
  if (connections.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function addConnection(driverId: string, res: Response): void {
  // Replace any prior connection for this driver. Two-device sign-in is a
  // legitimate case (e.g. driver checks the manager's tablet); the older
  // socket will quietly fail its next heartbeat and get cleaned up there.
  const prior = connections.get(driverId);
  if (prior && prior !== res) {
    try {
      prior.end();
    } catch {
      // Ignore — the prior socket may already be gone.
    }
  }
  connections.set(driverId, res);
  startHeartbeat();
  logger.info('SSE connection opened', { driverId, total: connections.size });
}

export function removeConnection(driverId: string, res?: Response): void {
  // Only remove if the stored connection is the one being closed —
  // otherwise we might evict a newer connection that already replaced us.
  const stored = connections.get(driverId);
  if (!stored) return;
  if (res && stored !== res) return;
  connections.delete(driverId);
  stopHeartbeatIfIdle();
  logger.info('SSE connection closed', { driverId, total: connections.size });
}

export function notifyDriver(driverId: string, event: SSEEvent): void {
  const res = connections.get(driverId);
  if (!res) return; // Driver not connected — silently ignore.
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (err) {
    logger.warn('SSE notifyDriver write failed — dropping connection', {
      driverId,
      eventType: event.type,
      err: (err as Error).message,
    });
    connections.delete(driverId);
    stopHeartbeatIfIdle();
  }
}

/** Test-only helper. Not exported through index files. */
export function _getConnectionCountForTests(): number {
  return connections.size;
}
