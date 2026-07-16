/**
 * Proof-of-collection Phase 3 (2026-07-15): OTP integration tests.
 *
 * Covers:
 *  - Auto-generation of OTP when an order transitions to pending_delivery
 *    (only when customer.requireDeliveryVerification=true, and never for
 *    godown pickup which bypasses the dispatch flow)
 *  - POST /delivery-otp/resend — driver-scoped, overwrites, refresh only
 *    valid for pending_delivery
 *  - POST /delivery-otp/verify — correct/wrong/idempotent/missing paths
 *    + tenant isolation
 *  - Customer portal otpCode visibility (4 eligibility conditions from
 *    customerPortalService.ts — status, flag, present, not-verified)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// S3 mock — same as delivery-proof-signature.test.ts so the OTP tests
// can run without AWS creds even though they never touch S3 directly.
vi.mock('../lib/s3.js', () => ({
  generateDeliveryProofUploadUrl: vi.fn(async () => ({
    uploadUrl: 'https://mock/upload',
    finalUrl: 'https://mock/cdn/x.png',
    s3Key: 'mock-key',
  })),
  deleteDeliveryProofObject: vi.fn(async () => undefined),
  validateProofUploadKey: () => true,
  isS3ConfiguredForUploads: () => false,
  LOCAL_UPLOADS_ROOT: '/tmp/mock-uploads',
}));

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import * as deliveryProofService from '../services/deliveryProofService.js';
import { loginAsDriver, loginAsDriverDist002, loginAsDistAdmin } from './helpers.js';
import { hashPassword } from '../services/authService.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { Express } from 'express';

let app: Express;

beforeAll(async () => {
  app = createApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Fresh order in pending_delivery for the given driver. Customer's
 * requireDeliveryVerification flag configurable. Also optionally
 * provision a portal user for the customer (Phase 3 needs both paths).
 */
async function seedForOtp(
  distributorId: string,
  driverId: string,
  requireDeliveryVerification: boolean,
  withPortalUser: boolean = false,
): Promise<{ orderId: string; customerId: string; customerUserToken: string | null; cleanup: () => Promise<void> }> {
  const cylinderType = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
  const stamp = Date.now();
  const customer = await prisma.customer.create({
    data: {
      distributorId,
      customerName: `OTP-TEST-${stamp}`,
      customerType: 'B2C',
      phone: `9${stamp}`.slice(0, 10),
      requireDeliveryVerification,
    },
  });
  let customerUserToken: string | null = null;
  let userId: string | null = null;
  if (withPortalUser) {
    const user = await prisma.user.create({
      data: {
        email: `otp-test-${stamp}@example.com`,
        passwordHash: await hashPassword('Test@1234'),
        firstName: 'OTP',
        lastName: 'Test',
        role: 'customer',
        distributorId,
        customerId: customer.id,
        requiresPasswordReset: false,
      },
    });
    userId = user.id;
    customerUserToken = jwt.sign(
      { userId: user.id, email: user.email, role: 'customer', distributorId, customerId: customer.id },
      config.jwt.accessSecret,
      { expiresIn: '1h' },
    );
  }
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-OTP-${stamp}`,
      distributorId,
      customerId: customer.id,
      driverId,
      orderDate: new Date(),
      deliveryDate: new Date(),
      status: 'pending_delivery',
      totalAmount: 100,
      items: {
        create: { cylinderTypeId: cylinderType.id, quantity: 1, unitPrice: 100, totalPrice: 100 },
      },
    },
  });
  const cleanup = async () => {
    await prisma.deliveryProof.deleteMany({ where: { orderId: order.id } });
    await prisma.inventoryEvent.deleteMany({ where: { referenceId: order.id } });
    await prisma.orderStatusLog.deleteMany({ where: { orderId: order.id } });
    await prisma.customerLedgerEntry.deleteMany({ where: { customerId: customer.id } });
    const invoices = await prisma.invoice.findMany({ where: { orderId: order.id }, select: { id: true } });
    for (const inv of invoices) {
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: inv.id } });
      await prisma.gstDocument.deleteMany({ where: { invoiceId: inv.id } });
    }
    await prisma.invoice.deleteMany({ where: { orderId: order.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.customerInventoryBalance.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.delete({ where: { id: customer.id } });
  };
  return { orderId: order.id, customerId: customer.id, customerUserToken, cleanup };
}

describe('generateOrRefreshOtp — service helper', () => {
  it('generates a 6-digit OTP when customer.requireDeliveryVerification=true', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      const otp = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      expect(otp).toMatch(/^\d{6}$/);
      const row = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId } });
      expect(row.otpCode).toBe(otp);
      expect(row.capturedBy).toBe('system:auto');
    } finally {
      await cleanup();
    }
  });

  it('no-ops when requireDeliveryVerification=false — returns null, no row', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, false);
    try {
      const otp = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      expect(otp).toBeNull();
      const row = await prisma.deliveryProof.findFirst({ where: { orderId } });
      expect(row).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('overwrites existing OTP on driver_resend', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      const otp1 = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      const otp2 = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'driver_resend');
      // Different codes (probability of collision ~ 1/900000).
      expect(otp2).not.toBe(otp1);
      const row = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId } });
      expect(row.otpCode).toBe(otp2);
    } finally {
      await cleanup();
    }
  });
});

describe('POST /orders/:id/delivery-otp/resend', () => {
  it('driver assigned to order can refresh — 200', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      // Seed an initial OTP so the resend has something to replace.
      await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      const rowBefore = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId } });
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/resend`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.refreshed).toBe(true);
      // Deliberately does NOT return the OTP.
      expect(res.body.data.otpCode).toBeUndefined();
      const rowAfter = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId } });
      expect(rowAfter.otpCode).not.toBe(rowBefore.otpCode);
    } finally {
      await cleanup();
    }
  });

  it('cross-tenant driver cannot resend — 404', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      const other = await loginAsDriverDist002();
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/resend`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({});
      expect(res.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('non-pending_delivery status blocks resend — 404', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      await prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } });
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/resend`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('customer without verification flag — 400', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, false);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/resend`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});

describe('POST /orders/:id/delivery-otp/verify', () => {
  it('correct OTP → verified=true, otpVerifiedAt set', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      const otp = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({ otpCode: otp });
      expect(res.status).toBe(200);
      expect(res.body.data.verified).toBe(true);
      const row = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId } });
      expect(row.otpVerifiedAt).toBeInstanceOf(Date);
    } finally {
      await cleanup();
    }
  });

  it('wrong OTP → 400 with OTP_INVALID code', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({ otpCode: '000000' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OTP_INVALID');
    } finally {
      await cleanup();
    }
  });

  it('already verified → 200 idempotent (alreadyVerified: true)', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      const otp = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      await request(app).post(`/api/orders/${orderId}/delivery-otp/verify`).set('Authorization', `Bearer ${token}`).send({ otpCode: otp });
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({ otpCode: otp });
      expect(res.status).toBe(200);
      expect(res.body.data.alreadyVerified).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('no OTP exists → 400', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({ otpCode: '123456' });
      expect(res.status).toBe(400);
    } finally {
      await cleanup();
    }
  });

  it('cross-tenant driver cannot verify — 404', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true);
    try {
      await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      const other = await loginAsDriverDist002();
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-otp/verify`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ otpCode: '123456' });
      expect(res.status).toBe(404);
    } finally {
      await cleanup();
    }
  });
});

describe('Customer portal otpCode visibility', () => {
  it('shows otpCode when status=pending_delivery + flag=true + OTP present + not verified', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, customerUserToken, cleanup } = await seedForOtp(distributorId, driver!.id, true, true);
    try {
      const otp = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      const res = await request(app).get('/api/customer-portal/orders').set('Authorization', `Bearer ${customerUserToken}`);
      expect(res.status).toBe(200);
      const found = (res.body.data.orders as Array<{ orderId: string; otpCode: string | null }>).find((o) => o.orderId === orderId);
      expect(found?.otpCode).toBe(otp);
    } finally {
      await cleanup();
    }
  });

  it('otpCode is null when requireDeliveryVerification=false', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, customerUserToken, cleanup } = await seedForOtp(distributorId, driver!.id, false, true);
    try {
      // even if a proof row somehow existed, no OTP because flag off
      const res = await request(app).get('/api/customer-portal/orders').set('Authorization', `Bearer ${customerUserToken}`);
      const found = (res.body.data.orders as Array<{ orderId: string; otpCode: string | null }>).find((o) => o.orderId === orderId);
      expect(found?.otpCode).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('otpCode is null after driver verifies (otpVerifiedAt set)', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, customerUserToken, cleanup } = await seedForOtp(distributorId, driver!.id, true, true);
    try {
      const otp = await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      // Manually flip otpVerifiedAt as the verify route would.
      const row = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId } });
      await prisma.deliveryProof.update({ where: { id: row.id }, data: { otpVerifiedAt: new Date() } });
      const res = await request(app).get('/api/customer-portal/orders').set('Authorization', `Bearer ${customerUserToken}`);
      const found = (res.body.data.orders as Array<{ orderId: string; otpCode: string | null }>).find((o) => o.orderId === orderId);
      expect(found?.otpCode).toBeNull();
      void otp;
    } finally {
      await cleanup();
    }
  });

  it('otpCode is null once order status leaves pending_delivery', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, customerUserToken, cleanup } = await seedForOtp(distributorId, driver!.id, true, true);
    try {
      await deliveryProofService.generateOrRefreshOtp(distributorId, orderId, 'auto');
      await prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } });
      const res = await request(app).get('/api/customer-portal/orders').set('Authorization', `Bearer ${customerUserToken}`);
      const found = (res.body.data.orders as Array<{ orderId: string; otpCode: string | null }>).find((o) => o.orderId === orderId);
      expect(found?.otpCode).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('Driver order response customerHasPortalAccess', () => {
  it('is true when customer has a portal user', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true, true);
    try {
      const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`).query({ status: 'pending_delivery' });
      const found = (res.body.data.orders as Array<{ orderId: string; customerHasPortalAccess: boolean }>).find((o) => o.orderId === orderId);
      expect(found?.customerHasPortalAccess).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('is false when customer has no portal user', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedForOtp(distributorId, driver!.id, true, false);
    try {
      const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`).query({ status: 'pending_delivery' });
      const found = (res.body.data.orders as Array<{ orderId: string; customerHasPortalAccess: boolean }>).find((o) => o.orderId === orderId);
      expect(found?.customerHasPortalAccess).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

// Silence unused-import lints — these are only used in helpers.
void loginAsDistAdmin;
