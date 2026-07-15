/**
 * Proof-of-collection Phase 1 (2026-07-15): S3 presigned-PUT upload.
 *
 * No AWS SDK on mobile — direct fetch to the presigned URL issued by
 * POST /orders/:id/delivery-proof-upload-url. The presigned URL carries
 * the auth (region + bucket + key + expires-in signature), so no
 * Authorization header is added client-side. Content-Type MUST match
 * exactly what the server signed the URL for (image/png for signature,
 * image/jpeg for photo — enforced by generateDeliveryProofUploadUrl).
 */

export async function uploadToPresignedUrl(
  uploadUrl: string,
  data: Blob | ArrayBuffer,
  contentType: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: data,
    headers: { 'Content-Type': contentType },
  });
  if (!response.ok) {
    // Include status + statusText so the caller can surface a legible
    // error in the driver UI. S3 responses on failure have an XML body
    // — we do NOT parse it here to keep this utility zero-dependency.
    throw new Error(`S3 upload failed: ${response.status} ${response.statusText}`);
  }
}
