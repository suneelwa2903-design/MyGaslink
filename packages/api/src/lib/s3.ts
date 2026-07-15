/**
 * Proof-of-collection Phase 1 (2026-07-15): S3 upload infrastructure.
 *
 * Restored from git history (deleted in 6abbb23 alongside receipt-photo
 * upload). Original file backed payment-attachment uploads for the
 * WI-PENDING-PAYMENTS feature. Restore + rename to focus on delivery-
 * proof artifacts (signature PNGs Phase 1, photo JPGs Phase 2).
 *
 * Presigned PUT URL strategy: the API never proxies the upload bytes
 * itself. Instead it issues a short-lived presigned PUT URL that the
 * client (driver phone) PUTs the file to directly. Saves API CPU/
 * bandwidth and keeps `multer`/`sharp` off the hot path.
 *
 * Tenant isolation: the S3 key always embeds `distributorId` taken from
 * the authenticated session, never from a request body. CloudFront read
 * access is keyed on the same path prefix in the bucket policy.
 * `validateProofUploadKey` (below) enforces the same convention when a
 * client POSTs an s3Key back to the /delivery-proof endpoint.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Lazy singleton — defer client construction until first use so dev
// environments without AWS configured can still boot.
let _s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (!_s3Client) {
    _s3Client = new S3Client({ region: config.aws.region });
  }
  return _s3Client;
}

export interface PresignedUploadUrl {
  /** Short-lived (5 min) PUT URL — client uploads bytes directly. */
  uploadUrl: string;
  /** Public CloudFront URL — safe to persist / display. */
  finalUrl: string;
  /** Bare S3 key — persist this on `delivery_proofs.s3_key` for later
   * deletion (DPDP account-anonymization) or CloudFront URL rebuild. */
  s3Key: string;
}

export type DeliveryProofUploadType = 'signature' | 'photo';

/**
 * Generate a presigned PUT URL for a delivery-proof upload.
 *
 * The S3 key embeds `distributorId` so a leaked credential cannot upload
 * across tenants. Content-Type is constrained to `image/png` (signature)
 * or `image/jpeg` (photo — Phase 2). 5-minute expiry.
 *
 * @param distributorId MUST come from the authenticated JWT, never from
 *   the request body. Tenant-isolation guarantee.
 * @param orderId       Order the proof is for. Included in the S3 key
 *   both for routability (deleteProofForDpdp cascades neatly) and to
 *   make bucket audits legible.
 * @param proofType     'signature' → .png, 'photo' → .jpg. OTP has no
 *   S3 artifact so is not a valid input here (enforced by the
 *   `DeliveryProofUploadType` union).
 */
export async function generateDeliveryProofUploadUrl(
  distributorId: string,
  orderId: string,
  proofType: DeliveryProofUploadType,
): Promise<PresignedUploadUrl> {
  if (!config.aws.s3Bucket) {
    throw new Error('S3 bucket not configured — set AWS_S3_BUCKET');
  }
  if (!config.aws.cloudFrontUrl) {
    throw new Error('CloudFront URL not configured — set AWS_CLOUDFRONT_URL');
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(distributorId)) {
    // Belt-and-suspenders: distributorId is verified by resolveDistributor
    // upstream, but a route-level mistake that passes an unverified value
    // here would put attacker-controlled characters into the S3 key.
    throw new Error('Invalid distributorId for S3 key generation');
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) {
    throw new Error('Invalid orderId for S3 key generation');
  }

  const ext = proofType === 'signature' ? 'png' : 'jpg';
  const contentType = proofType === 'signature' ? 'image/png' : 'image/jpeg';
  const uuid = randomUUID();
  const s3Key = `delivery-proofs/${distributorId}/${orderId}/${proofType}-${uuid}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: config.aws.s3Bucket,
    Key: s3Key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: 300 });
  const cdnRoot = config.aws.cloudFrontUrl.replace(/\/+$/, '');
  const finalUrl = `${cdnRoot}/${s3Key}`;

  return { uploadUrl, finalUrl, s3Key };
}

/**
 * Delete a previously-uploaded delivery-proof S3 object. Called by the
 * DPDP account-deletion worker (see docs/IOS-ACCOUNT-DELETION-SPEC.md
 * row 50) when anonymizing a customer's delivery proofs.
 *
 * Best-effort: swallows errors so a single object-delete failure does
 * NOT block the broader account-anonymization transaction. Logs at warn
 * level for visibility.
 */
export async function deleteDeliveryProofObject(s3Key: string): Promise<void> {
  if (!config.aws.s3Bucket) {
    logger.warn('deleteDeliveryProofObject: S3 not configured — skipping', { s3Key });
    return;
  }
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: s3Key }),
    );
  } catch (err) {
    logger.warn('deleteDeliveryProofObject failed — S3 object may still exist', {
      s3Key,
      err: (err as Error).message,
    });
    // Do not throw — DPDP anonymization must proceed even if S3 lags.
  }
}

/**
 * Validate that a client-submitted `s3Key` belongs to the authenticated
 * distributor's delivery-proof namespace. Used by the /delivery-proof
 * upsert route to prevent a driver from claiming an S3 object uploaded
 * under another tenant's path.
 *
 * Returns true only if the key starts with `delivery-proofs/{distId}/`
 * — anything else (payment-attachments, other tenants, arbitrary
 * prefixes) is rejected.
 */
export function validateProofUploadKey(s3Key: string, distributorId: string): boolean {
  if (!s3Key || typeof s3Key !== 'string') return false;
  const expectedPrefix = `delivery-proofs/${distributorId}/`;
  return s3Key.startsWith(expectedPrefix);
}
