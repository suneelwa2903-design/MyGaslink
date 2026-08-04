/**
 * One-shot GST filing export.
 *
 * Standalone CLI runner that builds the multi-sheet .xlsx workbook against
 * whatever DATABASE_URL is in the env. Intended for immediate month-end
 * filings where deploying the new /api/reports/gst-filing-export route to
 * prod would be overkill. Same output as the route — same service, same
 * exclusions, same shape.
 *
 * Usage:
 *   pnpm --filter @gaslink/api exec tsx scripts/gst-filing-export-oneshot.ts \
 *     --doc-code VGS --month 2026-07 --out ./vanasthali-jul.xlsx
 *
 * OR by id:
 *   ... --distributor-id 6a749f20-5a82-4b74-9977-51eac69049f2 --month 2026-07 --out ./out.xlsx
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { buildGstFilingExport } from '../src/services/gstFilingExportService.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const docCode = arg('doc-code');
  const distributorIdArg = arg('distributor-id');
  const month = arg('month');
  const out = arg('out');

  if (!month || !out || (!docCode && !distributorIdArg)) {
    console.error('Usage: --month YYYY-MM --out <path> (--doc-code XXX | --distributor-id <uuid>)');
    process.exit(1);
  }

  let distributorId = distributorIdArg;
  if (!distributorId) {
    const d = await prisma.distributor.findFirst({
      where: { docCode: docCode!.toUpperCase() },
      select: { id: true, businessName: true, gstMode: true },
    });
    if (!d) {
      console.error(`No distributor with docCode='${docCode}'`);
      process.exit(2);
    }
    distributorId = d.id;
    console.log(`Distributor: ${d.businessName} (${distributorId}) — gst_mode=${d.gstMode}`);
  }

  const started = Date.now();
  const { buffer, filename } = await buildGstFilingExport({
    distributorId: distributorId!,
    month: month!,
  });
  writeFileSync(out, buffer);
  const ms = Date.now() - started;
  console.log(`Wrote ${out} (${buffer.length} bytes, suggested filename: ${filename}) in ${ms} ms`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FAILED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
