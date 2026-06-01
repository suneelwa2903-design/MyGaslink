/**
 * One-shot verifier — runs through the same data the PDF + IRN payload
 * builders consume for a given invoice and prints the resulting numbers.
 * Use to sanity-check the GROUP-1 / AP-16 backfill.
 *
 *   pnpm tsx scripts/verify-gst-fix.ts <invoice-id>
 */
import { prisma } from '../src/lib/prisma.js';
import { buildIrnPayload } from '../src/services/gst/payloadBuilders.js';

// Mirror of invoicePdfService.computeItems' per-line math (the function
// is not exported). Keep in sync with the source if it changes.
function round2(n: number) { return Math.round(n * 100) / 100; }
function pdfLine(it: { quantity: number; unitPrice: number; discountPerUnit: number; gstRate: number }) {
  const up = it.unitPrice;
  const grossInclusive = round2(up * it.quantity);
  const discountAmt = round2(it.discountPerUnit * it.quantity);
  const afterDiscount = round2(grossInclusive - discountAmt);
  const taxable = round2(afterDiscount / (1 + it.gstRate / 100));
  const gstAmt = round2(afterDiscount - taxable);
  const baseRate = round2(up / (1 + it.gstRate / 100));
  return { baseRate, taxable, gstAmt, totalIncl: afterDiscount };
}

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId) {
    console.error('Usage: pnpm tsx scripts/verify-gst-fix.ts <invoice-id>');
    process.exit(1);
  }
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: { include: { cylinderType: true } },
      customer: true,
    },
  });
  if (!invoice) {
    console.error('Invoice not found:', invoiceId);
    process.exit(1);
  }

  console.log('\n=== INVOICE ===');
  console.log('Number:', invoice.invoiceNumber);
  console.log('totalAmount:', Number(invoice.totalAmount));
  console.log('cgst+sgst:', Number(invoice.cgstValue) + Number(invoice.sgstValue));
  console.log('igst:', Number(invoice.igstValue));

  console.log('\n=== INVOICE ITEMS (post-backfill) ===');
  for (const it of invoice.items) {
    console.log(`  [${it.cylinderType?.typeName ?? '—'}] qty=${it.quantity} unitPrice=${Number(it.unitPrice)} discount=${Number(it.discountPerUnit)} totalPrice=${Number(it.totalPrice)}`);
  }

  console.log('\n=== PDF per-line math (mirrors invoicePdfService) ===');
  for (const it of invoice.items) {
    const r = pdfLine({
      quantity: it.quantity,
      unitPrice: Number(it.unitPrice),
      discountPerUnit: Number(it.discountPerUnit),
      gstRate: it.gstRate,
    });
    console.log(`  [${it.cylinderType?.typeName ?? '—'}] baseRate=${r.baseRate}  taxable=${r.taxable}  gstAmt=${r.gstAmt}  totalIncl=${r.totalIncl}`);
  }

  // Mirror the gstService.processInvoiceGst feeder.
  const irnPayload = buildIrnPayload({
    docType: 'INV',
    docNumber: invoice.invoiceNumber,
    docDate: invoice.issueDate,
    seller: {
      gstin: '29AAGCB1286Q000',
      legalName: 'Sharma Gas Distributors',
      tradeName: 'Sharma',
      address: '123 Road',
      city: 'Bangalore',
      pincode: '560001',
      state: 'Karnataka',
      stateCode: '29',
    },
    buyer: {
      gstin: invoice.customer?.gstin || null,
      legalName: invoice.customer?.businessName || invoice.customer?.customerName || 'Customer',
      tradeName: invoice.customer?.customerName ?? undefined,
      address: invoice.customer?.billingAddressLine1 || '',
      city: invoice.customer?.billingCity || '',
      pincode: invoice.customer?.billingPincode || '',
      state: invoice.customer?.billingState || '',
      stateCode: '29',
    },
    items: invoice.items.map((it, i) => ({
      slNo: i + 1,
      description: it.description ?? 'LPG',
      hsnCode: it.hsnCode ?? '27111900',
      quantity: it.quantity,
      unit: 'NOS',
      unitPrice: Number(it.unitPrice),
      discountPerUnit: Number(it.discountPerUnit),
      gstRate: it.gstRate,
    })),
    isInterState: false,
  });

  console.log('\n=== IRN PAYLOAD ValDtls (what NIC sees) ===');
  console.log('  AssVal      =', irnPayload.ValDtls.AssVal);
  console.log('  CgstVal     =', irnPayload.ValDtls.CgstVal);
  console.log('  SgstVal     =', irnPayload.ValDtls.SgstVal);
  console.log('  IgstVal     =', irnPayload.ValDtls.IgstVal);
  console.log('  RndOffAmt   =', irnPayload.ValDtls.RndOffAmt);
  console.log('  TotInvVal   =', irnPayload.ValDtls.TotInvVal);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
