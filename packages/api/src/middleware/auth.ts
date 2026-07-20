import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { sendUnauthorized, sendForbidden } from '../utils/apiResponse.js';
import { logBusinessEvent } from '../utils/logger.js';
import type { UserRole, JwtPayload } from '@gaslink/shared';

// Minimal shape of the distributor record cached on the request after
// resolveDistributor passes. Downstream services can read this instead of
// re-querying for tenant config (gstMode, billingSuspended, etc.).
export interface ResolvedDistributor {
  id: string;
  status: string;
  gstMode: string;
  billingSuspended: boolean;
}

// Extend Express Request to include user
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express type augmentation requires namespace syntax
  namespace Express {
    interface Request {
      user?: JwtPayload;
      requestId?: string;
      distributor?: ResolvedDistributor;
      // Feature A (2026-07-15): set by requireGroupAccess middleware
      // for customer_hq routes. Every query in the group-portal service
      // uses BOTH distributorId (from req.user) AND
      // customerId: { in: visibleCustomerIds } — never one without the
      // other (anti-pattern #13 discipline extended to groups).
      visibleCustomerIds?: string[];
      // 2026-07-20: per-membership display-name overrides, keyed by
      // customerId. HQ portal readers use `map.get(cid) ?? customerName`
      // so admins can alias long property names to fit table cells
      // without renaming the underlying customer.
      memberDisplayNames?: Map<string, string>;
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

    // Verify user still exists and is active. M14 v1.0
    // (IOS-ACCOUNT-DELETION-SPEC §5.1): also join the active deletion
    // request — the middleware blocks every endpoint except cancel /
    // status / logout when a user has one pending.
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true, status: true, role: true, distributorId: true, customerId: true,
        // Feature A (2026-07-15): re-read groupId per request so a
        // customer_hq user whose group changes (rare — e.g. moved from
        // one HQ bundle to another by staff) picks up the change on
        // the next request without needing to re-login.
        groupId: true,
        // 1:1 relation — Prisma include can't filter on a unique-side
        // relation, so we fetch the row (any status) and check it below.
        accountDeletionRequest: {
          select: { id: true, status: true, scheduledCompletionAt: true },
        },
      },
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
      // Read from the fresh DB row, not the token, so a group change
      // takes effect immediately (same defence-in-depth pattern the
      // resolveDistributor middleware already applies for tenant).
      groupId: user.groupId,
    };

    // M14 v1.0 (spec §5.1): pending-deletion gate. Only cancel + status
    // + logout are reachable. Everything else gets 403 with the special
    // `account_pending_deletion` code so the mobile axios interceptor
    // can route to the pending-deletion screen.
    if (user.accountDeletionRequest && user.accountDeletionRequest.status === 'pending') {
      const path = req.originalUrl.split('?')[0];
      const method = req.method;
      const ALLOWED: Array<{ method: string; path: string }> = [
        { method: 'POST', path: '/api/users/me/deletion-request/cancel' },
        { method: 'GET', path: '/api/users/me/deletion-request' },
        { method: 'POST', path: '/api/auth/logout' },
      ];
      const allowed = ALLOWED.some((e) => e.method === method && e.path === path);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          data: null,
          error: 'account_pending_deletion',
          code: 'ACCOUNT_PENDING_DELETION',
          context: {
            scheduledCompletionAt: user.accountDeletionRequest.scheduledCompletionAt,
          },
        });
      }
    }

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
 * - Super admin: reads X-Distributor-Id header (regex-validated), then verifies
 *   the distributor row exists and is active. Falls through with no distributor
 *   if header is absent (super_admin can hit platform-level routes without one).
 * - All other roles: uses distributorId from JWT (set at login, never changes)
 *   and verifies the distributor is active on every request.
 *
 * On success, attaches the verified distributor to `req.distributor` so
 * downstream services can read tenant config without re-querying.
 *
 * Use requireDistributor() after this to enforce that a distributorId is
 * present (for tenant-scoped routes).
 */
export async function resolveDistributor(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return sendUnauthorized(res);
  }

  let candidateId: string | null = null;
  let isSuperAdminSwitch = false;

  if (req.user.role === 'super_admin') {
    const raw = req.headers['x-distributor-id'];
    const headerDistributorId = Array.isArray(raw) ? raw[0] : raw;

    if (headerDistributorId) {
      // Validate format before trusting the value — reject garbage/injection attempts
      if (!SAFE_ID_RE.test(headerDistributorId)) {
        return sendBadRequest(res, 'Invalid X-Distributor-Id header format', 'INVALID_DISTRIBUTOR_ID');
      }
      candidateId = headerDistributorId;
      isSuperAdminSwitch = true;
    }
    // candidateId remains null if header absent — requireDistributor() will reject
    // for tenant-scoped routes; platform-level routes pass through.
  } else {
    if (!req.user.distributorId) {
      return sendForbidden(res, 'No distributor assigned to your account');
    }
    candidateId = req.user.distributorId;
  }

  if (candidateId) {
    const distributor = await prisma.distributor.findFirst({
      where: { id: candidateId, deletedAt: null },
      select: { id: true, status: true, gstMode: true, billingSuspended: true },
    });

    if (!distributor) {
      return sendBadRequest(res, 'Invalid distributor context', 'INVALID_DISTRIBUTOR');
    }
    if (distributor.status === 'suspended') {
      return res.status(403).json({
        success: false,
        data: null,
        error: 'Distributor account suspended',
        code: 'DISTRIBUTOR_SUSPENDED',
      });
    }

    req.user.distributorId = distributor.id;
    req.distributor = distributor;

    // Group DPDP (2026-06-11): persist super-admin tenant switches to
    // audit_logs so the SaaS owner can audit which tenants a super-
    // admin actually looked at. Previously this only went to Winston
    // (logBusinessEvent), so there was no DB record. Fire-and-forget —
    // a write failure never blocks the request. Idempotency: every
    // request that includes a new X-Distributor-Id header writes one
    // row; if a super-admin sits on the same tenant across many
    // requests no extra row is written by other middlewares.
    if (isSuperAdminSwitch) {
      // Best-effort Winston log (legacy).
      try {
        logBusinessEvent({
          action: 'super_admin_tenant_switch',
          entityType: 'distributor',
          entityId: distributor.id,
          userId: req.user.userId,
          distributorId: distributor.id,
          requestId: req.requestId,
          details: { ip: req.ip },
        });
      } catch { /* best-effort */ }

      // DB persistence — captures IP + user-agent for forensic
      // correlation. Wrapped in its own try/catch so a transient DB
      // hiccup never breaks tenant switching.
      void prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          distributorId: distributor.id,
          action: 'tenant_switch',
          entityType: 'distributor',
          entityId: distributor.id,
          details: { previousDistributorId: req.user.distributorId } as object,
          ipAddress: req.ip,
          userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
        },
      }).catch(() => { /* fire-and-forget */ });
    }
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

/**
 * Feature A (2026-07-15): requireGroupAccess middleware.
 *
 * Used ONLY on /api/customer-group-portal/* routes. Reads
 * req.user.groupId, verifies the group belongs to req.user.distributorId
 * (belt-and-braces tenant check — anti-pattern #13), then attaches
 * `req.visibleCustomerIds` = the group's non-deleted member ids for
 * downstream handlers to use in every query.
 *
 * Must be composed after authenticate + resolveDistributor +
 * requireRole('customer_hq') so req.user.distributorId and
 * req.user.groupId are guaranteed present + tenant-valid.
 *
 * Refuses (403) if:
 *  - the JWT has no groupId claim (shouldn't happen for customer_hq
 *    but defensive)
 *  - the group is soft-deleted
 *  - the group belongs to a different distributor (attack path)
 */
export async function requireGroupAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.groupId) {
    return sendForbidden(res, 'Group access required');
  }
  if (!req.user?.distributorId) {
    return sendForbidden(res, 'Distributor context required');
  }
  const group = await prisma.customerGroup.findFirst({
    where: {
      id: req.user.groupId,
      distributorId: req.user.distributorId,
      deletedAt: null,
    },
    include: {
      members: {
        include: {
          customer: { select: { id: true, deletedAt: true } },
        },
      },
    },
  });
  if (!group) {
    return sendForbidden(res, 'Group not found or access denied');
  }
  const liveMembers = group.members.filter((m) => !m.customer.deletedAt);
  req.visibleCustomerIds = liveMembers.map((m) => m.customerId);
  // 2026-07-20: freeze the alias map alongside the id list so every
  // portal reader has a single-source-of-truth override without an
  // extra DB round-trip per request.
  req.memberDisplayNames = new Map(
    liveMembers
      .filter((m) => m.displayName)
      .map((m) => [m.customerId, m.displayName as string]),
  );
  next();
}
