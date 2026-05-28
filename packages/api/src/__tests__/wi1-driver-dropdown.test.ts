/**
 * WI-1.1 — Driver dropdown population guard.
 *
 * Root cause of the empty "Assign Driver" dropdown: the server returns all
 * active drivers correctly (see GET /api/drivers), but the AssignDriverModal
 * was filtering them out client-side when no driver had a confirmed
 * vehicle mapping for TODAY. The fix retains the server-side WI-079 guard
 * (server still requires a mapping at assign time) and changes the modal
 * to render all drivers, disabling rows that lack a today-mapping.
 *
 * This test asserts the foundational contract: the GET /api/drivers
 * endpoint returns at least one active driver for dist-002 — so the modal
 * can never be empty on a tenant with seeded drivers regardless of
 * whether vehicle mappings exist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';

const DIST = 'dist-002';

let app: Express;
beforeAll(() => {
  app = createApp();
});

describe('WI-1.1 — GET /api/drivers returns active drivers for dist-002', () => {
  it('returns at least one active driver and surfaces driverName', async () => {
    // Seed-independence guard: count active drivers in the DB. If none,
    // the test environment is unseeded; fail loudly rather than silently
    // green-passing on an empty roster.
    const activeCount = await prisma.driver.count({
      where: { distributorId: DIST, status: 'active', deletedAt: null },
    });
    expect(activeCount).toBeGreaterThan(0);

    // Use a real seeded distributor admin so resolveDistributor passes.
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role as UserRole,
      distributorId: user.distributorId,
    });
    const res = await request(app)
      .get('/api/drivers')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Distributor-Id', DIST);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const drivers = res.body.data?.drivers as Array<{ driverId: string; driverName: string; status: string }>;
    expect(Array.isArray(drivers)).toBe(true);
    expect(drivers.length).toBeGreaterThanOrEqual(1);
    // At least one row must be active (the modal renders the entire list;
    // status filtering is a separate concern).
    expect(drivers.some((d) => d.status === 'active')).toBe(true);
    // Each driver must have driverName populated so the dropdown label
    // never reads "undefined".
    for (const d of drivers) {
      expect(d.driverName).toBeTruthy();
    }
  });
});
