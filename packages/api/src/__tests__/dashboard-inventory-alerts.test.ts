/**
 * dashboard-inventory-alerts.test.ts
 *
 * Guards the live-stock semantics of `getDashboardStats().inventoryAlerts`.
 * Before 2026-06-01 the dashboard counted *configured* threshold rows
 * (`cylinderThreshold.count({ alertEnabled: true })`) — a constant per
 * tenant. The KPI tile then stuck at the configured count even after
 * stock was replenished above the warning level. Fix delegates to
 * `checkThresholds(distributorId)` which compares each type's latest
 * closing_fulls against its warningLevel/criticalLevel.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { getDashboardStats } from '../services/analyticsService.js';
import { startOfUtcDay } from '../utils/dateOnly.js';

const DIST = 'dist-001';
let cylinderTypeId: string;

beforeAll(async () => {
  // Pick a non-conflicting cylinder type — 5 KG isn't part of the
  // existing dist-001 threshold seed (only 19 KG is per the seed file
  // at packages/api/prisma/seed.ts), so we can add/remove a threshold
  // for it without colliding with the default config.
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST, typeName: '5 KG' },
  });
  cylinderTypeId = cyl.id;
});

afterEach(async () => {
  // Tear down anything this test seeded.
  await prisma.inventorySummary.deleteMany({
    where: {
      distributorId: DIST,
      cylinderTypeId,
      // Limit cleanup to the synthetic far-future row we created.
      summaryDate: { gte: startOfUtcDay(new Date('2099-12-30T00:00:00Z')) },
    },
  });
  await prisma.cylinderThreshold.deleteMany({
    where: { distributorId: DIST, cylinderTypeId },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function setStock(closingFulls: number) {
  // Replace any existing far-future summary with the requested closing.
  const today = startOfUtcDay();
  await prisma.inventorySummary.upsert({
    where: {
      distributorId_cylinderTypeId_summaryDate: {
        distributorId: DIST,
        cylinderTypeId,
        summaryDate: today,
      },
    },
    update: { closingFulls, closingEmpties: 0 },
    create: {
      distributorId,
      cylinderTypeId,
      summaryDate: today,
      openingFulls: 0,
      openingEmpties: 0,
      incomingFulls: 0,
      dispatchedQty: 0,
      deliveredQty: 0,
      cancelledStockQty: 0,
      closingFulls,
      closingEmpties: 0,
    },
  });
}
// Alias for shorthand inside the helper above.
const distributorId = DIST;

async function setThreshold(warningLevel: number, criticalLevel: number, alertEnabled = true) {
  await prisma.cylinderThreshold.upsert({
    where: { distributorId_cylinderTypeId: { distributorId: DIST, cylinderTypeId } },
    update: { warningLevel, criticalLevel, alertEnabled },
    create: {
      distributorId: DIST,
      cylinderTypeId,
      warningLevel,
      criticalLevel,
      alertEnabled,
    },
  });
}

describe('getDashboardStats().inventoryAlerts — reflects live stock vs threshold', () => {
  it('counts the 5 KG type when closing_fulls is AT warning level (fires alert)', async () => {
    await setThreshold(10, 3);
    await setStock(10); // exactly at warning → alert per checkThresholds rule
    const stats = await getDashboardStats(DIST);
    expect(stats.inventoryAlerts).toBeGreaterThanOrEqual(1);
  });

  it('counts the 5 KG type when closing_fulls is BELOW warning level', async () => {
    await setThreshold(10, 3);
    await setStock(4); // > critical (3), ≤ warning (10) → warning alert
    const stats = await getDashboardStats(DIST);
    expect(stats.inventoryAlerts).toBeGreaterThanOrEqual(1);
  });

  it('does NOT count the 5 KG type when closing_fulls is ABOVE warning level', async () => {
    await setThreshold(10, 3);
    await setStock(50); // well above warning → no alert
    const stats = await getDashboardStats(DIST);
    // The seed already configures a 19 KG threshold (warning=15) which
    // may or may not be alerting depending on dev DB state, so we can't
    // assert an exact total. We CAN assert that adding a stocked-up
    // type without disturbing 19 KG produced no extra alert: the count
    // is bounded by other tenants' existing thresholds, NOT inflated
    // by our high-stock fixture. Capture a baseline first.
    const before = stats.inventoryAlerts;
    // Now flip the same fixture to a low stock value and re-query — the
    // count must increase by exactly 1 (only 5 KG transitions).
    await setStock(1);
    const afterStats = await getDashboardStats(DIST);
    expect(afterStats.inventoryAlerts - before).toBe(1);
  });

  it('does NOT count an alert-DISABLED threshold even when stock is below', async () => {
    await setThreshold(10, 3, /* alertEnabled */ false);
    await setStock(0); // would be critical if alerts were enabled
    const baseline = await getDashboardStats(DIST);
    // Flip alertEnabled to true and confirm the count moves up by 1.
    await setThreshold(10, 3, /* alertEnabled */ true);
    const live = await getDashboardStats(DIST);
    expect(live.inventoryAlerts - baseline.inventoryAlerts).toBe(1);
  });
});
