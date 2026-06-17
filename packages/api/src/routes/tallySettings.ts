/**
 * Tally Setup — GET (admin + finance) and PUT (admin) endpoints.
 *
 * Body validation:
 *  - tallyVersion ∈ {"prime","erp9"}
 *  - tallyCompanyName: nullable or non-empty after trim
 *  - all ledger + voucher type fields: required, non-empty after trim
 *  - stockUnit: required, non-empty after trim
 *  - cylinderStockItems: object with non-empty string values
 *
 * Zod's `safeParse` collects every error in one pass; the validate middleware
 * returns them in `details.fieldErrors` shape so the UI can highlight
 * individual rows. Cross-tenant cylinder-id ownership is checked AFTER Zod
 * passes (it needs a DB lookup) and surfaces as a separate 400 with the
 * offending ids named — same as the route's GST credential validation
 * pattern.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import * as tallyService from '../services/tallySettingsService.js';

const router = Router();

const nonEmptyTrimmed = z
  .string()
  .trim()
  .min(1, 'Required');

const tallySettingsBodySchema = z.object({
  tallyVersion: z.enum(['prime', 'erp9'], {
    errorMap: () => ({ message: 'tallyVersion must be "prime" or "erp9"' }),
  }),
  // Nullable optional. Empty-string from the form is coerced to null at the
  // boundary so the DB column is consistent regardless of how the UI sends it.
  tallyCompanyName: z
    .union([z.string().trim().min(1), z.literal(''), z.null()])
    .transform((v) => (v === '' || v === null ? null : v))
    .optional()
    .transform((v) => v ?? null),
  ledgerSales: nonEmptyTrimmed,
  ledgerCgst: nonEmptyTrimmed,
  ledgerSgst: nonEmptyTrimmed,
  ledgerIgst: nonEmptyTrimmed,
  ledgerCash: nonEmptyTrimmed,
  ledgerBank: nonEmptyTrimmed,
  ledgerSundryDebtors: nonEmptyTrimmed,
  ledgerRoundOff: nonEmptyTrimmed,
  voucherTypeSales: nonEmptyTrimmed,
  voucherTypeReceipt: nonEmptyTrimmed,
  voucherTypeCreditNote: nonEmptyTrimmed,
  voucherTypeDebitNote: nonEmptyTrimmed,
  stockUnit: nonEmptyTrimmed,
  // Map of cylinderTypeId → Tally stock item name. Every value must be a
  // non-empty trimmed string. Ownership of the keys is checked after this
  // schema passes (DB call).
  cylinderStockItems: z.record(z.string().min(1), nonEmptyTrimmed),
});

// GET /api/tally-settings — admin + finance.
router.get(
  '/',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) {
        return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      }
      const eff = await tallyService.getEffective(distributorId);
      const cylinderTypes = await tallyService.getCylinderTypesWithMapping(
        distributorId,
        eff.settings.cylinderStockItems,
      );
      return sendSuccess(res, {
        isConfigured: eff.isConfigured,
        updatedAt: eff.updatedAt?.toISOString() ?? null,
        settings: eff.settings,
        cylinderTypes,
      });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// PUT /api/tally-settings — admin only.
router.put(
  '/',
  requireRole('super_admin', 'distributor_admin'),
  validate(tallySettingsBodySchema),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) {
        return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      }
      const values = req.body as tallyService.TallySettingsValues;

      // Anti-pattern #13 — every cylinderStockItems key must belong to this
      // tenant. Without this, a malicious admin (or a buggy client that
      // somehow learned an id from another tenant) could plant a foreign
      // CylinderType id into our JSON map and then read it back. The body
      // would round-trip cleanly through Zod (which only validates shape).
      const unknown = await tallyService.findUnknownCylinderIds(
        distributorId,
        values.cylinderStockItems,
      );
      if (unknown.length > 0) {
        return sendError(
          res,
          `Unknown cylinder type id(s): ${unknown.join(', ')}`,
          400,
          'UNKNOWN_CYLINDER_TYPE',
        );
      }

      const row = await tallyService.upsert(distributorId, values);
      const cylinderTypes = await tallyService.getCylinderTypesWithMapping(
        distributorId,
        values.cylinderStockItems,
      );
      return sendSuccess(res, {
        isConfigured: true,
        updatedAt: row.updatedAt.toISOString(),
        settings: values,
        cylinderTypes,
      });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
