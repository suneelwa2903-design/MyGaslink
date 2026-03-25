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
 * Super admin: uses X-Distributor-Id header
 * Others: uses their assigned distributor_id
 */
export function resolveDistributor(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return sendUnauthorized(res);
  }

  if (req.user.role === 'super_admin') {
    const headerDistributorId = req.headers['x-distributor-id'] as string | undefined;
    if (headerDistributorId) {
      req.user.distributorId = headerDistributorId;
    }
    // Super admin can operate without distributor context (for platform-level operations)
  } else if (!req.user.distributorId) {
    return sendForbidden(res, 'No distributor assigned to your account');
  }

  next();
}

/**
 * Require distributor context to be resolved (for distributor-scoped operations).
 */
export function requireDistributor(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.distributorId) {
    return sendError(res, 'Distributor context required. Please select a distributor.', 400);
  }
  next();
}

function sendError(res: Response, message: string, status: number) {
  return res.status(status).json({ success: false, data: null, error: message });
}
