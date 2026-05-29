/**
 * Driver SSE client — replaces 30s refetchInterval polling in
 * (driver)/orders.tsx and (driver)/trip.tsx with a server-pushed signal.
 *
 * Why XHR and not fetch+ReadableStream:
 *   React Native's fetch (whatwg-fetch polyfill, even in RN 0.81) returns
 *   the FULL body when the request resolves — there is no
 *   `response.body.getReader()` you can pull from progressively. The only
 *   way to read partial response data without adding a native module is
 *   XMLHttpRequest with `xhr.responseText` watched on `onprogress`.
 *   The cumulative text grows as bytes arrive; we slice from the last
 *   parsed offset to handle each new chunk.
 *
 * Why no native EventSource:
 *   React Native does not ship EventSource. `react-native-sse` is a
 *   community lib that works but adds a dep + native linking on iOS.
 *   The XHR approach has zero deps and works identically in dev / EAS
 *   production builds.
 *
 * Lifecycle:
 *   - connect(token) — opens the GET /api/drivers/me/events stream
 *   - onEvent(cb) — subscribe; returns unsubscribe fn
 *   - disconnect() — explicit close; stops reconnect loop
 *   - AppState 'background' triggers disconnect, 'active' triggers reconnect
 *     (wired in (driver)/_layout.tsx so it only runs while the driver is
 *     in the driver tab stack)
 *
 * Reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s cap. Reset on successful
 * 'connected' event. Stops when the caller invokes disconnect().
 */
import { AppState, type AppStateStatus } from 'react-native';

export interface SSEEvent {
  type: string;
  payload?: Record<string, unknown>;
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:5000/api';
const SSE_URL = `${API_BASE}/drivers/me/events`;
const MAX_BACKOFF_MS = 30_000;

type EventCallback = (event: SSEEvent) => void;

let xhr: XMLHttpRequest | null = null;
let token: string | null = null;
const subscribers: Set<EventCallback> = new Set();
let parseOffset = 0;
let backoffMs = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let explicitDisconnect = false;
let appStateSubscription: { remove: () => void } | null = null;

function dispatch(event: SSEEvent): void {
  for (const cb of subscribers) {
    try {
      cb(event);
    } catch {
      // Swallow subscriber errors so one bad listener can't kill the others.
    }
  }
}

/**
 * Parse newly arrived SSE text starting at `parseOffset`. SSE frames are
 * separated by a blank line (\n\n). Each frame is a sequence of lines;
 * lines beginning with `data:` carry the JSON payload, lines beginning
 * with `:` are comments (heartbeats — we ignore them).
 */
function consume(text: string): void {
  // Process complete frames; leave any partial frame in the buffer.
  let next = parseOffset;
  while (true) {
    const sep = text.indexOf('\n\n', next);
    if (sep === -1) break;
    const frame = text.slice(next, sep);
    next = sep + 2;

    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      // `event:` and `id:` ignored — we only use the default 'message' event
      // and the data line. Comments (`:`) and any other prefix are skipped.
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    try {
      const parsed = JSON.parse(data) as SSEEvent;
      if (parsed && typeof parsed.type === 'string') {
        if (parsed.type === 'connected') {
          // Successful handshake — reset backoff so subsequent drops start fresh.
          backoffMs = 1_000;
        }
        dispatch(parsed);
      }
    } catch {
      // Malformed JSON — log via dispatch? No, just drop. A broken frame
      // shouldn't stop the stream.
    }
  }
  parseOffset = next;
}

function scheduleReconnect(): void {
  if (explicitDisconnect) return;
  if (reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!explicitDisconnect && token) openStream();
  }, delay);
}

function openStream(): void {
  if (!token) return;
  if (xhr) return;
  parseOffset = 0;

  const req = new XMLHttpRequest();
  xhr = req;
  req.open('GET', SSE_URL, true);
  req.setRequestHeader('Authorization', `Bearer ${token}`);
  req.setRequestHeader('Accept', 'text/event-stream');
  req.setRequestHeader('Cache-Control', 'no-cache');

  req.onprogress = () => {
    // responseText accumulates; consume() handles the offset.
    if (typeof req.responseText === 'string') {
      consume(req.responseText);
    }
  };

  req.onerror = () => {
    if (xhr === req) xhr = null;
    if (!explicitDisconnect) scheduleReconnect();
  };

  req.onload = () => {
    // Server closed the stream cleanly (e.g. process restart). Treat as
    // a disconnect and reconnect.
    if (xhr === req) xhr = null;
    if (!explicitDisconnect) scheduleReconnect();
  };

  req.onabort = () => {
    if (xhr === req) xhr = null;
  };

  req.send();
}

function closeStream(): void {
  if (xhr) {
    try {
      xhr.abort();
    } catch {
      // Ignore — already torn down.
    }
    xhr = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function handleAppStateChange(state: AppStateStatus): void {
  if (state === 'active') {
    if (!xhr && token && !explicitDisconnect) {
      backoffMs = 1_000;
      openStream();
    }
  } else if (state === 'background') {
    closeStream();
  }
}

/**
 * Open the SSE connection. Idempotent — safe to call multiple times with
 * the same token. Pass a new token to rotate. Attaches an AppState
 * listener on first call.
 */
export function connect(authToken: string): void {
  if (token === authToken && xhr) return; // Already connected with same token.
  token = authToken;
  explicitDisconnect = false;
  backoffMs = 1_000;
  closeStream();
  if (!appStateSubscription) {
    appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
  }
  openStream();
}

/**
 * Explicit teardown (e.g. on logout). Stops the reconnect loop and
 * removes the AppState listener. After disconnect, subscribers stay
 * registered so a subsequent connect() resumes delivery without
 * re-subscribing — useful when a fresh login follows a logout.
 */
export function disconnect(): void {
  explicitDisconnect = true;
  token = null;
  closeStream();
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}

/**
 * Subscribe to driver events. Returns an unsubscribe function.
 * Safe to call before or after connect().
 */
export function onEvent(callback: EventCallback): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}
