import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { sendUnauthorized, sendForbidden } from '../utils/apiResponse.js';
import type { UserRole, JwtPayload } from '@gaslink/shared';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      requestId?: string;
    }
  }
}

// Safe ID format — alphanumeric, hyphens, underscores, max 128 chars (covers UUIDs and seed IDs like 'dist-001')
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function sendBadRequest(res: Response, message: string, code = 'BAD_REQUEST') {
  return res.status(400).json({ success: false, data: null, error: message, code });
}

/**
 * Verify JWT access token and attach user to request.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return sendUnauthorized(res, 'Missing or invalid authorization header');
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret) as JwtPayload;

    // Verify user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, status: true, role: true, distributorId: true, customerId: true },
    });

    if (!user || user.status !== 'active') {
      return sendUnauthorized(res, 'User account is inactive or not found');
    }

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      distributorId: decoded.distributorId,
      customerId: decoded.customerId,
    };

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return sendUnauthorized(res, 'Token expired');
    }
    return sendUnauthorized(res, 'Invalid token');
  }
}

/**
 * Require specific roles. Must be used after authenticate middleware.
 */
export function requireRole(...allowedRoles: (UserRole | string)[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return sendUnauthorized(res);
    }

    // Super admin bypasses role checks
    if (req.user.role === 'super_admin') {
      return next();
    }

    if (!allowedRoles.includes(req.user.role as UserRole)) {
      return sendForbidden(res, `Role '${req.user.role}' does not have access to this resource`);
    }

    next();
  };
}

/**
 * Resolve distributor context from request.
 *
 * - Super admin: reads X-Distributor-Id header (validated as UUID), falls through as null if absent
 * - All other roles: uses distributorId from JWT (set at login, never changes)
 *
 * This middleware never rejects — it only resolves. Use requireDistributor()
 * after this to enforce that a distributorId is present.
 */
export function resolveDistributor(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return sendUnauthorized(res);
  }

  if (req.user.role === 'super_admin') {
    const raw = req.headers['x-distributor-id'];
    const headerDistributorId = Array.isArray(raw) ? raw[0] : raw;

    if (headerDistributorId) {
      // Validate format before trusting the value — reject garbage/injection attempts
      if (!SAFE_ID_RE.test(headerDistributorId)) {
        return sendBadRequest(res, 'Invalid X-Distributor-Id header format', 'INVALID_DISTRIBUTOR_ID');
      }
      req.user.distributorId = headerDistributorId;
    }
    // distributorId remains null if header absent — requireDistributor() will enforce below
  } else if (!req.user.distributorId) {
    return sendForbidden(res, 'No distributor assigned to your account');
  }

  next();
}

/**
 * Require a resolved distributorId before proceeding.
 *
 * Must be used after resolveDistributor(). Applies to ALL roles including
 * super_admin — super admin must select a distributor and send X-Distributor-Id
 * header before accessing distributor-scoped endpoints.
 *
 * Routes that are genuinely platform-level (distributors list, health,
 * provider catalog) should NOT use this middleware.
 */
export function requireDistributor(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.distributorId) {
    return sendBadRequest(
      res,
      'No distributor selected. Please select a distributor first.',
      'NO_DISTRIBUTOR_SELECTED',
    );
  }
  next();
}
