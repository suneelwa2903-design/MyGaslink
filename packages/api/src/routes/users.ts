import { Router } from 'express';
import accountDeletionRoutes from './accountDeletionRoutes.js';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { createUserSchema, updateUserSchema, updateOwnProfileSchema } from '@gaslink/shared';
import * as userService from '../services/userService.js';
import { mapUser, mapUsers } from '../utils/mappers.js';
import { sendWelcomeEmail } from '../utils/email.js';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// M14 v1.0 — account deletion endpoints. Mounted BEFORE any :id-style routes
// so the literal `/me/deletion-request*` paths take precedence.
router.use('/', accountDeletionRoutes);

// GET /api/users/profile - get current user profile (must be before :id)
router.get('/profile', async (req, res) => {
  try {
    const user = await userService.getUserProfile(req.user!.userId);
    if (!user) return sendNotFound(res, 'User');
    return sendSuccess(res, mapUser(user));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/users - list users
//
// Group B Part 4 — staff-only by default. Query params:
//   role         filter by single role (overrides default-hide of
//                customer/driver)
//   status       filter by active|inactive
//   search       case-insensitive contains across firstName/lastName/
//                email/phone
//   sortBy       name | email | createdAt | lastLoginAt
//   sortDir      asc | desc (default desc)
//   includePortal=true  include customer + driver roles in the default
//                       response (rare — typically only for a portal
//                       roster view)
router.get('/', requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'), async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const users = await userService.listUsers(req.user!.distributorId, req.user!.role, {
      roleFilter: q.role,
      statusFilter: q.status,
      search: q.search,
      sortBy: q.sortBy as 'name' | 'email' | 'createdAt' | 'lastLoginAt' | undefined,
      sortDir: q.sortDir === 'asc' ? 'asc' : q.sortDir === 'desc' ? 'desc' : undefined,
      includePortal: q.includePortal === 'true' || q.includePortal === '1',
      // Group L1 (2026-06-11): super-admin only. Filters the list to a
      // single tenant without touching the global selector. The service
      // ignores it for non-super_admin callers.
      distributorIdFilter: q.distributorId,
    });
    return sendSuccess(res, { users: mapUsers(users) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/users/:id - get user by id
router.get('/:id', async (req, res) => {
  try {
    const user = await userService.getUserById(param(req.params.id));
    if (!user) return sendNotFound(res, 'User');
    // Non-super-admin can only see users in their distributor
    if (req.user!.role !== 'super_admin' && user.distributorId !== req.user!.distributorId) {
      return sendNotFound(res, 'User');
    }
    return sendSuccess(res, mapUser(user));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/users - create user
// Returns `{ user, tempPassword }` on success. The tempPassword field is
// echoed back from the request body (NOT re-read from the DB — the row
// stores only the bcrypt hash) so the Add User modal can render a copyable
// banner + WhatsApp share button. This is the ONLY response shape that
// exposes the plaintext password — every other user endpoint omits it.
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  validate(createUserSchema),
  auditLog('create', 'user'),
  async (req, res) => {
    try {
      const data = req.body;
      if (req.user!.role !== 'super_admin') {
        // distributor_admin can only create users for their own distributor
        data.distributorId = req.user!.distributorId;
      } else if (!data.distributorId) {
        // super_admin: use resolved distributor context (from X-Distributor-Id header or selector)
        data.distributorId = req.user!.distributorId || null;
      }
      // Prevent creating distributor-scoped roles without a distributorId
      if (!data.distributorId && data.role !== 'super_admin') {
        return sendError(res, 'A distributor must be selected before creating this user. Please select a distributor from the top bar.', 400);
      }
      const tempPassword: string = data.password;
      // Group B Part 3 — `driverId` is a one-shot wiring instruction, not a
      // User column. Strip it from `data` before handing to userService so
      // it doesn't accidentally flow into Prisma's user.create() input.
      const driverIdToLink: string | undefined = data.driverId;
      delete data.driverId;
      const user = await userService.createUser(data);

      // Driver linkage — atomically (or as close as we get without a tx
      // spanning the service boundary) point drivers.user_id at the new
      // login. If the driver row doesn't belong to this distributor we
      // silently no-op rather than throw — the user is created either way.
      if (driverIdToLink && user.role === 'driver' && user.distributorId) {
        try {
          await prisma.driver.update({
            where: { id: driverIdToLink, distributorId: user.distributorId },
            data: { userId: user.id },
          });
        } catch (linkErr) {
          // Don't fail user creation on a link mismatch. The admin can
          // re-link from Fleet → Drivers manually if needed.
          // Most likely cause: a Prisma P2025 (record not found) — driver
          // belongs to a different distributor or was deleted mid-flight.
          console.warn(`[users] driver link failed for user ${user.id} → driver ${driverIdToLink}: ${(linkErr as Error).message}`);
        }
      }

      // Fire-and-forget welcome email — never block the response on it.
      // sendWelcomeEmail itself swallows transport errors (returns 'failed'
      // / 'skipped' instead of throwing) so user creation succeeds even if
      // SMTP is unreachable. The admin still gets the copyable password
      // banner as a fallback handoff channel.
      const distributorName = user.distributorId
        ? (await prisma.distributor.findUnique({
            where: { id: user.distributorId },
            select: { businessName: true },
          }))?.businessName ?? null
        : null;
      void sendWelcomeEmail({
        to: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        email: user.email,
        tempPassword,
        loginUrl: `${config.webAppUrl}/login`,
        distributorName,
        userId: user.id,
      });

      return sendCreated(res, { user: mapUser(user), tempPassword });
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') {
        return sendError(res, 'A user with this email already exists', 409, 'CONFLICT');
      }
      return sendError(res, e.message);
    }
  }
);

// STAGE-E: PUT /api/users/me — self-edit profile (firstName/lastName/phone).
// MUST be declared BEFORE PUT /:id so Express's path matcher doesn't
// route a literal `/me` into the :id handler (which would 404 on a UUID
// param + then crash the role gate). No requireRole — any authenticated
// user edits ONLY their own row. The Zod schema strips email/role/
// distributorId/customerId so the caller cannot escalate privileges.
router.put('/me',
  validate(updateOwnProfileSchema),
  auditLog('update_profile', 'user'),
  async (req, res) => {
    try {
      const userId = req.user!.userId;
      const updated = await userService.updateUser(userId, req.body);
      return sendSuccess(res, mapUser(updated));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message);
    }
  }
);

// PUT /api/users/:id - update user
router.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  validate(updateUserSchema),
  auditLog('update', 'user'),
  async (req, res) => {
    try {
      const existing = await userService.getUserById(param(req.params.id));
      if (!existing) return sendNotFound(res, 'User');
      if (req.user!.role !== 'super_admin' && existing.distributorId !== req.user!.distributorId) {
        return sendNotFound(res, 'User');
      }
      const user = await userService.updateUser(param(req.params.id), req.body);
      return sendSuccess(res, mapUser(user));
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') {
        return sendError(res, 'A user with this email already exists', 409, 'CONFLICT');
      }
      return sendError(res, e.message);
    }
  }
);

// DELETE /api/users/:id - soft delete
router.delete('/:id',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  auditLog('delete', 'user'),
  async (req, res) => {
    try {
      const existing = await userService.getUserById(param(req.params.id));
      if (!existing) return sendNotFound(res, 'User');
      if (req.user!.role !== 'super_admin' && existing.distributorId !== req.user!.distributorId) {
        return sendNotFound(res, 'User');
      }
      if (param(req.params.id) === req.user!.userId) {
        return sendError(res, 'Cannot delete your own account', 400);
      }
      await userService.softDeleteUser(param(req.params.id));
      return sendSuccess(res, { message: 'User deleted successfully' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// Group L3 (2026-06-11): POST /api/users/:id/suspend, /reactivate.
// Reversible block (status → suspended) + refresh-token wipe so the
// existing session can't be renewed. Audit log written on both
// transitions. Tenant + role guards live in the service.
router.post('/:id/suspend',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  auditLog('suspend', 'user'),
  async (req, res) => {
    try {
      const user = await userService.suspendUser(
        param(req.params.id),
        req.user!.userId,
        req.user!.role,
        req.user!.distributorId,
      );
      return sendSuccess(res, mapUser(user));
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message: string };
      return sendError(res, e.message, e.statusCode || 500, e.code);
    }
  },
);

router.post('/:id/reactivate',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  auditLog('reactivate', 'user'),
  async (req, res) => {
    try {
      const user = await userService.reactivateUser(
        param(req.params.id),
        req.user!.userId,
        req.user!.role,
        req.user!.distributorId,
      );
      return sendSuccess(res, mapUser(user));
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message: string };
      return sendError(res, e.message, e.statusCode || 500, e.code);
    }
  },
);

export default router;
