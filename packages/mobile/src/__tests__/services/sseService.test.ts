/**
 * Mobile SSE service unit tests.
 *
 * The service uses XHR (see services/sseService.ts header for the
 * rationale) — we replace the global XMLHttpRequest with a fake
 * controlled-from-the-test instance so we can drive the lifecycle
 * (open → onprogress → onerror → onload) deterministically and assert
 * subscriber dispatch + backoff math.
 *
 * AppState comes from react-native's `AppState.addEventListener` — we
 * mock that via jest.mock so the service registers against a spy and
 * we can assert it's called on connect/disconnect.
 */
// jest.mock is hoisted above imports; the factory cannot close over
// test-file locals — we read the spies back through requireMock below.
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

import { AppState } from 'react-native';
import { connect, disconnect, onEvent } from '../../services/sseService';

const addEventListenerMock = AppState.addEventListener as unknown as jest.Mock;

interface FakeXHR {
  // Captured invocations
  open: jest.Mock;
  setRequestHeader: jest.Mock;
  send: jest.Mock;
  abort: jest.Mock;

  // Callbacks set by sseService
  onprogress: (() => void) | null;
  onerror: (() => void) | null;
  onload: (() => void) | null;
  onabort: (() => void) | null;

  // The stream surface the service reads
  responseText: string;

  // Test-only helpers
  pushChunk: (text: string) => void;
  fireError: () => void;
  fireLoad: () => void;
}

let lastXhr: FakeXHR | null = null;
const xhrInstances: FakeXHR[] = [];

function makeXhr(): FakeXHR {
  const x: FakeXHR = {
    open: jest.fn(),
    setRequestHeader: jest.fn(),
    send: jest.fn(),
    abort: jest.fn(() => {
      x.onabort?.();
    }),
    onprogress: null,
    onerror: null,
    onload: null,
    onabort: null,
    responseText: '',
    pushChunk(text: string) {
      x.responseText += text;
      x.onprogress?.();
    },
    fireError() {
      x.onerror?.();
    },
    fireLoad() {
      x.onload?.();
    },
  };
  return x;
}

beforeEach(() => {
  jest.useFakeTimers();
  addEventListenerMock.mockClear();
  xhrInstances.length = 0;
  lastXhr = null;
  // Install a global XMLHttpRequest factory that records every constructed
  // instance — sseService's reconnect path creates a fresh XHR each time.
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest =
    function MockXHR() {
      const x = makeXhr();
      xhrInstances.push(x);
      lastXhr = x;
      return x;
    } as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  // Always disconnect so module-level state doesn't leak between tests.
  disconnect();
  jest.useRealTimers();
});

describe('connect()', () => {
  it('opens GET /api/drivers/me/events with bearer token', () => {
    connect('test-token-abc');
    expect(lastXhr).toBeTruthy();
    expect(lastXhr!.open).toHaveBeenCalledWith(
      'GET',
      expect.stringMatching(/\/drivers\/me\/events$/),
      true,
    );
    expect(lastXhr!.setRequestHeader).toHaveBeenCalledWith(
      'Authorization',
      'Bearer test-token-abc',
    );
    expect(lastXhr!.setRequestHeader).toHaveBeenCalledWith(
      'Accept',
      'text/event-stream',
    );
    expect(lastXhr!.send).toHaveBeenCalledTimes(1);
  });

  it('attaches an AppState change listener so background/active toggles connect state', () => {
    connect('token-1');
    expect(addEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('onEvent() — frame parsing', () => {
  it('dispatches a parsed event object to the subscriber on a complete data frame', () => {
    const cb = jest.fn();
    onEvent(cb);
    connect('token-evt');
    lastXhr!.pushChunk('data: {"type":"order_assigned","payload":{"orderId":"o1"}}\n\n');

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({
      type: 'order_assigned',
      payload: { orderId: 'o1' },
    });
  });

  it('ignores comment lines (`: heartbeat`) — subscribers receive nothing', () => {
    const cb = jest.fn();
    onEvent(cb);
    connect('token-hb');
    lastXhr!.pushChunk(': heartbeat\n\n');
    expect(cb).not.toHaveBeenCalled();
  });

  it('fans out the same event to multiple subscribers', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    onEvent(cb1);
    onEvent(cb2);
    connect('token-multi');
    lastXhr!.pushChunk('data: {"type":"trip_updated"}\n\n');
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe returned by onEvent removes only that subscriber', () => {
    const keep = jest.fn();
    const drop = jest.fn();
    onEvent(keep);
    const unsub = onEvent(drop);
    unsub();

    connect('token-unsub');
    lastXhr!.pushChunk('data: {"type":"order_updated"}\n\n');
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
  });

  it('skips malformed frames silently (no throw, no dispatch)', () => {
    const cb = jest.fn();
    onEvent(cb);
    connect('token-bad');
    // Malformed JSON in a data: line — should not throw.
    expect(() => {
      lastXhr!.pushChunk('data: {not-json}\n\n');
    }).not.toThrow();
    // Frame with no `data:` prefix — should also not throw and not dispatch.
    expect(() => {
      lastXhr!.pushChunk('badprefix: anything\n\n');
    }).not.toThrow();
    expect(cb).not.toHaveBeenCalled();

    // Subsequent valid frame still dispatches — proves the parser
    // recovered position and didn't get stuck on the bad frames.
    lastXhr!.pushChunk('data: {"type":"order_assigned"}\n\n');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('disconnect()', () => {
  it('aborts the XHR', () => {
    connect('token-dc');
    const xhr = lastXhr!;
    disconnect();
    expect(xhr.abort).toHaveBeenCalled();
  });
});

describe('reconnection backoff', () => {
  it('schedules a reconnect after the initial 1s backoff when the stream errors', () => {
    connect('token-r1');
    expect(xhrInstances.length).toBe(1);
    lastXhr!.fireError();
    // No new XHR yet — backoff is pending.
    expect(xhrInstances.length).toBe(1);

    jest.advanceTimersByTime(999);
    expect(xhrInstances.length).toBe(1);

    jest.advanceTimersByTime(2);
    expect(xhrInstances.length).toBe(2);
  });

  it('doubles the backoff on repeated failures up to a 30 s cap', () => {
    connect('token-bk');
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    let xhrIdx = 0;
    expect(xhrInstances.length).toBe(1);

    for (const delay of expectedDelays) {
      xhrInstances[xhrIdx].fireError();
      jest.advanceTimersByTime(delay - 1);
      expect(xhrInstances.length).toBe(xhrIdx + 1);
      jest.advanceTimersByTime(2);
      xhrIdx += 1;
      expect(xhrInstances.length).toBe(xhrIdx + 1);
    }
  });

  it('resets the backoff to 1 s after a successful `connected` handshake', () => {
    connect('token-reset');
    // Burn the first backoff up to 4s.
    lastXhr!.fireError();
    jest.advanceTimersByTime(1_001); // reconnects after 1s
    xhrInstances[1].fireError();
    jest.advanceTimersByTime(2_001); // reconnects after 2s
    expect(xhrInstances.length).toBe(3);

    // Server sends the handshake — this is what resets the backoff.
    xhrInstances[2].pushChunk(
      'data: {"type":"connected","driverId":"d1"}\n\n',
    );

    // A subsequent error should now wait 1s again (not 4s).
    xhrInstances[2].fireError();
    jest.advanceTimersByTime(999);
    expect(xhrInstances.length).toBe(3);
    jest.advanceTimersByTime(2);
    expect(xhrInstances.length).toBe(4);
  });

  it('explicit disconnect() stops the reconnect loop — no new XHR after errors', () => {
    connect('token-stop');
    disconnect();
    expect(xhrInstances.length).toBe(1);
    // After disconnect, the XHR may not fire onerror at all, but if it
    // does (race), the reconnect must not schedule.
    lastXhr!.fireError();
    jest.advanceTimersByTime(60_000); // far beyond any backoff cap
    expect(xhrInstances.length).toBe(1);
  });
});

/**
 * Helper: invoke the AppState handler the service registered on connect.
 * Reads from the mock's call record so we don't have to plumb a stored
 * reference through the service itself.
 */
function fireAppState(state: 'active' | 'background' | 'inactive'): void {
  const calls = addEventListenerMock.mock.calls;
  if (calls.length === 0) {
    throw new Error('No AppState listener registered yet — call connect() first');
  }
  // Most recent registration's handler is the live one (disconnect removes
  // the prior subscription and connect re-adds; we want the active one).
  const handler = calls[calls.length - 1][1] as (s: string) => void;
  handler(state);
}

describe('AppState lifecycle', () => {
  it('background → SSE disconnects (XHR abort called, no new XHR opened until foreground)', () => {
    connect('token-bg-1');
    expect(xhrInstances.length).toBe(1);
    const original = lastXhr!;

    fireAppState('background');

    // The service called abort on the live XHR.
    expect(original.abort).toHaveBeenCalled();
    // No new XHR was opened — the service stays disconnected until
    // AppState flips back to 'active'. (closeStream also clears any
    // pending reconnect timer; we assert that explicitly in the
    // "background while a backoff retry is queued" test below.)
    expect(xhrInstances.length).toBe(1);
  });

  it('background → active reopens a new XHR via open()', () => {
    connect('token-cycle-1');
    expect(xhrInstances.length).toBe(1);

    fireAppState('background');
    expect(xhrInstances.length).toBe(1); // no new XHR while backgrounded

    fireAppState('active');
    expect(xhrInstances.length).toBe(2); // fresh XHR opened on resume
    expect(xhrInstances[1].open).toHaveBeenCalledWith(
      'GET',
      expect.stringMatching(/\/drivers\/me\/events$/),
      true,
    );
  });

  it('background → active reconnect carries the SAME auth token as the original connect', () => {
    connect('token-reauth-1');
    const firstAuth = xhrInstances[0].setRequestHeader.mock.calls.find(
      (c) => c[0] === 'Authorization',
    );
    expect(firstAuth?.[1]).toBe('Bearer token-reauth-1');

    fireAppState('background');
    fireAppState('active');

    const secondAuth = xhrInstances[1].setRequestHeader.mock.calls.find(
      (c) => c[0] === 'Authorization',
    );
    expect(secondAuth?.[1]).toBe('Bearer token-reauth-1');
  });

  it('full cycle: connect → background → active → still delivers events to subscribers', () => {
    const cb = jest.fn();
    onEvent(cb);
    connect('token-full-1');

    fireAppState('background');
    fireAppState('active');
    expect(xhrInstances.length).toBe(2);

    // The fresh XHR pushes data — subscribers must still receive it.
    xhrInstances[1].pushChunk(
      'data: {"type":"order_assigned","payload":{"orderId":"o-after-cycle"}}\n\n',
    );
    expect(cb).toHaveBeenCalledWith({
      type: 'order_assigned',
      payload: { orderId: 'o-after-cycle' },
    });
  });

  it('background while a backoff retry is queued cancels the retry — no reconnect until foreground', () => {
    connect('token-bg-backoff');
    expect(xhrInstances.length).toBe(1);
    // Trigger an error to arm the 1s backoff timer.
    lastXhr!.fireError();

    // Go to background BEFORE the backoff fires. closeStream clears the
    // pending reconnect timer; reconnect must not fire while backgrounded.
    fireAppState('background');
    jest.advanceTimersByTime(60_000);
    expect(xhrInstances.length).toBe(1);

    // Returning to foreground reopens — proving the reconnect was canceled
    // (not just delayed past the timer).
    fireAppState('active');
    expect(xhrInstances.length).toBe(2);
  });

  it('background → active after explicit disconnect() does NOT reconnect', () => {
    connect('token-explicit');
    expect(xhrInstances.length).toBe(1);
    // Capture the AppState handler BEFORE disconnect — disconnect removes
    // the listener, so calls[<i>][1] would be stale. We test the contract
    // that even if the OS happens to deliver a state change to a stale
    // handler reference, the service must not open a new XHR.
    const staleHandler = addEventListenerMock.mock.calls[
      addEventListenerMock.mock.calls.length - 1
    ][1] as (s: string) => void;

    disconnect();
    expect(xhrInstances.length).toBe(1);

    // Invoke the (now-stale) handler — service should be inert because
    // token is null and explicitDisconnect is true.
    staleHandler('background');
    staleHandler('active');
    expect(xhrInstances.length).toBe(1);
  });
});
