/**
 * Smoke check — run every catalog report against seeded data and log
 * a summary line per report (rows / columns / duration / OK/FAIL).
 *
 * Usage: pnpm exec tsx scripts/smoke-check-reports.ts
 */

import { REPORTS, getReportCatalog } from '../src/services/reportsService.js';
import type { ReportFilters } from '../src/services/reportsService.js';
import { UserRole } from '@gaslink/shared';

const DISTRIBUTOR_ID = 'dist-002';
const DATE_FROM = '2025-08-01';
const DATE_TO = '2026-08-05';

async function main(): Promise<void> {
  console.log(`\n=== Smoke check — all inline catalog reports for dist-002 ===`);
  console.log(`Range: ${DATE_FROM} → ${DATE_TO}\n`);

  const catalog = getReportCatalog(UserRole.DISTRIBUTOR_ADMIN);
  const inlineEntries = catalog.entries.filter((e) => e.kind === 'inline');
  const results: Array<{ slug: string; rows: number; cols: number; ms: number; ok: boolean; err?: string }> = [];

  const { prisma } = await import('../src/lib/prisma.js');
  const anyCustomer = await prisma.customer.findFirst({
    where: { distributorId: DISTRIBUTOR_ID, deletedAt: null },
    select: { id: true },
  });
  const customerId = anyCustomer?.id;

  for (const entry of inlineEntries) {
    const fn = REPORTS[entry.slug];
    if (!fn) {
      results.push({ slug: entry.slug, rows: 0, cols: 0, ms: 0, ok: false, err: 'no service function' });
      continue;
    }
    const filters: ReportFilters = { dateFrom: DATE_FROM, dateTo: DATE_TO };
    if (entry.requires === 'customer' && customerId) filters.customerId = customerId;

    const t0 = Date.now();
    try {
      const result = await fn(DISTRIBUTOR_ID, filters);
      const ms = Date.now() - t0;
      results.push({
        slug: entry.slug,
        rows: result.rows.length,
        cols: result.columns.length,
        ms,
        ok: true,
      });
    } catch (e) {
      const ms = Date.now() - t0;
      results.push({ slug: entry.slug, rows: 0, cols: 0, ms, ok: false, err: (e as Error).message });
    }
  }

  const w = (s: string, n: number): string => s.padEnd(n);
  console.log(w('Slug', 42), w('Rows', 8), w('Cols', 6), w('ms', 6), 'Status');
  console.log('─'.repeat(80));
  for (const r of results) {
    console.log(
      w(r.slug, 42),
      w(String(r.rows), 8),
      w(String(r.cols), 6),
      w(String(r.ms), 6),
      r.ok ? '✓ OK' : `✗ ${r.err}`,
    );
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount}/${results.length} inline reports rendered successfully.`);
  console.log(`Total catalog entries: ${catalog.entries.length} (${inlineEntries.length} inline + ${catalog.entries.length - inlineEntries.length} download/external).\n`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
