import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { gstCredentialsSchema, gstModeSchema, approvalWorkflowSchema, IFSC_REGEX, UPI_REGEX } from '@gaslink/shared';
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
        select: {
          gstMode: true,
          docCode: true,
          goLiveDate: true,
          // Phase 3 (2026-06-12): bank + UPI surfaced so the Settings page
          // can render the Payment Details section and prefill the inputs.
          bankName: true,
          bankAccountNumber: true,
          bankBranchName: true,
          ifscCode: true,
          upiId: true,
        },
      }),
      settingsService.getGstCredentials(distributorId, 'einvoice'),
    ]);
    return sendSuccess(res, {
      distributorId,
      gstMode: distributor?.gstMode ?? null,
      gstCredentials: gstCred ?? null,
      docCode: distributor?.docCode ?? null,
      // Group 5 (2026-06-11): exposed read-only here so distributor admins
      // can see their go-live date. Writes go through PUT /api/distributors
      // /:id/go-live-date (super-admin only).
      goLiveDate: distributor?.goLiveDate?.toISOString().split('T')[0] ?? null,
      // Phase 3 (2026-06-12): bank + UPI for the Payment Details section.
      bankName: distributor?.bankName ?? null,
      bankAccountNumber: distributor?.bankAccountNumber ?? null,
      bankBranchName: distributor?.bankBranchName ?? null,
      ifscCode: distributor?.ifscCode ?? null,
      upiId: distributor?.upiId ?? null,
      rawSettings,
    });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// WI-108: structured-numbering tenant code. Registered BEFORE the generic
// `/:key` routes so "doc-code" isn't swallowed as a JSONB setting key.
router.put('/doc-code',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  validate(z.object({ docCode: z.string().trim().regex(/^[A-Z]{3}$/, 'Must be exactly 3 uppercase letters (A–Z)') })),
  auditLog('upsert', 'doc_code'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const docCode: string = req.body.docCode;
      const { prisma } = await import('../lib/prisma.js');
      // Globally unique — reject if another tenant already owns the code.
      const clash = await prisma.distributor.findFirst({
        where: { docCode, id: { not: distributorId } },
        select: { id: true },
      });
      if (clash) {
        return sendError(res, 'This invoice code is already in use by another distributor', 409, 'DOC_CODE_TAKEN');
      }
      const updated = await prisma.distributor.update({
        where: { id: distributorId },
        data: { docCode },
        select: { docCode: true },
      });
      return sendSuccess(res, updated);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// Phase 3 (2026-06-12): bank + UPI payment details. Open to
// distributor_admin (so they can self-service their own bank info) AND
// super_admin (cross-tenant edits when onboarding). Validation lives in
// the local Zod schema below — IFSC and UPI are checked only when
// non-empty. Empty strings clear the field (write as NULL via service
// normalisation in distributorService.updateDistributor).
router.put('/payment-details',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  validate(z.object({
    bankName: z.string().max(100).optional().or(z.literal('')),
    bankAccountNumber: z.string().max(30).optional().or(z.literal('')),
    bankBranchName: z.string().max(100).optional().or(z.literal('')),
    ifscCode: z.string().regex(IFSC_REGEX, 'Invalid IFSC code format (expected 11 characters, e.g. HDFC0001234)').optional().or(z.literal('')),
    upiId: z.string().regex(UPI_REGEX, 'Invalid UPI ID format (expected e.g. gasagency@hdfc)').optional().or(z.literal('')),
  })),
  auditLog('update', 'distributor'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const distributorService = await import('../services/distributorService.js');
      const updated = await distributorService.updateDistributor(distributorId, req.body);
      return sendSuccess(res, {
        bankName: updated.bankName,
        bankAccountNumber: updated.bankAccountNumber,
        bankBranchName: updated.bankBranchName,
        ifscCode: updated.ifscCode,
        upiId: updated.upiId,
      });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

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
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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
  // Group A Step 6: locked down. The activation flow at
  // POST /api/admin/distributors/:id/gst/activate is the canonical path for
  // setting/rotating credentials. This endpoint is preserved for super-admin
  // emergency use (single-scope re-test, etc).
  requireRole('super_admin'),
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
  // Group A Step 6: locked down — see /gst/credentials route comment above.
  requireRole('super_admin'),
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
      } catch (authErr: unknown) {
        // authenticate() already set isValid=true on success; on failure
        // ensure the row reflects "broken" so callers don't think these
        // are usable.
        await settingsService.markGstCredentialsInvalid(distributorId, scope);
        return sendError(
          res,
          (authErr instanceof Error ? authErr.message : '') || 'WhiteBooks authentication failed',
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

// WI-042 / WI-054: Test Connection.
//
// Two-stage probe — see [docs/specs/WI-054-test-connection-fix.md]:
//   Stage 1 — WhiteBooks auth (force fresh, bypass token cache).
//   Stage 2 — NIC reachability via a read-only GSTNDETAILS ping on the
//             distributor's own GSTIN (einvoice scope only).
//
// Returns a structured envelope so the UI can render two distinct
// indicators instead of conflating "credentials are valid" with
// "NIC IRP will accept work". A green Test Connection here means BOTH
// hops are healthy — the 2026-05-15 outage (auth green, NIC IRN 5002)
// surfaced as a false positive under the old endpoint shape.
router.post('/gst/credentials/:scope/test',
  // Group A Step 6: locked down — see /gst/credentials route comment above.
  // The new activation flow uses POST /api/admin/distributors/:id/gst/test-connection
  // which accepts body-supplied creds (no DB read). This endpoint stays for
  // super-admin re-testing of already-saved credentials.
  requireRole('super_admin'),
  auditLog('test_connection', 'gst_credentials'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const scope = param(req.params.scope);
      if (scope !== 'einvoice' && scope !== 'ewaybill') {
        return sendError(res, 'Scope must be einvoice or ewaybill', 400, 'BAD_SCOPE');
      }

      const { getAuthToken, clearTokenCache } = await import('../services/gst/whitebooksClient.js');

      // Force a fresh auth call regardless of cache state. Without this,
      // a still-valid token returns success without ever hitting
      // WhiteBooks — which masked the 2026-05-16 outage where the email
      // got deregistered upstream but our cached token still said OK.
      clearTokenCache(distributorId);

      // Default to "both failed" and flip the flags as each stage passes.
      // Always return 200 — the failure is captured in the booleans, not
      // an HTTP error. UI renders both indicators regardless.
      let authenticated = false;
      let nicReachable = false;
      let authError: string | undefined;
      let nicError: string | undefined;

      // Stage 1 — WhiteBooks auth
      try {
        await getAuthToken(distributorId, scope);
        authenticated = true;
      } catch (authErr: unknown) {
        authError = (authErr instanceof Error ? authErr.message : '') || 'WhiteBooks authentication failed';
        await settingsService.markGstCredentialsInvalid(distributorId, scope);
      }

      // Stage 2 — NIC reachability (einvoice scope only).
      //
      // For `ewaybill`, the authenticate endpoint itself touches the NIC
      // EWB portal, so a green auth in Stage 1 already implies NIC is
      // reachable. We mirror that into `nicReachable` to keep the
      // response shape symmetric.
      if (authenticated) {
        if (scope === 'ewaybill') {
          nicReachable = true;
        } else {
          try {
            const { getDistributorGstin } = await import('../services/settingsService.js');
            const ownGstin = await getDistributorGstin(distributorId);
            if (!ownGstin) {
              nicError = 'Distributor has no GSTIN configured — cannot probe NIC';
            } else {
              const { validateGstin } = await import('../services/gst/gstService.js');
              const lookup = await validateGstin(distributorId, ownGstin);
              if (lookup && lookup.valid === false) {
                const errText: string = ('error' in lookup ? lookup.error : '') || '';
                // NIC error 1005 ("Invalid Token") on the GSTNDETAILS endpoint
                // means NIC DID respond — the sandbox GSTN lookup path has a
                // different session-token requirement from the IRN generation
                // path (GENERATE/CANCEL/GETIRN). We've confirmed the IRN path
                // works with the same token (live dispatches on 2026-05-20).
                // Treat 1005 as "NIC is reachable" so Test Connection shows
                // green; the IRN flow is unaffected. A true connectivity
                // failure (timeout, 5002 Application error, DNS) is not 1005
                // and will still surface as red.
                if (errText.includes('1005') || errText.toLowerCase().includes('invalid token')) {
                  nicReachable = true;
                } else {
                  nicError = `NIC GSTNDETAILS rejected: ${errText || 'unknown error'}`;
                }
              } else {
                nicReachable = true;
              }
            }
          } catch (nicErr: unknown) {
            nicError = (nicErr instanceof Error ? nicErr.message : '') || 'NIC GSTNDETAILS call failed';
          }
        }
      }

      // Build the human-readable summary. Front-end renders the two
      // booleans directly; this string is the screen-reader / log copy.
      const message =
        authenticated && nicReachable
          ? 'WhiteBooks auth OK, NIC responding'
          : authenticated
            ? 'WhiteBooks auth OK, NIC unreachable'
            : 'WhiteBooks auth failed';

      return sendSuccess(res, {
        scope,
        authenticated,
        nicReachable,
        message,
        authError,
        nicError,
      });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

router.put('/gst/mode',
  // Group A Step 6: locked down. The activation flow at
  // POST /api/admin/distributors/:id/gst/{activate,disable} is the canonical
  // path for mode changes. This endpoint is kept for super-admin emergency
  // direct toggles (e.g. force-disable a misconfigured tenant); it still
  // runs the sandbox allowlist + live-to-sandbox guards via updateGstMode.
  requireRole('super_admin'),
  validate(gstModeSchema),
  auditLog('update', 'gst_mode'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const result = await settingsService.updateGstMode(distributorId, req.body.mode);
      return sendSuccess(res, result);
    } catch (err) {
      // Group A: surface transition guards as 400 with the guard's code.
      const { GstTransitionError } = await import('../services/gst/transitionGuards.js');
      if (err instanceof GstTransitionError) {
        return sendError(res, err.message, 400, err.code);
      }
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
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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
