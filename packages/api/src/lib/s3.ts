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
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Dev fallback root — when AWS_S3_BUCKET is empty we treat this on-disk
 * directory as an S3 substitute. Files land under
 *   packages/api/uploads/<s3Key>
 * and the API static-serves /uploads from the same root, so a persisted
 * finalUrl like `http://<lan-ip>:5000/uploads/delivery-proofs/…` renders
 * in-app just like a CloudFront URL would in prod.
 */
export const LOCAL_UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

/** True when we should route uploads to the local-disk fallback. */
export function isS3ConfiguredForUploads(): boolean {
  return !!config.aws.s3Bucket && !!config.aws.cloudFrontUrl;
}

/**
 * Build the base URL the client should use to reach the API for local
 * dev uploads. The route layer supplies `hostHint` from req.get('host')
 * so the URL is the exact LAN IP:port the phone already used to hit us
 * (e.g. 192.168.1.3:5000). Falls back to localhost only when no hint
 * was passed (unit tests, background jobs).
 */
function localBaseUrl(hostHint?: string): string {
  const port = process.env.PORT || '5000';
  const host = hostHint || process.env.LOCAL_UPLOAD_HOST || `localhost:${port}`;
  return `http://${host}`;
}

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
  hostHint?: string,
): Promise<PresignedUploadUrl> {
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

  if (!isS3ConfiguredForUploads()) {
    // Dev fallback: hand the client a URL that PUTs bytes to the API's
    // local /api/dev-uploads endpoint. finalUrl is a static-served route
    // on the same API so the persisted URL renders in-app just like a
    // CloudFront URL would in prod.
    const base = localBaseUrl(hostHint);
    const uploadUrl = `${base}/api/dev-uploads/${s3Key}?ct=${encodeURIComponent(contentType)}`;
    const finalUrl = `${base}/uploads/${s3Key}`;
    logger.info('S3 not configured — using local dev-upload fallback', {
      s3Key,
      uploadUrl,
      finalUrl,
    });
    return { uploadUrl, finalUrl, s3Key };
  }

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
 * Write the raw upload body to the local uploads dir. Dev only —
 * exposed as PUT /api/dev-uploads/*. The route layer authenticates the
 * driver session before invoking this; here we only enforce path safety.
 *
 * Returns void; throws on any I/O error so the caller can 500.
 */
/**
 * Path C (2026-07-16) — server-side signature-vector save.
 *
 * The RN-native signature pad captures {points, w, h} JSON and posts it
 * directly to the API (no client-side PNG rasterization). We persist
 * the JSON as-is at a .json path under the delivery-proofs namespace.
 * The PDF layer parses it back and draws strokes with PDFKit's native
 * path API — vector-crisp, no server-side raster needed.
 *
 * For prod-S3 configurations, the JSON would be uploaded to S3 with
 * a text/plain content-type. For the moment the local-fallback path
 * is the tested surface; the S3 path throws so we notice at deploy.
 */
export async function saveSignatureVectorJson(
  distributorId: string,
  orderId: string,
  jsonPayload: string,
  hostHint?: string,
): Promise<PresignedUploadUrl> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(distributorId)) {
    throw new Error('Invalid distributorId for signature-vector save');
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) {
    throw new Error('Invalid orderId for signature-vector save');
  }
  const uuid = randomUUID();
  const s3Key = `delivery-proofs/${distributorId}/${orderId}/signature-${uuid}.json`;
  const bytes = Buffer.from(jsonPayload, 'utf8');

  if (isS3ConfiguredForUploads()) {
    // Prod path — direct-write to S3 via the AWS SDK.
    await getS3Client().send(new PutObjectCommand({
      Bucket: config.aws.s3Bucket,
      Key: s3Key,
      ContentType: 'application/json',
      Body: bytes,
    }));
    const cdnRoot = config.aws.cloudFrontUrl.replace(/\/+$/, '');
    return { uploadUrl: `${cdnRoot}/${s3Key}`, finalUrl: `${cdnRoot}/${s3Key}`, s3Key };
  }

  // Dev fallback — persist directly to the local uploads dir.
  await writeLocalUpload(s3Key, bytes);
  const port = process.env.PORT || '5000';
  const host = hostHint || process.env.LOCAL_UPLOAD_HOST || `localhost:${port}`;
  const finalUrl = `http://${host}/uploads/${s3Key}`;
  logger.info('Signature-vector JSON saved locally', { s3Key, finalUrl, bytes: bytes.length });
  return { uploadUrl: finalUrl, finalUrl, s3Key };
}

export async function writeLocalUpload(s3Key: string, body: Buffer): Promise<void> {
  // Reject any traversal attempt — s3Key comes from the URL path, so a
  // '..' segment could otherwise escape LOCAL_UPLOADS_ROOT.
  const safeKey = path.posix.normalize(s3Key);
  if (safeKey.startsWith('..') || safeKey.includes('/../') || safeKey.startsWith('/')) {
    throw new Error('Invalid s3Key for local upload');
  }
  const absPath = path.join(LOCAL_UPLOADS_ROOT, safeKey);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, body);
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
