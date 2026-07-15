/**
 * Feature A (2026-07-15): distributor-facing customer group management.
 *
 * Mounted at /api/customer-groups. Roles allowed:
 * super_admin | distributor_admin | finance | inventory (same set as
 * customer create/edit — /portal-access provisioning is guarded to
 * the same set since it creates login credentials).
 *
 * Every handler pulls distributorId from req.user.distributorId only —
 * NEVER from the request body (anti-pattern #13 discipline). The
 * service layer double-checks tenant on every query.
 */
import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated } from '../utils/apiResponse.js';
import {
  createGroupSchema,
  updateGroupSchema,
  addGroupMemberSchema,
  provisionGroupPortalAccessSchema,
} from '@gaslink/shared';
import * as service from '../services/customerGroupService.js';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

const ALLOWED_ROLES = ['super_admin', 'distributor_admin', 'finance', 'inventory'] as const;

// GET /api/customer-groups
router.get(
  '/',
  requireRole(...ALLOWED_ROLES),
  async (req, res) => {
    try {
      const rows = await service.listGroups(req.user!.distributorId!);
      return sendSuccess(res, { groups: rows });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/customer-groups
router.post(
  '/',
  requireRole(...ALLOWED_ROLES),
  validate(createGroupSchema),
  auditLog('create', 'customer_group'),
  async (req, res) => {
    try {
      const group = await service.createGroup(req.user!.distributorId!, req.body);
      return sendCreated(res, group);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// GET /api/customer-groups/:groupId
router.get(
  '/:groupId',
  requireRole(...ALLOWED_ROLES),
  async (req, res) => {
    try {
      const group = await service.getGroup(
        req.user!.distributorId!,
        param(req.params.groupId),
      );
      return sendSuccess(res, group);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// PUT /api/customer-groups/:groupId — rename
router.put(
  '/:groupId',
  requireRole(...ALLOWED_ROLES),
  validate(updateGroupSchema),
  auditLog('update', 'customer_group'),
  async (req, res) => {
    try {
      const group = await service.updateGroup(
        req.user!.distributorId!,
        param(req.params.groupId),
        req.body,
      );
      return sendSuccess(res, group);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// DELETE /api/customer-groups/:groupId — soft-delete
router.delete(
  '/:groupId',
  requireRole(...ALLOWED_ROLES),
  auditLog('delete', 'customer_group'),
  async (req, res) => {
    try {
      await service.deleteGroup(req.user!.distributorId!, param(req.params.groupId));
      return sendSuccess(res, { deleted: true });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/customer-groups/:groupId/members — add a customer to the group
router.post(
  '/:groupId/members',
  requireRole(...ALLOWED_ROLES),
  validate(addGroupMemberSchema),
  auditLog('add_member', 'customer_group'),
  async (req, res) => {
    try {
      await service.addMember(
        req.user!.distributorId!,
        param(req.params.groupId),
        req.body.customerId,
      );
      return sendCreated(res, { added: true });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// DELETE /api/customer-groups/:groupId/members/:customerId
router.delete(
  '/:groupId/members/:customerId',
  requireRole(...ALLOWED_ROLES),
  auditLog('remove_member', 'customer_group'),
  async (req, res) => {
    try {
      await service.removeMember(
        req.user!.distributorId!,
        param(req.params.groupId),
        param(req.params.customerId),
      );
      return sendSuccess(res, { removed: true });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/customer-groups/:groupId/portal-access — provision customer_hq user
router.post(
  '/:groupId/portal-access',
  requireRole(...ALLOWED_ROLES),
  validate(provisionGroupPortalAccessSchema),
  auditLog('provision_portal_access', 'customer_group'),
  async (req, res) => {
    try {
      const user = await service.provisionPortalAccess(
        req.user!.distributorId!,
        param(req.params.groupId),
        req.body,
      );
      return sendCreated(res, user);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// DELETE /api/customer-groups/:groupId/portal-access — revoke customer_hq user
router.delete(
  '/:groupId/portal-access',
  requireRole(...ALLOWED_ROLES),
  auditLog('revoke_portal_access', 'customer_group'),
  async (req, res) => {
    try {
      const result = await service.revokePortalAccess(
        req.user!.distributorId!,
        param(req.params.groupId),
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

export default router;
