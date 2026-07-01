/**
 * Generate a sample SaaS-side subscription invoice PDF using the
 * NEW template + real Kruthee Gas Agency-shaped buyer data, so you
 * can eyeball the layout before this ships.
 *
 * Writes the file to: C:/tmp/gaslink-sample-invoice-NEW.pdf
 */
import { prisma } from '../src/lib/prisma.js';
import { generateBillingInvoicePdf } from '../src/services/pdf/billingInvoicePdfService.js';
import fs from 'node:fs';

(async () => {
  const KRUTHEE_LIKE = {
    businessName: 'KRUTHEE GAS AGENCY',
    legalName: 'KRUTHEE GAS AGENCY',
    gstin: '36AIGPR5173H1ZY',
    address: '12-8-82/8/1/4/3',
    city: 'MOOSAPET, Hyderabad',
    state: 'Telangana',
    pincode: '500018',
    phone: '7780472600',
  };

  const d1 = await prisma.distributor.findUniqueOrThrow({ where: { id: 'dist-001' } });
  await prisma.distributor.update({ where: { id: 'dist-001' }, data: KRUTHEE_LIKE });

  const cycle = await prisma.billingCycle.create({
    data: {
      distributorId: 'dist-001',
      periodType: 'monthly',
      billingTier: 'tier_1',
      periodStartDate: new Date('2026-07-01T00:00:00Z'),
      periodEndDate: new Date('2026-07-31T00:00:00Z'),
      dueDate: new Date('2026-08-07T00:00:00Z'),
      totalAmountExclGst: 4999,
      totalGstAmount: 899.82,
      totalAmountInclGst: 5898.82,
      billingStatus: 'pending_payment',
      items: {
        create: {
          itemType: 'base_subscription',
          description: 'Base subscription - starter (monthly) - incl. 1 admin, 1 fin, 1 inv, 2 drivers',
          hsnCode: '998314',
          quantity: 1,
          unitPriceExclGst: 4999,
          gstRate: 18,
          lineGstAmount: 899.82,
          lineTotalExclGst: 4999,
          lineTotalInclGst: 5898.82,
        },
      },
    },
  });

  try {
    const pdf = await generateBillingInvoicePdf(cycle.id, 'dist-001');
    fs.mkdirSync('C:/tmp', { recursive: true });
    const out = 'C:/tmp/gaslink-sample-invoice-NEW.pdf';
    fs.writeFileSync(out, pdf);
    console.log(`Sample PDF written: ${out}`);
    console.log(`Bytes: ${pdf.byteLength}`);
    const counter = await prisma.saasInvoiceCounter.findUnique({ where: { financialYear: '2627' } });
    console.log(`Counter lastSequence now: ${counter?.lastSequence}`);
  } finally {
    await prisma.billingItem.deleteMany({ where: { cycleId: cycle.id } });
    await prisma.billingCycle.delete({ where: { id: cycle.id } });
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: {
        businessName: d1.businessName, legalName: d1.legalName, gstin: d1.gstin,
        address: d1.address, city: d1.city, state: d1.state, pincode: d1.pincode, phone: d1.phone,
      },
    });
    await prisma.$disconnect();
  }
})().catch(e => { console.error(e); process.exit(1); });
