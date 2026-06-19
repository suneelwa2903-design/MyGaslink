import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production',

  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production',
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'info@mygaslink.com',
    fromName: process.env.SMTP_FROM_NAME || 'MyGasLink',
    contactEmail: process.env.CONTACT_FORM_EMAIL || 'info@mygaslink.com',
  },

  // Group B Part 7 Bug 5 — production URL is the safer fallback. Before this,
  // an unset WEB_APP_URL on prod EC2 would have sent welcome emails carrying
  // a localhost:5173 link (useless for recipients). With this default, a
  // missing env var degrades to the public production site; the dev env
  // overrides by setting WEB_APP_URL=http://localhost:5173 in .env.
  webAppUrl: process.env.WEB_APP_URL || 'https://mygaslink.com',

  gst: {
    clientId: process.env.GASLINK_GST_CLIENT_ID || '',
    clientSecret: process.env.GASLINK_GST_CLIENT_SECRET || '',
    username: process.env.GASLINK_GST_USERNAME || '',
    gstin: process.env.GASLINK_GST_GSTIN || '',
    isSandbox: process.env.GASLINK_GST_SANDBOX === 'true',
  },

  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    s3Bucket: process.env.AWS_S3_BUCKET || '',
    cloudFrontUrl: process.env.AWS_CLOUDFRONT_URL || '',
  },
} as const;

/**
 * Validate required environment variables at startup.
 * In production, missing critical vars cause a hard failure.
 * In development, warnings are logged but the server continues.
 */
export function validateEnv(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // DATABASE_URL is always required
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL is required');
  }

  if (config.isProd) {
    // In production, JWT secrets must not be defaults
    if (config.jwt.accessSecret === 'dev-access-secret-change-in-production') {
      errors.push('JWT_ACCESS_SECRET must be set in production (not default)');
    }
    if (config.jwt.refreshSecret === 'dev-refresh-secret-change-in-production') {
      errors.push('JWT_REFRESH_SECRET must be set in production (not default)');
    }
    // CORS must be explicitly configured
    if (!process.env.CORS_ORIGINS) {
      errors.push('CORS_ORIGINS must be set in production');
    }
    // WI-PENDING-PAYMENTS: AWS S3 / CloudFront must be configured in prod
    // so the payment-attachment upload flow can issue presigned URLs.
    // The bucket policy expects writes under payment-attachments/{distributorId}/...
    // and CloudFront is the read path returned to clients.
    if (!config.aws.s3Bucket) {
      errors.push('AWS_S3_BUCKET must be set in production');
    }
    if (!config.aws.cloudFrontUrl) {
      errors.push('AWS_CLOUDFRONT_URL must be set in production');
    }
  } else {
    // Dev warnings
    if (config.jwt.accessSecret === 'dev-access-secret-change-in-production') {
      warnings.push('JWT_ACCESS_SECRET using dev default — set before deploying');
    }
    if (config.jwt.refreshSecret === 'dev-refresh-secret-change-in-production') {
      warnings.push('JWT_REFRESH_SECRET using dev default — set before deploying');
    }
    // WI-PENDING-PAYMENTS dev warnings — local dev can still boot without
    // AWS configured; the presigned-URL endpoint will surface 500 when
    // called, which is the right developer signal.
    if (!config.aws.s3Bucket) {
      warnings.push('AWS_S3_BUCKET unset — payment attachment uploads will fail');
    }
    if (!config.aws.cloudFrontUrl) {
      warnings.push('AWS_CLOUDFRONT_URL unset — payment attachment uploads will fail');
    }
  }

  if (warnings.length > 0) {
    console.warn(`\n⚠️  Environment warnings:\n  - ${warnings.join('\n  - ')}\n`);
  }

  if (errors.length > 0) {
    console.error(`\n❌ Environment validation failed:\n  - ${errors.join('\n  - ')}\n`);
    process.exit(1);
  }
}
