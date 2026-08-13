/**
 * Guard: the shared REPORT_FILTER_SPECS (packages/shared) is the single source
 * of truth for which filter controls each report exposes — imported by BOTH
 * the web ReportsPage and the mobile Reports screen. This test keeps that spec
 * in lock-step with the server report catalog so:
 *   • no inline report ships with the wrong (fallback) filters, and
 *   • no orphan spec lingers for a report that no longer exists.
 *
 * If you add a report to REPORT_CATALOG, add its filter spec to
 * packages/shared/src/constants/reportFilters.ts (and a label to both UIs).
 */
import { describe, it, expect } from 'vitest';
import { REPORT_CATALOG } from '../services/reportsService.js';
import { REPORT_FILTER_SPECS } from '@gaslink/shared';

describe('Report filter specs — web/mobile single source of truth', () => {
  const inlineSlugs = REPORT_CATALOG.filter((e) => e.kind === 'inline').map((e) => e.slug);

  it('every inline catalog report has a filter spec (no silent sales-summary fallback)', () => {
    const missing = inlineSlugs.filter((s) => !(s in REPORT_FILTER_SPECS));
    expect(missing, `inline reports missing a REPORT_FILTER_SPECS entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('every filter spec maps to a real inline catalog report (no orphans)', () => {
    const orphans = Object.keys(REPORT_FILTER_SPECS).filter((k) => !inlineSlugs.includes(k));
    expect(orphans, `filter specs with no catalog entry: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every declared filter key is one the UIs know how to render', () => {
    const known = new Set(['cylinderType', 'driver', 'customer', 'vehicle', 'groupBy', 'entryDate', 'arInterestRate']);
    const bad: string[] = [];
    for (const [slug, spec] of Object.entries(REPORT_FILTER_SPECS)) {
      for (const f of spec.filters) if (!known.has(f)) bad.push(`${slug}:${f}`);
    }
    expect(bad, `unknown filter keys: ${bad.join(', ')}`).toEqual([]);
  });
});
