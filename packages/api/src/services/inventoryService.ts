import { prisma } from '../lib/prisma.js';
import type { Prisma, PrismaClient } from '@prisma/client';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Create an immutable inventory event. All inventory changes go through this function.
 */
export async function createInventoryEvent(
  tx: TxClient,
  data: {
    distributorId: string;
    cylinderTypeId: string;
    eventType: string;
    fullsChange: number;
    emptiesChange: number;
    eventDate: Date;
    referenceId?: string;
    referenceType?: string;
    documentType?: string;
    documentNumber?: string;
    documentDate?: Date;
    vehicleNumber?: string;
    driverName?: string;
    notes?: string;
    createdBy: string;
  }
) {
  return tx.inventoryEvent.create({
    data: {
      distributorId: data.distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: data.eventType as any,
      fullsChange: data.fullsChange,
      emptiesChange: data.emptiesChange,
      eventDate: data.eventDate,
      referenceId: data.referenceId || null,
      referenceType: data.referenceType || null,
      documentType: data.documentType || null,
      documentNumber: data.documentNumber || null,
      documentDate: data.documentDate || null,
      vehicleNumber: data.vehicleNumber || null,
      driverName: data.driverName || null,
      notes: data.notes || null,
      createdBy: data.createdBy,
    },
  });
}

/**
 * Compute inventory summary for a specific date by aggregating all events.
 * This is the core event-sourcing computation.
 */
export async function computeSummaryForDate(
  distributorId: string,
  cylinderTypeId: string,
  date: Date
): Promise<{
  openingFulls: number;
  openingEmpties: number;
  incomingFulls: number;
  outgoingEmpties: number;
  deliveredQty: number;
  collectedEmpties: number;
  cancelledStockQty: number;
  manualAdjustment: number;
  closingFulls: number;
  closingEmpties: number;
}> {
  // Get opening balance from previous day's closing
  const prevSummary = await prisma.inventorySummary.findFirst({
    where: {
      distributorId,
      cylinderTypeId,
      summaryDate: { lt: date },
    },
    orderBy: { summaryDate: 'desc' },
    select: { closingFulls: true, closingEmpties: true },
  });

  const openingFulls = prevSummary?.closingFulls ?? 0;
  const openingEmpties = prevSummary?.closingEmpties ?? 0;

  // Aggregate all events for this date
  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      cylinderTypeId,
      eventDate: date,
    },
  });

  let incomingFulls = 0;
  let outgoingEmpties = 0;
  let deliveredQty = 0;
  let collectedEmpties = 0;
  let cancelledStockQty = 0;
  let manualAdjustment = 0;

  for (const event of events) {
    switch (event.eventType) {
      case 'incoming_fulls':
        incomingFulls += event.fullsChange;
        break;
      case 'outgoing_empties':
        outgoingEmpties += Math.abs(event.emptiesChange);
        break;
      case 'delivery':
        deliveredQty += Math.abs(event.fullsChange);
        break;
      case 'collection':
        collectedEmpties += event.emptiesChange;
        break;
      case 'cancellation':
        cancelledStockQty += event.fullsChange;
        break;
      case 'cancellation_return':
        // Returned cancelled stock goes back to fulls
        incomingFulls += event.fullsChange;
        break;
      case 'manual_adjustment':
        manualAdjustment += event.fullsChange;
        break;
      case 'initial_balance':
        // Initial balance treated as opening adjustment
        manualAdjustment += event.fullsChange;
        break;
      case 'write_off':
        manualAdjustment += event.fullsChange; // negative
        break;
      case 'returns_collection':
        // Returns-only orders: empties collected from customer
        collectedEmpties += event.emptiesChange;
        break;
    }
  }

  const closingFulls = openingFulls + incomingFulls - deliveredQty + cancelledStockQty + manualAdjustment;
  const closingEmpties = openingEmpties + collectedEmpties - outgoingEmpties;

  return {
    openingFulls,
    openingEmpties,
    incomingFulls,
    outgoingEmpties,
    deliveredQty,
    collectedEmpties,
    cancelledStockQty,
    manualAdjustment,
    closingFulls,
    closingEmpties,
  };
}

/**
 * Recalculate inventory summaries from a given date forward.
 * Fixes the carry-forward chain when historical data changes.
 */
export async function recalculateSummariesFromDate(
  distributorId: string,
  cylinderTypeId: string,
  fromDate: Date
) {
  // Get all dates with events from fromDate forward
  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      cylinderTypeId,
      eventDate: { gte: fromDate },
    },
    select: { eventDate: true },
    distinct: ['eventDate'],
    orderBy: { eventDate: 'asc' },
  });

  const dates = events.map(e => e.eventDate);

  // Also include existing summary dates that may need updating
  const existingSummaries = await prisma.inventorySummary.findMany({
    where: {
      distributorId,
      cylinderTypeId,
      summaryDate: { gte: fromDate },
      isLocked: false,
    },
    select: { summaryDate: true },
    orderBy: { summaryDate: 'asc' },
  });

  const allDates = new Set<number>();
  for (const d of dates) allDates.add(d.getTime());
  for (const s of existingSummaries) allDates.add(s.summaryDate.getTime());

  const sortedDates = Array.from(allDates).sort().map(t => new Date(t));

  for (const date of sortedDates) {
    const summary = await computeSummaryForDate(distributorId, cylinderTypeId, date);

    await prisma.inventorySummary.upsert({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId,
          cylinderTypeId,
          summaryDate: date,
        },
      },
      create: {
        distributorId,
        cylinderTypeId,
        summaryDate: date,
        ...summary,
      },
      update: summary,
    });
  }
}

/**
 * Record incoming fulls (manual entry for any corporation).
 */
export async function recordIncomingFulls(
  distributorId: string,
  userId: string,
  data: {
    cylinderTypeId: string;
    quantity: number;
    documentType: string;
    documentNumber: string;
    documentDate: string;
    vehicleNumber?: string;
    driverName?: string;
    notes?: string;
  }
) {
  const eventDate = new Date(data.documentDate);

  return prisma.$transaction(async (tx) => {
    const event = await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'incoming_fulls',
      fullsChange: data.quantity,
      emptiesChange: 0,
      eventDate,
      documentType: data.documentType,
      documentNumber: data.documentNumber,
      documentDate: eventDate,
      vehicleNumber: data.vehicleNumber,
      driverName: data.driverName,
      createdBy: userId,
      notes: data.notes,
    });

    await recalculateSummariesFromDate(distributorId, data.cylinderTypeId, eventDate);
    return event;
  });
}

/**
 * Record outgoing empties (manual entry).
 */
export async function recordOutgoingEmpties(
  distributorId: string,
  userId: string,
  data: {
    cylinderTypeId: string;
    quantity: number;
    documentType: string;
    documentNumber: string;
    documentDate: string;
    vehicleNumber?: string;
    driverName?: string;
    notes?: string;
  }
) {
  const eventDate = new Date(data.documentDate);

  return prisma.$transaction(async (tx) => {
    const event = await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'outgoing_empties',
      fullsChange: 0,
      emptiesChange: -data.quantity,
      eventDate,
      documentType: data.documentType,
      documentNumber: data.documentNumber,
      documentDate: eventDate,
      vehicleNumber: data.vehicleNumber,
      driverName: data.driverName,
      createdBy: userId,
      notes: data.notes,
    });

    await recalculateSummariesFromDate(distributorId, data.cylinderTypeId, eventDate);
    return event;
  });
}

/**
 * Record opening-stock balances (one InventoryEvent per cylinder type) as
 * the distributor's starting fulls/empties counts. Used by the onboarding
 * "Enter opening stock" flow. Skips entries where both fulls and empties are 0.
 */
export async function recordInitialBalance(
  distributorId: string,
  userId: string,
  data: {
    entries: { cylinderTypeId: string; openingFulls: number; openingEmpties: number }[];
    eventDate?: string;
  },
) {
  const eventDate = data.eventDate ? new Date(data.eventDate) : new Date();
  const created: { cylinderTypeId: string; eventId: string }[] = [];

  await prisma.$transaction(async (tx) => {
    for (const entry of data.entries) {
      const fulls = Math.max(0, Math.floor(entry.openingFulls));
      const empties = Math.max(0, Math.floor(entry.openingEmpties));
      if (fulls === 0 && empties === 0) continue;

      const event = await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: entry.cylinderTypeId,
        eventType: 'initial_balance',
        fullsChange: fulls,
        emptiesChange: empties,
        eventDate,
        createdBy: userId,
        notes: 'Opening balance entry',
      });
      created.push({ cylinderTypeId: entry.cylinderTypeId, eventId: event.id });
    }
  });

  // Summaries are recalculated outside the transaction (they themselves use
  // their own transaction internally).
  for (const c of created) {
    await recalculateSummariesFromDate(distributorId, c.cylinderTypeId, eventDate);
  }

  return { created: created.length };
}

/**
 * Manual adjustment (add or subtract).
 */
export async function recordManualAdjustment(
  distributorId: string,
  userId: string,
  data: {
    cylinderTypeId: string;
    adjustmentType: 'add' | 'subtract';
    quantity: number;
    reason: string;
    adjustmentDate: string;
  }
) {
  const eventDate = new Date(data.adjustmentDate);
  const change = data.adjustmentType === 'add' ? data.quantity : -data.quantity;

  return prisma.$transaction(async (tx) => {
    const event = await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'manual_adjustment',
      fullsChange: change,
      emptiesChange: 0,
      eventDate,
      createdBy: userId,
      notes: data.reason,
    });

    await recalculateSummariesFromDate(distributorId, data.cylinderTypeId, eventDate);
    return event;
  });
}

/**
 * Return cancelled stock to depot.
 */
export async function returnCancelledStock(
  distributorId: string,
  userId: string,
  data: { eventIds: string[]; returnDate: string; notes?: string }
) {
  const returnDate = new Date(data.returnDate);

  return prisma.$transaction(async (tx) => {
    const results = [];
    for (const eventId of data.eventIds) {
      const cse = await tx.cancelledStockEvent.findFirst({
        where: { id: eventId, distributorId, status: 'on_vehicle' },
      });
      if (!cse) continue;

      await tx.cancelledStockEvent.update({
        where: { id: eventId },
        data: { status: 'returned_to_depot', returnedDate: returnDate },
      });

      // Create inventory event for the return
      await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: cse.cylinderTypeId,
        eventType: 'cancellation_return',
        fullsChange: cse.quantity,
        emptiesChange: 0,
        eventDate: returnDate,
        referenceId: eventId,
        referenceType: 'cancelled_stock',
        createdBy: userId,
        notes: data.notes || 'Cancelled stock returned to depot',
      });

      await recalculateSummariesFromDate(distributorId, cse.cylinderTypeId, returnDate);
      results.push({ eventId, status: 'returned_to_depot' });
    }
    return results;
  });
}

/**
 * Get inventory summary for a date.
 */
export async function getInventorySummary(distributorId: string, date: string) {
  const summaryDate = new Date(date);

  const cylinderTypes = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    select: { id: true, typeName: true, capacity: true, unit: true },
  });

  const summaries = [];
  for (const ct of cylinderTypes) {
    let summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId,
          cylinderTypeId: ct.id,
          summaryDate,
        },
      },
      include: {
        cylinderType: { select: { id: true, typeName: true, capacity: true, unit: true } },
      },
    });

    if (!summary) {
      // Compute on-the-fly
      const computed = await computeSummaryForDate(distributorId, ct.id, summaryDate);
      summary = {
        id: '',
        distributorId,
        cylinderTypeId: ct.id,
        summaryDate,
        ...computed,
        isLocked: false,
        lockedAt: null,
        lockedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        cylinderType: { id: ct.id, typeName: ct.typeName, capacity: ct.capacity, unit: ct.unit },
      };
    }

    // Get thresholds
    const threshold = await prisma.cylinderThreshold.findUnique({
      where: { distributorId_cylinderTypeId: { distributorId, cylinderTypeId: ct.id } },
    });

    summaries.push({
      ...summary,
      cylinderType: { id: ct.id, typeName: ct.typeName, capacity: ct.capacity, unit: ct.unit },
      cylinderTypeName: ct.typeName,
      thresholdWarning: threshold?.warningLevel ?? null,
      thresholdCritical: threshold?.criticalLevel ?? null,
    });
  }

  return summaries;
}

/**
 * Get cancelled stock events.
 */
export async function getCancelledStock(
  distributorId: string,
  filters: { status?: string; vehicleId?: string; driverId?: string }
) {
  const where: any = { distributorId };
  if (filters.status) where.status = filters.status as any;
  if (filters.vehicleId) where.vehicleId = filters.vehicleId;
  if (filters.driverId) where.driverId = filters.driverId;

  return prisma.cancelledStockEvent.findMany({
    where,
    include: {
      order: { select: { orderNumber: true } },
      vehicle: { select: { vehicleNumber: true } },
      driver: { select: { driverName: true } },
      cylinderType: { select: { typeName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Check thresholds and return alerts.
 */
export async function checkThresholds(distributorId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const thresholds = await prisma.cylinderThreshold.findMany({
    where: { distributorId, alertEnabled: true },
    include: { cylinderType: { select: { typeName: true } } },
  });

  const alerts = [];
  for (const threshold of thresholds) {
    const summary = await prisma.inventorySummary.findFirst({
      where: {
        distributorId,
        cylinderTypeId: threshold.cylinderTypeId,
        summaryDate: { lte: today },
      },
      orderBy: { summaryDate: 'desc' },
    });

    const closingFulls = summary?.closingFulls ?? 0;
    if (closingFulls <= threshold.criticalLevel) {
      alerts.push({
        cylinderTypeId: threshold.cylinderTypeId,
        cylinderTypeName: threshold.cylinderType.typeName,
        currentStock: closingFulls,
        level: 'critical',
        threshold: threshold.criticalLevel,
      });
    } else if (closingFulls <= threshold.warningLevel) {
      alerts.push({
        cylinderTypeId: threshold.cylinderTypeId,
        cylinderTypeName: threshold.cylinderType.typeName,
        currentStock: closingFulls,
        level: 'warning',
        threshold: threshold.warningLevel,
      });
    }
  }

  return alerts;
}

/**
 * Get customer inventory balances.
 */
export async function getCustomerBalances(distributorId: string, customerId?: string) {
  const where: any = {};
  if (customerId) where.customerId = customerId;
  // Filter by distributor through customer relation
  where.customer = { distributorId, deletedAt: null };

  return prisma.customerInventoryBalance.findMany({
    where,
    include: {
      customer: { select: { id: true, customerName: true } },
      cylinderType: { select: { typeName: true } },
    },
  });
}

/**
 * Lock/unlock daily summary.
 */
export async function lockSummary(
  distributorId: string,
  cylinderTypeId: string,
  date: string,
  userId: string,
  lock: boolean
) {
  const summaryDate = new Date(date);

  return prisma.inventorySummary.upsert({
    where: {
      distributorId_cylinderTypeId_summaryDate: {
        distributorId,
        cylinderTypeId,
        summaryDate,
      },
    },
    create: {
      distributorId,
      cylinderTypeId,
      summaryDate,
      isLocked: lock,
      lockedAt: lock ? new Date() : null,
      lockedBy: lock ? userId : null,
    },
    update: {
      isLocked: lock,
      lockedAt: lock ? new Date() : null,
      lockedBy: lock ? userId : null,
    },
  });
}

/**
 * Unlock all inventory summaries for a given date.
 */
export async function unlockSummariesForDate(
  distributorId: string,
  date: string,
  userId: string
) {
  const summaryDate = new Date(date);

  const result = await prisma.inventorySummary.updateMany({
    where: {
      distributorId,
      summaryDate,
      isLocked: true,
    },
    data: {
      isLocked: false,
      lockedAt: null,
      lockedBy: null,
    },
  });

  return { unlockedCount: result.count, date };
}

/**
 * Inventory forecast using simple moving average from last 30 days.
 */
export async function getInventoryForecast(distributorId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const cylinderTypes = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    select: { id: true, typeName: true },
  });

  const forecasts = [];
  for (const ct of cylinderTypes) {
    // Get delivery events from last 30 days
    const deliveryEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId,
        cylinderTypeId: ct.id,
        eventType: 'delivery',
        eventDate: { gte: thirtyDaysAgo, lte: today },
      },
      select: { fullsChange: true, eventDate: true },
    });

    const totalDelivered = deliveryEvents.reduce((sum, e) => sum + Math.abs(e.fullsChange), 0);
    const daysWithData = new Set(deliveryEvents.map(e => e.eventDate.toISOString().split('T')[0])).size;
    const avgDailyDemand = daysWithData > 0 ? totalDelivered / 30 : 0;

    // Get current stock
    const latestSummary = await prisma.inventorySummary.findFirst({
      where: { distributorId, cylinderTypeId: ct.id },
      orderBy: { summaryDate: 'desc' },
    });
    const currentStock = latestSummary?.closingFulls ?? 0;
    const daysOfStockRemaining = avgDailyDemand > 0 ? Math.floor(currentStock / avgDailyDemand) : 999;

    // Determine trend
    const firstHalf = deliveryEvents.filter(e => e.eventDate < new Date(today.getTime() - 15 * 86400000));
    const secondHalf = deliveryEvents.filter(e => e.eventDate >= new Date(today.getTime() - 15 * 86400000));
    const firstHalfAvg = firstHalf.length > 0 ? firstHalf.reduce((s, e) => s + Math.abs(e.fullsChange), 0) / 15 : 0;
    const secondHalfAvg = secondHalf.length > 0 ? secondHalf.reduce((s, e) => s + Math.abs(e.fullsChange), 0) / 15 : 0;
    let trendDirection: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (secondHalfAvg > firstHalfAvg * 1.1) trendDirection = 'increasing';
    else if (secondHalfAvg < firstHalfAvg * 0.9) trendDirection = 'decreasing';

    forecasts.push({
      cylinderTypeId: ct.id,
      cylinderTypeName: ct.typeName,
      currentStock,
      averageDailyDemand: Math.round(avgDailyDemand * 100) / 100,
      daysOfStockRemaining,
      forecastedDemand7Days: Math.round(avgDailyDemand * 7),
      forecastedDemand30Days: Math.round(avgDailyDemand * 30),
      recommendedReorderQty: Math.max(Math.round(avgDailyDemand * 14) - currentStock, 0),
      trendDirection,
    });
  }

  return forecasts;
}

/**
 * Get depot history: paginated incoming_fulls and outgoing_empties events.
 */
export async function getDepotHistory(
  distributorId: string,
  filters: {
    page?: number;
    pageSize?: number;
    eventType?: 'incoming_fulls' | 'outgoing_empties';
    dateFrom?: string;
    dateTo?: string;
  }
) {
  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 20, 100);
  const skip = (page - 1) * pageSize;

  const where: any = {
    distributorId,
    eventType: { in: ['incoming_fulls', 'outgoing_empties'] as any },
  };

  if (filters.eventType) {
    where.eventType = filters.eventType as any;
  }

  if (filters.dateFrom || filters.dateTo) {
    where.eventDate = {};
    if (filters.dateFrom) where.eventDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.eventDate.lte = new Date(filters.dateTo);
  }

  const [events, total] = await Promise.all([
    prisma.inventoryEvent.findMany({
      where,
      include: {
        cylinderType: { select: { typeName: true } },
      },
      orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: pageSize,
    }),
    prisma.inventoryEvent.count({ where }),
  ]);

  return {
    events,
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

/**
 * Get reconciliation dashboard data.
 */
export async function getReconciliationDashboard(distributorId: string) {
  const [pendingReturn, onVehicle, returnedToDepot] = await Promise.all([
    prisma.cancelledStockEvent.count({ where: { distributorId, status: 'pending_return' } }),
    prisma.cancelledStockEvent.count({ where: { distributorId, status: 'on_vehicle' } }),
    prisma.cancelledStockEvent.count({ where: { distributorId, status: 'returned_to_depot' } }),
  ]);

  const cancelledByType = await prisma.cancelledStockEvent.groupBy({
    by: ['cylinderTypeId', 'status'],
    where: { distributorId },
    _sum: { quantity: true },
  });

  return { pendingReturn, onVehicle, returnedToDepot, cancelledByType };
}
