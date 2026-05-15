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
    const distributorId = req.user!.distributorId;
    if (!distributorId) {
      // super_admin without a tenant selected — empty object is safer
      // than [] since every UI consumer expects an object shape.
      return sendSuccess(res, {
        distributorId: null,
        gstMode: null,
        gstCredentials: null,
        rawSettings: [],
      });
    }
    // The TS contract on the web (DistributorSettings interface) expects
    // an object with gstMode + gstCredentials on it, not the raw
    // DistributorSetting[] rows. Build that envelope here so every page
    // that reads `settings.gstMode` works.
    const [rawSettings, distributor, gstCred] = await Promise.all([
      settingsService.getSettings(distributorId),
      (await import('../lib/prisma.js')).prisma.distributor.findUnique({
        where: { id: distributorId },
        select: { gstMode: true },
      }),
      settingsService.getGstCredentials(distributorId, 'einvoice'),
    ]);
    return sendSuccess(res, {
      distributorId,
      gstMode: distributor?.gstMode ?? null,
      gstCredentials: gstCred ?? null,
      rawSettings,
    });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.get('/:key', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
    const setting = await settingsService.getSetting(distributorId, param(req.params.key));
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const setting = await settingsService.upsertSetting(
        distributorId, param(req.params.key), req.body.value
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      await settingsService.deleteSetting(distributorId, param(req.params.key));
      return sendSuccess(res, { message: 'Setting deleted' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── GST Credentials ───────────────────────────────────────────────────────

router.get('/gst/credentials', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
    const creds = await settingsService.getGstCredentials(distributorId);
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      await settingsService.upsertGstCredentials(distributorId, req.body);
      return sendSuccess(res, { message: 'GST credentials saved' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// WI-042: scoped Test & Save — upserts the credentials, then calls
// WhiteBooks authenticate(). On success the credential row's
// isValid+lastValidated columns are set; on failure the row is rolled
// back to isValid=false and the WhiteBooks error message is returned
// to the UI so the admin sees exactly what NIC rejected.
router.put('/gst/credentials/:scope',
  requireRole('super_admin', 'distributor_admin'),
  validate(gstCredentialsSchema),
  auditLog('upsert', 'gst_credentials'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const scope = param(req.params.scope);
      if (scope !== 'einvoice' && scope !== 'ewaybill') {
        return sendError(res, 'Scope must be einvoice or ewaybill', 400, 'BAD_SCOPE');
      }
      // Upsert first so authenticate() reads the new credentials via
      // getCredentials(). isValid stays false until the auth check passes.
      await settingsService.upsertGstCredentials(distributorId, { ...req.body, scope });

      // Test the new credentials against WhiteBooks. We isolate the cached
      // token so a stale one from a previous valid set doesn't mask a
      // failed validation attempt with the new credentials.
      const { getAuthToken } = await import('../services/gst/whitebooksClient.js');
      try {
        await getAuthToken(distributorId, scope);
      } catch (authErr: any) {
        // authenticate() already set isValid=true on success; on failure
        // ensure the row reflects "broken" so callers don't think these
        // are usable.
        await settingsService.markGstCredentialsInvalid(distributorId, scope);
        return sendError(
          res,
          authErr.message || 'WhiteBooks authentication failed',
          400,
          'AUTH_FAILED',
        );
      }

      return sendSuccess(res, { message: 'GST credentials validated and saved', scope });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// WI-042: trigger a re-validation against WhiteBooks without modifying
// the stored credentials. Used by the "Test Connection" button when the
// admin just wants to confirm the existing config still authenticates.
router.post('/gst/credentials/:scope/test',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('test_connection', 'gst_credentials'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const scope = param(req.params.scope);
      if (scope !== 'einvoice' && scope !== 'ewaybill') {
        return sendError(res, 'Scope must be einvoice or ewaybill', 400, 'BAD_SCOPE');
      }
      const { getAuthToken } = await import('../services/gst/whitebooksClient.js');
      try {
        await getAuthToken(distributorId, scope);
      } catch (authErr: any) {
        await settingsService.markGstCredentialsInvalid(distributorId, scope);
        return sendError(res, authErr.message || 'WhiteBooks authentication failed', 400, 'AUTH_FAILED');
      }
      return sendSuccess(res, { message: 'Connection validated', scope });
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const result = await settingsService.updateGstMode(distributorId, req.body.mode);
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Cylinder Thresholds ────────────────────────────────────────────────────

router.get('/cylinder-thresholds/list', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
    const thresholds = await settingsService.getThresholds(distributorId);
    return sendSuccess(res, thresholds);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ─── Approval Workflows ─────────────────────────────────────────────────────

router.get('/approval-workflows/list', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
    const workflows = await settingsService.getApprovalWorkflows(distributorId);
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const result = await settingsService.updateApprovalWorkflows(
        distributorId, req.body.workflows
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
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
    const licenses = await settingsService.listLicenses(distributorId);
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const license = await settingsService.createLicense(distributorId, req.body);
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const license = await settingsService.updateLicense(param(req.params.id), distributorId, req.body);
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
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const result = await settingsService.deleteLicense(param(req.params.id), distributorId);
      if (!result) return sendNotFound(res, 'License');
      return sendSuccess(res, { message: 'License deleted' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
