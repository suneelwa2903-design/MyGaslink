/**
 * Mini-op #7 (2026-07-27) — Quotations routes.
 *
 * Mounted at /api/quotations. Roles allowed for reads + writes:
 *   super_admin / distributor_admin / mini_operator_admin / finance
 * Inventory + driver + customer roles have no access — quoting is a sales
 * task, not an operations task.
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import { z } from 'zod';
import {
  createQuotationSchema,
  updateQuotationSchema,
  listQuotationsQuerySchema,
  localTodayISO,
} from '@gaslink/shared';
import * as service from '../services/quotationService.js';
import { generateQuotationPdf } from '../services/pdf/quotationPdfService.js';

const router = Router();
router.use(requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'));

// GET /api/quotations
router.get('/',
  validateQuery(listQuotationsQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof listQuotationsQuerySchema>;
      const result = await service.listQuotations(req.user!.distributorId!, q);
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// POST /api/quotations
router.post('/',
  validate(createQuotationSchema),
  auditLog('create', 'quotation'),
  async (req, res) => {
    try {
      const created = await service.createQuotation(
        req.user!.distributorId!, req.user!.userId, req.body,
      );
      return sendCreated(res, created);
    } catch (err) {
      if (err instanceof service.QuotationError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/quotations/:id
router.get('/:id', async (req, res) => {
  try {
    const q = await service.getQuotation(req.user!.distributorId!, param(req.params.id));
    return sendSuccess(res, q);
  } catch (err) {
    if (err instanceof service.QuotationError) {
      if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
      return sendError(res, err.message, err.statusCode, err.code);
    }
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/quotations/:id — only drafts editable
router.put('/:id',
  validate(updateQuotationSchema),
  auditLog('update', 'quotation'),
  async (req, res) => {
    try {
      const updated = await service.updateQuotation(
        req.user!.distributorId!, param(req.params.id), req.body,
      );
      return sendSuccess(res, updated);
    } catch (err) {
      if (err instanceof service.QuotationError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// DELETE /api/quotations/:id — only drafts deletable
router.delete('/:id',
  auditLog('delete', 'quotation'),
  async (req, res) => {
    try {
      await service.deleteQuotation(req.user!.distributorId!, param(req.params.id));
      return sendSuccess(res, { id: param(req.params.id), deleted: true });
    } catch (err) {
      if (err instanceof service.QuotationError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// POST /api/quotations/:id/duplicate — clone into a new draft
router.post('/:id/duplicate',
  auditLog('create', 'quotation'),
  async (req, res) => {
    try {
      const clone = await service.duplicateQuotation(
        req.user!.distributorId!, req.user!.userId, param(req.params.id),
        localTodayISO(),
      );
      return sendCreated(res, clone);
    } catch (err) {
      if (err instanceof service.QuotationError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// POST /api/quotations/:id/mark-sent
router.post('/:id/mark-sent',
  auditLog('update', 'quotation'),
  async (req, res) => {
    try {
      const q = await service.markSent(req.user!.distributorId!, param(req.params.id));
      return sendSuccess(res, q);
    } catch (err) {
      if (err instanceof service.QuotationError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

router.post('/:id/mark-accepted',
  auditLog('update', 'quotation'),
  async (req, res) => {
    try {
      const q = await service.markAccepted(req.user!.distributorId!, param(req.params.id));
      return sendSuccess(res, q);
    } catch (err) {
      if (err instanceof service.QuotationError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

router.post('/:id/mark-rejected',
  auditLog('update', 'quotation'),
  async (req, res) => {
    try {
      const q = await service.markRejected(req.user!.distributorId!, param(req.params.id));
      return sendSuccess(res, q);
    } catch (err) {
      if (err instanceof service.QuotationError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/quotations/:id/pdf
router.get('/:id/pdf', async (req, res) => {
  try {
    const pdf = await generateQuotationPdf(req.user!.distributorId!, param(req.params.id));
    const quotation = await service.getQuotation(req.user!.distributorId!, param(req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${quotation.quotationNumber}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    if (err instanceof service.QuotationError) {
      if (err.statusCode === 404) return sendNotFound(res, 'Quotation');
      return sendError(res, err.message, err.statusCode, err.code);
    }
    return sendError(res, (err as Error).message);
  }
});

export default router;
