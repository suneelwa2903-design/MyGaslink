/**
 * Proof-of-collection Phase 1 (2026-07-15): DeliveryProof service.
 *
 * Per-order proof-of-delivery capture for customers with
 * `requireDeliveryVerification=true`. One row per order (@unique orderId,
 * upsert-by-orderId — latest proof wins on driver retry). Decoupled from
 * confirm-delivery: mobile client uploads the S3 object, then POSTs to
 * /delivery-proof BEFORE calling /confirm-delivery. This decoupling is
 * the plan §R1 mitigation — proof idempotency is independent of the
 * highest-blast-radius mutation's own idempotency branch.
 *
 * Tenant isolation: every read/write below is keyed on `distributorId`
 * sourced from the caller's authenticated session — never trusted from
 * the request body. Follows the paymentSubmissionService.ts convention
 * (10+ WHERE clauses all with distributorId) per anti-pattern #13.
 */
import * as crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import type { DeliveryProof } from '@prisma/client';
import { logger } from '../utils/logger.js';
import {
  generateDeliveryProofUploadUrl,
  saveSignatureVectorJson,
  deleteDeliveryProofObject,
  validateProofUploadKey,
  type PresignedUploadUrl,
  type DeliveryProofUploadType,
} from '../lib/s3.js';

export class DeliveryProofError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'DeliveryProofError';
  }
}

/**
 * Issue a presigned S3 PUT URL for a signature (Phase 1) or photo
 * (Phase 2) upload. Validates that (a) the order exists in this tenant,
 * (b) the caller is the driver assigned to that order, (c) the order is
 * in `pending_delivery` status (proof only makes sense pre-confirm),
 * (d) the customer actually requires verification. Throws 400/403/404
 * with structured status codes for the route layer to translate.
 *
 * OTP proofs do NOT use this — they have no S3 artifact — hence the
 * `DeliveryProofUploadType` union excludes 'otp'.
 */
export async function getUploadUrl(
  distributorId: string,
  orderId: string,
  proofType: DeliveryProofUploadType,
  requestingDriverId: string,
  hostHint?: string,
): Promise<PresignedUploadUrl> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    select: {
      id: true,
      status: true,
      driverId: true,
      customer: { select: { requireDeliveryVerification: true } },
    },
  });
  if (!order) {
    throw new DeliveryProofError('Order not found', 404);
  }
  if (order.driverId !== requestingDriverId) {
    throw new DeliveryProofError('You are not the driver assigned to this order', 403);
  }
  if (order.status !== 'pending_delivery') {
    throw new DeliveryProofError(
      `Order status is ${order.status} — proof upload only allowed while pending_delivery`,
      400,
    );
  }
  if (!order.customer?.requireDeliveryVerification) {
    throw new DeliveryProofError(
      'This customer does not require delivery verification',
      400,
    );
  }
  return generateDeliveryProofUploadUrl(distributorId, orderId, proofType, hostHint);
}

/**
 * Path C (2026-07-16) — persist a signature captured as a stroke-point
 * list rather than a PNG. Same auth gates as getUploadUrl above. Writes
 * the JSON to the delivery-proofs namespace and returns the s3Key so the
 * caller can then POST to /delivery-proof to upsert the proof row.
 */
export async function submitSignatureVector(
  distributorId: string,
  orderId: string,
  requestingDriverId: string,
  payload: { points: Array<Array<[number, number]>>; w: number; h: number },
  hostHint?: string,
): Promise<PresignedUploadUrl> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    select: {
      id: true,
      status: true,
      driverId: true,
      customer: { select: { requireDeliveryVerification: true } },
    },
  });
  if (!order) throw new DeliveryProofError('Order not found', 404);
  if (order.driverId !== requestingDriverId) {
    throw new DeliveryProofError('You are not the driver assigned to this order', 403);
  }
  if (order.status !== 'pending_delivery') {
    throw new DeliveryProofError(
      `Order status is ${order.status} — signature only allowed while pending_delivery`,
      400,
    );
  }
  if (!order.customer?.requireDeliveryVerification) {
    throw new DeliveryProofError('This customer does not require delivery verification', 400);
  }
  // Bound the payload — a legitimate signature is at most ~10 strokes with
  // ~200 points each. Reject anything larger to keep a single request
  // from filling the uploads dir.
  if (!Array.isArray(payload.points) || payload.points.length === 0 || payload.points.length > 40) {
    throw new DeliveryProofError('Invalid signature payload: point group count out of range', 400);
  }
  const totalPoints = payload.points.reduce((n, g) => n + (Array.isArray(g) ? g.length : 0), 0);
  if (totalPoints === 0 || totalPoints > 8000) {
    throw new DeliveryProofError('Invalid signature payload: total point count out of range', 400);
  }
  if (!(payload.w > 0 && payload.h > 0)) {
    throw new DeliveryProofError('Invalid signature payload: non-positive canvas dimensions', 400);
  }
  return saveSignatureVectorJson(distributorId, orderId, JSON.stringify(payload), hostHint);
}

export interface UpsertProofInput {
  proofType: 'signature' | 'photo' | 'otp';
  s3Key?: string;
  signingPartyPhone?: string;
  otpCode?: string;
  capturedLat?: number;
  capturedLng?: number;
  capturedBy: string;
}

/**
 * Upsert a delivery proof for an order. Latest-write-wins semantics via
 * @unique(orderId) — driver retries with a different method (network
 * drop scenario) succeed, overwriting the prior row's method + payload.
 *
 * Method-specific required fields enforced here (Zod covers wire shape;
 * this covers cross-field business rules the wire schema can't):
 *   signature: s3Key + signingPartyPhone (both mandatory)
 *   photo:     s3Key (mandatory)
 *   otp:       otpCode (mandatory — Phase 3)
 *
 * Any submitted s3Key is validated against the tenant's namespace via
 * `validateProofUploadKey` — prevents claiming an S3 object from
 * another tenant's prefix.
 */
export async function upsertProof(
  distributorId: string,
  orderId: string,
  data: UpsertProofInput,
): Promise<DeliveryProof> {
  // Validate order + tenant (anti-pattern #13 — BOTH clauses required).
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!order) {
    throw new DeliveryProofError('Order not found', 404);
  }

  // Method-specific business validation.
  if (data.proofType === 'signature') {
    if (!data.s3Key) {
      throw new DeliveryProofError('signature proof requires s3Key', 400);
    }
    if (!data.signingPartyPhone) {
      throw new DeliveryProofError('signature proof requires signingPartyPhone', 400);
    }
  } else if (data.proofType === 'photo') {
    if (!data.s3Key) {
      throw new DeliveryProofError('photo proof requires s3Key', 400);
    }
  } else if (data.proofType === 'otp') {
    if (!data.otpCode) {
      throw new DeliveryProofError('otp proof requires otpCode', 400);
    }
  }

  // Tenant-scope the s3Key claim.
  if (data.s3Key && !validateProofUploadKey(data.s3Key, distributorId)) {
    throw new DeliveryProofError(
      's3Key does not belong to this distributor',
      403,
    );
  }

  const capturedAt = new Date();

  return prisma.deliveryProof.upsert({
    where: { orderId },
    update: {
      proofType: data.proofType,
      s3Key: data.s3Key ?? null,
      signingPartyPhone: data.signingPartyPhone ?? null,
      otpCode: data.otpCode ?? null,
      capturedLat: data.capturedLat ?? null,
      capturedLng: data.capturedLng ?? null,
      capturedAt,
      capturedBy: data.capturedBy,
      // Reset OTP verification on any upsert — a fresh proof means a
      // fresh OTP verification cycle (Phase 3).
      otpVerifiedAt: null,
      otpExpiresAt: null,
    },
    create: {
      orderId,
      distributorId,
      proofType: data.proofType,
      s3Key: data.s3Key ?? null,
      signingPartyPhone: data.signingPartyPhone ?? null,
      otpCode: data.otpCode ?? null,
      capturedLat: data.capturedLat ?? null,
      capturedLng: data.capturedLng ?? null,
      capturedAt,
      capturedBy: data.capturedBy,
    },
  });
}

/**
 * Fetch the proof for an order — tenant-scoped read. Returns null when
 * no proof exists. Callers strip `otpCode` before returning to non-
 * driver roles (route-layer concern, not the service's).
 */
export async function getProof(
  distributorId: string,
  orderId: string,
): Promise<DeliveryProof | null> {
  return prisma.deliveryProof.findFirst({
    where: { orderId, distributorId },
  });
}

/**
 * Proof-of-collection Phase 3 (2026-07-15): auto-generate (or refresh
 * on driver-triggered resend) the OTP for an order.
 *
 * Fires whenever an order transitions to `pending_delivery` for a
 * customer whose `requireDeliveryVerification` is true. Also called by
 * the driver's `/delivery-otp/resend` endpoint. The generated code is
 * plaintext (per plan §1.3.3 — customer portal must display it, hash
 * would be unreversible), lives for the life of the order (no expiry
 * per locked design), and is naturally invalidated when the order
 * moves out of `pending_delivery` (mapper stops surfacing it).
 *
 * Idempotent: safe to call multiple times per order — upserts by
 * orderId. Fire-and-forget from the caller's perspective; caller
 * catches to prevent OTP failure from blocking the order transition.
 *
 * Returns the 6-digit code. Nothing about "portal login exists" is
 * checked here — the OTP is generated regardless so a future
 * SMS/WhatsApp channel can pick it up. The driver's UI reads a
 * separate `customerHasPortalAccess` flag to decide whether the
 * customer will actually see the code.
 */
export async function generateOrRefreshOtp(
  distributorId: string,
  orderId: string,
  triggeredBy: 'auto' | 'driver_resend',
): Promise<string | null> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    select: {
      id: true,
      customer: { select: { requireDeliveryVerification: true } },
    },
  });
  if (!order) {
    // Order deleted / cross-tenant / not found — no-op. Caller may be
    // a fire-and-forget hook, so log at debug and return null.
    logger.debug('generateOrRefreshOtp: order not found', { orderId, distributorId });
    return null;
  }
  if (!order.customer?.requireDeliveryVerification) {
    // Verification not required for this customer — no OTP needed.
    return null;
  }

  // Cryptographically random 6-digit code (same shape as
  // authService.generateOtp). No expiry — valid for the life of the
  // order per locked design.
  const otp = String(crypto.randomInt(100000, 999999));

  const capturedAt = new Date();

  await prisma.deliveryProof.upsert({
    where: { orderId },
    update: {
      otpCode: otp,
      // Do NOT reset proofType or otpVerifiedAt here — the driver may
      // already have captured a signature/photo before requesting an
      // OTP refresh. proofType only changes when the driver actually
      // completes verification via /delivery-otp/verify or via a
      // signature/photo submission through /delivery-proof.
    },
    create: {
      orderId,
      distributorId,
      // Provisional proofType — will be overwritten when the driver
      // actually submits a proof. Chosen 'otp' rather than a nullable
      // enum because the schema doesn't allow null here.
      proofType: 'otp',
      otpCode: otp,
      capturedAt,
      capturedBy: `system:${triggeredBy}`,
    },
  });

  logger.debug('OTP generated', { orderId, distributorId, triggeredBy });
  return otp;
}

/**
 * DPDP account-anonymization: for every DeliveryProof row belonging to
 * a given customer within this tenant, delete the S3 object then null-
 * out PII fields on the row. Preserves the audit trail ("delivery was
 * verified via method X at time Y") without any customer PII. Called
 * by the account-deletion worker (see docs/IOS-ACCOUNT-DELETION-SPEC.md
 * row 50).
 *
 * Best-effort S3 deletion — errors are swallowed inside
 * `deleteDeliveryProofObject` and logged, never blocking DB anonymization.
 */
export async function deleteProofForDpdp(
  distributorId: string,
  customerId: string,
): Promise<void> {
  // Find every proof for this customer's orders in this tenant.
  const proofs = await prisma.deliveryProof.findMany({
    where: {
      distributorId,
      order: { customerId },
    },
    select: { id: true, s3Key: true },
  });

  // Best-effort S3 delete for each.
  await Promise.all(
    proofs
      .filter((p): p is { id: string; s3Key: string } => p.s3Key !== null)
      .map((p) => deleteDeliveryProofObject(p.s3Key)),
  );

  // Anonymize the rows themselves — preserve the audit trail (id,
  // orderId, distributorId, proofType, capturedAt, otpVerifiedAt) but
  // strip every PII field.
  await prisma.deliveryProof.updateMany({
    where: {
      distributorId,
      order: { customerId },
    },
    data: {
      s3Key: null,
      signingPartyPhone: null,
      capturedLat: null,
      capturedLng: null,
      capturedBy: 'ANONYMIZED',
      otpCode: null,
    },
  });
}
