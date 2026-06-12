import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { logBusinessEvent } from '../utils/logger.js';
import type { Prisma } from '@prisma/client';

/**
 * Middleware to automatically log data-modifying operations.
 * Attach to routes that create, update, or delete data.
 */
export function auditLog(action: string, entityType: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        const bodyData = body as { data?: { id?: string } } | null;
        const rawId = req.params.id || bodyData?.data?.id;
        const entityId: string | undefined = Array.isArray(rawId) ? rawId[0] : rawId;
        const ip = Array.isArray(req.ip) ? req.ip[0] : (req.ip || req.socket.remoteAddress || '');
        const ua = Array.isArray(req.headers['user-agent']) ? req.headers['user-agent'][0] : (req.headers['user-agent'] || '');

        prisma.auditLog.create({
          data: {
            userId: req.user.userId,
            distributorId: req.user.distributorId || undefined,
            action,
            entityType,
            entityId: entityId ?? null,
            details: sanitizeForLog(req.body) as Prisma.InputJsonValue | undefined,
            ipAddress: ip,
            userAgent: ua,
          },
        }).catch(() => { /* don't break the request */ });

        logBusinessEvent({
          action,
          entityType,
          entityId: entityId ?? undefined,
          userId: req.user.userId,
          distributorId: req.user.distributorId || undefined,
          requestId: req.requestId,
        });
      }

      return originalJson(body);
    } as typeof res.json;

    next();
  };
}

function sanitizeForLog(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const sanitized = { ...body };
  const sensitiveFields = [
    'password', 'currentPassword', 'newPassword', 'confirmPassword',
    'clientSecret', 'token', 'refreshToken',
    // Phase F (2026-06-12): Razorpay credentials + handler signature.
    // The secret + webhook secret arrive in PUT /distributors/:id body
    // when a super-admin configures per-distributor payments; the
    // signature arrives on every /verify-payment call (Phase E + F).
    // None of these should land in the audit_logs details JSON.
    'razorpayKeySecret', 'razorpayWebhookSecret', 'razorpaySignature',
  ];
  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }
  return sanitized;
}
