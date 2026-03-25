import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

const accountabilityInclude = {
  driver: { select: { id: true, driverName: true } },
  customer: { select: { id: true, customerName: true } },
  cylinderType: { select: { id: true, typeName: true } },
} satisfies Prisma.AccountabilityLogInclude;

export async function listAccountabilityLogs(
  distributorId: string,
  filters: {
    status?: string; driverId?: string; customerId?: string;
    incidentType?: string;
    page?: number; pageSize?: number;
  }
) {
  const where: Prisma.AccountabilityLogWhereInput = { distributorId };
  if (filters.status) where.status = filters.status as any;
  if (filters.driverId) where.driverId = filters.driverId;
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.incidentType) where.incidentType = filters.incidentType as any;

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;

  const [logs, total] = await Promise.all([
    prisma.accountabilityLog.findMany({
      where,
      include: accountabilityInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.accountabilityLog.count({ where }),
  ]);

  return {
    data: logs,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getAccountabilityLogById(id: string, distributorId: string) {
  return prisma.accountabilityLog.findFirst({
    where: { id, distributorId },
    include: accountabilityInclude,
  });
}

export async function createAccountabilityLog(
  distributorId: string,
  userId: string,
  data: {
    driverId?: string;
    customerId?: string;
    cylinderTypeId?: string;
    incidentType: string;
    incidentDate: string;
    quantity: number;
    description: string;
  }
) {
  // Validate references belong to distributor
  if (data.driverId) {
    const driver = await prisma.driver.findFirst({
      where: { id: data.driverId, distributorId, deletedAt: null },
    });
    if (!driver) throw new AccountabilityError('Driver not found', 404);
  }

  if (data.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, distributorId, deletedAt: null },
    });
    if (!customer) throw new AccountabilityError('Customer not found', 404);
  }

  return prisma.$transaction(async (tx) => {
    const log = await tx.accountabilityLog.create({
      data: {
        distributorId,
        driverId: data.driverId || null,
        customerId: data.customerId || null,
        cylinderTypeId: data.cylinderTypeId || null,
        incidentType: data.incidentType as any,
        incidentDate: new Date(data.incidentDate),
        quantity: data.quantity,
        description: data.description,
        status: 'open_accountability',
      },
      include: accountabilityInclude,
    });

    // Create pending action
    await tx.pendingAction.create({
      data: {
        distributorId,
        module: 'inventory',
        entityType: 'accountability_log',
        entityId: log.id,
        actionType: 'resolve_incident',
        description: `${data.incidentType}: ${data.description} (Qty: ${data.quantity})`,
        status: 'open',
        severity: data.quantity >= 10 ? 'high' : 'medium',
      },
    });

    return log;
  });
}

export async function updateAccountabilityLog(
  id: string,
  distributorId: string,
  data: {
    status?: string;
    description?: string;
    quantity?: number;
  }
) {
  const existing = await prisma.accountabilityLog.findFirst({
    where: { id, distributorId },
  });
  if (!existing) throw new AccountabilityError('Accountability log not found', 404);

  const updateData: Prisma.AccountabilityLogUpdateInput = {};
  if (data.status) updateData.status = data.status as any;
  if (data.description) updateData.description = data.description;
  if (data.quantity !== undefined) updateData.quantity = data.quantity;

  return prisma.accountabilityLog.update({
    where: { id },
    data: updateData,
    include: accountabilityInclude,
  });
}

export async function resolveAccountabilityLog(
  id: string,
  distributorId: string,
  userId: string,
  data: {
    resolutionNotes: string;
    costAmount?: number;
    status: string;
  }
) {
  const existing = await prisma.accountabilityLog.findFirst({
    where: { id, distributorId },
  });
  if (!existing) throw new AccountabilityError('Accountability log not found', 404);
  if (['resolved_recovered', 'resolved_written_off', 'resolved_charged', 'closed'].includes(existing.status)) {
    throw new AccountabilityError('Incident is already resolved', 400);
  }

  return prisma.$transaction(async (tx) => {
    const resolved = await tx.accountabilityLog.update({
      where: { id },
      data: {
        status: data.status as any,
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolutionNotes: data.resolutionNotes,
        costAmount: data.costAmount ?? existing.costAmount,
      },
      include: accountabilityInclude,
    });

    // If written off, create inventory write-off event
    if (data.status === 'resolved_written_off' && existing.cylinderTypeId) {
      const { createInventoryEvent, recalculateSummariesFromDate } = await import('./inventoryService.js');
      await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: existing.cylinderTypeId,
        eventType: 'write_off',
        fullsChange: -existing.quantity,
        emptiesChange: 0,
        eventDate: new Date(),
        referenceId: id,
        referenceType: 'accountability_log',
        createdBy: userId,
        notes: `Write-off: ${data.resolutionNotes}`,
      });
      await recalculateSummariesFromDate(distributorId, existing.cylinderTypeId, new Date());
    }

    // If charged to customer, create a ledger entry
    if (data.status === 'resolved_charged' && existing.customerId && data.costAmount) {
      await tx.customerLedgerEntry.create({
        data: {
          distributorId,
          customerId: existing.customerId,
          entryType: 'adjustment',
          referenceId: id,
          amountDelta: data.costAmount,
          narration: `Accountability charge: ${data.resolutionNotes}`,
          entryDate: new Date(),
          createdBy: userId,
        },
      });
    }

    // Resolve pending action
    await tx.pendingAction.updateMany({
      where: { entityId: id, entityType: 'accountability_log', status: { in: ['open', 'in_progress'] } },
      data: { status: 'resolved', resolvedBy: userId, resolvedAt: new Date(), resolutionNotes: data.resolutionNotes },
    });

    return resolved;
  });
}

export class AccountabilityError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'AccountabilityError';
  }
}
