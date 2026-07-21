/**
 * Generates a customer-statement PDF showcasing all three OB scenarios
 * on a fresh mini-op tenant. Writes to the scratchpad dir.
 *   - Scenario A: ₹ only (no empties)
 *   - Scenario B: empties only (no ₹)
 *   - Scenario C: ₹ + multi-type empties (5 × 19KG + 7 × 47.5KG + ₹12,500)
 * Plus a couple of delivered invoices on Scenario C so the ledger has
 * BOTH the OB block AND regular rows the Total row can aggregate.
 */

import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';
import { getCustomerLedger } from '../src/services/paymentService.js';
import { generateCustomerLedgerPdf } from '../src/services/pdf/customerLedgerPdfService.js';

const RUN = Date.now().toString().slice(-6);
const OUT_DIR = process.argv[2] || '.';

async function main() {
  // 1. Tenant + admin user + cylinder types + empty prices.
  const dist = await prisma.distributor.create({
    data: {
      businessName: `OB Showcase ${RUN}`,
      legalName: `OB Showcase ${RUN}`,
      accountType: 'mini_operator',
      gstMode: 'disabled',
      docCode: `OBS${RUN.slice(-3)}`,
      state: 'Telangana',
    },
  });
  await prisma.user.create({
    data: {
      email: `obshowcase-${RUN}@example.com`,
      passwordHash: await bcrypt.hash('x', 4),
      firstName: 'OB', lastName: 'Showcase',
      role: 'mini_operator_admin',
      status: 'active',
      distributorId: dist.id,
      requiresPasswordReset: false,
    },
  });
  const ct19 = await prisma.cylinderType.create({
    data: { distributorId: dist.id, typeName: '19 KG Commercial', capacity: 19, unit: 'KG', hsnCode: '27111900', isActive: true },
  });
  const ct47 = await prisma.cylinderType.create({
    data: { distributorId: dist.id, typeName: '47.5 KG', capacity: 47, unit: 'KG', hsnCode: '27111900', isActive: true },
  });
  await prisma.emptyCylinderPrice.create({ data: { distributorId: dist.id, cylinderTypeId: ct19.id, emptyCylinderPrice: 2400 } });
  await prisma.emptyCylinderPrice.create({ data: { distributorId: dist.id, cylinderTypeId: ct47.id, emptyCylinderPrice: 7200 } });

  // Cylinder prices so we can seed a couple of delivered invoices.
  await prisma.cylinderPrice.create({ data: { distributorId: dist.id, cylinderTypeId: ct19.id, price: 3211, effectiveDate: new Date() } });
  await prisma.cylinderPrice.create({ data: { distributorId: dist.id, cylinderTypeId: ct47.id, price: 7654, effectiveDate: new Date() } });

  const seed = async (name: string, phone: string, os: { balance?: number; empties?: Array<[string, number]> }) => {
    const cust = await prisma.customer.create({
      data: {
        distributorId: dist.id, customerName: name, phone,
        billingState: 'Telangana', creditPeriodDays: 30, gstRateOverride: 18,
         status: 'active',
        openingStateSeededAt: new Date(),
      },
    });
    // Empties
    for (const [typeId, qty] of (os.empties || [])) {
      await prisma.customerInventoryBalance.create({
        data: { customerId: cust.id, cylinderTypeId: typeId, withCustomerQty: qty, openingSeedQty: qty },
      });
      await prisma.customerAllowedCylinderType.create({
        data: { customerId: cust.id, cylinderTypeId: typeId },
      });
    }
    // ₹ OB invoice
    if (os.balance && os.balance > 0) {
      const invNo = `OB-${cust.id.slice(0,8)}-${RUN}`;
      const inv = await prisma.invoice.create({
        data: {
          invoiceNumber: invNo,
          distributorId: dist.id,
          customerId: cust.id,
          issueDate: new Date(), dueDate: new Date(),
          totalAmount: os.balance,
          outstandingAmount: os.balance,
          amountPaid: 0,
          status: 'overdue',
          isOpeningBalance: true,
          notes: `Opening balance ${name}`,
        },
      });
      await prisma.customerLedgerEntry.create({
        data: {
          distributorId: dist.id,
          customerId: cust.id,
          entryType: 'invoice_entry',
          referenceId: inv.id,
          invoiceId: inv.id,
          amountDelta: os.balance,
          narration: `Opening Balance b/f — ${name}`,
          entryDate: new Date(),
        },
      });
    }
    return cust.id;
  };

  const custA = await seed('Scenario A — ₹ only', '+91 900000A', { balance: 4500 });
  const custB = await seed('Scenario B — empties only', '+91 900000B', {
    empties: [[ct19.id, 3]],
  });
  const custC = await seed('Scenario C — ₹ + multi-type empties + deliveries', '+91 900000C', {
    balance: 12500,
    empties: [[ct19.id, 5], [ct47.id, 7]],
  });

  // Seed a couple of delivery invoices on C so the ledger PDF also
  // shows the delivery rows AND the Total row aggregates across OB.
  for (let i = 0; i < 2; i++) {
    const invNo = `IQGS-${custC.slice(0,6)}-${i}${RUN}`;
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: invNo,
        distributorId: dist.id, customerId: custC,
        issueDate: new Date(), dueDate: new Date(),
        totalAmount: i === 0 ? 6422 : 7654,
        outstandingAmount: i === 0 ? 6422 : 7654,
        amountPaid: 0,
        status: 'overdue',
      },
    });
    await prisma.invoiceItem.create({
      data: {
        invoiceId: inv.id,
        cylinderTypeId: i === 0 ? ct19.id : ct47.id,
        quantity: i === 0 ? 2 : 1,
        unitPrice: i === 0 ? 3211 : 7654,
        totalPrice: i === 0 ? 6422 : 7654, description: i === 0 ? '19 KG Commercial' : '47.5 KG',
      },
    });
    await prisma.customerLedgerEntry.create({
      data: {
        distributorId: dist.id, customerId: custC,
        entryType: 'invoice_entry',
        referenceId: inv.id,
        invoiceId: inv.id,
        amountDelta: i === 0 ? 6422 : 7654,
        narration: invNo,
        entryDate: new Date(),
      },
    });
  }

  // 2. Render each ledger PDF and dump.
  for (const [label, customerId] of [['A', custA], ['B', custB], ['C', custC]] as const) {
    const ledger = await getCustomerLedger(dist.id, customerId);
    const buf = await generateCustomerLedgerPdf(dist.id, customerId);
    const path = `${OUT_DIR}/OB-scenario-${label}.pdf`;
    writeFileSync(path, buf);
    console.log(`Wrote ${path}  (${(buf.length/1024).toFixed(1)} KB, ${ledger.rows.length} ledger rows)`);
    // Print row summary
    for (const [i, r] of ledger.rows.entries()) {
      console.log(`  [${i}] kind=${r.kind} type='${r.cylinderType}' pend=${r.pendingEmptyCyls} empCost=${r.emptyCylsCost} due=${r.dueAmount} narration='${r.narration}'`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
