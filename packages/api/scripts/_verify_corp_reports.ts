/**
 * F8v2-R end-to-end verification of all 5 Corporation reports against
 * Bhargava (GST-disabled) + Sharma (GST-live) seeded data.
 */
import { prisma } from '../src/lib/prisma.js';
import { REPORTS, REPORT_CATALOG, REPORT_BUCKETS } from '../src/services/reportsService.js';

async function runReport(distId: string, slug: string, filters: Record<string, string> = {}) {
  const fn = REPORTS[slug];
  if (!fn) throw new Error(`No report: ${slug}`);
  const result = await fn(distId, filters as never);
  return result;
}

async function main() {
  console.log('━'.repeat(76));
  console.log('F8v2-R Corporation Reports — end-to-end verification');
  console.log('━'.repeat(76));

  // Verify bucket + catalog wiring
  const corpBucket = REPORT_BUCKETS.find((b) => b.key === 'corporation');
  console.log(`\nBucket check: ${corpBucket ? '✓' : '✗'} "${corpBucket?.label}"`);
  const corpEntries = REPORT_CATALOG.filter((e) => e.bucket === 'corporation');
  console.log(`Catalog entries: ${corpEntries.length} (target: 5)`);
  for (const e of corpEntries) {
    console.log(`  • ${e.slug}  →  ${e.label}`);
  }

  const slugs = [
    'corp-landed-cost-trend',
    'corp-statement-register',
    'corp-purchase-vs-sale-margin',
    'corp-supplier-payment-aging',
    'corp-landed-cost-reconciliation',
  ];

  for (const distId of ['dist-001', 'dist-002']) {
    const tenant = distId === 'dist-001' ? 'Bhargava (GST-disabled)' : 'Sharma (GST-live)';
    console.log('\n' + '─'.repeat(76));
    console.log(`Tenant: ${tenant}`);
    console.log('─'.repeat(76));

    for (const slug of slugs) {
      try {
        const result = await runReport(distId, slug, { dateFrom: '2026-04-01', dateTo: '2026-12-31' });
        const cols = result.columns.map((c) => c.key).join(', ');
        console.log(`  ✓ ${slug.padEnd(40)}  rows=${String(result.rows.length).padStart(3)}  chart=${result.chart ? 'YES' : 'no '}  totals=${result.totals ? 'YES' : 'no '}`);
        if (result.rows.length > 0) {
          console.log(`      cols: ${cols}`);
          console.log(`      row[0]: ${JSON.stringify(result.rows[0])}`);
        }
      } catch (err) {
        console.log(`  ✗ ${slug}: ${(err as Error).message}`);
      }
    }
  }

  console.log('\n' + '━'.repeat(76));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
