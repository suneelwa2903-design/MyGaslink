/**
 * Pins the fix for the 2026-08-03 audit-log contamination: when a
 * super_admin POSTs a body carrying `distributorId` that differs from
 * their session's X-Distributor-Id header, the audit row must record
 * the BODY's distributor (the write's actual target), not the session's.
 *
 * The prior buggy behaviour recorded req.user.distributorId — which was
 * whatever the top-bar selector last landed on. It produced audit rows
 * like "Kruthee's admin generated a Vanasthali billing cycle" that
 * inverted the cross-tenant story in every trace.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { auditLog } from '../middleware/auditLog.js';
import { prisma } from '../lib/prisma.js';

const SUPER_ADMIN_ID = '00000000-0000-0000-0000-000000000901';

async function seedSuperAdmin(): Promise<void> {
  await prisma.user.upsert({
    where: { id: SUPER_ADMIN_ID },
    update: {},
    create: {
      id: SUPER_ADMIN_ID,
      email: `super-${SUPER_ADMIN_ID}@example.test`,
      firstName: 'Super',
      lastName: 'Test',
      passwordHash: 'x',
      role: 'super_admin',
      status: 'active',
    },
  });
}

async function seedDistributor(id: string): Promise<void> {
  await prisma.distributor.upsert({
    where: { id },
    update: {},
    create: {
      id,
      businessName: `Test ${id.slice(-4)}`,
      legalName: `Test ${id.slice(-4)}`,
      state: 'Telangana',
    },
  });
}

describe('auditLog middleware — cross-tenant write capture', () => {
  it('records TARGET distributorId (from body) when it differs from session', async () => {
    const sessionDist = 'dist-cross-tenant-session';
    const targetDist = 'dist-cross-tenant-target';
    await Promise.all([seedSuperAdmin(), seedDistributor(sessionDist), seedDistributor(targetDist)]);

    const app = express();
    app.use(express.json());
    app.post(
      '/test',
      (req, _res, next) => {
        req.user = { userId: SUPER_ADMIN_ID, distributorId: sessionDist, role: 'super_admin', email: 'x@y' } as never;
        next();
      },
      auditLog('generate', 'billing_cycle'),
      (_req, res) => res.status(201).json({ data: { id: 'entity-1' } }),
    );

    const before = await prisma.auditLog.count({ where: { userId: SUPER_ADMIN_ID, entityType: 'billing_cycle', distributorId: targetDist } });
    await request(app).post('/test').send({ distributorId: targetDist, periodType: 'monthly' }).expect(201);
    // The middleware writes asynchronously (fire-and-forget) — poll briefly.
    let after = before;
    for (let i = 0; i < 20; i++) {
      after = await prisma.auditLog.count({ where: { userId: SUPER_ADMIN_ID, entityType: 'billing_cycle', distributorId: targetDist } });
      if (after > before) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after).toBe(before + 1);

    // And zero new rows should land under the session tenant.
    const sessionRows = await prisma.auditLog.count({ where: { userId: SUPER_ADMIN_ID, entityType: 'billing_cycle', distributorId: sessionDist } });
    expect(sessionRows).toBe(0);

    await prisma.auditLog.deleteMany({ where: { userId: SUPER_ADMIN_ID } });
  });

  it('falls back to session distributorId when body omits it', async () => {
    const sessionDist = 'dist-single-tenant';
    await Promise.all([seedSuperAdmin(), seedDistributor(sessionDist)]);

    const app = express();
    app.use(express.json());
    app.post(
      '/test',
      (req, _res, next) => {
        req.user = { userId: SUPER_ADMIN_ID, distributorId: sessionDist, role: 'super_admin', email: 'x@y' } as never;
        next();
      },
      auditLog('mark_paid', 'billing_cycle'),
      (_req, res) => res.status(200).json({ data: { id: 'entity-2' } }),
    );

    const before = await prisma.auditLog.count({ where: { userId: SUPER_ADMIN_ID, entityType: 'billing_cycle', distributorId: sessionDist } });
    await request(app).post('/test').send({}).expect(200);
    let after = before;
    for (let i = 0; i < 20; i++) {
      after = await prisma.auditLog.count({ where: { userId: SUPER_ADMIN_ID, entityType: 'billing_cycle', distributorId: sessionDist } });
      if (after > before) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after).toBe(before + 1);

    await prisma.auditLog.deleteMany({ where: { userId: SUPER_ADMIN_ID } });
  });
});
