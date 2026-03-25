import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { gstCredentialsSchema, gstModeSchema, approvalWorkflowSchema } from '@gaslink/shared';
import * as settingsService from '../services/settingsService.js';
import { z } from 'zod';

const router = Router();

// ─── Distributor Settings (JSONB key-value) ─────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const settings = await settingsService.getSettings(req.user!.distributorId!);
    return sendSuccess(res, settings);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.get('/:key', async (req, res) => {
  try {
    const setting = await settingsService.getSetting(req.user!.distributorId!, param(req.params.key));
    if (!setting) return sendNotFound(res, 'Setting');
    return sendSuccess(res, setting);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.put('/:key',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ value: z.any() })),
  auditLog('upsert', 'setting'),
  async (req, res) => {
    try {
      const setting = await settingsService.upsertSetting(
        req.user!.distributorId!, param(req.params.key), req.body.value
      );
      return sendSuccess(res, setting);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

router.delete('/:key',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'setting'),
  async (req, res) => {
    try {
      await settingsService.deleteSetting(req.user!.distributorId!, param(req.params.key));
      return sendSuccess(res, { message: 'Setting deleted' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── GST Credentials ───────────────────────────────────────────────────────

router.get('/gst/credentials', async (req, res) => {
  try {
    const creds = await settingsService.getGstCredentials(req.user!.distributorId!);
    return sendSuccess(res, creds);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.put('/gst/credentials',
  requireRole('super_admin', 'distributor_admin'),
  validate(gstCredentialsSchema),
  auditLog('upsert', 'gst_credentials'),
  async (req, res) => {
    try {
      const creds = await settingsService.upsertGstCredentials(req.user!.distributorId!, req.body);
      return sendSuccess(res, { message: 'GST credentials saved' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

router.put('/gst/mode',
  requireRole('super_admin', 'distributor_admin'),
  validate(gstModeSchema),
  auditLog('update', 'gst_mode'),
  async (req, res) => {
    try {
      const result = await settingsService.updateGstMode(req.user!.distributorId!, req.body.mode);
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Cylinder Thresholds ────────────────────────────────────────────────────

router.get('/cylinder-thresholds/list', async (req, res) => {
  try {
    const thresholds = await settingsService.getThresholds(req.user!.distributorId!);
    return sendSuccess(res, thresholds);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ─── Approval Workflows ─────────────────────────────────────────────────────

router.get('/approval-workflows/list', async (req, res) => {
  try {
    const workflows = await settingsService.getApprovalWorkflows(req.user!.distributorId!);
    return sendSuccess(res, workflows);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.put('/approval-workflows',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ workflows: z.array(approvalWorkflowSchema) })),
  auditLog('update', 'approval_workflows'),
  async (req, res) => {
    try {
      const result = await settingsService.updateApprovalWorkflows(
        req.user!.distributorId!, req.body.workflows
      );
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Licenses ───────────────────────────────────────────────────────────────

router.get('/licenses/list', async (req, res) => {
  try {
    const licenses = await settingsService.listLicenses(req.user!.distributorId!);
    return sendSuccess(res, licenses);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.post('/licenses',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    licenseType: z.string().min(1),
    licenseName: z.string().min(1).max(200),
    licenseNumber: z.string().optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    documentUrl: z.string().url().optional(),
  })),
  auditLog('create', 'license'),
  async (req, res) => {
    try {
      const license = await settingsService.createLicense(req.user!.distributorId!, req.body);
      return sendCreated(res, license);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

router.put('/licenses/:id',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    licenseName: z.string().min(1).max(200).optional(),
    licenseNumber: z.string().optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    documentUrl: z.string().url().optional(),
  })),
  auditLog('update', 'license'),
  async (req, res) => {
    try {
      const license = await settingsService.updateLicense(param(req.params.id), req.user!.distributorId!, req.body);
      if (!license) return sendNotFound(res, 'License');
      return sendSuccess(res, license);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

router.delete('/licenses/:id',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'license'),
  async (req, res) => {
    try {
      const result = await settingsService.deleteLicense(param(req.params.id), req.user!.distributorId!);
      if (!result) return sendNotFound(res, 'License');
      return sendSuccess(res, { message: 'License deleted' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
