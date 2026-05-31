import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { createUserSchema, updateUserSchema, updateOwnProfileSchema } from '@gaslink/shared';
import * as userService from '../services/userService.js';
import { mapUser, mapUsers } from '../utils/mappers.js';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

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
router.get('/', requireRole('super_admin', 'distributor_admin'), async (req, res) => {
  try {
    const users = await userService.listUsers(req.user!.distributorId, req.user!.role);
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
router.post('/',
  requireRole('super_admin', 'distributor_admin'),
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
      const user = await userService.createUser(data);
      return sendCreated(res, mapUser(user));
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
  requireRole('super_admin', 'distributor_admin'),
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
  requireRole('super_admin', 'distributor_admin'),
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

export default router;
