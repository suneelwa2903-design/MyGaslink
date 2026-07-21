/**
 * reset-miniop-today.ts
 *
 * Deletes TODAY's transactional activity on Quick Gas Supply (dist-miniop-cp3)
 * so the operator can redo. Preserves:
 *   - customers (all 5)
 *   - opening_state_seeded_at + opening_seed_qty on inventory balances
 *   - OB invoices (isOpeningBalance=true) + their ledger entries
 *   - customer_allowed_cylinder_types (preferences)
 *
 * Deletes:
 *   - non-OB invoices created today
 *   - non-OB ledger entries created today
 *   - orders created today (+ nested delivery-vehicle-assignment, order-items,
 *     order-status-history if any)
 *   - rebuilds customer_inventory_balances.withCustomerQty back to
 *     opening_seed_qty for every affected customer (deliveries adjusted
 *     these balances forward — after removing the deliveries the physical
 *     count should equal the seeded snapshot).
 *
 * Also deletes 6 throwaway "OB Showcase" mini-op tenants that pollute the
 * distributor list from earlier scratch work.
 *
 * Usage:
 *   npx tsx scripts/reset-miniop-today.ts --dry-run     (preview counts, no writes)
 *   npx tsx scripts/reset-miniop-today.ts --execute     (do it)
 */
import { prisma } from '../src/lib/prisma.js';

const TARGET_DIST = 'dist-miniop-cp3'; // Quick Gas Supply
const SHOWCASE_PREFIX = 'OB Showcase';

async function main() {
  const flag = process.argv[2];
  if (flag !== '--dry-run' && flag !== '--execute') {
    console.error('Usage: --dry-run | --execute');
    process.exit(1);
  }
  const dry = flag === '--dry-run';

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  console.log(`[${dry ? 'DRY' : 'EXEC'}] cutoff = ${startOfToday.toISOString()}`);

  // 1. Preview counts on Quick Gas Supply.
  const dist = await prisma.distributor.findUnique({ where: { id: TARGET_DIST } });
  if (!dist) throw new Error('Quick Gas Supply tenant not found');
  console.log(`\nTenant: ${dist.businessName} (${dist.id})`);

  const todayInv = await prisma.invoice.findMany({
    where: {
      distributorId: TARGET_DIST,
      createdAt: { gte: startOfToday },
      isOpeningBalance: false,
    },
    select: { id: true, invoiceNumber: true, totalAmount: true, isOpeningBalance: true, customerId: true },
  });
  // OB invoice ids for this tenant so we can exclude ledger entries
  // pointing at them (there is no `invoice` relation on the ledger
  // model — filter by ID list).
  const obInvIds = new Set(
    (await prisma.invoice.findMany({
      where: { distributorId: TARGET_DIST, isOpeningBalance: true },
      select: { id: true },
    })).map((i) => i.id),
  );
  const allTodayLedger = await prisma.customerLedgerEntry.findMany({
    where: { distributorId: TARGET_DIST, createdAt: { gte: startOfToday } },
    select: { id: true, entryType: true, amountDelta: true, invoiceId: true, customerId: true },
  });
  const todayLedger = allTodayLedger.filter(
    (l) => !l.invoiceId || !obInvIds.has(l.invoiceId),
  );
  const todayOrders = await prisma.order.findMany({
    where: { distributorId: TARGET_DIST, createdAt: { gte: startOfToday } },
    select: { id: true, orderNumber: true, customerId: true, status: true },
  });

  console.log(`  Non-OB invoices to DELETE      : ${todayInv.length}`);
  todayInv.forEach((i) => console.log(`     ${i.invoiceNumber}  cust=${i.customerId}  ₹${i.totalAmount}`));
  console.log(`  Non-OB ledger entries to DELETE: ${todayLedger.length}`);
  console.log(`  Orders to DELETE               : ${todayOrders.length}`);
  todayOrders.forEach((o) => console.log(`     ${o.orderNumber}  cust=${o.customerId}  status=${o.status}`));

  // Customers affected — need their inventory balances reset.
  const affectedCustIds = new Set<string>([
    ...todayInv.map((x) => x.customerId),
    ...todayLedger.map((x) => x.customerId),
    ...todayOrders.map((x) => x.customerId),
  ]);
  console.log(`  Customers touched              : ${affectedCustIds.size}`);
  const balances = await prisma.customerInventoryBalance.findMany({
    where: { customerId: { in: [...affectedCustIds] } },
    select: { id: true, customerId: true, cylinderTypeId: true, withCustomerQty: true, openingSeedQty: true },
  });
  console.log(`  Inventory rows to REBUILD      : ${balances.length}`);
  balances.forEach((b) => console.log(`     cust=${b.customerId}  type=${b.cylinderTypeId}  with=${b.withCustomerQty} → openingSeedQty=${b.openingSeedQty}`));

  // 2. Preview the OB Showcase throwaway tenants.
  const throwaway = await prisma.distributor.findMany({
    where: { accountType: 'mini_operator', businessName: { startsWith: SHOWCASE_PREFIX } },
    select: { id: true, businessName: true },
  });
  console.log(`\n"${SHOWCASE_PREFIX}" throwaway tenants to DROP: ${throwaway.length}`);
  throwaway.forEach((t) => console.log(`     ${t.id}  ${t.businessName}`));

  if (dry) {
    console.log('\n[DRY-RUN] no writes performed. Re-run with --execute to apply.');
    return;
  }

  // 3. EXECUTE — single transaction so a mid-flight failure doesn't leave a half state.
  await prisma.$transaction(async (tx) => {
    // Delete ledger entries first (FK references invoices / orders).
    const invIds = todayInv.map((i) => i.id);
    const orderIds = todayOrders.map((o) => o.id);
    const ledgerIds = todayLedger.map((l) => l.id);

    // Any ledger entries pointing at today's non-OB invoices are removed
    // even if the ledger row itself was somehow pre-dated — otherwise the
    // invoice delete would FK-fail.
    await tx.customerLedgerEntry.deleteMany({
      where: {
        distributorId: TARGET_DIST,
        OR: [
          { id: { in: ledgerIds } },
          { invoiceId: { in: invIds } },
          { referenceId: { in: orderIds } },
        ],
      },
    });

    // Invoice items → then invoices.
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invIds } } });
    await tx.invoice.deleteMany({ where: { id: { in: invIds } } });

    // Orders → OrderItem, OrderStatusLog, DeliveryProof all cascade on
    // Order delete per schema.prisma. VehicleInventory (line 1510-1521)
    // does NOT cascade — clear those references first so the delete
    // succeeds. Same treatment for the invoice-order back-reference:
    // Invoice.orderId is nullable, so null it out before deleting the
    // order.
    if (orderIds.length) {
      await tx.driverAssignment.deleteMany({ where: { orderId: { in: orderIds } } });
      // Clear back-refs from any surviving-but-related tables so the
      // order can be deleted. Prisma model names inferred from schema
      // §@map. Any nullable back-ref gets null-ed; cancelled stock
      // events reference the order but survive.
      await tx.invoice.updateMany({
        where: { orderId: { in: orderIds } },
        data: { orderId: null },
      });
      // CancelledStockEvent.orderId is non-nullable — delete the events
      // outright. These are artifacts of cancelled-then-returned stock
      // for the today's orders being wiped; nothing else references them
      // for this tenant.
      await tx.cancelledStockEvent.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    }

    // Rebuild inventory balances to opening snapshot.
    for (const b of balances) {
      await tx.customerInventoryBalance.update({
        where: { id: b.id },
        data: { withCustomerQty: b.openingSeedQty },
      });
    }
  });
  console.log('[EXEC] Quick Gas Supply today-transactions removed + balances reset.');

  // 4. Drop the throwaway OB Showcase tenants. Cascade-safe order.
  for (const t of throwaway) {
    await prisma.$transaction(async (tx) => {
      await tx.customerLedgerEntry.deleteMany({ where: { distributorId: t.id } });
      await tx.invoiceItem.deleteMany({ where: { invoice: { distributorId: t.id } } });
      await tx.invoice.deleteMany({ where: { distributorId: t.id } });
      await tx.customerInventoryBalance.deleteMany({ where: { customer: { distributorId: t.id } } });
      await tx.customerAllowedCylinderType.deleteMany({ where: { customer: { distributorId: t.id } } });
      await tx.customer.deleteMany({ where: { distributorId: t.id } });
      await tx.emptyCylinderPrice.deleteMany({ where: { distributorId: t.id } });
      await tx.cylinderPrice.deleteMany({ where: { distributorId: t.id } });
      await tx.cylinderType.deleteMany({ where: { distributorId: t.id } });
      await tx.invoiceCounter.deleteMany({ where: { distributorId: t.id } });
      await tx.auditLog.deleteMany({ where: { distributorId: t.id } });
      await tx.user.deleteMany({ where: { distributorId: t.id } });
      await tx.distributor.delete({ where: { id: t.id } });
    });
    console.log(`[EXEC] Dropped throwaway tenant ${t.id}  ${t.businessName}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
