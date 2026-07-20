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
  updateGroupMemberSchema,
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
        req.body.displayName ?? null,
      );
      return sendCreated(res, { added: true });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// PATCH /api/customer-groups/:groupId/members/:customerId — update alias
// 2026-07-20: distributor-facing edit for the per-membership displayName
// shown on HQ portal surfaces. Same role set as the add path.
router.patch(
  '/:groupId/members/:customerId',
  requireRole(...ALLOWED_ROLES),
  validate(updateGroupMemberSchema),
  auditLog('update_member', 'customer_group'),
  async (req, res) => {
    try {
      await service.updateMember(
        req.user!.distributorId!,
        param(req.params.groupId),
        param(req.params.customerId),
        { displayName: req.body.displayName },
      );
      return sendSuccess(res, { updated: true });
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

// DELETE /api/customer-groups/:groupId/portal-access — revoke ALL customer_hq users on this group
// Feature A follow-up (2026-07-15): still used by the group-deletion
// preflight ("revoke access before deleting the group"). The per-user
// revoke lives on the more specific /:userId route below.
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

// DELETE /api/customer-groups/:groupId/portal-access/:userId — revoke ONE HQ login
// Feature A follow-up (2026-07-15): per-row Revoke button in the
// Portal Access tab when a group has multiple HQ logins. Service
// verifies the user belongs to this group before soft-deleting.
router.delete(
  '/:groupId/portal-access/:userId',
  requireRole(...ALLOWED_ROLES),
  auditLog('revoke_portal_user', 'customer_group'),
  async (req, res) => {
    try {
      const result = await service.revokePortalUser(
        req.user!.distributorId!,
        param(req.params.groupId),
        param(req.params.userId),
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// GET /api/customer-groups/:groupId/contacts — candidate contacts to promote to HQ
// Feature A follow-up (2026-07-15): powers the "Promote a contact"
// picker. Returns every CustomerContact across every member customer
// of this group, with `hasLogin` flagged for contacts that have
// already been promoted.
router.get(
  '/:groupId/contacts',
  requireRole(...ALLOWED_ROLES),
  async (req, res) => {
    try {
      const contacts = await service.listGroupContacts(
        req.user!.distributorId!,
        param(req.params.groupId),
      );
      return sendSuccess(res, { contacts });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

export default router;
