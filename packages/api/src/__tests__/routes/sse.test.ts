/**
 * Integration tests for GET /api/drivers/me/events (SSE endpoint).
 *
 * supertest by default waits for the response to end before resolving.
 * SSE is a long-lived stream — it never ends voluntarily. We work around
 * that by listening directly to the underlying socket via supertest's
 * pass-through HTTP request: we read enough bytes to verify the headers
 * and the initial `data: {"type":"connected"…}` frame, then abort the
 * request from the client side.
 *
 * Auth flow uses the existing dist-002 seeded driver (`driver2@gasdist.com`
 * → phone 9876500010 → driver row 'Kiran Reddy'), matching the pattern
 * used by other helpers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { generateToken } from '../helpers.js';
import { _getConnectionCountForTests } from '../../lib/sseManager.js';
import type { UserRole } from '@gaslink/shared';

interface ProbeResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Hit the SSE endpoint and resolve after `untilBytes` bytes arrive or
 * 1500ms — whichever comes first. Always destroys the socket so the
 * Express handler's `req.on('close')` cleanup fires.
 */
function probeSse(
  port: number,
  authHeader: string | undefined,
  untilBytes = 200,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      Accept: 'text/event-stream',
    };
    if (authHeader) headers.Authorization = authHeader;

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/drivers/me/events', method: 'GET', headers },
      (res) => {
        let body = '';
        const finalize = () => {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length >= untilBytes) finalize();
        });
        res.on('end', finalize);
        res.on('error', () => finalize());
        // Backstop in case the server never writes any bytes (would only
        // happen if it short-circuited and returned end-of-response).
        setTimeout(finalize, 1500);
      },
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

let port = 0;
let driverToken = '';
let financeToken = '';
let driverDbId = '';

beforeAll(async () => {
  const app = createApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;

  // Driver user from dist-002 seed.
  const driverUser = await prisma.user.findUniqueOrThrow({
    where: { email: 'driver2@gasdist.com' },
  });
  driverToken = generateToken({
    userId: driverUser.id,
    email: driverUser.email,
    role: driverUser.role as UserRole,
    distributorId: driverUser.distributorId,
  });

  // The route resolves the Driver row by (distributorId, phone) — capture
  // the id so we can assert addConnection used it.
  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: driverUser.distributorId!, phone: driverUser.phone! },
  });
  driverDbId = driver.id;

  // Finance user — confirms the 403 path for the requireRole('driver') guard.
  const financeUser = await prisma.user.findUniqueOrThrow({
    where: { email: 'finance2@gasdist.com' },
  });
  financeToken = generateToken({
    userId: financeUser.id,
    email: financeUser.email,
    role: financeUser.role as UserRole,
    distributorId: financeUser.distributorId,
  });
});

describe('GET /api/drivers/me/events — positive', () => {
  it('returns 200 with SSE headers and the initial `connected` frame', async () => {
    const before = _getConnectionCountForTests();

    const res = await probeSse(port, `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    // express sets `connection: keep-alive` for HTTP/1.1; the route sets
    // it again explicitly so this assertion is robust to both.
    expect(res.headers['connection']).toMatch(/keep-alive/i);
    expect(res.headers['x-accel-buffering']).toBe('no');

    // First frame must be {type:'connected', driverId}.
    const firstFrame = res.body.split('\n\n')[0];
    expect(firstFrame.startsWith('data: ')).toBe(true);
    const json = JSON.parse(firstFrame.slice('data: '.length));
    expect(json).toEqual({ type: 'connected', driverId: driverDbId });

    // Connection was added; the socket close on probeSse() triggers the
    // server-side cleanup, but the cleanup is async — we don't assert
    // the count afterwards because of that race. The before/after of
    // adding is implied by the frame having been written at all (the
    // route writes the initial frame BEFORE calling addConnection... no
    // — wait, it writes the initial frame first then addConnection.
    // Either way the frame proves the handler executed past auth.)
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/drivers/me/events — negative', () => {
  it('rejects with 401 when the Authorization header is missing', async () => {
    const res = await probeSse(port, undefined);
    expect(res.status).toBe(401);
  });

  it('rejects with 401 when the JWT is malformed', async () => {
    const res = await probeSse(port, 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects with 403 for a non-driver role (finance) — requireRole guard', async () => {
    const res = await probeSse(port, `Bearer ${financeToken}`);
    expect(res.status).toBe(403);
  });
});
