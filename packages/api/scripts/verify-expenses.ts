import { prisma } from '../src/lib/prisma.js';

async function main() {
  for (const distributorId of ['dist-001', 'dist-002', 'dist-miniop-cp3']) {
    const d = await prisma.distributor.findUnique({ where: { id: distributorId }, select: { businessName: true } });
    console.log(`\n[${d?.businessName ?? distributorId}]`);
    const catCount = await prisma.expenseCategory.count({ where: { distributorId, deletedAt: null } });
    const headerCount = await prisma.expenseCategory.count({ where: { distributorId, isHeader: true, deletedAt: null } });
    const leafCount = catCount - headerCount;
    const expenseCount = await prisma.expense.count({ where: { distributorId, deletedAt: null } });
    console.log(`  categories: ${catCount} (${headerCount} headers, ${leafCount} leaves)`);
    console.log(`  expenses:   ${expenseCount}`);
    // categoryId is NOT NULL by schema — orphans are structurally impossible.
    // Instead, sanity-check that every categoryId in expenses points at a real
    // row in expense_categories (FK guarantees it, but this is the belt-and-braces
    // read).
    const byCategory = await prisma.expense.groupBy({
      by: ['categoryId'],
      where: { distributorId, deletedAt: null },
      _count: { _all: true },
    });
    const categoryIds = byCategory.map((r) => r.categoryId);
    const found = await prisma.expenseCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, code: true, parent: { select: { name: true } } },
    });
    const foundIds = new Set(found.map((f) => f.id));
    const missing = categoryIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      console.log(`  ⚠️  ${missing.length} categoryIds have no matching expense_categories row`);
    } else {
      console.log(`  ✓ every categoryId resolves to a live row`);
    }
    // Show top 3 categories by row count for quick eyeball.
    const top = [...byCategory].sort((a, b) => b._count._all - a._count._all).slice(0, 3);
    for (const t of top) {
      const c = found.find((f) => f.id === t.categoryId);
      const path = c?.parent ? `${c.parent.name} / ${c.name}` : c?.name ?? '?';
      console.log(`     ${path.padEnd(35)} ${String(t._count._all).padStart(3)} expenses`);
    }
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
