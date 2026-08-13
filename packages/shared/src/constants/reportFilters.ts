/**
 * Report filter specs — the SINGLE SOURCE OF TRUTH for which filter controls
 * each report exposes (2026-08-13, Suneel).
 *
 * Both the web ReportsPage and the mobile Reports screen import this map so the
 * two surfaces can never drift: a report's filters are declared once, here.
 * The server catalog (REPORT_CATALOG in reportsService.ts) owns labels, buckets
 * and role gating; this owns the UI filter set + `customerRequired`.
 *
 * A guard test asserts every inline report in the catalog has an entry here, so
 * a newly-added report cannot silently ship with the wrong (fallback) filters.
 */
export type ReportFilterKey =
  | 'cylinderType'
  | 'driver'
  | 'customer'
  | 'vehicle'
  | 'groupBy'
  | 'entryDate'
  | 'arInterestRate';

export interface ReportFilterSpec {
  filters: ReportFilterKey[];
  /** When true the report cannot run until a customer is picked. */
  customerRequired?: boolean;
}

export const REPORT_FILTER_SPECS: Record<string, ReportFilterSpec> = {
  // ── Chunk 1 (original 8) ──────────────────────────────────────────────
  'sales-summary': { filters: ['cylinderType'] },
  'outstanding-aging': { filters: [] },
  'gst-summary': { filters: [] },
  'delivery-performance': { filters: ['driver'] },
  'inventory-movement': { filters: ['cylinderType'] },
  'customer-statement': { filters: ['customer'], customerRequired: true },
  'vehicle-ledger': { filters: ['vehicle', 'driver', 'cylinderType', 'groupBy'] },
  'payment-collections': { filters: ['driver', 'entryDate'] },

  // ── Chunk 2 · Daily Book ──────────────────────────────────────────────
  'day-close-summary': { filters: [] },
  'daily-sales': { filters: ['cylinderType'] },
  'driver-daily-log': { filters: ['driver'] },

  // ── Chunk 3a · Inventory / Customers / Expenses ───────────────────────
  'deposit-ledger-by-customer': { filters: ['customer'] },
  'stock-adjustment-audit-log': { filters: ['cylinderType'] },
  'expense-register': { filters: [] },

  // ── Chunk 3b · Invoicing & Payments ───────────────────────────────────
  'credit-notes-register': { filters: [] },
  'debit-notes-register': { filters: [] },
  'opening-balance-certificates-register': { filters: [] },

  // ── Chunk 4 · mixed ───────────────────────────────────────────────────
  'cylinder-rotation': { filters: ['customer', 'cylinderType'] },
  'driver-vehicle-cost-breakdown': { filters: ['driver'] },
  'empties-in-transit': { filters: ['cylinderType'] },
  'payment-method-mix': { filters: [] },
  'rate-variance-leakage': { filters: ['customer', 'cylinderType'] },
  'cash-book': { filters: [] },
  'cashflow-statement': { filters: [] },
  'expenses-by-category-trend': { filters: [] },
  'accountability-log-report': { filters: ['driver', 'customer', 'cylinderType'] },
  'gst-reconciliation': { filters: [] },
  'gstr-3b-preview': { filters: [] },
  'customer-profitability': { filters: ['arInterestRate'] },

  // ── F8v2-R · Corporation bucket ───────────────────────────────────────
  'corp-landed-cost-trend': { filters: ['cylinderType'] },
  'corp-statement-register': { filters: [] },
  'corp-purchase-vs-sale-margin': { filters: ['cylinderType'] },
  'corp-batch-cost-vs-price': { filters: [] },
  'corp-supplier-payment-aging': { filters: [] },
  'corp-landed-cost-reconciliation': { filters: ['cylinderType'] },
};

/** Filters for a report key, defaulting to none (never the wrong fallback). */
export function reportFilterSpec(key: string): ReportFilterSpec {
  return REPORT_FILTER_SPECS[key] ?? { filters: [] };
}
