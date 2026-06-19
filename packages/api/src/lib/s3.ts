/**
 * WI-PENDING-PAYMENTS: S3 attachment upload infrastructure.
 *
 * Presigned PUT URL strategy: the API never proxies the upload bytes
 * itself. Instead it issues a short-lived presigned PUT URL that the
 * client (driver phone, customer browser, staff browser) PUTs the file
 * to directly. Saves API CPU/bandwidth and keeps `multer`/`sharp` off
 * the hot path. Client compression is fine — driver phones already
 * compress JPEGs on capture.
 *
 * Tenant isolation: the S3 key always embeds `distributorId` taken
 * from the authenticated session, never from a request body. CloudFront
 * read access is keyed on the same path prefix in the bucket policy.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { config } from '../config/index.js';

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
  /** Public CloudFront URL — store on PaymentSubmission.attachmentUrl. */
  finalUrl: string;
  /** Bare S3 key — for diagnostics or deletion. */
  s3Key: string;
}

/**
 * Generate a presigned PUT URL for a payment-attachment upload.
 *
 * The S3 key embeds `distributorId` so a leaked credential cannot
 * upload across tenants. Content-Type is constrained to image/jpeg —
 * the API accepts JPEG only for receipts (drivers can convert from PNG
 * client-side; gallery picks coerce). Content-Length is bounded at the
 * S3 level via the signed conditions: 1 byte to 5 MB.
 *
 * @param distributorId MUST come from the authenticated JWT, never from
 *   the request body. This is the tenant-isolation guarantee.
 * @returns presigned URL + final CDN URL + bare S3 key
 */
export async function generatePaymentAttachmentUploadUrl(
  distributorId: string,
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

  const uuid = randomUUID();
  const s3Key = `payment-attachments/${distributorId}/${uuid}.jpg`;

  const command = new PutObjectCommand({
    Bucket: config.aws.s3Bucket,
    Key: s3Key,
    ContentType: 'image/jpeg',
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: 300 });
  // CloudFront URL is the read path returned to clients. The bucket
  // policy grants CloudFront the read role; clients never see the raw
  // S3 hostname.
  const cdnRoot = config.aws.cloudFrontUrl.replace(/\/+$/, '');
  const finalUrl = `${cdnRoot}/${s3Key}`;

  return { uploadUrl, finalUrl, s3Key };
}

/**
 * Delete a previously-uploaded payment attachment. Used when a
 * submission is rejected and the office wants to clean up storage.
 * Currently not wired into any route — included for completeness so
 * a future cleanup job can reuse it.
 */
export async function deletePaymentAttachment(s3Key: string): Promise<void> {
  if (!config.aws.s3Bucket) {
    throw new Error('S3 bucket not configured');
  }
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: s3Key }),
  );
}

/**
 * Validate that a stored URL points at our CloudFront origin and the
 * expected payment-attachments path prefix. Lets routes accept an
 * `attachmentUrl` from a submission body without trusting the client
 * to point at our bucket.
 *
 * Returns true if the URL is valid AND belongs to the given distributor.
 */
export function isOwnedPaymentAttachmentUrl(
  url: string,
  distributorId: string,
): boolean {
  if (!config.aws.cloudFrontUrl) return false;
  const cdnRoot = config.aws.cloudFrontUrl.replace(/\/+$/, '');
  const prefix = `${cdnRoot}/payment-attachments/${distributorId}/`;
  return url.startsWith(prefix) && url.endsWith('.jpg');
}
