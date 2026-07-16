/**
 * Dev-only upload fallback (2026-07-16).
 *
 * When AWS_S3_BUCKET is empty in .env, the S3 lib returns a presigned URL
 * pointing at PUT /api/dev-uploads/<s3Key> instead of a real S3 URL. The
 * driver phone then PUTs the signature PNG / photo JPG bytes to us. We
 * write them under packages/api/uploads/<s3Key>. The static /uploads
 * mount in app.ts serves them back for read.
 *
 * Auth model: the driver's phone already authenticated to obtain the
 * upload URL (POST /api/orders/:id/delivery-proof-upload-url is
 * requireRole('driver')). The presigned-URL model does NOT re-auth the
 * upload PUT because a real S3 URL wouldn't either — the signature IS
 * the auth in prod. Here in dev we accept the PUT unauthenticated to
 * match that shape, but the s3Key path is namespaced by distributorId +
 * orderId so a stray PUT can't cross tenants. This is DEV ONLY — the
 * router refuses to mount when NODE_ENV === 'production'.
 */
import { Router } from 'express';
import { writeLocalUpload } from '../lib/s3.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Raw-body parser for image PUTs. 10 MB cap matches app.ts's JSON limit;
// a signature PNG at 2× DPR fits comfortably under 500 KB.
import express from 'express';
// Express 5 requires a NAMED wildcard param — bare '/*' throws
// "Missing parameter name at index 2" from path-to-regexp v8.
router.put(
  '/*rest',
  express.raw({
    type: () => true,
    limit: '10mb',
  }),
  async (req, res) => {
    try {
      // Express 5's wildcard param typing differs across route styles;
      // read the s3Key straight off req.path (leading '/' trimmed).
      const s3Key = req.path.replace(/^\/+/, '');
      if (!s3Key || !s3Key.startsWith('delivery-proofs/')) {
        return res.status(400).json({ success: false, error: 'Invalid s3Key' });
      }
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ success: false, error: 'Empty body' });
      }
      await writeLocalUpload(s3Key, req.body);
      logger.info('dev-upload wrote local file', {
        s3Key,
        bytes: req.body.length,
      });
      return res.status(200).send('OK');
    } catch (err) {
      logger.error('dev-upload failed', { error: (err as Error).message });
      return res.status(500).json({ success: false, error: (err as Error).message });
    }
  },
);

export default router;
