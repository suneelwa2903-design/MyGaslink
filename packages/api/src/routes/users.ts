import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { createUserSchema, updateUserSchema } from '@gaslink/shared';
import * as userService from '../services/userService.js';
import { mapUser, mapUsers } from '../utils/mappers.js';

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
      // distributor_admin can only create users for their own distributor
      if (req.user!.role !== 'super_admin') {
        data.distributorId = req.user!.distributorId;
      }
      const user = await userService.createUser(data);
      return sendCreated(res, mapUser(user));
    } catch (err: any) {
      if (err.code === 'P2002') {
        return sendError(res, 'A user with this email already exists', 409, 'CONFLICT');
      }
      return sendError(res, err.message);
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
    } catch (err: any) {
      if (err.code === 'P2002') {
        return sendError(res, 'A user with this email already exists', 409, 'CONFLICT');
      }
      return sendError(res, err.message);
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
