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

        // Which distributor is this row FOR? For most routes it's the
        // session tenant (req.user.distributorId). But for super_admin
        // cross-tenant writes — e.g. POST /billing/generate with a body
        // { distributorId } targeting a DIFFERENT tenant than the one
        // currently selected in the header — the audit log must record
        // the TARGET tenant, not the session tenant. Otherwise you get
        // "Kruthee's admin generated a Vanasthali invoice" style
        // false-positive audit rows (the bug that surfaced on 2026-08-03).
        const bodyDistributorId = extractBodyDistributorId(req.body);
        const targetDistributorId = bodyDistributorId ?? req.user.distributorId ?? undefined;
        const sessionDistributorId = req.user.distributorId ?? undefined;

        prisma.auditLog.create({
          data: {
            userId: req.user.userId,
            distributorId: targetDistributorId,
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
          distributorId: targetDistributorId,
          // Only emit the extra field when the two disagree — keeps the
          // 99% single-tenant case's log line unchanged.
          ...(sessionDistributorId && targetDistributorId && sessionDistributorId !== targetDistributorId
            ? { sessionDistributorId }
            : {}),
          requestId: req.requestId,
        });
      }

      return originalJson(body);
    } as typeof res.json;

    next();
  };
}

function extractBodyDistributorId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>).distributorId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
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
