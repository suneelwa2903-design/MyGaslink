/**
 * probe-cancel-logs.ts (READ-ONLY) — WI investigation into the two B2B
 * IRN cancel attempts from 2026-05-21:
 *   INV-MPFCFGZWUGV (Hyderabad Caterers)
 *   INV-MPFCFGNAOBZ (Maruthi Agencies)
 *
 * Run: pnpm exec tsx --env-file=.env ../../scripts/probe-cancel-logs.ts
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const NUMS = ['INV-MPFCFGZWUGV', 'INV-MPFCFGNAOBZ'];

function trunc(v: any, n = 600): string {
  if (v == null) return '(null)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main() {
  const invoices = await prisma.invoice.findMany({
    where: { invoiceNumber: { in: NUMS } },
    select: {
      id: true, invoiceNumber: true, irn: true, irnStatus: true,
      ewbStatus: true, status: true,
      customer: { select: { businessName: true, gstin: true } },
      gstDocuments: { select: { docType: true, irn: true, ackNo: true, cancelledAt: true, errorCode: true, errorMessage: true, isLatest: true } },
    },
  });

  for (const inv of invoices) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`INVOICE ${inv.invoiceNumber}  (${inv.customer?.businessName} / ${inv.customer?.gstin})`);
    console.log(`  invoiceId   : ${inv.id}`);
    console.log(`  status      : ${inv.status}`);
    console.log(`  irnStatus   : ${inv.irnStatus}`);
    console.log(`  irn         : ${inv.irn ? inv.irn.slice(0, 20) + '…(' + inv.irn.length + ')' : '(null)'}`);
    console.log(`  ewbStatus   : ${inv.ewbStatus}`);
    for (const d of inv.gstDocuments) {
      console.log(`  gstDoc[${d.docType}] latest=${d.isLatest} irn=${d.irn ? d.irn.slice(0, 12) + '…' : '(null)'} ackNo=${d.ackNo ?? '-'} cancelledAt=${d.cancelledAt?.toISOString() ?? '-'} code=${d.errorCode ?? '-'}`);
    }
    console.log('───────────────────────────────────────────────────────────────');

    const logs = await prisma.gstApiLog.findMany({
      where: { invoiceId: inv.id },
      orderBy: { createdAt: 'asc' },
      select: {
        apiType: true, status: true, errorCode: true, errorMessage: true,
        httpStatus: true, latencyMs: true, createdAt: true, responsePayload: true,
      },
    });
    if (logs.length === 0) { console.log('  (no gst_api_logs rows)'); continue; }

    let prev: Date | null = null;
    for (const l of logs) {
      const gap = prev ? `  (+${l.createdAt.getTime() - prev.getTime()}ms)` : '';
      console.log(`\n  ${l.createdAt.toISOString()}${gap}`);
      console.log(`    apiType=${l.apiType}  status=${l.status}  http=${l.httpStatus ?? '-'}  code=${l.errorCode ?? '-'}  ${l.latencyMs}ms`);
      if (l.errorMessage) console.log(`    errMsg : ${trunc(l.errorMessage, 200)}`);
      console.log(`    resp   : ${trunc(l.responsePayload, 500)}`);
      prev = l.createdAt;
    }

    // Cancel-specific timing analysis
    const cancels = logs.filter((l) => l.apiType.includes('CANCEL'));
    const ewbC = cancels.find((l) => l.apiType.includes('EWB'));
    const irnC = cancels.find((l) => l.apiType.includes('IRN') || l.apiType === 'CANCEL');
    console.log('\n  ── CANCEL ANALYSIS ──');
    console.log(`    EWB_CANCEL attempted: ${!!ewbC}  ${ewbC ? `status=${ewbC.status} code=${ewbC.errorCode ?? '-'}` : ''}`);
    console.log(`    IRN_CANCEL attempted: ${!!irnC}  ${irnC ? `status=${irnC.status} code=${irnC.errorCode ?? '-'}` : ''}`);
    if (ewbC && irnC) {
      console.log(`    EWB→IRN gap: ${irnC.createdAt.getTime() - ewbC.createdAt.getTime()}ms`);
    }
  }
}

main()
  .catch((e) => { console.error('PROBE ERROR:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
