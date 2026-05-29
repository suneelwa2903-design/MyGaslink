/**
 * Unit tests for the in-memory SSE connection manager.
 *
 * No DB hit — these test the Map + write-to-response semantics in
 * isolation. Mocks the Express Response as a minimal shim: `write` is a
 * vi.fn so we can assert payload format byte-for-byte.
 *
 * Heartbeat behaviour is tested via vitest fake timers — we advance 25s
 * and assert all live connections received `: heartbeat\n\n`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Response } from 'express';
import {
  addConnection,
  removeConnection,
  notifyDriver,
  _getConnectionCountForTests,
} from '../../lib/sseManager.js';

/** Minimal Response shim — only the methods sseManager touches. */
function mockRes(): Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  const res = {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  } as unknown as Response & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  return res;
}

// Each test reuses the same module-level Map, so we clean up everything
// the test added. Tracking ids per-test is more robust than blanket
// teardown since other tests in this file may share state if parallelised.
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup.length = 0;
});

describe('sseManager — addConnection', () => {
  it('stores the connection so notifyDriver finds it', () => {
    const before = _getConnectionCountForTests();
    const res = mockRes();
    addConnection('driver-add-1', res);
    cleanup.push(() => removeConnection('driver-add-1', res));

    expect(_getConnectionCountForTests()).toBe(before + 1);
    notifyDriver('driver-add-1', { type: 'probe' });
    expect(res.write).toHaveBeenCalledWith('data: {"type":"probe"}\n\n');
  });
});

describe('sseManager — notifyDriver', () => {
  it('writes a properly framed SSE data event', () => {
    const res = mockRes();
    addConnection('driver-notify-1', res);
    cleanup.push(() => removeConnection('driver-notify-1', res));

    notifyDriver('driver-notify-1', {
      type: 'order_assigned',
      payload: { orderId: 'order-123' },
    });

    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith(
      'data: {"type":"order_assigned","payload":{"orderId":"order-123"}}\n\n',
    );
  });

  it('JSON-stringifies the full event object', () => {
    const res = mockRes();
    addConnection('driver-notify-2', res);
    cleanup.push(() => removeConnection('driver-notify-2', res));

    notifyDriver('driver-notify-2', {
      type: 'trip_updated',
      payload: { dvaId: 'dva-9', extra: 42 },
    });

    const writeArg = res.write.mock.calls[0][0] as string;
    expect(writeArg.startsWith('data: ')).toBe(true);
    expect(writeArg.endsWith('\n\n')).toBe(true);
    const json = writeArg.slice('data: '.length, -2);
    expect(JSON.parse(json)).toEqual({
      type: 'trip_updated',
      payload: { dvaId: 'dva-9', extra: 42 },
    });
  });

  it('silently ignores an unknown driverId — no throw, no side effect', () => {
    const before = _getConnectionCountForTests();
    expect(() =>
      notifyDriver('driver-does-not-exist', { type: 'order_assigned' }),
    ).not.toThrow();
    expect(_getConnectionCountForTests()).toBe(before);
  });

  it('drops the connection when res.write throws (broken socket)', () => {
    const res = mockRes();
    res.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    addConnection('driver-broken-1', res);
    const before = _getConnectionCountForTests();
    // Track cleanup just in case, though the broken-connection branch
    // removes it for us.
    cleanup.push(() => removeConnection('driver-broken-1', res));

    expect(() =>
      notifyDriver('driver-broken-1', { type: 'order_assigned' }),
    ).not.toThrow();

    expect(_getConnectionCountForTests()).toBe(before - 1);
    // A second notify should also no-throw and find nothing to write.
    res.write.mockClear();
    notifyDriver('driver-broken-1', { type: 'order_assigned' });
    expect(res.write).not.toHaveBeenCalled();
  });
});

describe('sseManager — removeConnection', () => {
  it('removes the driver from the map', () => {
    const res = mockRes();
    addConnection('driver-remove-1', res);
    const after = _getConnectionCountForTests();
    expect(after).toBeGreaterThan(0);

    removeConnection('driver-remove-1', res);
    expect(_getConnectionCountForTests()).toBe(after - 1);
    // A subsequent notify must not write to the stale response.
    res.write.mockClear();
    notifyDriver('driver-remove-1', { type: 'order_assigned' });
    expect(res.write).not.toHaveBeenCalled();
  });

  it('is a safe no-op when called for an unknown driverId', () => {
    const before = _getConnectionCountForTests();
    expect(() => removeConnection('driver-never-added')).not.toThrow();
    expect(_getConnectionCountForTests()).toBe(before);
  });

  it('does not evict a newer connection when called with a stale response', () => {
    // The route's `req.on('close')` handler may fire AFTER a fresh login
    // already replaced the connection. Guarded by the res-identity check.
    const oldRes = mockRes();
    const newRes = mockRes();
    addConnection('driver-evict-guard', oldRes);
    addConnection('driver-evict-guard', newRes); // replaces oldRes
    cleanup.push(() => removeConnection('driver-evict-guard', newRes));

    // The replace path calls end() on the old socket. Confirm that happened.
    expect(oldRes.end).toHaveBeenCalledTimes(1);

    // Now simulate the late close handler for oldRes — must NOT remove
    // the newRes that's now in the map.
    removeConnection('driver-evict-guard', oldRes);
    notifyDriver('driver-evict-guard', { type: 'order_assigned' });
    expect(newRes.write).toHaveBeenCalledTimes(1);
  });
});

describe('sseManager — replace connection on re-add', () => {
  it('replaces the old response with the new one; old socket gets end()', () => {
    const oldRes = mockRes();
    const newRes = mockRes();
    addConnection('driver-replace-1', oldRes);
    addConnection('driver-replace-1', newRes);
    cleanup.push(() => removeConnection('driver-replace-1', newRes));

    // The old socket is closed by addConnection().
    expect(oldRes.end).toHaveBeenCalledTimes(1);
    // Subsequent notifies hit ONLY the new response.
    notifyDriver('driver-replace-1', { type: 'order_assigned' });
    expect(oldRes.write).not.toHaveBeenCalled();
    expect(newRes.write).toHaveBeenCalledTimes(1);
  });
});

describe('sseManager — heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a comment heartbeat (`: heartbeat\\n\\n`) every 25 seconds', () => {
    const res = mockRes();
    addConnection('driver-heartbeat-1', res);
    cleanup.push(() => removeConnection('driver-heartbeat-1', res));

    // Just before the heartbeat fires — no writes yet.
    vi.advanceTimersByTime(24_000);
    expect(res.write).not.toHaveBeenCalled();

    // Just after — exactly one heartbeat.
    vi.advanceTimersByTime(2_000);
    expect(res.write).toHaveBeenCalledWith(': heartbeat\n\n');
  });
});
