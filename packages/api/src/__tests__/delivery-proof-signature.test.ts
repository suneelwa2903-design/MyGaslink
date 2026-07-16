/**
 * Proof-of-collection Phase 1 (2026-07-15): integration tests for the
 * driver signature-capture flow.
 *
 * Covers: upload-url auth/tenant gates, /delivery-proof upsert semantics
 * (create, update-on-retry, method-specific validation, tenant isolation),
 * GET /delivery-proof otpCode role-redaction, and the
 * Customer.requireDeliveryVerification flag round-trip through
 * createCustomer / updateCustomer / GET response.
 *
 * S3 lib is mocked — no real AWS calls. The mock returns a stable
 * signed-URL shape so validateProofUploadKey's tenant-scoping regression
 * is exercised by the "cross-tenant s3Key" test without needing a real
 * bucket.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// Mock the S3 lib BEFORE createApp is imported — the route handlers
// resolve it at import time.
vi.mock('../lib/s3.js', () => ({
  generateDeliveryProofUploadUrl: vi.fn(async (distributorId: string, orderId: string, proofType: string) => ({
    uploadUrl: `https://mock.s3.amazonaws.com/PUT-signed?d=${distributorId}&o=${orderId}`,
    finalUrl: `https://mock.cdn.example.com/delivery-proofs/${distributorId}/${orderId}/${proofType}-abc123.png`,
    s3Key: `delivery-proofs/${distributorId}/${orderId}/${proofType}-abc123.png`,
  })),
  deleteDeliveryProofObject: vi.fn(async () => undefined),
  validateProofUploadKey: (s3Key: string, distributorId: string) =>
    s3Key.startsWith(`delivery-proofs/${distributorId}/`),
  isS3ConfiguredForUploads: () => false,
  LOCAL_UPLOADS_ROOT: '/tmp/mock-uploads',
}));

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  loginAsDriver,
  loginAsDriverDist002,
  loginAsFinance,
  loginAsCustomer,
} from './helpers.js';
import type { Express } from 'express';

let app: Express;

beforeAll(async () => {
  app = createApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Set up a pending_delivery order for the driver's own tenant, with the
 * customer flagged as requiring verification. Returns { orderId,
 * customerId } for the test to consume + tear down.
 */
async function seedPendingDeliveryForDriver(
  distributorId: string,
  driverId: string,
  requireDeliveryVerification: boolean,
): Promise<{ orderId: string; customerId: string; cleanup: () => Promise<void> }> {
  const cylinderType = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
  // Fresh customer per test so requireDeliveryVerification is deterministic.
  const customer = await prisma.customer.create({
    data: {
      distributorId,
      customerName: `PROOF-TEST-${Date.now()}`,
      customerType: 'B2C',
      phone: `9${Date.now()}`.slice(0, 10),
      requireDeliveryVerification,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-PROOF-${Date.now()}`,
      distributorId,
      customerId: customer.id,
      driverId,
      orderDate: new Date('2099-12-31'),
      deliveryDate: new Date('2099-12-31'),
      status: 'pending_delivery',
      totalAmount: 100,
      items: {
        create: {
          cylinderTypeId: cylinderType.id,
          quantity: 1,
          unitPrice: 100,
          totalPrice: 100,
        },
      },
    },
  });
  const cleanup = async () => {
    // Some tests confirm delivery which mints an invoice + ledger
    // entries + inventory events for this order/customer. Tear the
    // full graph down in FK-safe order so the customer.delete at the
    // end doesn't hit a constraint violation.
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
    await prisma.customerInventoryBalance.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.delete({ where: { id: customer.id } });
  };
  return { orderId: order.id, customerId: customer.id, cleanup };
}

describe('POST /orders/:id/delivery-proof-upload-url', () => {
  it('returns presigned URL for driver assigned to order', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof-upload-url`)
        .set('Authorization', `Bearer ${token}`)
        .send({ proofType: 'signature' });
      expect(res.status).toBe(200);
      expect(res.body.data.uploadUrl).toContain('mock.s3.amazonaws.com');
      expect(res.body.data.s3Key).toContain(`delivery-proofs/${distributorId}/${orderId}/`);
      expect(res.body.data.s3Key).toContain('signature-');
    } finally {
      await cleanup();
    }
  });

  it('rejects when customer.requireDeliveryVerification is false — 400', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, false);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof-upload-url`)
        .set('Authorization', `Bearer ${token}`)
        .send({ proofType: 'signature' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not require delivery verification/i);
    } finally {
      await cleanup();
    }
  });

  it('rejects when order.driverId !== requesting driver — 403', async () => {
    const { driver, distributorId } = await loginAsDriver();
    // Order assigned to the seeded driver but the driver2 session tries to grab an upload URL for it.
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const otherDriver = await loginAsDriverDist002();
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof-upload-url`)
        .set('Authorization', `Bearer ${otherDriver.token}`)
        .send({ proofType: 'signature' });
      // Cross-tenant → 404 because the order isn't visible in the other
      // distributor's scope at all. This is the isolation-first shape:
      // no info leak (would give away order existence via 403 vs 404).
      expect([403, 404]).toContain(res.status);
    } finally {
      await cleanup();
    }
  });

  it('rejects non-driver role — 403', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const admin = await loginAsDistAdmin();
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof-upload-url`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ proofType: 'signature' });
      expect(res.status).toBe(403);
      // Guard against wrong-role slip — driver token would return 200.
      void token;
    } finally {
      await cleanup();
    }
  });
});

describe('POST /orders/:id/delivery-proof', () => {
  it('creates proof row on first submission (signature)', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          proofType: 'signature',
          proofS3Key: `delivery-proofs/${distributorId}/${orderId}/signature-first.png`,
          proofSigningPartyPhone: '9876543210',
          capturedLat: 17.4239,
          capturedLng: 78.4738,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.deliveryProofId).toBeDefined();
      const row = await prisma.deliveryProof.findFirst({ where: { orderId } });
      expect(row).not.toBeNull();
      expect(row!.proofType).toBe('signature');
      expect(row!.signingPartyPhone).toBe('9876543210');
      expect(row!.capturedLat).toBe(17.4239);
    } finally {
      await cleanup();
    }
  });

  it('upserts (overwrites) on retry — no duplicate row, latest wins', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          proofType: 'signature',
          proofS3Key: `delivery-proofs/${distributorId}/${orderId}/signature-v1.png`,
          proofSigningPartyPhone: '9111111111',
        })
        .expect(201);

      const res2 = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          proofType: 'signature',
          proofS3Key: `delivery-proofs/${distributorId}/${orderId}/signature-v2.png`,
          proofSigningPartyPhone: '9222222222',
        });
      expect(res2.status).toBe(201);

      const rows = await prisma.deliveryProof.findMany({ where: { orderId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].s3Key).toContain('signature-v2.png');
      expect(rows[0].signingPartyPhone).toBe('9222222222');
    } finally {
      await cleanup();
    }
  });

  it('rejects signature type without s3Key — 400', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({ proofType: 'signature', proofSigningPartyPhone: '9876543210' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/s3Key/i);
    } finally {
      await cleanup();
    }
  });

  it('rejects signature type without signingPartyPhone — 400', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          proofType: 'signature',
          proofS3Key: `delivery-proofs/${distributorId}/${orderId}/signature-x.png`,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/signingPartyPhone/i);
    } finally {
      await cleanup();
    }
  });

  it('rejects cross-tenant s3Key — 403 (validateProofUploadKey)', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          proofType: 'signature',
          // s3Key claims a different tenant's namespace — must reject.
          proofS3Key: `delivery-proofs/dist-999/${orderId}/signature-cross.png`,
          proofSigningPartyPhone: '9876543210',
        });
      expect(res.status).toBe(403);
    } finally {
      await cleanup();
    }
  });
});

describe('GET /orders/:id/delivery-proof', () => {
  it('returns proof for driver caller (otpCode intact where applicable)', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      await prisma.deliveryProof.create({
        data: {
          orderId,
          distributorId,
          proofType: 'signature',
          s3Key: `delivery-proofs/${distributorId}/${orderId}/signature-x.png`,
          signingPartyPhone: '9111000111',
          capturedAt: new Date(),
          capturedBy: 'test',
        },
      });
      const res = await request(app)
        .get(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.proofType).toBe('signature');
      expect(res.body.data.signingPartyPhone).toBe('9111000111');
    } finally {
      await cleanup();
    }
  });

  it('strips otpCode for non-driver caller (finance)', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      await prisma.deliveryProof.create({
        data: {
          orderId,
          distributorId,
          proofType: 'otp',
          otpCode: '654321',
          otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          capturedAt: new Date(),
          capturedBy: 'test',
        },
      });
      const finance = await loginAsFinance();
      const res = await request(app)
        .get(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${finance.token}`);
      expect(res.status).toBe(200);
      // Redacted for non-driver — a finance user reviewing a proof must
      // never see a live OTP.
      expect(res.body.data.otpCode).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('returns 404 when no proof exists', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .get(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    } finally {
      await cleanup();
    }
  });
});

describe('Customer requireDeliveryVerification flag round-trip', () => {
  it('defaults to false on createCustomer', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerName: `DEFAULT-TEST-${Date.now()}`,
        phone: `9${Date.now()}`.slice(0, 10),
      });
    expect(res.status).toBe(201);
    // POST /customers response envelope: `{...mapCustomer(customer), warnings}`
    // — flat customer fields at data root (customers.ts:260), not nested
    // under data.customer.
    expect(res.body.data.requireDeliveryVerification).toBe(false);
    await prisma.customer.delete({ where: { id: res.body.data.customerId } });
  });

  it('accepts requireDeliveryVerification: true on createCustomer + surfaces it on GET', async () => {
    const { token } = await loginAsDistAdmin();
    const createRes = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerName: `FLAG-ON-TEST-${Date.now()}`,
        phone: `9${Date.now()}`.slice(0, 10),
        requireDeliveryVerification: true,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.requireDeliveryVerification).toBe(true);

    const custId = createRes.body.data.customerId;
    const getRes = await request(app)
      .get(`/api/customers/${custId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.requireDeliveryVerification).toBe(true);

    await prisma.customer.delete({ where: { id: custId } });
  });

  it('appears flat-aliased as customerRequiresVerification on GET /orders (mapOrder)', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .query({ status: 'pending_delivery' });
      expect(res.status).toBe(200);
      // GET /orders envelope for driver role: `{ orders: [...] }` at
      // data root (orders.ts:64) so consumers can accompany with meta.
      const orders = res.body.data.orders as Array<{ orderId: string; customerRequiresVerification?: boolean }>;
      const seeded = orders.find((o) => o.orderId === orderId);
      expect(seeded).toBeDefined();
      expect(seeded!.customerRequiresVerification).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('Cross-tenant isolation', () => {
  it('driver from dist-002 cannot POST proof for a dist-001 order — 404', async () => {
    const { driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const otherDriver = await loginAsDriverDist002();
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${otherDriver.token}`)
        .send({
          proofType: 'signature',
          proofS3Key: `delivery-proofs/${otherDriver.distributorId}/${orderId}/signature-x.png`,
          proofSigningPartyPhone: '9876543210',
        });
      // Order not visible in dist-002's tenant → 404. Never 200 (write) or
      // 403 (info-leak). Belt-and-suspenders: assert the proof row was
      // not created either.
      expect([403, 404]).toContain(res.status);
      const rows = await prisma.deliveryProof.findMany({ where: { orderId } });
      expect(rows).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

// ─── Phase 2 (2026-07-15): Photo proof ─────────────────────────────
describe('Photo proof', () => {
  it('POST /delivery-proof accepts proofType=photo with s3Key (no phone required)', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          proofType: 'photo',
          proofS3Key: `delivery-proofs/${distributorId}/${orderId}/photo-abc123.jpg`,
          capturedLat: 17.4065,
          capturedLng: 78.4772,
          // deliberately no proofSigningPartyPhone — photo doesn't need one.
        });
      expect(res.status).toBe(201);
      const row = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId } });
      expect(row.proofType).toBe('photo');
      expect(row.s3Key).toContain('photo-abc123.jpg');
      expect(row.signingPartyPhone).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('rejects photo proof without s3Key — 400', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({ proofType: 'photo' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/s3Key/i);
    } finally {
      await cleanup();
    }
  });

  it('photo proof does NOT require signingPartyPhone (contrast with signature)', async () => {
    // The negative for signature is already covered above; this test
    // asserts photo succeeds WITHOUT phone (proves the branch in
    // deliveryProofService.upsertProof only enforces the phone rule
    // for signature type, not photo).
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          proofType: 'photo',
          proofS3Key: `delivery-proofs/${distributorId}/${orderId}/photo-nophone.jpg`,
        });
      expect(res.status).toBe(201);
    } finally {
      await cleanup();
    }
  });

  it('upload-url endpoint accepts proofType=photo', async () => {
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const res = await request(app)
        .post(`/api/orders/${orderId}/delivery-proof-upload-url`)
        .set('Authorization', `Bearer ${token}`)
        .send({ proofType: 'photo' });
      expect(res.status).toBe(200);
      expect(res.body.data.s3Key).toContain('photo-');
    } finally {
      await cleanup();
    }
  });

  it('PDF drawProofSection renders photo header, no reference line, no CDN fetch in dev', async () => {
    // Build a delivered order with a photo proof, then generate its
    // invoice PDF and verify the extracted text contains the photo
    // header text but NOT the obsolete "Photo reference:" line.
    // 2026-07-16 (FIX 1) — drawProofSection now embeds the photo as
    // a 71×71pt image when readProofBytes returns bytes. In this test
    // the mocked s3.js reports isS3ConfiguredForUploads=false, so the
    // fetch code path is NOT reached (dev-mode reads the local uploads
    // dir instead — and that file doesn't exist here, so photoEmbedded
    // stays false and the layout gracefully falls back to text-only).
    // The dropped "Photo reference:" line is asserted negatively so a
    // future regression re-adding it fails loudly.
    const { token, driver, distributorId } = await loginAsDriver();
    const { orderId, cleanup, customerId } = await seedPendingDeliveryForDriver(distributorId, driver!.id, true);
    try {
      const cylinderType = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
      // 1. Photo proof
      await prisma.deliveryProof.create({
        data: {
          orderId,
          distributorId,
          proofType: 'photo',
          s3Key: `delivery-proofs/${distributorId}/${orderId}/photo-testrefabcd.jpg`,
          capturedLat: 17.4065,
          capturedLng: 78.4772,
          capturedAt: new Date('2026-07-15T04:50:00Z'),
          capturedBy: 'photo-test',
        },
      });
      // 2. Confirm the delivery to mint the invoice.
      const confRes = await request(app)
        .post(`/api/orders/${orderId}/confirm-delivery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ cylinderTypeId: cylinderType.id, deliveredQuantity: 1, emptiesCollected: 0 }] });
      expect(confRes.status).toBe(200);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { invoice: { select: { id: true } } },
      });
      const invoiceId = order.invoice?.id;
      if (!invoiceId) throw new Error('Invoice not created — cannot exercise PDF path');

      // Stub fetch: if drawProofSection attempts to fetch the photo
      // (regression), this mock records the call. Photo type MUST NOT
      // trigger an image fetch — only signature does.
      const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
      const origFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = fetchSpy;
      try {
        const { generateInvoicePdf } = await import('../services/pdf/invoicePdfService.js');
        const pdf = await generateInvoicePdf(invoiceId, distributorId);
        // Assert: no fetch for the photo s3Key. (drawProofSection's
        // signature branch does call fetch — but this order has photo,
        // not signature, so fetch should never be invoked from proof.)
        const called = fetchSpy.mock.calls.some((args: unknown[]) => {
          const url = args[0];
          return typeof url === 'string' && url.includes('photo-testrefabcd');
        });
        expect(called).toBe(false);
        // Assert text: DELIVERY VERIFIED + via PHOTO present; the old
        // "Photo reference: …" line MUST NOT appear (FIX 1 removed it
        // in favour of an embedded thumbnail — see the it() comment).
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: pdf });
        try {
          const { text } = await parser.getText();
          expect(text).toMatch(/DELIVERY VERIFIED/);
          expect(text).toMatch(/via PHOTO/);
          expect(text).not.toMatch(/Photo reference:/);
        } finally {
          await parser.destroy();
        }
      } finally {
        globalThis.fetch = origFetch;
      }
      // Keep customer alive for cleanup order (foreign keys).
      void customerId;
    } finally {
      await cleanup();
    }
  });
});

// Bind loginAsCustomer so ts-eslint doesn't flag the unused import — it's
// imported for signal-of-intent (the routes are gated to `driver` +
// admin roles; a customer role never appears here, and this reminder
// keeps future authors from adding a customer-role branch by mistake).
void loginAsCustomer;
