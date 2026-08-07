/**
 * Saved Reports + Report Builder routes (Phase 2 · 2026-08-05).
 *
 * Endpoints:
 *   GET    /api/saved-reports              List user's saved + tenant-shared reports
 *   POST   /api/saved-reports              Create a new saved report
 *   GET    /api/saved-reports/:id          Get one saved report by id
 *   PUT    /api/saved-reports/:id          Update name/description/visibility/spec
 *   DELETE /api/saved-reports/:id          Soft-delete (owner only)
 *   POST   /api/saved-reports/:id/run      Execute a saved report + return results
 *   POST   /api/saved-reports/preview      Execute a one-off spec WITHOUT saving
 *                                          (used by the builder's live preview)
 *
 * All routes require an authenticated user with a Builder-eligible role
 * (super_admin | distributor_admin | finance | inventory | mini_operator_admin).
 *
 * Tenant scope: every read/write filters by req.user.distributorId.
 * Execution: every run also enforces distributorId via the executor's
 * base-where injection (defence in depth).
 */

import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/apiResponse.js';
import { validate } from '../middleware/validate.js';
import { REPORT_BUILDER_SPEC, CREATE_SAVED_REPORT, UPDATE_SAVED_REPORT } from '../services/reportBuilder/spec.js';
import { executeReportBuilderSpec, type ExecutorContext } from '../services/reportBuilder/executor.js';
import { isRoleAllowedForBuilder } from '../services/reportBuilder/allowlist.js';
import type { ReportBuilderModel, ReportBuilderSpec } from '@gaslink/shared';

const router = Router();

const BUILDER_ROLES = ['super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'] as const;

// Every route below requires a Builder-eligible role.
router.use(requireRole(...BUILDER_ROLES));

// ─── GET /api/saved-reports ──────────────────────────────────────────
// List reports the user can see: their own (any visibility) + everyone
// else's DISTRIBUTOR-visible reports in the same tenant.
router.get('/', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId!;
    const userId = req.user!.userId;
    const rows = await prisma.savedReport.findMany({
      where: {
        distributorId,
        deletedAt: null,
        OR: [
          { ownerId: userId },
          { visibility: 'distributor' },
        ],
      },
      orderBy: [{ updatedAt: 'desc' }],
    });
    return sendSuccess(res, { savedReports: rows.map(toDto) });
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
});

// ─── GET /api/saved-reports/:id ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId!;
    const userId = req.user!.userId;
    const row = await prisma.savedReport.findFirst({
      where: {
        id: String(req.params.id),
        distributorId,
        deletedAt: null,
        OR: [{ ownerId: userId }, { visibility: 'distributor' }],
      },
    });
    if (!row) return sendNotFound(res, 'Saved report');
    return sendSuccess(res, toDto(row));
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
});

// ─── POST /api/saved-reports ─────────────────────────────────────────
router.post('/', validate(CREATE_SAVED_REPORT), async (req, res) => {
  try {
    const distributorId = req.user!.distributorId!;
    const userId = req.user!.userId;
    const role = req.user!.role;
    const body = req.body as {
      name: string;
      description?: string | null;
      visibility?: 'private' | 'distributor';
      spec: ReportBuilderSpec;
    };
    if (!isRoleAllowedForBuilder(role)) {
      return sendError(res, 'Report Builder is not available for your role', 403);
    }
    const created = await prisma.savedReport.create({
      data: {
        distributorId,
        ownerId: userId,
        name: body.name,
        description: body.description ?? null,
        model: body.spec.model,
        spec: body.spec as unknown as object,
        visibility: body.visibility ?? 'private',
      },
    });
    return sendSuccess(res, toDto(created), 201);
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
});

// ─── PUT /api/saved-reports/:id ──────────────────────────────────────
// Only the owner can edit.
router.put('/:id', validate(UPDATE_SAVED_REPORT), async (req, res) => {
  try {
    const distributorId = req.user!.distributorId!;
    const userId = req.user!.userId;
    const existing = await prisma.savedReport.findFirst({
      where: { id: String(req.params.id), distributorId, deletedAt: null },
    });
    if (!existing) return sendNotFound(res, 'Saved report');
    if (existing.ownerId !== userId) {
      return sendError(res, 'Only the owner can edit this report', 403);
    }
    const body = req.body as {
      name?: string;
      description?: string | null;
      visibility?: 'private' | 'distributor';
      spec?: ReportBuilderSpec;
    };
    const updated = await prisma.savedReport.update({
      where: { id: String(req.params.id) },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.visibility !== undefined && { visibility: body.visibility }),
        ...(body.spec !== undefined && {
          model: body.spec.model,
          spec: body.spec as unknown as object,
        }),
      },
    });
    return sendSuccess(res, toDto(updated));
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
});

// ─── DELETE /api/saved-reports/:id ───────────────────────────────────
// Owner-only. Soft-delete (deletedAt stamped).
router.delete('/:id', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId!;
    const userId = req.user!.userId;
    const existing = await prisma.savedReport.findFirst({
      where: { id: String(req.params.id), distributorId, deletedAt: null },
    });
    if (!existing) return sendNotFound(res, 'Saved report');
    if (existing.ownerId !== userId) {
      return sendError(res, 'Only the owner can delete this report', 403);
    }
    await prisma.savedReport.update({
      where: { id: String(req.params.id) },
      data: { deletedAt: new Date() },
    });
    return sendSuccess(res, { ok: true });
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
});

// ─── POST /api/saved-reports/preview ─────────────────────────────────
// One-off run for the builder's live-preview panel. Does NOT save.
router.post('/preview', validate(REPORT_BUILDER_SPEC), async (req, res) => {
  try {
    const distributorId = req.user!.distributorId!;
    const userId = req.user!.userId;
    const role = req.user!.role;
    const spec = req.body as import('../services/reportBuilder/spec.js').ValidatedReportBuilderSpec;
    const ctx: ExecutorContext = { distributorId, userId, role };
    const result = await executeReportBuilderSpec(spec, ctx);
    return sendSuccess(res, result);
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return sendError(res, e.message, e.statusCode ?? 500);
  }
});

// ─── POST /api/saved-reports/:id/run ─────────────────────────────────
// Execute a stored saved report. Enforces the SAME allowlist gates as
// preview — a shared distributor-visible report still executes under
// the CALLER's role (not the owner's), so hiding money fields for
// inventory role is enforced consistently.
router.post('/:id/run', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId!;
    const userId = req.user!.userId;
    const role = req.user!.role;
    const stored = await prisma.savedReport.findFirst({
      where: {
        id: String(req.params.id),
        distributorId,
        deletedAt: null,
        OR: [{ ownerId: userId }, { visibility: 'distributor' }],
      },
    });
    if (!stored) return sendNotFound(res, 'Saved report');
    // Re-validate the stored spec at run time (belt-and-braces against
    // schema drift: an old saved report might reference a field that
    // the allowlist has since removed).
    const parseResult = REPORT_BUILDER_SPEC.safeParse(stored.spec);
    if (!parseResult.success) {
      return sendError(res, `Saved report has an invalid spec: ${parseResult.error.message}`, 400);
    }
    const start = Date.now();
    const result = await executeReportBuilderSpec(parseResult.data, { distributorId, userId, role });
    // Log the run for audit (best-effort — failure doesn't fail the response).
    void prisma.savedReportRun.create({
      data: {
        savedReportId: stored.id,
        runBy: userId,
        durationMs: Date.now() - start,
        rowCount: result.rows.length,
      },
    }).catch(() => { /* audit-only */ });
    return sendSuccess(res, result);
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return sendError(res, e.message, e.statusCode ?? 500);
  }
});

// ─── DTO mapper ──────────────────────────────────────────────────────

function toDto(row: {
  id: string; distributorId: string; ownerId: string;
  name: string; description: string | null; model: string;
  spec: unknown; visibility: string;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: row.id,
    distributorId: row.distributorId,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    model: row.model as ReportBuilderModel,
    spec: row.spec as ReportBuilderSpec,
    visibility: row.visibility as 'private' | 'distributor',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default router;
