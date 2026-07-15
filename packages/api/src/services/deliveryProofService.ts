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
import { prisma } from '../lib/prisma.js';
import type { DeliveryProof } from '@prisma/client';
import {
  generateDeliveryProofUploadUrl,
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
  return generateDeliveryProofUploadUrl(distributorId, orderId, proofType);
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
