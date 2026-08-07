import { prisma } from '../src/lib/prisma.js';
import { generateSupplierLedgerPdf } from '../src/services/pdf/supplierLedgerPdfService.js';
import { writeFileSync, mkdirSync } from 'fs';

async function main() {
  const hpcl = await prisma.sourceDistributor.findFirstOrThrow({
    where: { distributorId: 'dist-002', name: 'HPCL', deletedAt: null },
    select: { id: true },
  });
  const pdf = await generateSupplierLedgerPdf('dist-002', hpcl.id, {
    from: '2026-11-01',
    to: '2026-12-31',
  });
  const dir = 'C:/Users/HP/AppData/Local/Temp/claude/C--Projects-Re-New-Gaslink/c7a884dc-68bb-4b04-ab12-1eb44961b905/scratchpad';
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/sharma-hpcl-statement.pdf`;
  writeFileSync(p, pdf);
  console.log(`WROTE ${p} (${pdf.length} bytes)`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
