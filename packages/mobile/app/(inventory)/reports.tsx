/**
 * Phase B3 (2026-06-12) — inventory reports (operational subset).
 *
 * Wraps the named ReportsScreen from (admin)/reports.tsx with a
 * 3-key whitelist: inventory-movement, delivery-performance,
 * sales-summary. The financial reports (outstanding-aging,
 * gst-summary, customer-statement, vehicle-ledger) are intentionally
 * hidden per the Phase B Suneel spec — inventory staff don't manage
 * collections.
 *
 * The named export was introduced in the same commit. The default
 * export at the bottom of admin/reports.tsx still passes no allowedKeys
 * so finance + admin keep all 7.
 */
import { ReportsScreen } from '../(admin)/reports';

const INVENTORY_REPORT_KEYS = [
  'inventory-movement',
  'delivery-performance',
  'sales-summary',
];

export default function InventoryReportsScreen() {
  return <ReportsScreen allowedKeys={INVENTORY_REPORT_KEYS} />;
}
