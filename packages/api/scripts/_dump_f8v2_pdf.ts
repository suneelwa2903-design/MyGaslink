import { prisma } from '../src/lib/prisma.js';
import { generateSupplierLedgerPdf } from '../src/services/pdf/supplierLedgerPdfService.js';
import { writeFileSync, mkdirSync } from 'fs';

async function main() {
  const iocl = await prisma.sourceDistributor.findFirstOrThrow({
    where: { distributorId: 'dist-001', name: 'IOCL', deletedAt: null },
    select: { id: true },
  });
  const pdf = await generateSupplierLedgerPdf('dist-001', iocl.id, {
    from: '2026-06-01',
    to: '2026-08-15',
  });
  const dir = 'C:/Users/HP/AppData/Local/Temp/claude/C--Projects-Re-New-Gaslink/c7a884dc-68bb-4b04-ab12-1eb44961b905/scratchpad';
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/bhargava-iocl-statement.pdf`;
  writeFileSync(p, pdf);
  console.log(`WROTE ${p} (${pdf.length} bytes)`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
