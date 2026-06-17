/**
 * Tally Setup — per-tenant accounting export config (WI 2026-06-17).
 *
 * Drives the Tally XML export on the Reports page. The service is intentionally
 * thin: a single `getEffective` fetches the row (or returns defaults), a
 * single `upsert` writes it back, and a single `getCylinderTypes` fetches
 * the active cylinder types the UI / payload builder needs to render the
 * mapping table.
 *
 * All queries are tenant-scoped on `distributorId` (anti-pattern #1/#13).
 * Cross-tenant validation on `cylinderStockItems` keys lives in `upsert`
 * — Zod handles shape; only the DB knows which CylinderType ids are owned
 * by which tenant, so the ownership check has to live here.
 */
import { prisma } from '../lib/prisma.js';
import type { TallySettings } from '@prisma/client';

export interface TallySettingsValues {
  tallyVersion: 'prime' | 'erp9';
  tallyCompanyName: string | null;
  ledgerSales: string;
  ledgerCgst: string;
  ledgerSgst: string;
  ledgerIgst: string;
  ledgerCash: string;
  ledgerBank: string;
  ledgerSundryDebtors: string;
  ledgerRoundOff: string;
  voucherTypeSales: string;
  voucherTypeReceipt: string;
  voucherTypeCreditNote: string;
  voucherTypeDebitNote: string;
  stockUnit: string;
  cylinderStockItems: Record<string, string>;
}

/**
 * Defaults applied when no TallySettings row exists yet. Mirrored from the
 * Prisma schema column defaults so the export service can run against a
 * brand-new tenant without an isConfigured row. Kept in code (not derived
 * from Prisma at runtime) because every consumer needs synchronous access.
 */
export const TALLY_DEFAULTS: TallySettingsValues = {
  tallyVersion: 'prime',
  tallyCompanyName: null,
  ledgerSales: 'Sales',
  ledgerCgst: 'Output CGST',
  ledgerSgst: 'Output SGST',
  ledgerIgst: 'Output IGST',
  ledgerCash: 'Cash',
  ledgerBank: 'Bank Account',
  ledgerSundryDebtors: 'Sundry Debtors',
  ledgerRoundOff: 'Round Off',
  voucherTypeSales: 'Sales',
  voucherTypeReceipt: 'Receipt',
  voucherTypeCreditNote: 'Credit Note',
  voucherTypeDebitNote: 'Debit Note',
  stockUnit: 'NOS',
  cylinderStockItems: {},
};

/**
 * Coerce a stored TallySettings row (which has Json `cylinderStockItems`
 * and a Date `updatedAt`) into the API-facing shape. Centralised so route
 * + tests + the export service all see the same field set.
 */
function rowToValues(row: TallySettings): TallySettingsValues {
  return {
    tallyVersion: row.tallyVersion as 'prime' | 'erp9',
    tallyCompanyName: row.tallyCompanyName,
    ledgerSales: row.ledgerSales,
    ledgerCgst: row.ledgerCgst,
    ledgerSgst: row.ledgerSgst,
    ledgerIgst: row.ledgerIgst,
    ledgerCash: row.ledgerCash,
    ledgerBank: row.ledgerBank,
    ledgerSundryDebtors: row.ledgerSundryDebtors,
    ledgerRoundOff: row.ledgerRoundOff,
    voucherTypeSales: row.voucherTypeSales,
    voucherTypeReceipt: row.voucherTypeReceipt,
    voucherTypeCreditNote: row.voucherTypeCreditNote,
    voucherTypeDebitNote: row.voucherTypeDebitNote,
    stockUnit: row.stockUnit,
    cylinderStockItems:
      // Json column is `unknown`; safe to coerce here because the writer
      // enforces `Record<string, string>` shape via Zod + the cross-tenant
      // check below.
      (row.cylinderStockItems as Record<string, string>) ?? {},
  };
}

/** Fetch the row (or null if not yet configured). Tenant-scoped. */
export async function getRow(distributorId: string): Promise<TallySettings | null> {
  return prisma.tallySettings.findUnique({ where: { distributorId } });
}

/**
 * Returns settings + isConfigured flag + the canonical updatedAt timestamp.
 * isConfigured reflects DB-row existence, NOT field comparison — a row
 * that was saved and then reset to defaults still counts as configured.
 */
export async function getEffective(distributorId: string): Promise<{
  isConfigured: boolean;
  settings: TallySettingsValues;
  updatedAt: Date | null;
}> {
  const row = await getRow(distributorId);
  if (!row) {
    return { isConfigured: false, settings: TALLY_DEFAULTS, updatedAt: null };
  }
  return { isConfigured: true, settings: rowToValues(row), updatedAt: row.updatedAt };
}

/**
 * Active cylinder types for this tenant, ordered by typeName ASC, with
 * the mapped Tally name resolved (cylinderStockItems[id] → typeName).
 * Used by both the Settings UI (to render mapping rows) and the GET / PUT
 * response.
 */
export async function getCylinderTypesWithMapping(
  distributorId: string,
  cylinderStockItems: Record<string, string>,
): Promise<Array<{ id: string; typeName: string; capacity: number; mappedTallyName: string }>> {
  const types = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    orderBy: { typeName: 'asc' },
    select: { id: true, typeName: true, capacity: true },
  });
  return types.map((t) => ({
    id: t.id,
    typeName: t.typeName,
    capacity: t.capacity,
    mappedTallyName: cylinderStockItems[t.id]?.trim() || t.typeName,
  }));
}

/**
 * Verify every key in cylinderStockItems is a CylinderType id owned by
 * THIS distributor (anti-pattern #13 — a leaked cylinder id from another
 * tenant must not slip into the JSON). Returns the unknown ids so the
 * route can name them in the 400 response.
 */
export async function findUnknownCylinderIds(
  distributorId: string,
  cylinderStockItems: Record<string, string>,
): Promise<string[]> {
  const ids = Object.keys(cylinderStockItems);
  if (ids.length === 0) return [];
  const owned = await prisma.cylinderType.findMany({
    where: { distributorId, id: { in: ids } },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((c) => c.id));
  return ids.filter((id) => !ownedSet.has(id));
}

/** Upsert (always full replace — the PUT payload is the entire form state). */
export async function upsert(
  distributorId: string,
  values: TallySettingsValues,
): Promise<TallySettings> {
  return prisma.tallySettings.upsert({
    where: { distributorId },
    create: {
      distributorId,
      ...values,
      // Prisma's Json input type is broader than Record<string,string>;
      // the cross-tenant check above gates this.
      cylinderStockItems: values.cylinderStockItems,
    },
    update: {
      ...values,
      cylinderStockItems: values.cylinderStockItems,
    },
  });
}
