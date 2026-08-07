import { prisma } from '../src/lib/prisma.js';

async function main() {
  const dist = 'dist-002'; // Sharma Gas Distributors — seeded target
  console.log('=== dist-001 baseline counts ===');
  console.log('Customers:', await prisma.customer.count({ where: { distributorId: dist, deletedAt: null } }));
  console.log('Drivers:', await prisma.driver.count({ where: { distributorId: dist, deletedAt: null } }));
  console.log('Vehicles:', await prisma.vehicle.count({ where: { distributorId: dist, deletedAt: null } }));
  console.log('CylinderTypes:', await prisma.cylinderType.count({ where: { distributorId: dist, isActive: true } }));
  console.log('Orders:', await prisma.order.count({ where: { distributorId: dist } }));
  console.log('Invoices:', await prisma.invoice.count({ where: { distributorId: dist } }));
  console.log('Payments:', await prisma.paymentTransaction.count({ where: { distributorId: dist } }));
  console.log('Expenses:', await prisma.expense.count({ where: { distributorId: dist } }));
  console.log('ExpenseCategories:', await prisma.expenseCategory.count({ where: { distributorId: dist } }));
  console.log('LedgerEntries:', await prisma.customerLedgerEntry.count({ where: { distributorId: dist } }));
  console.log('InventoryEvents:', await prisma.inventoryEvent.count({ where: { distributorId: dist } }));
  console.log('AccountabilityLogs:', await prisma.accountabilityLog.count({ where: { distributorId: dist } }));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
